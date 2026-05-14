"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigStore = void 0;
const electron_store_1 = __importDefault(require("electron-store"));
const crypto_1 = __importDefault(require("crypto"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const electron_1 = require("electron");
const kasmap_heartbeat_1 = require("./kasmap-heartbeat");
const dir_size_1 = require("./dir-size");
const identity_backup_1 = require("./identity-backup");
const DEFAULTS = {
    network: 'mainnet',
    nodeMode: 'bundled',
    remoteUrl: '',
    dataDir: '',
    borshPort: 17110,
    jsonPort: 18110,
    outpeers: 64,
    ramScale: 0.5,
    utxoIndex: true,
    autoStart: true,
    minimizeToTray: true,
    nodeVisibility: 'public',
    // Telemetry is now OPT-IN (changed from v0.3.8 which defaulted true).
    // Sovereign-fork ethos: nothing phones home unless the user explicitly says yes.
    contributeMonitoring: false,
    shareErrorDiagnostics: false,
    preventSleepDuringSetup: true,
    autoUpdate: true,
    nodeId: '',
    accountKey: '',
    kasmap: kasmap_heartbeat_1.KASMAP_DEFAULTS,
    miningEnabled: false,
    miningAddress: '',
    stratumPort: 5555,
    stratumBind: 'localhost',
    hiddenNodeIds: [],
    theme: 'dark',
    launchOnStartup: true,
    // Storage mode — controls whether kaspad prunes, retains-N-days, or archives.
    // 'pruned'    → kaspad default (~30 GB disk, ~30h retention post-Crescendo)
    // 'retention' → --retention-period-days=N (N>=2)
    // 'archival'  → --archival (keeps all blocks since flip; ~1.5 TB and growing)
    // Mutually exclusive at the kaspad layer; archival wins if both somehow set.
    nodeStorageMode: 'pruned',
    retentionDays: 0,
};
class ConfigStore {
    store;
    /** True only when this constructor detected a GENUINE first run —
     *  electron-store was empty AND Documents\MyKAI\identity.json did
     *  not exist. Reinstalls that auto-restored from Documents are NOT
     *  first runs and this stays false.
     *
     *  Used by main.ts to fire the firstRun:show-prompt IPC event so the
     *  renderer can show the welcome modal. Transient (not persisted) —
     *  rotated to false on the first read so the modal fires at most
     *  once per process lifetime. */
    _isFreshFirstRun = false;
    /** One-shot: returns true the first time it's called after a genuine
     *  first run, false thereafter (and on every call after a normal
     *  start or restore). main.ts uses this to fire firstRun:show-prompt
     *  at most once. */
    consumeFreshFirstRunFlag() {
        const v = this._isFreshFirstRun;
        this._isFreshFirstRun = false;
        return v;
    }
    constructor() {
        this.store = new electron_store_1.default({
            name: 'mykai-node-config',
            defaults: DEFAULTS,
        });
        if (!this.store.get('dataDir')) {
            this.store.set('dataDir', this.detectDataDir());
        }
        // Ensure kasmap config exists (upgrade from older version)
        if (!this.store.get('kasmap')) {
            this.store.set('kasmap', kasmap_heartbeat_1.KASMAP_DEFAULTS);
        }
        if (!this.store.get('nodeVisibility')) {
            this.store.set('nodeVisibility', 'public');
        }
        // Migration v0.3.x → v0.4: storage mode is a new tri-state config.
        // Pre-v0.4 installs were silently running pruned. Default them to
        // 'pruned' so behavior is unchanged on upgrade. Never silently flip
        // an existing user to archival — that would trigger a 3 TB re-sync
        // on next launch.
        if (this.store.get('nodeStorageMode') === undefined) {
            this.store.set('nodeStorageMode', 'pruned');
        }
        if (this.store.get('retentionDays') === undefined) {
            this.store.set('retentionDays', 0);
        }
        // Identity restore — runs BEFORE the fresh-key generation below.
        // If electron-store has nothing but Documents\MyKAI\identity.json
        // exists (e.g., a PC cleaner wiped %APPDATA% but left Documents
        // alone), restore both stores silently. See identity-backup.ts for
        // the architectural background.
        //
        // Snapshot whether identity existed BEFORE the restore step so we
        // can detect a genuine first run (no electron-store identity AND
        // no Documents backup -> _isFreshFirstRun = true). A successful
        // restore from Documents is NOT a first run.
        const hadAccountKeyBeforeRestore = !!this.store.get('accountKey');
        const restored = this.restoreIdentityIfNeeded();
        // Generate persistent random nodeId on first run (after restore attempt
        // — so a successful restore prevents fresh generation).
        let generatedFresh = false;
        if (!this.store.get('nodeId')) {
            this.store.set('nodeId', `node_${crypto_1.default.randomBytes(16).toString('hex')}`);
            generatedFresh = true;
        }
        // Generate account key — groups all nodes under one owner
        if (!this.store.get('accountKey')) {
            this.store.set('accountKey', `acc_${crypto_1.default.randomBytes(16).toString('hex')}`);
            generatedFresh = true;
        }
        // First-run flag = we just generated fresh keys AND nothing was
        // restored from Documents. Existing users on first 0.3.3 launch
        // (electron-store has accountKey from before) skip the modal.
        // Reinstalls that auto-restored from Documents skip the modal too.
        this._isFreshFirstRun = generatedFresh && !restored && !hadAccountKeyBeforeRestore;
        // Migration: autoStart used to be user-toggleable. Now it's implicitly
        // always true — kaspad runs whenever the app is open. Anyone stuck with
        // autoStart: false from an old version would have a broken UX.
        if (this.store.get('autoStart') === false) {
            this.store.set('autoStart', true);
        }
        // Mirror current accountKey + nodeId to the Documents backup.
        // Idempotent: writeBackupPartial merges with existing file (one
        // file per accountKey, named identity_acc_<key>.json — never gets
        // overwritten by another identity). On a fresh first run this
        // creates the file; on a normal launch it refreshes updatedAt so
        // we know the install is alive. Gamification mirrors its lifetime
        // stats separately on each save (gamification.ts).
        const accountKey = this.store.get('accountKey');
        if (accountKey) {
            (0, identity_backup_1.writeBackupPartial)(accountKey, {
                nodeId: this.store.get('nodeId'),
            });
        }
    }
    /** Restore accountKey + nodeId + lifetime stats from
     *  Documents\MyKAI\identity.json if electron-store is empty.
     *  Writes restored values directly into both the config store and
     *  the gamification store (separate electron-store names) so both
     *  classes pick them up on construction.
     *
     *  Returns true if a restore actually happened — caller uses that
     *  to suppress the first-run modal (a restored install is NOT a
     *  first run). Silent on success — only logs if restore happened. */
    restoreIdentityIfNeeded() {
        const hasNodeId = !!this.store.get('nodeId');
        const hasAccountKey = !!this.store.get('accountKey');
        // Both present? electron-store is healthy, nothing to restore.
        if (hasNodeId && hasAccountKey)
            return false;
        const backup = (0, identity_backup_1.readBackup)();
        if (!backup)
            return false; // no backup file → genuine first run, fall through to fresh generation.
        // Restore identity into THIS store (config).
        if (!hasNodeId && backup.nodeId) {
            this.store.set('nodeId', backup.nodeId);
        }
        if (!hasAccountKey && backup.accountKey) {
            this.store.set('accountKey', backup.accountKey);
        }
        // Restore lifetime stats into the gamification store. Gamification's
        // constructor (which runs after this) will read these values.
        // We write directly to its electron-store file via a temporary Store
        // instance rather than coupling through the Gamification class.
        try {
            const gamStore = new electron_store_1.default({ name: 'mykai-node-gamification' });
            const set = (k, v) => { if (v !== undefined && v !== null)
                gamStore.set(k, v); };
            set('blocksValidated', backup.blocksValidated);
            set('transactionsSeen', backup.transactionsSeen);
            set('totalUptimeSeconds', backup.totalUptimeSeconds);
            set('longestStreakSeconds', backup.longestStreakSeconds);
            set('peakTps', backup.peakTps);
            set('firstSyncCompleted', backup.firstSyncCompleted);
            set('sharesAccepted', backup.sharesAccepted);
            set('blocksFound', backup.blocksFound);
            set('totalRewardSompi', backup.totalRewardSompi);
        }
        catch (err) {
            console.error('[config-store] gamification restore failed:', err.message);
        }
        const accKey = backup.accountKey || '(none)';
        console.log(`[config-store] restored identity from Documents (electron-store was empty). ` +
            `accountKey=${accKey.slice(0, 12)}..., totalUptime=${Math.round((backup.totalUptimeSeconds || 0) / 60)}min, ` +
            `blocksValidated=${backup.blocksValidated || 0}`);
        return true;
    }
    get(key) {
        return this.store.get(key);
    }
    set(key, value) {
        // electron-store does its disk write synchronously by default —
        // a slow disk + large config file can stall the event loop. Time
        // the call and log to perf-stalls.log if it exceeds 50 ms so we
        // catch sync I/O regressions before they become user-visible BPS
        // dropouts (the bug class we chased on 2026-04-28).
        const t0 = Date.now();
        this.store.set(key, value);
        const dt = Date.now() - t0;
        if (dt > 50) {
            try {
                // Lazy import keeps perf-stalls out of the cold-start path
                // and avoids a circular dependency between config-store and
                // perf-stalls (which imports nothing from here).
                require('./perf-stalls').recordSlowStoreWrite('config', String(key), dt);
            }
            catch { /* perf-stalls not init yet — skip */ }
        }
    }
    getAll() {
        return {
            network: this.store.get('network'),
            nodeMode: this.store.get('nodeMode') || 'bundled',
            remoteUrl: this.store.get('remoteUrl') || '',
            dataDir: this.store.get('dataDir'),
            borshPort: this.store.get('borshPort'),
            jsonPort: this.store.get('jsonPort'),
            outpeers: this.store.get('outpeers'),
            ramScale: this.store.get('ramScale'),
            utxoIndex: this.store.get('utxoIndex'),
            autoStart: this.store.get('autoStart'),
            minimizeToTray: this.store.get('minimizeToTray'),
            nodeVisibility: this.store.get('nodeVisibility') || 'public',
            contributeMonitoring: this.store.get('contributeMonitoring') !== false,
            shareErrorDiagnostics: this.store.get('shareErrorDiagnostics') !== false,
            preventSleepDuringSetup: this.store.get('preventSleepDuringSetup') !== false,
            autoUpdate: this.store.get('autoUpdate') !== false,
            nodeId: this.store.get('nodeId') || '',
            accountKey: this.store.get('accountKey') || '',
            kasmap: this.store.get('kasmap') || kasmap_heartbeat_1.KASMAP_DEFAULTS,
            miningEnabled: this.store.get('miningEnabled') === true,
            miningAddress: this.store.get('miningAddress') || '',
            stratumPort: this.store.get('stratumPort') || 5555,
            stratumBind: this.store.get('stratumBind') || 'localhost',
            hiddenNodeIds: this.store.get('hiddenNodeIds') || [],
            theme: this.store.get('theme') || 'dark',
            launchOnStartup: this.store.get('launchOnStartup') !== false,
            // v0.4: storage mode is the primary new config axis.
            // 'pruned' | 'retention' | 'archival' — see DEFAULTS for semantics.
            nodeStorageMode: this.store.get('nodeStorageMode') || 'pruned',
            retentionDays: this.store.get('retentionDays') || 0,
        };
    }
    setAll(config) {
        for (const [key, value] of Object.entries(config)) {
            if (value !== undefined) {
                this.store.set(key, value);
            }
        }
    }
    /** Wipe accountKey + nodeId from electron-store. Caller is responsible
     *  for also wiping the gamification store and Documents\MyKAI\identity.json,
     *  then relaunching the app so a fresh identity is generated on init.
     *
     *  Used ONLY by the explicit "Reset identity" Settings button. Never call
     *  from automatic cleanup, migration, or error-recovery paths. */
    resetIdentityKeys() {
        this.store.delete('accountKey');
        this.store.delete('nodeId');
    }
    getKaspadPath() {
        if (electron_1.app.isPackaged) {
            return path_1.default.join(process.resourcesPath, 'kaspad.exe');
        }
        return path_1.default.join(electron_1.app.getAppPath(), 'resources', 'kaspad.exe');
    }
    getStratumBridgePath() {
        if (electron_1.app.isPackaged) {
            return path_1.default.join(process.resourcesPath, 'ks_bridge.exe');
        }
        return path_1.default.join(electron_1.app.getAppPath(), 'resources', 'ks_bridge.exe');
    }
    detectDataDir() {
        const localAppData = process.env.LOCALAPPDATA || path_1.default.join(process.env.USERPROFILE || '', 'AppData', 'Local');
        const existingDir = path_1.default.join(localAppData, 'rusty-kaspa');
        if (fs_1.default.existsSync(existingDir))
            return existingDir;
        return path_1.default.join(localAppData, 'MyKAI Node', 'kaspad-data');
    }
    hasExistingData() {
        const dataDir = this.store.get('dataDir');
        const network = this.store.get('network');
        const networkDir = path_1.default.join(dataDir, `kaspa-${network}`);
        return fs_1.default.existsSync(networkDir);
    }
    getDataSize() {
        const dataDir = this.store.get('dataDir');
        try {
            return this.formatDirSize(dataDir);
        }
        catch {
            return '0 B';
        }
    }
    /** Async variant that awaits the directory walk if the cache is cold,
     *  so the first call after process start returns the real size instead
     *  of "0 B". Used by the renderer (Settings UI, dashboard hero card)
     *  and by the startup activity-feed line — these have a real user
     *  watching, so paying ~1-5 s latency on cold start is the right
     *  trade-off vs. silently displaying 0. */
    async getDataSizeFresh() {
        const dataDir = this.store.get('dataDir');
        try {
            const bytes = await (0, dir_size_1.walkDirSizeFresh)(dataDir);
            return ConfigStore._formatBytes(bytes);
        }
        catch {
            return '0 B';
        }
    }
    static _formatBytes(totalSize) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = totalSize;
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }
        return `${size.toFixed(1)} ${units[unitIndex]}`;
    }
    /** Raw byte size of the data directory — for Insights telemetry. */
    getDataSizeBytes() {
        const dataDir = this.store.get('dataDir');
        try {
            return (0, dir_size_1.walkDirSize)(dataDir);
        }
        catch {
            return 0;
        }
    }
    getAccountKey() {
        return this.store.get('accountKey') || '';
    }
    // --- Update system helpers ---
    getUpdateStagingDir() {
        const dir = path_1.default.join(electron_1.app.getPath('userData'), 'update-staging');
        if (!fs_1.default.existsSync(dir))
            fs_1.default.mkdirSync(dir, { recursive: true });
        return dir;
    }
    getLastKnownKaspadVersion() {
        return this.store.get('lastKnownKaspadVersion') || '';
    }
    setLastKnownKaspadVersion(version) {
        this.store.set('lastKnownKaspadVersion', version);
    }
    getLastUpdateCheck() {
        return this.store.get('lastUpdateCheck') || 0;
    }
    setLastUpdateCheck(timestamp) {
        this.store.set('lastUpdateCheck', timestamp);
    }
    getDismissedUpdateVersion() {
        return this.store.get('dismissedUpdateVersion') || '';
    }
    setDismissedUpdateVersion(version) {
        this.store.set('dismissedUpdateVersion', version);
    }
    formatDirSize(dirPath) {
        const totalSize = (0, dir_size_1.walkDirSize)(dirPath);
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = totalSize;
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }
        return `${size.toFixed(1)} ${units[unitIndex]}`;
    }
}
exports.ConfigStore = ConfigStore;
//# sourceMappingURL=config-store.js.map