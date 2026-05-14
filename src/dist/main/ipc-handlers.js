"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLastIpcFromRendererAt = getLastIpcFromRendererAt;
exports.registerIpcHandlers = registerIpcHandlers;
const electron_1 = require("electron");
const diagnostic_1 = require("./diagnostic");
const firewall_1 = require("./firewall");
const http_body_1 = require("./util/http-body");
const http_agent_1 = require("./util/http-agent");
const https_1 = __importDefault(require("https"));
// cloud-node-manager removed in v0.4 sovereign-fork. The FluxCloud-specific
// mykai-monitor.sh that phoned home is no longer shipped; cloud deployment
// is treated as a separate concern.
const network_utils_1 = require("./network-utils");
// Passive renderer liveness — touched on every IPC invoke from the renderer.
// The renderer's own setInterval polls (5s health, 5s mining, 2min cloud)
// already produce frequent IPC traffic; if the gap grows past ~60s while the
// app is supposed to be running, the renderer is hung (CPU-bound JS loop, GC
// thrash, or crashed). Heartbeat builder reads this via getLastIpcFromRendererAt
// to populate the diagnostic's renderer_health block + drive the
// `renderer_unresponsive` Tier-2 trigger.
let lastIpcFromRendererAt = Date.now();
function getLastIpcFromRendererAt() { return lastIpcFromRendererAt; }
function registerIpcHandlers(manager, monitor, config, gamification, kasmap, updater, stratum, monitoring, opts) {
    // Local wrapper around ipcMain.handle that stamps lastIpcFromRendererAt on
    // every invocation. Same signature/behavior as ipcMain.handle — drop-in.
    const track = (channel, listener) => {
        electron_1.ipcMain.handle(channel, async (event, ...args) => {
            lastIpcFromRendererAt = Date.now();
            return await listener(event, ...args);
        });
    };
    track('node:start', async () => {
        try {
            await manager.start();
            monitor.start(() => manager.uptime);
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: err.message };
        }
    });
    track('node:stop', async () => {
        try {
            monitor.stop();
            await manager.stop();
            gamification.resetStreak();
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: err.message };
        }
    });
    track('node:restart', async () => {
        try {
            monitor.stop();
            await manager.restart();
            monitor.start(() => manager.uptime);
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: err.message };
        }
    });
    // ─── Reset chain data (Theme F of 0.3.4) ──────────────────────────────
    // Heavy-hammer escape hatch for users whose kaspad chain DB is in an
    // unrecoverable state — corrupted UTXO index that won't finish rebuilding,
    // partial sync stuck for hours, etc. Stops kaspad, deletes the rusty-kaspa
    // data dir entirely, restarts kaspad on a fresh sync.
    //
    // Preserves identity: %APPDATA%\Roaming\mykai-node\ (electron-store with
    // accountKey + lifetime stats) and Documents\MyKAI\ (identity backups)
    // are NOT touched. Only the kaspa chain DB is wiped.
    //
    // Cost to user: 2-4 hour fresh IBD. Visible via the new sync count display
    // (Theme A) so users see progress immediately, not 30 min of 0%.
    //
    // UX safety: 5-second hold-to-confirm in the renderer before this fires
    // (matches Reset Identity pattern). The IPC handler itself doesn't
    // double-confirm — that's the renderer's job.
    track('node:reset-chain-data', async () => {
        const fs = await Promise.resolve().then(() => __importStar(require('fs')));
        const path = await Promise.resolve().then(() => __importStar(require('path')));
        try {
            const dataDir = config.get('dataDir');
            if (!dataDir || !fs.existsSync(dataDir)) {
                return { ok: false, error: 'Chain data folder not found — nothing to reset.' };
            }
            // 1. Stop kaspad cleanly (graceful SIGTERM → 15s → force-kill)
            monitor.stop();
            await manager.stop();
            // 2. Delete the entire kaspa data folder. fs.rm with recursive +
            //    force = "rm -rf"; force=true makes no-such-file errors silent.
            //    We delete the WHOLE rusty-kaspa folder so logs + datadir + any
            //    testnet leftovers all go in one shot. kaspad will recreate
            //    the dir tree on next start.
            try {
                await fs.promises.rm(dataDir, { recursive: true, force: true });
            }
            catch (rmErr) {
                // If the rm fails (file lock, permissions), surface it — user
                // needs to know they may have to do it manually.
                return { ok: false, error: `Could not delete chain data: ${rmErr?.message ?? rmErr}` };
            }
            // 3. Restart kaspad on the empty data dir. kaspad will recreate
            //    the directory structure and start a fresh IBD from scratch.
            await manager.start();
            monitor.start(() => manager.uptime);
            return { ok: true };
        }
        catch (err) {
            // If anything goes wrong AFTER the delete (e.g., kaspad won't
            // start), surface clearly — user is in a half-state and may
            // need to manually click Start.
            return { ok: false, error: err?.message ?? String(err) };
        }
    });
    track('node:status', () => {
        const status = monitor.status;
        if (manager.pid !== null) {
            status.state = manager.state === 'stopped' ? 'syncing' : manager.state;
        }
        else {
            status.state = manager.state;
        }
        status.uptimeSeconds = manager.uptime;
        if (status.peerCount === 0 && manager.peerCount > 0) {
            status.peerCount = manager.peerCount;
        }
        return status;
    });
    // Gamification
    track('gamification:stats', () => gamification.current);
    track('gamification:milestones', () => gamification.pendingMilestones);
    // Agent indicator state. Driven by AgentBridge presence — the previous
    // implementation enumerated TCP sockets via netstat every 5s, which blocked
    // the main thread for 100-400ms (the steady-state event-loop stall the
    // renderer-hang investigation pinned). The renderer's `updateAgentIndicator`
    // already reads `connected` + `name`; AgentBridge exposes both natively.
    track('health:agent-status', () => ({
        connected: opts?.agentBridge?.isAgentConnected ?? false,
        name: opts?.agentBridge?.agentName ?? '',
        connections: opts?.agentBridge?.isAgentConnected ? 1 : 0,
    }));
    // KasMap
    track('kasmap:status', () => kasmap.status);
    // v0.5: shard storage stats. Returns null when feature off so renderer
    // can hide the dashboard widget entirely. opts.getShardStats is wired
    // by main.js with the same closure that agent-bridge uses.
    track('shard:stats', () => {
        if (!opts?.getShardStats) return null;
        return opts.getShardStats();
    });
    // v0.5: hardware probe for the Archive Pool page. Bundles disk + RAM +
    // CPU info plus a recommended contribution based on the user's machine.
    // Recommendation algorithm:
    //   - disk_bound = free_disk * 0.7  (leave 30% for OS + user)
    //   - ram_bound by pinset table from research (50 GB ≈ +1.5 GB RAM, etc.)
    //   - recommended = min(disk_bound, ram_bound), floored to nice multiple
    track('pool:hardware-probe', () => {
        const hostSpecs = require('./host-specs').getHostSpecs();
        const { getFreeBytes, getTotalBytes } = require('./disk-monitor');
        const dataDir = config.get('dataDir');
        const freeDiskBytes = getFreeBytes(dataDir);
        const totalDiskBytes = getTotalBytes(dataDir);
        // Reserve baseline RAM for OS + kaspad. The remaining RAM can fund
        // the shard module's working set. Pinset-to-RAM mapping from
        // empirical research (see project memory rule #21):
        //   10 GB pinset  ≈ +0.5 GB RAM
        //   50 GB         ≈ +1.5 GB
        //   200 GB        ≈ +3.5 GB
        //   1 TB          ≈ +6 GB
        //   1.5 TB        ≈ +9 GB
        // Solve for max pinset that fits in available RAM headroom.
        const ramFreeBytes = hostSpecs.ramFreeBytes;
        const ramHeadroomBytes = Math.max(0, ramFreeBytes - 4 * 1024 * 1024 * 1024); // reserve 4 GB
        // Linear approximation: ~3 MB RAM per GB pinset above the baseline
        const ramBoundGB = Math.floor(ramHeadroomBytes / (3 * 1024 * 1024));
        // Disk: leave 30% buffer for OS + user + kaspad's own 30 GB
        const diskHeadroomBytes = Math.max(0, freeDiskBytes - 30 * 1024 * 1024 * 1024);
        const diskBoundGB = Math.floor(diskHeadroomBytes * 0.7 / (1024 * 1024 * 1024));
        // Final recommendation: min of the two, snapped to a nice multiple of 10
        const rawRec = Math.min(ramBoundGB, diskBoundGB);
        let recommended = 0;
        if (rawRec >= 10) {
            // Snap to nice rungs: 10, 25, 50, 100, 200, 500, 1000, 2000
            const rungs = [10, 25, 50, 100, 200, 500, 1000, 2000, 5000];
            recommended = rungs.filter(r => r <= rawRec).pop() || 10;
        }
        return {
            ramTotalBytes: hostSpecs.ramBytes,
            ramFreeBytes: hostSpecs.ramFreeBytes,
            ramFreeGB: Math.round(hostSpecs.ramFreeBytes / (1024 * 1024 * 1024) * 10) / 10,
            cpuCores: hostSpecs.cpuCount,
            cpuModel: hostSpecs.cpuModel,
            cpuSpeedMHz: hostSpecs.cpuSpeedMHz,
            diskTotalBytes: totalDiskBytes,
            diskFreeBytes: freeDiskBytes,
            diskFreeGB: Math.round(freeDiskBytes / (1024 * 1024 * 1024) * 10) / 10,
            currentContributionGB: config.get('shardSizeGB') || 0,
            recommendedGB: recommended,
            // Bounds for the UI slider — never offer more than the machine can handle.
            maxRecommendedGB: Math.max(0, Math.floor(Math.min(ramBoundGB, diskBoundGB))),
        };
    });
    track('kasmap:verify', async (_event, token) => {
        return await kasmap.verify(token);
    });
    // Config
    track('config:get', () => config.getAll());
    track('config:set', async (_event, updates) => {
        // Snapshot pre-change values so we can detect what actually changed,
        // then let firewall rules reflect the new state.
        const oldNetwork = config.get('network');
        const oldStratumBind = config.get('stratumBind');
        // v0.4: snapshot storage-mode state so we can fire the
        // config:storage-mode-changed IPC event and rotate the marker file.
        const oldNodeStorageMode = config.get('nodeStorageMode') || 'pruned';
        const oldRetentionDays = config.get('retentionDays') || 0;
        config.setAll(updates);
        if (updates.launchOnStartup !== undefined) {
            electron_1.app.setLoginItemSettings({
                openAtLogin: updates.launchOnStartup,
                args: ['--hidden'],
            });
        }
        if (updates.kasmap) {
            kasmap.updateConfig(updates.kasmap);
            // If KasMap was just enabled with a valid token, start heartbeat immediately
            if (updates.kasmap.enabled && updates.kasmap.token && opts?.getHeartbeatData) {
                kasmap.start(opts.getHeartbeatData);
            }
        }
        // --- Firewall sync (after config is committed) ---
        const mainWin = electron_1.BrowserWindow.getFocusedWindow() || electron_1.BrowserWindow.getAllWindows()[0] || null;
        // Testnet rule follows the network setting
        if (updates.network !== undefined && updates.network !== oldNetwork) {
            if (updates.network === 'testnet') {
                await (0, firewall_1.requestOpenPort)(mainWin, firewall_1.FW_TESTNET, 'testnet peers');
            }
            else if (oldNetwork === 'testnet') {
                await (0, firewall_1.requestRemovePort)(mainWin, firewall_1.FW_TESTNET.ruleName, 'testnet peers');
            }
        }
        // Mining rule follows stratumBind (only if mining is actually on)
        if (updates.stratumBind !== undefined && updates.stratumBind !== oldStratumBind) {
            const wasLanOrAll = oldStratumBind === 'lan' || oldStratumBind === 'all';
            const isLanOrAll = updates.stratumBind === 'lan' || updates.stratumBind === 'all';
            if (isLanOrAll && !wasLanOrAll) {
                await (0, firewall_1.requestOpenPort)(mainWin, firewall_1.FW_MINING, 'miners on your LAN');
            }
            else if (!isLanOrAll && wasLanOrAll) {
                await (0, firewall_1.requestRemovePort)(mainWin, firewall_1.FW_MINING.ruleName, 'miners on your LAN');
            }
        }
        // v0.4: storage-mode change handling.
        // - Hot-update DiskMonitor's thresholds so they reflect the new mode immediately.
        // - Write a marker file so we can detect drift between config and kaspad's
        //   persisted is_archival_node flag on next boot (defends against the
        //   rusty-kaspa set_is_archival_node WriteBatch bug; see upstream PR-01).
        // - Emit config:storage-mode-changed IPC so the renderer can show the right
        //   confirmation dialog and trigger a kaspad restart.
        const newNodeStorageMode = config.get('nodeStorageMode') || 'pruned';
        const newRetentionDays = config.get('retentionDays') || 0;
        const modeChanged = newNodeStorageMode !== oldNodeStorageMode;
        const retentionChanged = newRetentionDays !== oldRetentionDays;
        if (modeChanged || retentionChanged) {
            if (opts?.diskMonitor && modeChanged) {
                opts.diskMonitor.setStorageMode(newNodeStorageMode);
            }
            // Marker file: written to userData so it survives kaspad's datadir
            // wipes. Defends against the upstream set_is_archival_node bug.
            try {
                const markerPath = require('path').join(electron_1.app.getPath('userData'), 'mykai-storage-mode.json');
                const marker = {
                    schemaVersion: 1,
                    requestedAt: new Date().toISOString(),
                    requestedMode: newNodeStorageMode,
                    previousMode: oldNodeStorageMode,
                    requestedRetentionDays: newRetentionDays,
                    previousRetentionDays: oldRetentionDays,
                    note: 'Defends against upstream rusty-kaspa set_is_archival_node WriteBatch non-commit bug. See docs/upstream-prs/PR-01.',
                };
                require('fs').writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf-8');
            }
            catch (err) {
                console.warn('[config:set] could not write storage-mode marker file:', err?.message || err);
            }
            // Pruned → archival requires kaspad to actually re-sync historical
            // data (which we lost when running pruned). Renderer should warn
            // and confirm before persisting.
            // Archival → pruned does NOT require resync (kaspad will start
            // pruning the existing data on the next CSV cycle).
            // Retention changes are always non-destructive.
            const requiresFullResync = oldNodeStorageMode !== 'archival' && newNodeStorageMode === 'archival';
            if (mainWin) {
                mainWin.webContents.send('config:storage-mode-changed', {
                    oldMode: oldNodeStorageMode,
                    newMode: newNodeStorageMode,
                    oldRetentionDays,
                    newRetentionDays,
                    requiresFullResync,
                    requiresKaspadRestart: true,
                });
            }
        }
        return config.getAll();
    });
    track('config:hasExistingData', () => config.hasExistingData());
    // Use the async fresh getter so the renderer's first call after process
    // start awaits the directory walk instead of getting "0 B" from the cold
    // cache. Walk takes ~1-5 s on a 30+ GB rusty-kaspa dir; settings UI and
    // dashboard hero card get the real value the moment they ask for it.
    track('config:dataSize', () => config.getDataSizeFresh());
    // ─── Recovery flow (paste-key recovery via Insights) ────────────────────
    // Theme 5 of the 0.3.3 plan. User pastes their accountKey OR nodeId
    // (e.g. recovered from a screenshot, password manager, or Discord DM
    // from support); client POSTs to /api/recover-by-key; server returns
    // a list of (accountKey, nodeId, nodeName, lifetime stats) matches;
    // user picks one and we restore both keys + a stat snapshot locally.
    // Recovery uses ONLY the pasted key — no IP, no fingerprint, no fuzzy
    // match. See recovery-client.ts for the architectural background.
    track('recovery:lookup', async (_event, key) => {
        try {
            // Local-first lookup. If the user has a Documents\MyKAI\identity_acc_<key>.json
            // file for this exact accountKey, prefer it over cloud — local has full
            // fidelity (whatever the user accumulated locally before any Reset),
            // while cloud may have lower values if heartbeats hadn't caught up yet
            // (the pre-Theme-2 era issue Seb hit on 28-04-2026: cloud's identity_backup
            // was populated from 48h node_snapshots backfill, not from the user's
            // actual lifetime, so Reset+Restore from cloud lost real data).
            //
            // The local file survives Reset Identity (Theme 1.C never deletes it),
            // so it acts as a "before-Reset snapshot" the user can restore from
            // by pasting their old key. Cloud is the fallback for "lost everything
            // including the local file" cases (fresh OS install, etc.).
            const ACC_RX = /^acc_[0-9a-f]{32}$/;
            if (ACC_RX.test(key)) {
                try {
                    const { readBackup } = await Promise.resolve().then(() => __importStar(require('./identity-backup')));
                    const local = readBackup(key);
                    if (local && local.accountKey === key) {
                        return {
                            ok: true,
                            source: 'local',
                            matches: [{
                                    accountKey: local.accountKey,
                                    nodeId: local.nodeId,
                                    nodeName: local.nodeName || 'Local Node',
                                    blocksValidated: local.blocksValidated || 0,
                                    transactionsSeen: local.transactionsSeen || 0,
                                    totalUptimeSeconds: local.totalUptimeSeconds || 0,
                                    longestStreakSeconds: local.longestStreakSeconds || 0,
                                    peakTps: local.peakTps || 0,
                                    lastHeartbeatAt: local.updatedAt,
                                }],
                        };
                    }
                }
                catch (err) {
                    // Local lookup failure shouldn't block cloud fallback.
                    console.error('[recovery:lookup] local read failed:', err?.message);
                }
            }
            // Cloud fallback. Either the key is a node_... (we don't index local
            // by node), or no local file exists for this accountKey.
            const { lookupByKey } = await Promise.resolve().then(() => __importStar(require('./recovery-client')));
            const result = await lookupByKey(key);
            return { ok: true, source: 'cloud', matches: result.matches };
        }
        catch (err) {
            // RecoveryError carries a code we surface to the renderer for
            // friendlier UI messaging. Non-RecoveryError failures fall through
            // to a generic 'unknown' so the picker can still show something.
            return {
                ok: false,
                code: err?.code ?? 'unknown',
                error: err?.message ?? String(err),
            };
        }
    });
    // Apply a chosen recovery match: restore accountKey + nodeId + stat
    // snapshot to BOTH electron-store and Documents\MyKAI\identity.json,
    // then relaunch the app. Same relaunch pattern as config:reset-identity
    // — fresh ConfigStore + Gamification on init pick up the restored
    // values from electron-store, so all UI tiles + the next heartbeat
    // reflect the recovered identity.
    track('recovery:apply', async (_event, match) => {
        try {
            const { writeBackupPartial } = await Promise.resolve().then(() => __importStar(require('./identity-backup')));
            const { default: Store } = await Promise.resolve().then(() => __importStar(require('electron-store')));
            // Validate shape — never trust a renderer payload, even from our own UI.
            if (!match || typeof match !== 'object'
                || typeof match.accountKey !== 'string'
                || typeof match.nodeId !== 'string') {
                return { ok: false, error: 'Invalid match payload (missing accountKey or nodeId).' };
            }
            const ACC_RX = /^acc_[0-9a-f]{32}$/;
            const NODE_RX = /^node_[0-9a-f]{32}$/;
            if (!ACC_RX.test(match.accountKey) || !NODE_RX.test(match.nodeId)) {
                return { ok: false, error: 'Invalid match payload (key format mismatch).' };
            }
            // 1. Write to config store (accountKey + nodeId)
            config.setAll({
                accountKey: match.accountKey,
                nodeId: match.nodeId,
            });
            // 2. Write to gamification store (lifetime stats snapshot)
            // Direct Store write rather than going through Gamification class —
            // we want these values in storage BEFORE the relaunch, and the
            // running Gamification instance might have stale in-memory state.
            // Same pattern config-store.ts uses for restoreIdentityIfNeeded().
            try {
                const gamStore = new Store({ name: 'mykai-node-gamification' });
                const setIfNum = (k, v) => {
                    if (typeof v === 'number' && Number.isFinite(v) && v >= 0)
                        gamStore.set(k, v);
                };
                setIfNum('blocksValidated', match.blocksValidated);
                setIfNum('transactionsSeen', match.transactionsSeen);
                setIfNum('totalUptimeSeconds', match.totalUptimeSeconds);
                setIfNum('longestStreakSeconds', match.longestStreakSeconds);
                setIfNum('peakTps', match.peakTps);
            }
            catch (err) {
                // Non-fatal — accountKey/nodeId still restored. Log and continue.
                console.error('[recovery:apply] gamification store write failed:', err?.message);
            }
            // 3. Write the full identity blob to
            //    Documents\MyKAI\identity_acc_<key>.json. Keyed filename so
            //    multi-machine sync / multi-identity scenarios don't collide.
            writeBackupPartial(match.accountKey, {
                nodeId: match.nodeId,
                nodeName: typeof match.nodeName === 'string' ? match.nodeName : 'Local Node',
                blocksValidated: match.blocksValidated || 0,
                transactionsSeen: match.transactionsSeen || 0,
                totalUptimeSeconds: match.totalUptimeSeconds || 0,
                longestStreakSeconds: match.longestStreakSeconds || 0,
                peakTps: match.peakTps || 0,
            });
            // 4. Relaunch — fresh ConfigStore + Gamification will read the
            //    restored values on init. Renderer will see the new state on
            //    next launch via the normal status-update flow.
            electron_1.app.relaunch();
            electron_1.app.exit(0);
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: err?.message ?? String(err) };
        }
    });
    // ─── Reset identity (the ONLY programmatic path to wipe accountKey + stats) ──
    // Called by the explicit "Reset identity" button in Settings, which shows
    // a confirmation dialog in the renderer first. Three things happen:
    //   1. Documents\MyKAI\identity.json is deleted (durable backup gone).
    //   2. accountKey + nodeId cleared from electron-store config.
    //   3. All lifetime gamification stats cleared from electron-store gam.
    //   4. App relaunches — fresh identity is generated on init.
    // PC cleaners and accidental %APPDATA% wipes will NOT trigger this path;
    // they wipe the same data but identity-restore picks it back up from
    // Documents on next launch. The user-driven reset is the only true reset.
    track('config:reset-identity', async () => {
        try {
            // Commit any pending writes before the wipe so we leave the
            // backup file in a clean state. The old keyed file is then NOT
            // deleted from Documents — it stays as a recovery record. User
            // can paste the old accountKey later to switch back. If they
            // truly want to burn it, they delete the file themselves from
            // the backup folder. (See identity-backup.ts header comment.)
            gamification.flush();
            gamification.resetAllStats();
            config.resetIdentityKeys();
            // Relaunch with no special args; fresh ConfigStore + Gamification
            // on init. The new accountKey will get its own
            // identity_acc_<newkey>.json file alongside any old ones.
            electron_1.app.relaunch();
            electron_1.app.exit(0);
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: err?.message ?? String(err) };
        }
    });
    track('clipboard:copy', (_event, text) => {
        electron_1.clipboard.writeText(text);
        return true;
    });
    // App metadata — used by the renderer to show the version in the title bar.
    // Reads from Electron's app.getVersion(), which reads package.json at build
    // time so it matches exactly what was packaged.
    track('app:version', () => electron_1.app.getVersion());
    // ─── Data directory management (picker + move) ─────────────────────────
    // Renderer calls drives:list to populate the picker; drives:choose-folder
    // for a custom location; data-dir:move to actually move the data. Main
    // owns the move because it needs to stop/start kaspad around it.
    track('drives:list', async () => {
        const { enumerateDrives } = await Promise.resolve().then(() => __importStar(require('./drives')));
        return await enumerateDrives();
    });
    track('drives:choose-folder', async (_event, defaultPath) => {
        const parent = electron_1.BrowserWindow.getFocusedWindow() || electron_1.BrowserWindow.getAllWindows()[0] || null;
        const result = await (parent
            ? (await Promise.resolve().then(() => __importStar(require('electron')))).dialog.showOpenDialog(parent, {
                title: 'Choose folder for Kaspa data',
                defaultPath,
                properties: ['openDirectory', 'createDirectory'],
            })
            : (await Promise.resolve().then(() => __importStar(require('electron')))).dialog.showOpenDialog({
                title: 'Choose folder for Kaspa data',
                defaultPath,
                properties: ['openDirectory', 'createDirectory'],
            }));
        if (result.canceled || !result.filePaths[0])
            return null;
        return result.filePaths[0];
    });
    track('data-dir:current', () => config.get('dataDir'));
    track('data-dir:move', async (_event, newDir) => {
        const { DataDirMover } = await Promise.resolve().then(() => __importStar(require('./data-dir-move')));
        const mover = new DataDirMover();
        mover.on('progress', (p) => {
            try {
                electron_1.BrowserWindow.getAllWindows()[0]?.webContents.send('data-dir:progress', p);
            }
            catch { /* ignore */ }
        });
        const oldDir = config.get('dataDir');
        // Persist the new dataDir inside the mover, between copy-success and the
        // old-dir delete. If the process is killed between the config write and
        // the rmSync, both directories exist and the config points to the new
        // one — no orphaned data.
        const result = await mover.move(oldDir, newDir, manager, (committed) => {
            config.setAll({ dataDir: committed });
        });
        if (result.ok) {
            // Restart kaspad from the new location
            try {
                await manager.start();
                monitor.start(() => manager.uptime);
            }
            catch { /* ignore */ }
        }
        return result;
    });
    // Build a markdown-formatted diagnostic report the user can paste into a
    // support channel. Assembled from all live sources + activity ring buffer,
    // with personal identifiers redacted.
    track('diagnostic:build', async () => {
        return await (0, diagnostic_1.buildDiagnosticReport)({
            manager, monitor, config, gamification, stratum, monitoring,
            agentBridge: opts?.agentBridge,
            kasmapRealtime: opts?.kasmapRealtime,
        });
    });
    // --- Update system ---
    track('update:check', () => updater.checkForUpdates());
    track('update:install-kaspad', () => updater.installKaspadUpdate());
    track('update:install-app', () => updater.installAppUpdate());
    track('update:dismiss', (_event, version) => updater.dismissUpdate(version));
    track('update:status', () => updater.getStatus());
    // --- Mining ---
    track('mining:start', async () => {
        try {
            if (manager.state !== 'synced' && monitor.status.state !== 'synced') {
                return { ok: false, error: 'Node must be synced before mining can start' };
            }
            const addr = config.get('miningAddress');
            if (!addr || !addr.startsWith('kaspa:')) {
                return { ok: false, error: 'Enter a valid Kaspa mining address in Settings' };
            }
            const bind = config.get('stratumBind') || 'localhost';
            // If miners need to reach us from LAN or beyond, open the firewall
            // for port 5555 first. User sees a confirm dialog + UAC. If they
            // decline, mining still starts — just no LAN access (localhost fine).
            if (bind === 'lan' || bind === 'all') {
                const mainWin = electron_1.BrowserWindow.getFocusedWindow() || electron_1.BrowserWindow.getAllWindows()[0] || null;
                await (0, firewall_1.requestOpenPort)(mainWin, firewall_1.FW_MINING, 'miners on your LAN');
            }
            stratum.updateConfig({
                bridgePath: config.getStratumBridgePath(),
                miningAddress: addr,
                stratumPort: config.get('stratumPort') || 5555,
                stratumBind: bind,
            });
            await stratum.start();
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: err.message };
        }
    });
    track('mining:stop', async () => {
        try {
            await stratum.stop();
            // If we had opened a firewall rule for LAN/all mining, remove it now.
            const bind = config.get('stratumBind') || 'localhost';
            if (bind === 'lan' || bind === 'all') {
                const mainWin = electron_1.BrowserWindow.getFocusedWindow() || electron_1.BrowserWindow.getAllWindows()[0] || null;
                await (0, firewall_1.requestRemovePort)(mainWin, firewall_1.FW_MINING.ruleName, 'miners on your LAN');
            }
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: err.message };
        }
    });
    track('mining:status', () => ({
        state: stratum.state,
        stats: stratum.stats,
        uptime: stratum.uptime,
    }));
    track('mining:logs', () => stratum.logs);
    track('mining:connection-urls', async () => {
        const port = config.get('stratumPort') || 5555;
        const lanIp = (0, network_utils_1.getLanIp)();
        const urls = {
            lan: (0, network_utils_1.getStratumUrl)(lanIp, port),
        };
        // Only fetch public IP if user explicitly enabled it
        const appConfig = config.getAll();
        if (appConfig.stratumBind === 'all') {
            const pubIp = await (0, network_utils_1.getPublicIp)();
            if (pubIp)
                urls.public = (0, network_utils_1.getStratumUrl)(pubIp, port);
        }
        return urls;
    });
    track('mining:validate-address', (_event, address) => {
        if (!address)
            return { valid: false, error: 'Address is required' };
        const network = config.get('network');
        const prefix = network === 'testnet' ? 'kaspatest:' : 'kaspa:';
        if (!address.startsWith(prefix)) {
            return { valid: false, error: `Address must start with '${prefix}'` };
        }
        if (address.length < 60 || address.length > 70) {
            return { valid: false, error: 'Address length looks incorrect' };
        }
        return { valid: true };
    });
    // --- Cloud node management (DISABLED in sovereign-fork v0.4) ---
    //
    // The v0.3.x flow generated a FluxCloud-specific mykai-monitor.sh script
    // that phoned home to https://mykai.dev/api/network/contribute. We don't
    // ship that script anymore and the cloud:status endpoint hit a remote
    // Supabase-backed registry. Both are anti-sovereign-ethos.
    //
    // We keep the IPC channels for backward-compat (renderer may still call
    // them), but they return disabled-state responses. Calling code in
    // renderer/app.js renderMyNodesTable handles empty cloudNodes already.
    track('cloud:generate-script', () => {
        return { ok: false, error: 'Cloud-node script generation is disabled in this sovereign-fork build. Cloud deployment is a separate concern; consider running MyKAI on your own server via reproducible builds.' };
    });
    track('cloud:account-key', () => config.getAccountKey());
    track('cloud:status', () => {
        // Always return empty cloud nodes — we don't phone home to discover them.
        return { ok: true, nodes: [] };
    });
}
//# sourceMappingURL=ipc-handlers.js.map