"use strict";
/**
 * MyKAI Node Update System
 *
 * Two update channels:
 * Channel A: Full app update via electron-updater (NSIS delta updates)
 * Channel B: Kaspad-only hot-swap for urgent consensus upgrades
 *
 * Both channels share the same version manifest from GitHub Releases.
 * The user always clicks the button — no silent auto-install.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppUpdater = void 0;
const events_1 = require("events");
const electron_1 = require("electron");
const electron_updater_1 = require("electron-updater");
const https_1 = __importDefault(require("https"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const update_downloader_1 = require("./update-downloader");
const http_body_1 = require("./util/http-body");
const http_agent_1 = require("./util/http-agent");
const MANIFEST_URL = 'https://api.github.com/repos/KasMapApp/MyKAI-Node-public/releases/latest';
const CHECK_INTERVAL = 8 * 60 * 60 * 1000; // 8 hours (laptops also get a check on every cold start, see scheduleChecks below)
const CRITICAL_CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes when fork deadline known
class AppUpdater extends events_1.EventEmitter {
    config;
    manager;
    downloader;
    state = 'idle';
    manifest = null;
    downloadProgress = null;
    checkTimer = null;
    _error = null;
    currentKaspadVersion = '';
    appUpdateDownloaded = false;
    constructor(config, manager) {
        super();
        this.config = config;
        this.manager = manager;
        this.downloader = new update_downloader_1.UpdateDownloader();
        // Wire downloader progress
        this.downloader.on('progress', (progress) => {
            this.downloadProgress = progress;
            this.emit('kaspad-download-progress', progress);
        });
        // Configure electron-updater for Channel A
        electron_updater_1.autoUpdater.autoDownload = true;
        electron_updater_1.autoUpdater.autoInstallOnAppQuit = true;
        // Bypass Authenticode signature verification on Windows. Our builds
        // ship UNSIGNED — every release from 0.2.19 onward is unsigned because
        // electron-builder's signtool config has `signtoolOptions.publisherName`
        // set but no actual certificate is configured (no CSC_LINK env, no
        // explicit certificate path). signtool is invoked but produces an
        // unsigned binary, which silently passes through the build pipeline.
        //
        // electron-updater on Windows refuses to install unsigned updates by
        // default — it downloads the .exe, runs WinTrustVerify, gets "not
        // signed", and deletes the file. The user-visible symptom (which
        // surfaced first on 0.3.8 because that's the first real auto-update
        // attempt against an existing install) is a download stuck at 100%
        // with the file disappearing from the cache directory after each
        // attempt and the banner never flipping to "Restart now."
        //
        // Trust model for accepting unsigned updates: HTTPS (TLS) protects
        // the update download in-transit, and GitHub Releases is the trusted
        // source. A MITM or update-injection attack would require
        // compromising both, which isn't in our threat model. Many indie
        // Electron projects ship this way.
        //
        // Long-term plan: acquire a code-signing cert (DigiCert / Sectigo /
        // SSL.com, ~$200-500/yr; EV cert preferred for SmartScreen reputation)
        // and remove this override. Tracked for the 0.4.x series.
        //
        // The override returns null to indicate "verification passed" per
        // electron-updater's API. Returning anything else (or rejecting the
        // promise) would cause the update to be rejected and deleted.
        //
        // Cast to `any` because `verifyUpdateCodeSignature` lives on the
        // platform-specific `NsisUpdater` (Windows) subtype, not on the
        // base `AppUpdater` interface electron-updater exports as
        // `autoUpdater`. The runtime object IS an NsisUpdater on Windows;
        // the cast just silences the type checker.
        electron_updater_1.autoUpdater.verifyUpdateCodeSignature = () => Promise.resolve(null);
        // Persist electron-updater's own internal log to userData/updater.log.
        // Pre-0.3.6 this was set to `null`, which hid the only signal that
        // could tell us WHY auto-update silently fails on user machines (the
        // long-running "no banner ever appears" bug since 0.2.28). Writing
        // to a file the user can copy out via "Copy diagnostic" lets us see
        // the actual error chain — checksum failure, signature mismatch,
        // network error, blockmap mismatch, whatever — instead of guessing.
        try {
            const logPath = path_1.default.join(electron_1.app.getPath('userData'), 'updater.log');
            const writeLine = (level, args) => {
                try {
                    const line = `${new Date().toISOString()} [${level}] ${args.map(a => {
                        if (a instanceof Error)
                            return a.stack || a.message;
                        if (typeof a === 'object') {
                            try {
                                return JSON.stringify(a);
                            }
                            catch {
                                return String(a);
                            }
                        }
                        return String(a);
                    }).join(' ')}\n`;
                    fs_1.default.appendFile(logPath, line, () => { });
                }
                catch { }
            };
            electron_updater_1.autoUpdater.logger = {
                info: (...a) => writeLine('info', a),
                warn: (...a) => writeLine('warn', a),
                error: (...a) => writeLine('error', a),
                debug: (...a) => writeLine('debug', a),
            };
        }
        catch {
            electron_updater_1.autoUpdater.logger = null;
        }
        electron_updater_1.autoUpdater.on('update-available', (info) => {
            this.emit('app-update-available', {
                version: info.version,
                releaseNotes: info.releaseNotes,
                releaseDate: info.releaseDate,
            });
        });
        electron_updater_1.autoUpdater.on('download-progress', (progress) => {
            this.emit('app-download-progress', {
                bytesReceived: progress.transferred,
                totalBytes: progress.total,
                percent: Math.round(progress.percent),
            });
        });
        electron_updater_1.autoUpdater.on('update-downloaded', (info) => {
            this.appUpdateDownloaded = true;
            // Prefer release notes from our custom update-manifest.json
            // (Channel B) over whatever electron-updater pulled from
            // latest.yml. We control the manifest directly and write
            // user-friendly notes there ("Behind-the-scenes improvements.
            // Your node just got better."); latest.yml usually has no
            // releaseNotes field so info.releaseNotes is undefined.
            // Fall back to whatever electron-updater provided if Channel B
            // hasn't completed by the time the download finishes (rare).
            const releaseNotes = this.manifest?.releaseNotes || info.releaseNotes || '';
            this.emit('app-update-downloaded', {
                version: info.version,
                releaseNotes,
            });
        });
        electron_updater_1.autoUpdater.on('error', (err) => {
            // Surface the FULL error string so the renderer's activity feed
            // shows what actually broke. Pre-0.3.6 this just emitted
            // err.message, and the renderer filtered most of those messages
            // out — leaving us blind on real download/signature/blockmap
            // failures. Now we attach a tag so even after filtering the
            // diagnostic dump can read updater.log directly.
            const detail = (err && (err.stack || err.message)) || String(err);
            this.emit('app-update-error', `[autoUpdater] ${detail}`);
        });
    }
    /**
     * Run on app startup: detect kaspad version, recover from interrupted updates, check for updates.
     */
    async checkOnStartup() {
        // Recover from interrupted kaspad binary swap
        this.manager.recoverBinaryIfNeeded();
        // Detect current kaspad version
        const version = await this.manager.detectVersion();
        if (version) {
            this.currentKaspadVersion = version;
            this.config.setLastKnownKaspadVersion(version);
        }
        else {
            this.currentKaspadVersion = this.config.getLastKnownKaspadVersion();
        }
        // Only check if auto-update is enabled
        const appConfig = this.config.getAll();
        if (appConfig.autoUpdate === false)
            return;
        // Delay first check to let UI render
        setTimeout(() => this.checkForUpdates(), 5000);
        // Schedule periodic checks
        this.scheduleChecks(CHECK_INTERVAL);
    }
    /**
     * Check both update channels.
     */
    async checkForUpdates() {
        this.state = 'checking';
        this._error = null;
        this.emit('state-change', this.state);
        // Channel A: full app update via electron-updater.
        // Runs UNCONDITIONALLY so auto-update works even if our custom
        // `update-manifest.json` (Channel B) isn't in the release assets.
        // Pre-0.2.27 bug: this was gated behind our custom manifest, which
        // we never actually upload — so 0.2.25/0.2.26 users never auto-
        // updated. Fixed by separating the two channels here.
        try {
            await electron_updater_1.autoUpdater.checkForUpdates();
        }
        catch (err) {
            // Best effort — dev builds, unpublished releases, or rare transient
            // network errors. Fall through to Channel B.
            this.emit('app-update-error', err?.message || String(err));
        }
        // Channel B: kaspad-only hot-swap via our custom manifest.
        // Independent of Channel A — if manifest is missing, we just skip.
        try {
            this.manifest = await this.fetchManifest();
            this.config.setLastUpdateCheck(Date.now());
            const kaspadNeedsUpdate = this.isKaspadUpdateNeeded();
            const appNeedsUpdate = this.isAppUpdateNeeded();
            if (kaspadNeedsUpdate && !appNeedsUpdate) {
                // Kaspad-only update (user has latest app but older kaspad)
                this.state = 'available';
                this.emit('kaspad-update-available', {
                    currentVersion: this.currentKaspadVersion,
                    newVersion: this.manifest.kaspadVersion,
                    urgency: this.manifest.urgency,
                    forkDeadline: this.manifest.forkDeadline,
                    releaseNotes: this.manifest.releaseNotes,
                    size: this.manifest.kaspadAssets['win-x64']?.size || 0,
                });
                if (this.manifest.urgency === 'critical') {
                    this.scheduleChecks(CRITICAL_CHECK_INTERVAL);
                }
            }
            else if (!kaspadNeedsUpdate && !appNeedsUpdate) {
                this.state = 'idle';
            }
        }
        catch {
            // Manifest missing or malformed — Channel B unavailable. That's OK,
            // Channel A (electron-updater) above handles app updates on its own.
            // Don't set state=error here; Channel A may have succeeded.
        }
        this.emit('state-change', this.state);
        return this.getStatus();
    }
    /**
     * Install a kaspad-only update (Channel B hot-swap).
     */
    async installKaspadUpdate() {
        if (!this.manifest)
            return { success: false, error: 'No update manifest' };
        const asset = this.manifest.kaspadAssets['win-x64'];
        if (!asset)
            return { success: false, error: 'No kaspad asset for this platform' };
        const stagingDir = this.config.getUpdateStagingDir();
        const expectedVersion = this.manifest.kaspadVersion;
        try {
            // Step 1: Download
            this.state = 'downloading';
            this.emit('state-change', this.state);
            this.emit('kaspad-install-step', 'Downloading kaspad update...');
            const downloadedPath = await this.downloader.download(asset.url, stagingDir, 'kaspad-pending.exe');
            // Step 2: Verify checksum
            this.emit('kaspad-install-step', 'Verifying integrity...');
            const valid = await this.downloader.verifyChecksum(downloadedPath, asset.sha256);
            if (!valid) {
                this.downloader.cleanStaging(stagingDir);
                this.state = 'error';
                this._error = 'Checksum verification failed — download may be corrupted';
                this.emit('state-change', this.state);
                return { success: false, error: this._error };
            }
            // Step 3: Stop kaspad
            this.state = 'installing';
            this.emit('state-change', this.state);
            this.emit('kaspad-install-step', 'Stopping node...');
            const wasRunning = this.manager.state !== 'stopped';
            if (wasRunning) {
                await this.manager.stop();
                // Wait for Windows to release file handles
                await new Promise(r => setTimeout(r, 2000));
            }
            // Step 4: Replace binary
            this.emit('kaspad-install-step', 'Installing new kaspad...');
            const replaceResult = await this.manager.replaceBinary(downloadedPath);
            if (!replaceResult.success) {
                // Try to restart old version
                if (wasRunning) {
                    try {
                        await this.manager.start();
                    }
                    catch { }
                }
                this.state = 'error';
                this._error = replaceResult.error || 'Binary replacement failed';
                this.emit('state-change', this.state);
                return { success: false, error: this._error };
            }
            // Step 5: Start kaspad and verify
            this.emit('kaspad-install-step', 'Starting updated node...');
            if (wasRunning) {
                try {
                    await this.manager.start();
                }
                catch (err) {
                    // New binary failed to start — rollback
                    this.emit('kaspad-install-step', 'Start failed — rolling back...');
                    await this.manager.rollbackBinary();
                    try {
                        await this.manager.start();
                    }
                    catch { }
                    this.state = 'error';
                    this._error = `New kaspad failed to start: ${err.message}. Rolled back.`;
                    this.emit('state-change', this.state);
                    return { success: false, error: this._error };
                }
            }
            // Step 6: Update stored version
            this.currentKaspadVersion = expectedVersion;
            this.config.setLastKnownKaspadVersion(expectedVersion);
            // Clean up staging
            this.downloader.cleanStaging(stagingDir);
            // Schedule .bak cleanup after 5 minutes of stable running
            setTimeout(() => {
                try {
                    const bakPath = this.config.getKaspadPath() + '.bak';
                    if (fs_1.default.existsSync(bakPath))
                        fs_1.default.unlinkSync(bakPath);
                }
                catch { }
            }, 5 * 60 * 1000);
            this.state = 'idle';
            this.manifest = null;
            this.emit('state-change', this.state);
            this.emit('kaspad-install-step', `Update complete! kaspad v${expectedVersion} is running.`);
            this.emit('kaspad-update-complete', { version: expectedVersion });
            return { success: true };
        }
        catch (err) {
            this.state = 'error';
            this._error = err.message;
            this.emit('state-change', this.state);
            return { success: false, error: err.message };
        }
    }
    /**
     * Install a full app update (Channel A). Quits the app and installs via NSIS.
     */
    installAppUpdate() {
        if (this.appUpdateDownloaded) {
            electron_updater_1.autoUpdater.quitAndInstall(false, true);
        }
    }
    /**
     * Dismiss an update notification for this version.
     */
    dismissUpdate(version) {
        this.config.setDismissedUpdateVersion(version);
        this.state = 'idle';
        this.emit('state-change', this.state);
    }
    /**
     * Get current update status for the renderer.
     */
    getStatus() {
        return {
            state: this.state,
            manifest: this.manifest,
            kaspadUpdateAvailable: this.isKaspadUpdateNeeded(),
            appUpdateAvailable: this.isAppUpdateNeeded(),
            downloadProgress: this.downloadProgress,
            currentKaspadVersion: this.currentKaspadVersion,
            currentAppVersion: electron_1.app.getVersion(),
            error: this._error,
        };
    }
    // --- Private helpers ---
    isKaspadUpdateNeeded() {
        if (!this.manifest)
            return false;
        if (!this.currentKaspadVersion)
            return false;
        // If the manifest has no downloadable kaspad assets, there's
        // nothing to update TO — the version field is just reference
        // metadata for the recommended kaspad version. Without this guard
        // the banner can fire spuriously (e.g. when currentKaspadVersion
        // briefly holds a stale lastKnownKaspadVersion from electron-store
        // before detectVersion finishes its 5s execSync). User reports
        // seeing "kaspad v1.1.0 available" while already running 1.1.0.
        //
        // We never publish kaspad updates from MyKAI's own update channel
        // anyway — kaspad ships bundled with the app installer; updating
        // kaspad means a full app update. This guard makes that explicit.
        const platformKey = process.platform === 'win32' ? 'win-x64' :
            process.platform === 'darwin' ? 'mac-x64' :
                process.platform === 'linux' ? 'linux-x64' :
                    process.platform;
        if (!this.manifest.kaspadAssets || !this.manifest.kaspadAssets[platformKey]) {
            return false;
        }
        return this.compareVersions(this.manifest.kaspadVersion, this.currentKaspadVersion) > 0;
    }
    isAppUpdateNeeded() {
        if (!this.manifest)
            return false;
        return this.compareVersions(this.manifest.appVersion, electron_1.app.getVersion()) > 0;
    }
    /** Returns >0 if a > b, <0 if a < b, 0 if equal.
     *  Used to decide whether the banner fires. The contract:
     *  banner shows ONLY when the new release version is strictly
     *  greater than the currently-running version. Equal versions =
     *  no banner. Older versions in the manifest = no banner (no
     *  silent downgrade prompts). */
    compareVersions(a, b) {
        // Defensive normalization:
        //  - trim whitespace (in case manifest JSON had stray padding)
        //  - strip leading "v"/"V" (kaspad's wRPC sometimes returns
        //    "v1.1.0", manifests should never have it but cheap guard)
        //  - parseInt over Number so "1-rc1" parses to 1 instead of NaN
        //    (release candidates aren't part of our version scheme but
        //    this stays robust if someone ever embeds one)
        const normalize = (s) => (s || '').trim().replace(/^v/i, '');
        const pa = normalize(a).split('.').map((p) => parseInt(p, 10) || 0);
        const pb = normalize(b).split('.').map((p) => parseInt(p, 10) || 0);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const na = pa[i] ?? 0;
            const nb = pb[i] ?? 0;
            if (na > nb)
                return 1;
            if (na < nb)
                return -1;
        }
        return 0;
    }
    scheduleChecks(interval) {
        if (this.checkTimer)
            clearInterval(this.checkTimer);
        this.checkTimer = setInterval(() => this.checkForUpdates(), interval);
    }
    async fetchManifest() {
        return new Promise((resolve, reject) => {
            // Fetch the latest release from GitHub API, then find update-manifest.json in assets
            const req = https_1.default.get(MANIFEST_URL, {
                headers: {
                    'User-Agent': 'MyKAI-Node-Updater',
                    'Accept': 'application/vnd.github.v3+json',
                },
                timeout: 10000,
                agent: http_agent_1.sharedHttpsAgent,
            }, (res) => {
                // Follow redirects
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    https_1.default.get(res.headers.location, {
                        headers: { 'User-Agent': 'MyKAI-Node-Updater', 'Accept': 'application/vnd.github.v3+json' },
                        timeout: 10000,
                        agent: http_agent_1.sharedHttpsAgent,
                    }, (redirectRes) => this.parseGitHubRelease(redirectRes, resolve, reject));
                    return;
                }
                this.parseGitHubRelease(res, resolve, reject);
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Manifest fetch timeout')); });
        });
    }
    parseGitHubRelease(res, resolve, reject) {
        (0, http_body_1.readBody)(res).then(body => {
            let release;
            try {
                release = JSON.parse(body);
            }
            catch {
                reject(new Error('Failed to parse GitHub release'));
                return;
            }
            const manifestAsset = release.assets?.find((a) => a.name === 'update-manifest.json');
            if (!manifestAsset) {
                reject(new Error('No update-manifest.json found in latest release'));
                return;
            }
            this.fetchManifestFollowingRedirects(manifestAsset.browser_download_url, 0, resolve, reject);
        }).catch(err => reject(err instanceof Error ? err : new Error(String(err))));
    }
    /**
     * Fetch the manifest JSON, following redirects up to MAX depth.
     * GitHub → S3 is the common case (1 redirect). Cap at 5 to prevent
     * stack blowup / infinite loops from a misbehaving or malicious URL.
     */
    fetchManifestFollowingRedirects(url, depth, resolve, reject) {
        const MAX_REDIRECTS = 5;
        if (depth > MAX_REDIRECTS) {
            reject(new Error(`Too many redirects fetching update manifest (>${MAX_REDIRECTS})`));
            return;
        }
        https_1.default.get(url, {
            headers: { 'User-Agent': 'MyKAI-Node-Updater' },
            timeout: 10000,
            agent: http_agent_1.sharedHttpsAgent,
        }, async (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                // Drain to free the socket before following the redirect
                res.resume();
                this.fetchManifestFollowingRedirects(res.headers.location, depth + 1, resolve, reject);
                return;
            }
            try {
                const body = await (0, http_body_1.readBody)(res, 2_000_000); // manifests should be tiny
                try {
                    resolve(JSON.parse(body));
                }
                catch {
                    reject(new Error('Failed to parse update manifest'));
                }
            }
            catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        }).on('error', reject);
    }
}
exports.AppUpdater = AppUpdater;
//# sourceMappingURL=updater.js.map