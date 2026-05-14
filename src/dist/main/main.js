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
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
// Process-wide safety net for "Object has been destroyed" errors that
// fire when long-lived sources (kaspad-manager log parser, setInterval
// callbacks, IPC handlers) keep emitting briefly after app.relaunch
// destroys the BrowserWindow. The wrapped webContents.send() catches
// most cases, but `mainWindow?.webContents.send(...)` evaluates
// `webContents` BEFORE the wrapper runs — and the getter on a
// destroyed window itself throws "Object has been destroyed".
//
// We can't fix every call site (50+ across main.ts + ipc-handlers).
// This handler swallows the specific destroy-time race silently. Real
// uncaught exceptions still crash as expected (we re-throw anything
// that doesn't match the destroy signature).
//
// Reported by Seb 28-04-2026: error dialog after Reset Identity hold;
// recurred even after the wrapper was added because the throw happens
// at the .webContents access, not inside .send().
process.on('uncaughtException', (err) => {
    const msg = err?.message ?? String(err);
    if (msg.includes('Object has been destroyed')) {
        // Late event from a source that didn't see the relaunch in time.
        // The process is already in shutdown; let it complete cleanly.
        return;
    }
    // Real uncaught — log and continue. We can't re-throw inside this
    // handler (risks recursion) and we can't restore Electron's default
    // dialog once we've registered a listener. Log to console + main
    // process stderr; severe issues will surface via session-log /
    // diagnostic on next launch anyway.
    console.error('[main] uncaught exception:', err);
});
// Import for side effect: loop-lag.ts enables the histogram on module load,
// so the percentile data is already warm by the time the first diagnostic
// runs. Not imported by value — consumers read via loop-lag.ts directly.
require("./loop-lag");
const kaspad_manager_1 = require("./kaspad-manager");
const rpc_monitor_1 = require("./rpc-monitor");
const config_store_1 = require("./config-store");
const gamification_1 = require("./gamification");
const kasmap_heartbeat_1 = require("./kasmap-heartbeat");
const monitoring_contributor_1 = require("./monitoring-contributor");
const agent_bridge_1 = require("./agent-bridge");
const kasmap_realtime_1 = require("./kasmap-realtime");
const ipc_handlers_1 = require("./ipc-handlers");
const updater_1 = require("./updater");
const stratum_manager_1 = require("./stratum-manager");
const clock_offset_1 = require("./clock-offset");
const host_specs_1 = require("./host-specs");
const activity_buffer_1 = require("./activity-buffer");
const perfStalls = __importStar(require("./perf-stalls"));
const cpu_profiler_1 = require("./cpu-profiler");
const system_load_1 = require("./system-load");
const health_checks_1 = require("./health-checks");
const diagnostic_payload_1 = require("./diagnostic-payload");
const diagnostic_1 = require("./diagnostic");
const network_info_1 = require("./network-info");
const disk_monitor_1 = require("./disk-monitor");
const dir_size_1 = require("./dir-size");
const session_log_1 = require("./session-log");
const perf_hot_1 = require("./perf-hot");
const fs_1 = __importDefault(require("fs"));
// v0.5: shard-storage module — optional archival contribution feature
const shard_storage_1 = require("./shard-storage");
let mainWindow = null;
let tray = null;
let isQuitting = false;
// v0.5: shard storage instance. Created in initialize() if user has
// shardSizeGB > 0. Null otherwise (feature off, pure Kaspa node behavior).
let shardStorage = null;
let shardPruneTimer = null;
let _loggedShardCaptureError = false;
let manager;
let monitor;
let config;
let gamification;
let kasmap;
let monitoring;
let agentBridge;
let kasmapRealtime;
let updater;
let stratum;
let diskMonitor = null;
// True when the disk monitor has auto-paused kaspad. We use this to know
// whether a later resume event should auto-start kaspad (only if WE paused
// it — user manual stops must not be auto-resumed).
let autoPausedForDisk = false;
// Start the perf-hot tracker if MYKAI_PERF_HOT env var is set. Off in
// packaged production builds; flip on locally for hot-path forensics.
// Must run BEFORE any of the wrapped handlers fire.
(0, perf_hot_1.startPerfDump)(30_000);
/** webContents.send wrapped to measure IPC marshalling time per channel.
 *  When MYKAI_PERF_HOT is set, this records under bucket `ipc.<channel>`;
 *  otherwise it's a thin pass-through with negligible overhead. */
function trackedSend(channel, ...args) {
    if (!mainWindow)
        return;
    if ((0, perf_hot_1.isPerfHotEnabled)()) {
        const mark = (0, perf_hot_1.startMark)();
        mainWindow.webContents.send(channel, ...args);
        (0, perf_hot_1.endMark)(`ipc.${channel}`, mark);
    }
    else {
        mainWindow.webContents.send(channel, ...args);
    }
}
/** User-friendly activity-feed wording for each diagnostic trigger.
 *
 *  Non-tech users found the previous "Sent diagnostic to help diagnose an
 *  issue (previous_session_clean)" line alarming on healthy restarts —
 *  the words "diagnose an issue" and the raw trigger name suggested
 *  something was wrong even when nothing was. This maps each trigger to
 *  gentler wording. `previous_session_clean` is suppressed entirely at
 *  the call site (returns null here as a defensive default in case it's
 *  ever invoked); the data still flows to Insights for support
 *  correlation, only the user-facing message is silenced.
 */
function activityMessageForTrigger(trigger) {
    switch (trigger) {
        case 'previous_session_unclean':
            return "Reporting last session's unexpected shutdown to support";
        case 'renderer_unresponsive':
        case 'main_event_loop_stalled':
        case 'event_loop_stalled':
            return 'Reporting a brief stall to support';
        case 'kaspad_crash_loop':
        case 'crashed_during_sync':
            return 'Reporting a kaspad crash to support';
        case 'prev_heartbeat_failed':
        case 'heartbeats_missed':
            return 'Retrying telemetry upload';
        default:
            return 'Sent diagnostic to support';
    }
}
function createWindow() {
    // Auto-launch detection: Windows passes --hidden via the login item we
    // registered. macOS has wasOpenedAtLogin as a backup.
    const autoLaunched = process.argv.includes('--hidden')
        || electron_1.app.getLoginItemSettings().wasOpenedAtLogin;
    mainWindow = new electron_1.BrowserWindow({
        width: 800,
        height: 700,
        minWidth: 480,
        minHeight: 500,
        frame: false,
        backgroundColor: '#0a0f1a',
        // Visible from creation on manual launch, hidden in tray on auto-launch.
        // This avoids the show:false + show() race that caused windows to
        // silently not appear on Windows.
        show: !autoLaunched,
        webPreferences: {
            preload: path_1.default.join(__dirname, '..', 'preload', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // Defense-in-depth: with the contextBridge already isolating the
            // renderer from Node, sandbox is the second layer that drops the
            // renderer's OS privileges (no fs, no child_process, no native modules)
            // even if a future bug were to leak something through. The preload
            // continues to run with `contextBridge` and `ipcRenderer` access —
            // those APIs are sandbox-safe.
            sandbox: true,
        },
    });
    const rendererPath = path_1.default.join(__dirname, '..', '..', 'src', 'renderer', 'index.html');
    mainWindow.loadFile(rendererPath);
    // Fixed font size via Chromium's native zoom — no user setting, no runtime
    // toggles. GPU-composited, negligible performance cost.
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow?.webContents.setZoomFactor(1.3);
        // Fire the first-run welcome modal IF this was a genuine first
        // launch (no electron-store identity AND no Documents backup).
        // ConfigStore tracks this transient flag and rotates it false on
        // first read, so the modal fires at most once per process.
        // Reinstalls that auto-restored from Documents skip this entirely
        // (the user is already authenticated to their cloud history).
        try {
            if (config.consumeFreshFirstRunFlag()) {
                // Small delay so the renderer has time to register listeners
                // (preload's contextBridge fires before did-finish-load, but
                // the renderer's app.js may still be wiring its event handlers).
                setTimeout(() => {
                    mainWindow?.webContents.send('firstRun:show-prompt');
                }, 500);
            }
        }
        catch (err) {
            console.error('[main] first-run prompt check failed:', err?.message);
        }
    });
    // Tap node:activity messages into a ring buffer used by the diagnostic
    // report builder. Transparent — doesn't affect any of the 20+ existing
    // webContents.send('node:activity', ...) call sites.
    //
    // Also guards against post-destroy sends. Multiple long-lived sources
    // (kaspad-manager log parser, 30s sync polling loop, RPC monitor
    // callbacks, etc.) keep emitting briefly after app.relaunch/exit
    // initiates shutdown — the BrowserWindow gets destroyed but the
    // process continues until all its event-loop work drains. Without
    // this guard those late events crash the dying process with
    // "TypeError: Object has been destroyed" before it actually exits
    // (reported by Seb 28-04-2026 right after a Reset identity hold —
    // visible as a JS error dialog overlaid on the relaunching app).
    // The optional-chaining `mainWindow?.webContents.send(...)` pattern
    // call sites use ISN'T enough — the reference is still truthy, the
    // underlying object is just destroyed.
    const originalSend = mainWindow.webContents.send.bind(mainWindow.webContents);
    mainWindow.webContents.send = (channel, ...args) => {
        if (channel === 'node:activity' && typeof args[0] === 'string') {
            (0, activity_buffer_1.recordActivity)(args[0]);
        }
        try {
            // isDestroyed() is on the BrowserWindow itself, not webContents,
            // but the latter has the same lifecycle. Either being destroyed
            // means send() will throw — bail out silently.
            if (mainWindow?.isDestroyed?.() || mainWindow?.webContents?.isDestroyed?.()) {
                return;
            }
            return originalSend(channel, ...args);
        }
        catch {
            // Defense-in-depth: if anything slips past the isDestroyed check
            // (e.g. window destroyed mid-call), eat the error. A late event
            // is never worth crashing the process over.
        }
    };
    mainWindow.on('close', (event) => {
        if (config.get('minimizeToTray') && tray && !isQuitting) {
            event.preventDefault();
            mainWindow?.hide();
        }
    });
    electron_1.ipcMain.on('window:minimize', () => mainWindow?.minimize());
    electron_1.ipcMain.on('window:maximize', () => {
        if (mainWindow?.isMaximized())
            mainWindow.unmaximize();
        else
            mainWindow?.maximize();
    });
    electron_1.ipcMain.on('window:close', () => mainWindow?.close());
    // shell:open-external accepts only https + mailto. The previous unrestricted
    // pass-through let any future XSS in the renderer (or any IPC misuse) ask
    // Electron to open file:// or javascript: URLs — the renderer doesn't need
    // any other scheme. Local folders go through shell:open-data-folder below,
    // which uses shell.openPath() (the correct API for directories).
    electron_1.ipcMain.handle('shell:open-external', async (_event, url) => {
        try {
            const u = new URL(url);
            if (u.protocol !== 'https:' && u.protocol !== 'mailto:') {
                return { ok: false, error: 'Unsupported scheme' };
            }
            await electron_1.shell.openExternal(url);
            return { ok: true };
        }
        catch {
            return { ok: false, error: 'Invalid URL' };
        }
    });
    // Open the kaspad data directory in the system file manager. Reads the
    // path from main-process config so the renderer never gets to hand-craft
    // a file:// URL — closes the path-concatenation hole that the previous
    // 'file://' + cfg.dataDir pattern in app.js created (spaces, #, % all
    // produce malformed URLs in shell.openExternal).
    electron_1.ipcMain.handle('shell:open-data-folder', async () => {
        const dir = config.get('dataDir');
        if (!dir || !fs_1.default.existsSync(dir))
            return { ok: false, error: 'Data dir not found' };
        const errMsg = await electron_1.shell.openPath(dir);
        if (errMsg)
            return { ok: false, error: errMsg };
        return { ok: true };
    });
    // Open Documents\MyKAI\ in the OS file explorer so the user can drag
    // identity.json to OneDrive / USB / etc. for offsite backup.
    // Creates the folder lazily if absent — first call after a fresh
    // install + before any heartbeat. Same pattern as shell:open-data-folder.
    electron_1.ipcMain.handle('shell:open-backup-folder', async () => {
        const { getBackupFolder } = await Promise.resolve().then(() => __importStar(require('./identity-backup')));
        const dir = getBackupFolder();
        try {
            if (!fs_1.default.existsSync(dir))
                fs_1.default.mkdirSync(dir, { recursive: true });
        }
        catch (err) {
            return { ok: false, error: `Could not create backup folder: ${err.message}` };
        }
        const errMsg = await electron_1.shell.openPath(dir);
        if (errMsg)
            return { ok: false, error: errMsg };
        return { ok: true };
    });
    // Elevated clock sync — triggers UAC prompt. Uses PowerShell's Start-Process
    // -Verb RunAs to request elevation; the actual w32tm commands run in an
    // invisible window. No CLI output is surfaced to the user.
    electron_1.ipcMain.handle('clock:fix-now', async () => {
        try {
            const { spawn } = await Promise.resolve().then(() => __importStar(require('child_process')));
            const ps = `$proc = Start-Process cmd -ArgumentList '/c w32tm /config /manualpeerlist:\\"time.windows.com,0x8 time.nist.gov,0x8 pool.ntp.org,0x8\\" /syncfromflags:manual /reliable:yes /update & net start w32time & w32tm /resync /force' -Verb RunAs -WindowStyle Hidden -PassThru -Wait; exit $proc.ExitCode`;
            return await new Promise((resolve) => {
                const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
                let stderr = '';
                child.stderr?.on('data', (d) => { stderr += d.toString(); });
                child.on('exit', (code) => {
                    if (code === 0) {
                        // Re-measure shortly after fix so the info/warning alert clears faster
                        setTimeout(() => { Promise.resolve().then(() => __importStar(require('./clock-offset'))).then(m => m.remeasureNow?.()).catch(() => { }); }, 3000);
                        resolve({ ok: true });
                    }
                    else {
                        // User likely clicked "No" on UAC (code 1223) or command failed
                        resolve({ ok: false, error: stderr || `exit ${code}` });
                    }
                });
                child.on('error', (err) => resolve({ ok: false, error: err.message }));
            });
        }
        catch (err) {
            return { ok: false, error: err.message };
        }
    });
}
function createTray() {
    const icon = electron_1.nativeImage.createFromBuffer(createTrayIcon('gray'));
    tray = new electron_1.Tray(icon);
    tray.setToolTip('MyKAI Node');
    updateTrayMenu();
    tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}
function updateTrayMenu() {
    if (!tray)
        return;
    const isRunning = manager.state !== 'stopped' && manager.state !== 'error';
    const contextMenu = electron_1.Menu.buildFromTemplate([
        { label: `MyKAI Node — ${manager.state}`, enabled: false },
        { type: 'separator' },
        {
            label: isRunning ? 'Stop Node' : 'Start Node',
            click: async () => {
                if (isRunning) {
                    monitor.stop();
                    await manager.stop();
                }
                else {
                    await manager.start();
                    monitor.start(() => manager.uptime);
                }
            },
        },
        { label: 'Open Window', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
        { type: 'separator' },
        { label: 'Quit', click: () => { electron_1.app.quit(); } },
    ]);
    tray.setContextMenu(contextMenu);
}
function updateTrayIcon(state) {
    if (!tray)
        return;
    let color = 'gray';
    if (state === 'synced')
        color = 'green';
    else if (state === 'syncing' || state === 'starting')
        color = 'amber';
    else if (state === 'error')
        color = 'red';
    tray.setImage(electron_1.nativeImage.createFromBuffer(createTrayIcon(color)));
}
function createTrayIcon(color) {
    const colors = {
        green: [73, 234, 203], amber: [255, 191, 0], gray: [128, 128, 128], red: [255, 80, 80],
    };
    const [r, g, b] = colors[color];
    const size = 16;
    const pixels = Buffer.alloc(size * size * 4);
    const cx = 7.5, cy = 7.5, radius = 6;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
            const idx = (y * size + x) * 4;
            if (dist <= radius) {
                pixels[idx] = r;
                pixels[idx + 1] = g;
                pixels[idx + 2] = b;
                pixels[idx + 3] = 255;
            }
            else {
                pixels[idx + 3] = 0;
            }
        }
    }
    return electron_1.nativeImage.createFromBuffer(pixels, { width: size, height: size }).toPNG();
}
function getHeartbeatData() {
    const status = monitor.status;
    const stats = gamification.current;
    return {
        nodeId: config.get('nodeId'),
        nodeName: 'Local Node',
        status: manager.state,
        daaScore: status.daaScore,
        kaspadVersion: status.serverVersion,
        isPublic: config.get('nodeVisibility') === 'public',
        uptimeSeconds: manager.uptime,
        blocksValidated: stats.blocksValidated,
        transactionsSeen: stats.transactionsSeen,
    };
}
async function initialize() {
    // Programmatic V8 CPU profiler — captures the entire startup freeze
    // window. Writes userData/startup.cpuprofile after 60 s. Open in Chrome
    // DevTools → Performance → Load profile to find the native-code time
    // sink that JS-level timing wrappers can't see (ws frame parsing,
    // permessage-deflate, V8 JIT, IPC marshalling). ~1-3% overhead.
    (0, cpu_profiler_1.startStartupProfile)(electron_1.app.getPath('userData'));
    config = new config_store_1.ConfigStore();
    const appConfig = config.getAll();
    // Session shutdown log — read prior session BEFORE writing the fresh
    // in-progress marker. The next heartbeat's pre-send hook will attach
    // either a previous_session_clean (graceful prior shutdown via before-quit)
    // or previous_session_unclean (force-kill / segfault / OOM / power loss)
    // Tier-2 trigger so Insights sees how every session ended.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const monitorVersionForSession = require('../../package.json').version;
    (0, session_log_1.initSessionLog)(monitorVersionForSession);
    // Kick off network info detection early — PowerShell spawn is ~200ms,
    // non-blocking. First heartbeat (5 min later) will have fresh data.
    (0, network_info_1.warmCache)();
    // Refresh every 10 min; adapters rarely change but users can plug in /
    // disconnect while the app runs.
    setInterval(() => { (0, network_info_1.warmCache)(); }, 10 * 60_000);
    // Disk monitor — auto-pauses kaspad when free space drops below 5 GB,
    // resumes at 10 GB. Protects against the fill-then-corrupt pattern that
    // leaves users stuck in UTXO-rebuild loops.
    // v0.4: storage mode passed so thresholds scale (pruned 5/10 GB,
    // retention 20/40 GB, archival 50/100 GB). DiskMonitor.setStorageMode()
    // can hot-update from ipc-handlers when mode changes.
    diskMonitor = new disk_monitor_1.DiskMonitor(appConfig.dataDir, appConfig.nodeStorageMode || 'pruned');
    diskMonitor.on('pause-needed', async (info) => {
        const freeGB = (info.freeBytes / 1_073_741_824).toFixed(1);
        mainWindow?.webContents.send('node:activity', `Your disk is almost full (${freeGB} GB free) — pausing your node to protect it`);
        autoPausedForDisk = true;
        try {
            await manager.stop();
        }
        catch { /* ignore */ }
    });
    diskMonitor.on('resume-ok', async (info) => {
        if (!autoPausedForDisk)
            return; // user manually stopped; don't auto-start
        const freeGB = (info.freeBytes / 1_073_741_824).toFixed(1);
        mainWindow?.webContents.send('node:activity', `Disk recovered (${freeGB} GB free) — resuming your node`);
        autoPausedForDisk = false;
        try {
            await manager.start();
            monitor.start(() => manager.uptime);
        }
        catch { /* ignore */ }
    });
    diskMonitor.start();
    // Pass ConfigStore so Gamification can look up the current accountKey
    // when mirroring lifetime stats to Documents\MyKAI\identity_acc_<key>.json.
    gamification = new gamification_1.Gamification(config);
    kasmap = new kasmap_heartbeat_1.KasMapHeartbeat(appConfig.kasmap);
    monitoring = new monitoring_contributor_1.MonitoringContributor({
        enabled: appConfig.contributeMonitoring,
        nodeId: appConfig.nodeId,
        accountKey: appConfig.accountKey,
        nodeName: 'Local Node',
        isPublic: appConfig.nodeVisibility === 'public',
        onAlerts: (alerts) => {
            mainWindow?.webContents.send('node:alerts', alerts);
        },
    });
    agentBridge = new agent_bridge_1.AgentBridge(17111);
    stratum = new stratum_manager_1.StratumManager({
        bridgePath: config.getStratumBridgePath(),
        miningAddress: appConfig.miningAddress,
        stratumPort: appConfig.stratumPort || 5555,
        stratumBind: appConfig.stratumBind || 'localhost',
    });
    kasmapRealtime = new kasmap_realtime_1.KasMapRealtime({
        enabled: appConfig.kasmap.enabled && !!appConfig.kasmap.token,
        token: appConfig.kasmap.token,
    });
    // Apply launch-on-startup setting. Pass --hidden so we can detect auto-launch
    // and start minimized to tray (instead of popping the window on every boot).
    electron_1.app.setLoginItemSettings({
        openAtLogin: appConfig.launchOnStartup !== false,
        args: ['--hidden'],
    });
    // Start clock offset detection (warns user if system clock is drifted)
    (0, clock_offset_1.startClockSync)((offsetMs) => {
        const secs = (Math.abs(offsetMs) / 1000).toFixed(1);
        const direction = offsetMs > 0 ? 'behind' : 'ahead of';
        mainWindow?.webContents.send('node:activity', `\u26a0\ufe0f System clock is ${secs}s ${direction} UTC \u2014 propagation times may be inaccurate`);
    });
    const isRemote = appConfig.nodeMode === 'remote' && appConfig.remoteUrl;
    manager = new kaspad_manager_1.KaspadManager({
        kaspadPath: config.getKaspadPath(),
        appDir: appConfig.dataDir,
        network: appConfig.network,
        borshPort: appConfig.borshPort,
        jsonPort: appConfig.jsonPort,
        outpeers: appConfig.outpeers,
        ramScale: appConfig.ramScale,
        utxoIndex: appConfig.utxoIndex,
        nodeVisibility: appConfig.nodeVisibility,
        // v0.4: storage mode threaded through to buildArgs() for --archival /
        // --retention-period-days kaspad flags. See config-store.js DEFAULTS.
        nodeStorageMode: appConfig.nodeStorageMode || 'pruned',
        retentionDays: appConfig.retentionDays || 0,
    });
    // In remote mode, parse the URL to get host and ports
    if (isRemote) {
        try {
            const remoteUrl = new URL(appConfig.remoteUrl);
            const remoteHost = remoteUrl.hostname;
            const remotePort = parseInt(remoteUrl.port, 10) || 17110;
            const remoteJsonPort = remotePort + 1000;
            monitor = new rpc_monitor_1.RpcMonitor(remoteJsonPort, remotePort, remoteHost);
        }
        catch {
            monitor = new rpc_monitor_1.RpcMonitor(appConfig.jsonPort, appConfig.borshPort);
        }
    }
    else {
        monitor = new rpc_monitor_1.RpcMonitor(appConfig.jsonPort, appConfig.borshPort);
    }
    // v0.5: initialize the shard-storage module IF user has opted in.
    // shardSizeGB == 0 means feature is off — pure Kaspa node, no module init,
    // no extra resource use, no behavior change from v0.3.x.
    // shardSizeGB > 0 means user wants to contribute that many GB to the
    // distributed archive. We start the module + periodic pruning.
    if (appConfig.shardSizeGB && appConfig.shardSizeGB > 0) {
        try {
            shardStorage = new shard_storage_1.ShardStorage(electron_1.app.getPath('userData'));
            shardStorage.on('log', (msg) => {
                mainWindow?.webContents.send('node:activity', `Shard: ${msg}`);
            });
            shardStorage.on('error', (info) => {
                mainWindow?.webContents.send('node:activity', `Shard ${info.stage} error: ${info.error}`);
            });
            await shardStorage.init();
            const stats = shardStorage.getStats();
            mainWindow?.webContents.send('node:activity',
                `Shard storage ready: ${stats.blockCount} blocks, ${(stats.totalBytes / 1024 / 1024).toFixed(1)} MB held, budget ${appConfig.shardSizeGB} GB`);
            // Periodic pruning to enforce disk budget. Cheap to call; pruneToFit
            // returns immediately when under budget. Run every 5 minutes.
            shardPruneTimer = setInterval(() => {
                if (!shardStorage) return;
                const budgetBytes = (appConfig.shardSizeGB || 0) * 1024 * 1024 * 1024;
                shardStorage.pruneToFit(budgetBytes);
            }, 5 * 60_000);
        }
        catch (err) {
            mainWindow?.webContents.send('node:activity',
                `Shard storage failed to init: ${err?.message || err}. Continuing without archival contribution.`);
            shardStorage = null;
        }
    }
    // Begin sampling CPU% every 5 s. Replaces `os.loadavg()[0]` which
    // is always 0 on Windows. Read by getSystemLoad() during diagnostic
    // build — gives us the aggregated "is the whole machine struggling
    // right now?" signal that we lacked all day on 2026-04-28.
    (0, system_load_1.startCpuTracking)();
    // Wire perf-stalls module — captures event-loop stalls > 100 ms, GC
    // pauses > 50 ms, rate divergences (poll vs event), slow store writes,
    // and BPS clamp fires. Always-on, writes to userData/perf-stalls.log.
    // The context provider gives the logger access to "what was kaspad
    // sending / what was the buffer state / what were the rates" at the
    // moment of the stall, so each entry is forensically complete.
    perfStalls.init(electron_1.app.getPath('userData'), () => ({
        recentActivity: (0, activity_buffer_1.getRecentActivity)(5),
        recentMethods: monitor?.recentMethods ?? [],
        bufferSizes: {
            ...(monitor?.bufferSizes ?? {}),
            _blockRate: manager?._blockRate?.length ?? 0,
            recentBlocks: monitoring?.buffer?.recentBlocks?.length ?? 0,
            blockFirstSeen: monitoring?.buffer?.blockFirstSeen?.length ?? 0,
            chainEvents: monitoring?.buffer?.chainEvents?.length ?? 0,
            propagationSamples: monitoring?.buffer?.propagationSamples?.length ?? 0,
            blockArrivalTimestamps: monitoring?.buffer?.blockArrivalTimestamps?.length ?? 0,
            minedBlocks: monitoring?.buffer?.minedBlocks?.length ?? 0,
        },
        socketBuffered: monitor?.socketBuffered ?? { rpc: 0, notify: 0 },
        rates: {
            poll: monitor?.getDaaBps?.(30_000) ?? 0,
            event: monitor?.getDaaEventBpsRaw?.(30_000) ?? 0,
            display: monitor?.getDaaEventBps?.(30_000) ?? 0,
        },
    }));
    // Periodic divergence check — every 10 s, compare poll vs event BPS.
    // If they disagree by more than 2 BPS during a 30 s window, log a
    // divergence entry to perf-stalls.log so we can see if the gap is
    // sustained vs a one-off sample-clustering artifact.
    setInterval(() => {
        if (!monitor)
            return;
        const poll = monitor.getDaaBps(30_000);
        const event = monitor.getDaaEventBpsRaw(30_000);
        const display = monitor.getDaaEventBps(30_000);
        if (poll > 0 && event > 0 && Math.abs(poll - event) > 2.0) {
            perfStalls.recordDivergence(poll, event, display);
        }
    }, 10_000);
    // --- Wire events ---
    // Manager state → monitor + tray + renderer + mining + kasmap.
    // Single consolidated handler — there used to be a duplicate
    // `manager.on('state-change', ...)` registered later in this function for
    // kasmap, which doubled dispatch cost on every state transition.
    manager.on('state-change', (state) => {
        monitor.setState(state);
        updateTrayIcon(state);
        updateTrayMenu();
        if (state === 'synced') {
            gamification.markSynced();
            // Belt-and-suspenders: if our log parser missed the rebuild-done line
            // but the node reached 'synced', the rebuild is definitely done.
            manager.markUtxoRebuildComplete();
        }
        // Crash-safety release of the UTXO wake lock. utxo-resync-done is the
        // happy path; if kaspad crashes mid-rebuild (state=error) or the user
        // hits Stop while it's running (state=stopped), 'utxo-resync-done' never
        // fires and the lock would leak across the rest of the session.
        if (state === 'stopped' || state === 'error') {
            releaseUtxoWakeLock();
        }
        const status = monitor.status;
        status.uptimeSeconds = manager.uptime;
        // Auto-start/stop mining based on kaspad state
        const miningCfg = config.getAll();
        if (state === 'synced' && miningCfg.miningEnabled && miningCfg.miningAddress && stratum.state === 'stopped') {
            stratum.start().catch(err => {
                mainWindow?.webContents.send('node:activity', `Mining failed to start: ${err.message}`);
            });
        }
        else if (state !== 'synced' && stratum.state !== 'stopped') {
            stratum.stop();
        }
        mainWindow?.webContents.send('node:status-update', status);
        mainWindow?.webContents.send('node:activity', `Node state: ${state}`);
        // KasMap Realtime: keep presence status in sync, connect on first synced.
        // The !isConnecting guard avoids a parallel connect() fired concurrently
        // by the 10-s tick below (which used to leak Supabase clients).
        if (kasmapRealtime.isConnected) {
            kasmapRealtime.updateStatus(state);
        }
        if (state === 'synced' && !kasmapRealtime.isConnected && !kasmapRealtime.isConnecting
            && config.get('kasmap').enabled && config.get('kasmap').token) {
            kasmapRealtime.connect(status.serverVersion || '1.0.1', status.daaScore || 0, status.peerCount || 0)
                .then((ok) => {
                if (ok) {
                    mainWindow?.webContents.send('node:activity', `Connected to KasMap Realtime as @${kasmapRealtime.kasmapName}`);
                }
                else {
                    reportKasMapFailure(kasmapRealtime);
                }
            })
                .catch(() => { });
        }
    });
    manager.on('sync-detail', (detail) => {
        monitor.setSyncDetail(detail);
        const status = monitor.status;
        status.uptimeSeconds = manager.uptime;
        mainWindow?.webContents.send('node:status-update', status);
    });
    manager.on('sync-progress', (progress) => { monitor.setSyncProgress(progress); });
    // Track the latest sync percentages so the 30s polling loop further down
    // can emit count-only updates without resetting the progress bar back
    // to 0%. kaspad-manager owns the percentages (parsed from kaspad logs);
    // we cache them here so the renderer always gets a coherent
    // {percent + count} payload regardless of which path fired the event.
    let _lastHeaderPct = 0;
    let _lastBlockPct = 0;
    manager.on('sync-phase', (phase) => {
        _lastHeaderPct = phase.headers;
        _lastBlockPct = phase.blocks;
        mainWindow?.webContents.send('node:sync-phase', {
            headers: phase.headers,
            blocks: phase.blocks,
            headersCount: monitor.status.headerCount || 0,
            blocksCount: monitor.status.blockCount || 0,
        });
    });
    manager.on('peer-count', (count) => {
        const __m = (0, perf_hot_1.startMark)();
        monitor.setManagerPeerCount(count);
        const status = monitor.status;
        status.uptimeSeconds = manager.uptime;
        mainWindow?.webContents.send('node:status-update', status);
        (0, perf_hot_1.endMark)('handler.peer-count', __m);
    });
    // Gamification events
    manager.on('blocks-accepted', (count) => {
        const __m = (0, perf_hot_1.startMark)();
        gamification.addBlocks(count);
        mainWindow?.webContents.send('gamification:stats-update', gamification.current);
        (0, perf_hot_1.endMark)('handler.blocks-accepted', __m);
    });
    manager.on('transactions-processed', (count) => {
        const __m = (0, perf_hot_1.startMark)();
        gamification.addTransactions(count);
        (0, perf_hot_1.endMark)('handler.transactions-processed', __m);
    });
    manager.on('tps-update', (tps) => {
        gamification.setTps(tps);
        mainWindow?.webContents.send('gamification:stats-update', gamification.current);
    });
    // UTXO resync progress + sleep-prevention.
    //
    // Real user scenario: laptop starts rebuild, user walks away, power-
    // management puts the laptop to sleep after idle, kaspad suspends mid-
    // write, wakes up in an inconsistent state, wipes and restarts the
    // rebuild. User comes back 8 hours later to find "0 progress".
    //
    // Fix: hold a 'prevent-app-suspension' power-save blocker during rebuild.
    // Display can still turn off (saves battery); app + timers stay running
    // so kaspad completes its rebuild. Released when rebuild finishes.
    let utxoWakeLockId = null;
    // Idempotent wake-lock release. Called from utxo-resync-done (happy path),
    // and now also from any kaspad state transition to 'stopped' or 'error' —
    // covers the crashed_during_sync case where a mid-rebuild kaspad crash
    // would otherwise leak the lock indefinitely (next rebuild's null-check
    // would skip acquiring a fresh one, leaving sleep prevention disabled).
    const releaseUtxoWakeLock = () => {
        if (utxoWakeLockId !== null) {
            try {
                electron_1.powerSaveBlocker.stop(utxoWakeLockId);
            }
            catch { /* ignore */ }
            utxoWakeLockId = null;
        }
    };
    manager.on('utxo-resync-start', async () => {
        const lastDuration = gamification.store?.get('lastUtxoResyncSeconds') || 0;
        // Compute dataSizeGB via the existing async walker — yields to the event
        // loop on every readdir/stat. The previous inline sync walk blocked the
        // main thread for 500ms-2s on a 30+ GB data dir, starving wRPC and IPC
        // exactly when the user was watching a sync-progress toast.
        let dataSizeGB = 0;
        try {
            const networkDir = path_1.default.join(config.get('dataDir'), `kaspa-${config.get('network')}`);
            if (fs_1.default.existsSync(networkDir)) {
                const total = await (0, dir_size_1.walkDirSizeFresh)(networkDir);
                dataSizeGB = Math.round(total / (1024 * 1024 * 1024));
            }
        }
        catch { }
        mainWindow?.webContents.send('node:utxo-resync', { phase: 'start', estimateSeconds: lastDuration, dataSizeGB });
        // Acquire wake lock for the rebuild duration — gated by user setting.
        // Default ON: most non-tech users benefit from the protection (prevents
        // laptop-sleep from restarting setup). Power users on laptops who
        // deliberately want sleep can turn it off in Settings.
        if (config.get('preventSleepDuringSetup') !== false) {
            try {
                if (utxoWakeLockId === null) {
                    utxoWakeLockId = electron_1.powerSaveBlocker.start('prevent-app-suspension');
                }
            }
            catch { /* ignore on platforms that don't support it */ }
        }
    });
    manager.on('utxo-resync-done', (durationSeconds) => {
        try {
            gamification.store?.set('lastUtxoResyncSeconds', durationSeconds);
        }
        catch { }
        mainWindow?.webContents.send('node:utxo-resync', { phase: 'done', actualSeconds: durationSeconds });
        mainWindow?.webContents.send('node:activity', `UTXO index rebuilt in ${Math.round(durationSeconds / 60)}m ${durationSeconds % 60}s`);
        // Release wake lock — normal power management resumes
        releaseUtxoWakeLock();
    });
    // Power-monitor events for visibility. We can't PREVENT sleep if the OS
    // forces it (e.g., user closes lid with Shut Down action), but we can log
    // it to the activity feed and handle wake events cleanly.
    electron_1.powerMonitor.on('suspend', () => {
        if (manager.state === 'syncing' || manager.state === 'starting') {
            mainWindow?.webContents.send('node:activity', '\u26a0\ufe0f System is going to sleep while your node is still setting up. Setup may restart from scratch.');
        }
        else {
            mainWindow?.webContents.send('node:activity', 'System going to sleep \u2014 node will resume on wake.');
        }
    });
    electron_1.powerMonitor.on('resume', () => {
        mainWindow?.webContents.send('node:activity', 'System resumed from sleep.');
    });
    // v0.4: pause-on-battery — amateur-safe default from research.
    // The single biggest amateur quit-trigger is "MyKAI drained my battery on a
    // flight." On battery, we stop kaspad cleanly; on AC, we resume.
    // User can override via Settings > Power (deferred to v0.5 UI).
    //
    // Persist the pause-reason in-memory only — we don't want a reboot to
    // miss the "was on battery" state. On startup we check power state in
    // the initialize() flow.
    let _autoPausedForBattery = false;
    const handleBatteryStateChange = async () => {
        try {
            const onBattery = electron_1.powerMonitor.isOnBatteryPower?.();
            if (onBattery && !_autoPausedForBattery && manager.state !== 'stopped') {
                _autoPausedForBattery = true;
                mainWindow?.webContents.send('node:activity', '🔋 On battery power — pausing kaspad to save battery. Will resume on AC.');
                await manager.stop();
            }
            else if (!onBattery && _autoPausedForBattery) {
                _autoPausedForBattery = false;
                mainWindow?.webContents.send('node:activity', '⚡ AC power detected — resuming kaspad.');
                await manager.start();
            }
        }
        catch (err) {
            // Don't crash on power-state probe failures (some Linux configs lack
            // the upower interface). Just log and skip — user can manually pause.
            console.warn('[battery] power state handler failed:', err?.message || err);
        }
    };
    electron_1.powerMonitor.on('on-battery', handleBatteryStateChange);
    electron_1.powerMonitor.on('on-ac', handleBatteryStateChange);
    // Initial check at startup so a user who launches on battery doesn't burn
    // through their charge before the first state-change fires.
    setTimeout(handleBatteryStateChange, 10_000);
    // --- Raw event relay → monitoring buffer (dumb pipe to Insights) ---
    // blockBatchStats removed — Insights derives from per-block parentCount + txCount
    // Red blocks from GHOSTDAG coloring — authoritative from kaspad's
    // blockAdded.verboseData.mergeSetRedsHashes. No more timing heuristics.
    monitor.on('red-block', (event) => {
        monitoring.buffer.redBlockEvents.push({
            hash: event.hash,
            acceptingBlockHash: event.acceptingBlockHash,
            timestamp: event.ts,
            networkState: {
                peerCount: monitor.status.peerCount || manager.peerCount,
                mempoolSize: monitor.status.mempoolSize || 0,
            },
        });
    });
    manager.on('propagation-orphan', (event) => {
        monitoring.buffer.propagationOrphans.push(event);
    });
    manager.on('peer-disconnect', () => {
        monitoring.buffer.disconnectTimestamps.push(Date.now());
    });
    monitor.on('tip-count', (count) => {
        monitoring.buffer.tipCountSamples.push(count);
    });
    monitor.on('propagation-sample', (delayMs) => {
        const __m = (0, perf_hot_1.startMark)();
        monitoring.buffer.propagationSamples.push(delayMs);
        monitoring.buffer.blockArrivalTimestamps.push(Date.now());
        // Cap unbounded array growth — a 1000-block peer-flood otherwise
        // pushes 1000 entries into each in one synchronous tick. Splice
        // oldest 500 when over 1000; mirrors the _daaEventSamples /
        // _blockAddedSamples pattern in rpc-monitor.ts.
        if (monitoring.buffer.propagationSamples.length > 1000)
            monitoring.buffer.propagationSamples.splice(0, 500);
        if (monitoring.buffer.blockArrivalTimestamps.length > 1000)
            monitoring.buffer.blockArrivalTimestamps.splice(0, 500);
        (0, perf_hot_1.endMark)('handler.propagation-sample', __m);
    });
    monitor.on('peer-details', (peers) => {
        const __m = (0, perf_hot_1.startMark)();
        monitoring.buffer.peerSnapshots = peers;
        (0, perf_hot_1.endMark)('handler.peer-details', __m);
    });
    monitor.on('sink-change', (event) => {
        monitoring.buffer.sinkChanges.push(event);
        // blockFirstSeen is handled by block-added (every block, not just sinks)
    });
    monitor.on('pruning-change', (event) => {
        monitoring.buffer.pruningEvents.push(event);
        mainWindow?.webContents.send('node:activity', `Pruning point advanced`);
    });
    // Finality conflict / resolved — captured for Insights only. No UI surface:
    // users would misinterpret it as a problem with their node or the network.
    monitor.on('finality-event', (event) => {
        monitoring.buffer.finalityEvents.push(event);
    });
    // chain-event tracks chain reorganizations (added/removed chain hashes) for
    // reorg analysis. Block first-seen timestamps come from block-added instead.
    monitor.on('chain-event', (event) => {
        const __m = (0, perf_hot_1.startMark)();
        monitoring.buffer.chainEvents.push(event);
        if (monitoring.buffer.chainEvents.length > 1000)
            monitoring.buffer.chainEvents.splice(0, 500);
        (0, perf_hot_1.endMark)('handler.chain-event', __m);
    });
    // Every block the node accepts — captured via notifyBlockAdded subscription.
    // Feeds Insights buffers for propagation analysis, chain walk, and miner data.
    // Also drives the 1-second activity-feed tick so "Validated N blocks" arrives
    // smoothly in real time (kaspad stdout is pipe-buffered so log-based counting
    // produced multi-second bursts).
    monitor.on('block-added', (block) => {
        const __m = (0, perf_hot_1.startMark)();
        monitoring.buffer.recentBlocks.push({
            hash: block.hash,
            selectedParentHash: block.selectedParentHash,
            blueScore: block.blueScore,
            parentCount: block.parentCount,
            // block.timestamp is block.header.timestamp (consensus-immutable
            // mining timestamp set by the miner). Captured here so the server
            // can compute settlement_latency = chain_event.ts − minedAt and
            // populate the blocks table via UPSERT (insights dev's data model).
            minedAt: typeof block.timestamp === 'number' && block.timestamp > 0 ? block.timestamp : undefined,
        });
        if (monitoring.buffer.recentBlocks.length > 1000)
            monitoring.buffer.recentBlocks.splice(0, 500);
        monitoring.buffer.blockFirstSeen.push({ hash: block.hash, ts: block.ts });
        if (monitoring.buffer.blockFirstSeen.length > 1000)
            monitoring.buffer.blockFirstSeen.splice(0, 500);
        // Activity feed counters — incremented per block as notifications arrive.
        // The wRPC block-added subscription may drop some blocks under heavy
        // backpressure, but it's the only reliable source: kaspad v1.1.0's
        // "Accepted N blocks" log line doesn't fire consistently enough on
        // startup to drive this counter (tried that approach — produced an
        // empty feed for the full first minute). Bursty-but-complete wRPC
        // counting beats a silent feed every time.
        manager._pendingBlocks += 1;
        manager._pendingTx += block.txCount || 0;
        // Timestamped sample for the rolling-window feed. Using the enqueue
        // wall-clock ts (not the tick time) keeps the displayed rate correct
        // even when the event loop stalls between emitter ticks — blocks that
        // arrived 200ms ago still land in the right 10-second bucket when the
        // emitter next wakes up.
        manager._blockRate.push({ ts: Date.now(), txCount: block.txCount || 0 });
        // Tighter cap (600/300) than the monitoring buffers because consumers
        // only look at the last 30 s window — 60 s of headroom is plenty.
        if (manager._blockRate.length > 600)
            manager._blockRate.splice(0, 300);
        // Receiving a blockAdded is definitive proof kaspad is past UTXO rebuild.
        // If our log-parser missed the transition line, this clears the stale
        // "Rebuilding UTXO index — X elapsed" toast that could otherwise persist
        // for hours while the node was actually fully operational.
        manager.markUtxoRebuildComplete();
        (0, perf_hot_1.endMark)('handler.block-added', __m);
    });
    // v0.5: shard-storage capture subscriber. Only fires when feature enabled
    // (shardStorage instance exists). Captures each block's full body from the
    // notification — no extra RPC call needed because the wRPC blockAdded
    // notification already contains block.transactions inline.
    //
    // Body is serialized as JSON for v0.5 MVP (sql.js can't store complex
    // objects directly). Migration to Borsh-encoded binary in v0.6 along with
    // native SQLite. JSON adds ~30% overhead vs Borsh — acceptable for now.
    monitor.on('block-added', (block) => {
        if (!shardStorage || !block.rawBlock) return;
        try {
            // Convert hex hash to 32-byte buffer for SQLite BLOB primary key.
            const hashBytes = Buffer.from(block.hash, 'hex');
            if (hashBytes.length !== 32) return; // malformed
            const bodyJson = Buffer.from(JSON.stringify(block.rawBlock), 'utf-8');
            shardStorage.captureBlock(hashBytes, block.daaScore || 0, bodyJson, true);
        }
        catch (err) {
            // Capture failures are non-fatal — kaspad still has the block,
            // we just don't shard it. Log once-per-error-type to avoid spam.
            if (!_loggedShardCaptureError) {
                _loggedShardCaptureError = true;
                mainWindow?.webContents.send('node:activity', `Shard capture error: ${err?.message || err} (further errors suppressed)`);
            }
        }
    });
    // Live TPS from subscription (replaces log-parsed TPS when available)
    monitor.on('tps-update', (tps) => {
        gamification.setTps(tps);
        mainWindow?.webContents.send('gamification:stats-update', gamification.current);
    });
    // --- Stratum (mining) events ---
    stratum.on('state-change', (state) => {
        mainWindow?.webContents.send('mining:status-update', { state, stats: stratum.stats, uptime: stratum.uptime });
        mainWindow?.webContents.send('node:activity', `Mining: ${state}`);
    });
    stratum.on('stats-update', (stats) => {
        mainWindow?.webContents.send('mining:status-update', { state: stratum.state, stats, uptime: stratum.uptime });
    });
    stratum.on('block-found', () => {
        gamification.addMiningBlock();
        mainWindow?.webContents.send('mining:block-found');
        mainWindow?.webContents.send('node:activity', 'Block found! Your miner earned KAS');
        mainWindow?.webContents.send('gamification:stats-update', gamification.current);
    });
    stratum.on('log', (line) => {
        mainWindow?.webContents.send('mining:log', line);
    });
    // KasMap Realtime state-change handling was merged into the single
    // consolidated `manager.on('state-change', ...)` listener above. Having a
    // second listener here doubled dispatch cost on every state transition.
    // Mined-block events feed the Insights monitoring buffer. Per-block KasMap
    // Realtime broadcasts were removed in 0.2.29: at 10 BPS × 86400 s, each
    // active node burned ~864K Supabase Broadcast Events per day (17% of Pro
    // plan quota per node, per day). KasMap's BlockDAG admin viewer and Globe
    // tx page both default to REST polling, so no user-visible feature depends
    // on this broadcast stream. Node presence still propagates via Realtime
    // presence tracking + KasMap heartbeat every 5 min.
    monitor.on('mined-block', (info) => {
        monitoring.buffer.minedBlocks.push(info);
        if (monitoring.buffer.minedBlocks.length > 1000)
            monitoring.buffer.minedBlocks.splice(0, 500);
    });
    // Watch-tx activity feed. Per-tx KasMap Realtime broadcasts were removed
    // in 0.2.29 — KasMap's Globe Transactions viewer uses 100ms REST polling
    // of /blocks as its primary source; the Realtime stream was purely additive
    // and dedup-filtered against the REST set.
    agentBridge.on('watch-tx', (txId) => {
        mainWindow?.webContents.send('node:activity', `Watching transaction: ${txId.substring(0, 12)}...`);
    });
    // Agent bridge events
    agentBridge.on('agent-connected', (name) => {
        mainWindow?.webContents.send('node:agent-status', { connected: true, name });
        mainWindow?.webContents.send('node:activity', `${name} connected`);
    });
    agentBridge.on('agent-disconnected', () => {
        mainWindow?.webContents.send('node:agent-status', { connected: false, name: '' });
        mainWindow?.webContents.send('node:activity', 'Agent disconnected');
    });
    agentBridge.on('tx-confirmed', (tx) => {
        mainWindow?.webContents.send('node:activity', `Your transaction confirmed ✓ ${tx.txId.substring(0, 12)}...`);
    });
    agentBridge.on('log', (msg) => {
        mainWindow?.webContents.send('node:activity', msg);
    });
    // Friendly activity feed (non-block messages only — block counts use dedicated 1s tick)
    manager.on('activity', (msg) => {
        mainWindow?.webContents.send('node:activity', msg);
    });
    // Rolling-window activity emitter. Window = 30s, emit cadence = 1s.
    //
    // Window widened from 10s to 30s (v0.3.3) because a 10s window over a
    // genuinely-bursty network produced visible swings (2-15 BPS readings
    // for a network rate of ~10 BPS), and the swings tripped alarming
    // "your node is catching up / processing backlog" suffixes for what is
    // really just network-rate variance. 30s smooths burstiness ~3× without
    // making the display unresponsive — a real catch-up is still visible
    // within ~30s, and steady-state stays steady.
    //
    // Samples carry their own wall-clock ts (pushed in the block-added
    // handler above), so a missed tick from an event-loop stall still
    // produces the correct rate on the next emit.
    //
    // Replaces the raw 1s drain that was turning clustered block arrivals
    // (wRPC backpressure, JSON.stringify pauses) into alarming "Validated
    // 142 new blocks" lines on a node actually keeping pace with the network
    // at 10 BPS. Network reference is Kaspa post-Crescendo at 10 BPS.
    const BLOCK_WINDOW_MS = 30_000;
    const BLOCK_FEED_EMIT_MS = 1_000;
    let feedState = null;
    let belowThresholdSince = 0; // ms since first sub-13 reading while in catching_up
    setInterval(() => {
        const __tickMark = (0, perf_hot_1.startMark)();
        const now = Date.now();
        const cutoff = now - BLOCK_WINDOW_MS;
        // Housekeeping prune of manager._blockRate — pushed by the block-added
        // listener earlier in this file. We no longer read it for the activity
        // feed (the user-facing line below uses event-based BPS), but other
        // consumers (gamification, etc.) may still read it, and an unpruned
        // array would grow without bound on a long-running synced node.
        const __pruneMark = (0, perf_hot_1.startMark)();
        while (manager._blockRate.length > 0 && manager._blockRate[0].ts < cutoff) {
            manager._blockRate.shift();
        }
        (0, perf_hot_1.endMark)('tick.activity-feed.pruneBlockRate', __pruneMark);
        // ─── User-facing activity-feed line ─────────────────────────────────
        // Sourced from kaspad's VirtualDaaScoreChanged notification stream:
        //   - DAA score increments by exactly 1 per network block accepted
        //     into the virtual chain (the chosen path through the DAG that
        //     gets applied to UTXO). Same value on every node — protocol-level
        //     "global clock" of confirmed network progress.
        //   - Notification fires at ~10–14 Hz (kaspad's virtual-processor
        //     batch flush rate), giving us ~100–140 samples in the 10s window —
        //     dense enough to wash out batch boundaries that produced visible
        //     5-second plateaus when sampled at the 1Hz getBlockDagInfo cadence.
        // Stays silent on cold start until at least 2 samples accumulate, so
        // the user doesn't see a confusing 0 BPS line for the first second.
        const __bpsMark = (0, perf_hot_1.startMark)();
        const networkBps = monitor.getDaaEventBps(BLOCK_WINDOW_MS);
        (0, perf_hot_1.endMark)('tick.activity-feed.getDaaEventBps', __bpsMark);
        if (networkBps <= 0) {
            (0, perf_hot_1.endMark)('tick.activity-feed.early-return', __tickMark);
            return;
        }
        // Chain-applied TPS from VirtualChainChanged.acceptedTransactionIds
        // (set by tps-update events into gamification). Matches the dashboard
        // "Current TPS" tile — counts only transactions that actually settle
        // to UTXO, not raw transactions in every accepted DAG block (which
        // overcount by ~2–3× the merge-set width).
        const networkTps = Math.round(gamification.current.currentTps || 0);
        // State machine update (see closure declaration above for thresholds
        // and rationale).
        if (networkBps > 20) {
            feedState = 'catching_up';
            belowThresholdSince = 0;
        }
        else if (networkBps < 13) {
            if (feedState === 'catching_up') {
                if (belowThresholdSince === 0)
                    belowThresholdSince = now;
                if (now - belowThresholdSince >= 5_000) {
                    feedState = 'steady';
                    belowThresholdSince = 0;
                }
            }
            else if (feedState === null) {
                // First reading is already steady-state — skip the catchup label.
                feedState = 'steady';
            }
        }
        else {
            // Gray zone (13–20): hold prior state. Reset the hysteresis timer
            // since we're not below threshold anymore.
            belowThresholdSince = 0;
        }
        // Compose the activity-feed line based on state.
        //
        // catching_up: raw rate is informative ("how fast is my node
        //   processing the backlog"), TPS is omitted because tx counts during
        //   catchup reflect blocks accumulated during the offline window
        //   rather than current network throughput.
        //
        // steady: existing wording with both BPS and TPS — neither catchup
        //   nor "your node is broken" suffix. The numbers themselves describe
        //   network state. Any genuine node-problem signal lives elsewhere
        //   (sync state, peer count, kaspad health checks).
        let activityLine;
        if (feedState === 'catching_up') {
            activityLine = `Catching up 😅 Processing ${networkBps.toFixed(1)} BPS`;
        }
        else {
            activityLine = `Settling ${networkBps.toFixed(1)} BPS (blocks/sec), ${networkTps.toLocaleString()} TPS (transactions/sec) confirmed`;
        }
        const __sendMark = (0, perf_hot_1.startMark)();
        mainWindow?.webContents.send('node:activity', activityLine);
        (0, perf_hot_1.endMark)('ipc.node:activity.bps-line', __sendMark);
        // The legacy "[event] Validating ~X BPS" A/B comparison line and the
        // BlockAdded-derived "Validating ~X BPS" line have been retired from
        // the activity feed — both metrics live on inside the diagnostic
        // report (developer view) under "RPC subscriptions / block-added emit
        // rate" and "Notify-socket raw message rate", where node operators
        // can still inspect them when debugging.
        (0, perf_hot_1.endMark)('tick.activity-feed', __tickMark);
    }, BLOCK_FEED_EMIT_MS);
    // 30s tick for sync progress — gives users visible proof-of-work during
    // long IBD / UTXO rebuild phases so they don't think the app is stuck.
    // Non-tech users reported "is something wrong?" when they watched the
    // "Running · Syncing…" screen for hours with no feedback. This emits an
    // activity line every 30s showing header/block progression.
    let _lastSyncHeader = 0;
    let _lastSyncBlock = 0;
    let _lastSyncDaa = 0;
    setInterval(() => {
        const s = monitor.status;
        const effectiveState = s.state || manager.state;
        if (effectiveState !== 'syncing' && effectiveState !== 'starting')
            return;
        const hc = s.headerCount || 0;
        const bc = s.blockCount || 0;
        const daa = s.daaScore || 0;
        // Skip if nothing advanced — no useful info to share, keeps feed quiet.
        if (hc === _lastSyncHeader && bc === _lastSyncBlock && daa === _lastSyncDaa) {
            return;
        }
        let msg = '';
        if (hc > 0 && bc > 0 && bc <= hc) {
            const pct = Math.round((bc / hc) * 100);
            const delta = bc - _lastSyncBlock;
            const deltaStr = delta > 0 ? ` (+${delta.toLocaleString()} in 30s)` : '';
            msg = `Syncing — ${bc.toLocaleString()} of ${hc.toLocaleString()} blocks validated (${pct}%)${deltaStr}`;
        }
        else if (hc > 0) {
            const delta = hc - _lastSyncHeader;
            const deltaStr = delta > 0 ? ` (+${delta.toLocaleString()} in 30s)` : '';
            msg = `Syncing headers — ${hc.toLocaleString()} downloaded${deltaStr}`;
        }
        if (msg)
            mainWindow?.webContents.send('node:activity', msg);
        // Emit a sync-phase update with counts so the progress bar can show
        // "1.2M downloaded" alongside the percent — even during kaspad's
        // pre-IBD phases when the percentage regex hasn't fired yet (kaspad
        // emits "IBD: Processed N block headers (X%)" only after pruning-
        // point negotiation finishes; users were seeing a static "0%" for
        // 5-30 minutes thinking the node was frozen).
        // _lastHeaderPct / _lastBlockPct cached above by the kaspad-manager
        // sync-phase handler — keeps the percentage at its highest seen
        // value while we update only the counts here.
        mainWindow?.webContents.send('node:sync-phase', {
            headers: _lastHeaderPct,
            blocks: _lastBlockPct,
            headersCount: hc,
            blocksCount: bc,
        });
        _lastSyncHeader = hc;
        _lastSyncBlock = bc;
        _lastSyncDaa = daa;
    }, 30000);
    // During UTXO index rebuild, tail the last distinct kaspad log line every
    // 60s into the activity feed. Users reported "it feels stuck" when they
    // watch "Rebuilding UTXO index" for hours with no change — this shows
    // kaspad IS working, one log line at a time. Rebuild can legitimately
    // take 1-2 h on fast SSDs, many hours on HDDs or after unclean shutdowns.
    let _lastEmittedUtxoLog = '';
    setInterval(() => {
        if (manager.utxoRebuildElapsedSec === 0)
            return;
        const logs = manager.recentLogLines;
        if (!logs.length)
            return;
        // Skip purely informational "Starting kaspad" / "Args:" lines from the
        // preamble — find the last meaningful one.
        for (let i = logs.length - 1; i >= 0; i--) {
            const line = logs[i].trim();
            if (!line)
                continue;
            if (line.startsWith('Starting kaspad') || line.startsWith('Args:'))
                continue;
            if (line === _lastEmittedUtxoLog)
                return; // nothing new
            _lastEmittedUtxoLog = line;
            mainWindow?.webContents.send('node:activity', `Rebuild: ${line.substring(0, 120)}`);
            return;
        }
    }, 60000);
    // ─── Health check state tracking ───────────────────────────────────────
    // zeroPeersSince / syncStalledSince are timestamps (Unix-ms) recording
    // when each condition was first observed this session. Reset to 0 when
    // the condition clears. runHealthChecks uses these + a min-duration
    // threshold to only flag REAL failures (not momentary blips).
    let zeroPeersSince = 0;
    let syncStalledSince = 0;
    let lastSyncAdvance = Date.now();
    let lastProgressKey = '';
    let lastHealthBroadcast = null;
    // Recompute + broadcast health every 10s. Cheap, deterministic, fires UI
    // updates as conditions change. Renderer gets the latest snapshot.
    setInterval(() => {
        const s = monitor.status;
        // Track zero-peer state
        const peers = s.peerCount || manager.peerCount || 0;
        if (peers === 0) {
            if (zeroPeersSince === 0)
                zeroPeersSince = Date.now();
        }
        else {
            zeroPeersSince = 0;
        }
        // Track sync stall: any advance in daaScore/headerCount/blockCount resets the stall timer.
        const progressKey = `${s.daaScore || 0}:${s.headerCount || 0}:${s.blockCount || 0}`;
        if (progressKey !== lastProgressKey) {
            lastProgressKey = progressKey;
            lastSyncAdvance = Date.now();
        }
        const state = s.state || manager.state;
        const SYNC_STALL_THRESHOLD_MS = 30 * 60_000;
        // Only flag sync-stall when NOT in UTXO rebuild. During rebuild, DAA
        // legitimately doesn't advance for hours — that's the rebuild working,
        // not a stall. The dedicated UTXO rebuild health check handles that state.
        const inUtxoRebuild = manager.utxoRebuildElapsedSec > 0;
        if (!inUtxoRebuild && (state === 'syncing' || state === 'starting') && Date.now() - lastSyncAdvance > SYNC_STALL_THRESHOLD_MS) {
            if (syncStalledSince === 0)
                syncStalledSince = lastSyncAdvance + SYNC_STALL_THRESHOLD_MS;
        }
        else {
            syncStalledSince = 0;
        }
        const snapshot = (0, health_checks_1.runHealthChecks)(buildHealthInputs());
        lastHealthBroadcast = snapshot;
        mainWindow?.webContents.send('node:health', snapshot);
    }, 10_000);
    // Helper — keeps the three runHealthChecks call sites in sync.
    function buildHealthInputs() {
        const kmConfig = config.get('kasmap');
        return {
            manager, monitor, zeroPeersSince, syncStalledSince, autoPausedForDisk,
            freeDiskBytes: diskMonitor?.lastFreeBytes || 0,
            kasmapEnabled: !!(kmConfig.enabled && kmConfig.token),
            kasmapCircuitOpen: kasmapRealtime.circuitOpen,
            kasmapLastError: kasmapRealtime.lastErrorReason,
        };
    }
    electron_1.ipcMain.handle('node:health', () => lastHealthBroadcast || (0, health_checks_1.runHealthChecks)(buildHealthInputs()));
    // User-initiated "Retry KasMap" action from the Health card.
    electron_1.ipcMain.handle('kasmap:retry', () => {
        kasmapRealtime.resetCircuit();
        return true;
    });
    // Raw kaspad logs are not sent to renderer — activity feed handles user-facing messages
    // RPC monitor diagnostics → activity feed
    monitor.on('activity', (msg) => {
        mainWindow?.webContents.send('node:activity', msg);
    });
    // rpc-monitor's getInfo poll is authoritative for isSynced. Propagate its
    // "synced" confirmation to kaspad-manager so the manager.state field
    // (which powers the diagnostic + "My Nodes" UI) doesn't stay stuck on
    // 'syncing' when kaspad v1.1.0 happens not to emit the 'via relay' log
    // phrase that the log-based state machine was waiting for.
    monitor.on('rpc-sync-confirmed', () => {
        manager.confirmSyncedFromRpc();
    });
    // RPC monitor status (throttled to max 1x/sec to avoid flooding renderer)
    let lastStatusSend = 0;
    monitor.on('status', (status) => {
        const __m = (0, perf_hot_1.startMark)();
        const now = Date.now();
        if (now - lastStatusSend < 1000) {
            (0, perf_hot_1.endMark)('handler.status.throttled', __m);
            return;
        }
        lastStatusSend = now;
        const __sendMark = (0, perf_hot_1.startMark)();
        mainWindow?.webContents.send('node:status-update', status);
        (0, perf_hot_1.endMark)('ipc.node:status-update', __sendMark);
        // Cache kaspad version for update system fallback
        if (status.serverVersion && status.serverVersion !== config.getLastKnownKaspadVersion()) {
            config.setLastKnownKaspadVersion(status.serverVersion);
        }
        (0, perf_hot_1.endMark)('handler.status', __m);
    });
    // Uptime tracking (every 10 seconds)
    setInterval(() => {
        if (manager.state !== 'stopped' && manager.state !== 'error') {
            gamification.updateUptime(manager.uptime);
            const newMilestones = gamification.pendingMilestones;
            for (const m of newMilestones) {
                mainWindow?.webContents.send('node:milestone', m);
                mainWindow?.webContents.send('node:activity', `Achievement unlocked: ${m.label}!`);
            }
            // Agent connection status from bridge
            mainWindow?.webContents.send('node:agent-status', {
                connected: agentBridge.isAgentConnected,
                name: agentBridge.agentName,
            });
            // KasMap Realtime: wall-clock JWT expiry check FIRST (defensive — catches
            // missed setTimeout refreshes across laptop sleep/resume). If the JWT is
            // stale-by-wall-clock, force a teardown so the reconnect below re-mints.
            if (kasmapRealtime.checkJwtAge()) {
                mainWindow?.webContents.send('node:activity', 'KasMap session expired — reconnecting');
            }
            // Auto-connect KasMap Realtime if synced but not connected.
            // The !isConnecting guard is critical — connect() can take longer than
            // this 10-s tick on flaky networks, and without it we'd fire parallel
            // connects that each leak a Supabase client + channel.
            // connect() also internally respects the backoff + circuit breaker so
            // repeated auth failures don't turn into a retry storm against KasMap.
            if ((manager.state === 'synced' || monitor.status.state === 'synced') && !kasmapRealtime.isConnected && !kasmapRealtime.isConnecting) {
                const kmConfig = config.get('kasmap');
                if (kmConfig.enabled && kmConfig.token) {
                    const status = monitor.status;
                    kasmapRealtime.connect(status.serverVersion || '1.0.1', status.daaScore || 0, status.peerCount || 0)
                        .then((ok) => {
                        if (ok) {
                            mainWindow?.webContents.send('node:activity', `Connected to KasMap Realtime as @${kasmapRealtime.kasmapName}`);
                        }
                        else {
                            reportKasMapFailure(kasmapRealtime);
                        }
                    })
                        .catch(() => { });
                }
            }
        }
    }, 10000);
    /**
     * Emit a user-facing activity line for each KasMap connect failure so the
     * activity feed and diagnostic dumps show WHY it's failing, not just that
     * it's offline. De-duplicates to keep the feed quiet.
     *
     * Two distinct reporting modes:
     *  - Circuit open: report ONCE with a "paused" message, then stay silent
     *    until the circuit transitions (Retry click or successful reconnect).
     *    The Health card carries ongoing visibility while open.
     *  - Circuit closed (backoff retries in progress): report each new
     *    (reason, attempt#) tuple once, so rising attempt counts show in the
     *    feed without flooding.
     *
     * The earlier version fell through from the circuit-open check to the
     * key-based path on subsequent calls once `lastKasMapErrorReported`
     * flipped off 'circuit-open', which produced a rapid alternation
     * between "paused" and "attempt 10, retry in 0s" messages every tick.
     */
    let lastKasMapErrorReported = null;
    function reportKasMapFailure(rt) {
        const s = rt.getStatus();
        if (s.circuitOpen) {
            // Emit once when we first detect open; stay quiet afterward.
            if (lastKasMapErrorReported !== 'circuit-open') {
                mainWindow?.webContents.send('node:activity', `KasMap Realtime unreachable — paused after ${s.consecutiveFailures} failures (last: ${s.lastErrorReason || 'unknown'}). Click Retry in Health card to try again.`);
                lastKasMapErrorReported = 'circuit-open';
            }
            return;
        }
        // Circuit is closed — normal backoff retries are running. Report each
        // new (reason, attempt) tuple once so the feed shows progression.
        const key = `${s.lastErrorReason || 'unknown'}:${s.consecutiveFailures}`;
        if (key !== lastKasMapErrorReported) {
            const waitSec = Math.round(s.nextRetryInMs / 1000);
            mainWindow?.webContents.send('node:activity', `KasMap Realtime: ${s.lastErrorReason || 'connect failed'} (attempt ${s.consecutiveFailures}, retry in ${waitSec}s)`);
            lastKasMapErrorReported = key;
        }
    }
    // Initialize update system
    updater = new updater_1.AppUpdater(config, manager);
    // Forward update events to renderer
    updater.on('kaspad-update-available', (info) => mainWindow?.webContents.send('update:kaspad-available', info));
    updater.on('kaspad-download-progress', (p) => mainWindow?.webContents.send('update:progress', p));
    updater.on('kaspad-install-step', (msg) => mainWindow?.webContents.send('update:step', msg));
    updater.on('kaspad-update-complete', (info) => {
        mainWindow?.webContents.send('update:kaspad-complete', info);
        mainWindow?.webContents.send('node:activity', `kaspad updated to v${info.version}`);
    });
    updater.on('app-update-available', (info) => mainWindow?.webContents.send('update:app-available', info));
    updater.on('app-download-progress', (p) => mainWindow?.webContents.send('update:app-progress', p));
    updater.on('app-update-downloaded', (info) => mainWindow?.webContents.send('update:app-downloaded', info));
    updater.on('error', (err) => mainWindow?.webContents.send('update:error', err.message));
    updater.on('state-change', (state) => mainWindow?.webContents.send('update:state', state));
    (0, ipc_handlers_1.registerIpcHandlers)(manager, monitor, config, gamification, kasmap, updater, stratum, monitoring, {
        getHeartbeatData,
        agentBridge,
        kasmapRealtime,
        // v0.4: pass diskMonitor so config:set can hot-update thresholds
        // when storage mode changes (pruned 5/10 GB → archival 50/100 GB etc.).
        diskMonitor,
    });
    // Runtime diagnostic — exposes main-process memory, per-emitter listener
    // counts, and long-lived connection state. Baked into the diagnostic
    // report so future leak reports surface the evidence directly.
    electron_1.ipcMain.handle('diagnostic:runtime', () => {
        const mem = process.memoryUsage();
        return {
            memory: {
                rss: mem.rss,
                heapUsed: mem.heapUsed,
                heapTotal: mem.heapTotal,
                external: mem.external,
            },
            listenerCounts: {
                managerStateChange: manager.listenerCount('state-change'),
                monitorBlockAdded: monitor.listenerCount('block-added'),
                monitorStatus: monitor.listenerCount('status'),
                monitorPeerDetails: monitor.listenerCount('peer-details'),
                agentBridgeWatchTx: agentBridge.listenerCount('watch-tx'),
                agentBridgeConnected: agentBridge.listenerCount('agent-connected'),
            },
            kasmap: {
                connected: kasmapRealtime.isConnected,
                connecting: kasmapRealtime.isConnecting,
            },
            uptimeSec: Math.floor(process.uptime()),
        };
    });
    createWindow();
    createTray();
    // Wire AgentBridge data providers BEFORE start() so the first GET
    // request after the server binds gets a valid response. Five GET
    // endpoints become available: /node-state, /recent-activity,
    // /diagnostic, /logs/perf-stalls, /logs/updater. The local AI
    // assistant pulls from these to answer "how's my node doing?"
    // without the user having to copy-paste anything. See
    // agent-bridge.ts comments for the full security model.
    agentBridge.setDataProviders({
        getNodeState: () => {
            const s = monitor?.status;
            return {
                appVersion: monitorVersionForSession,
                kaspadVersion: s?.serverVersion || 'unknown',
                state: manager?.state,
                syncProgress: s?.syncProgress ?? 0,
                syncDetail: s?.syncDetail || null,
                daaScore: s?.daaScore ?? 0,
                peersTotal: (monitor?.peersInbound ?? 0) + (monitor?.peersOutbound ?? 0),
                peersInbound: monitor?.peersInbound ?? 0,
                peersOutbound: monitor?.peersOutbound ?? 0,
                kaspadUptimeSec: Math.round((manager?.uptime ?? 0) / 1000),
                appUptimeSec: Math.round(process.uptime()),
                network: appConfig.network,
                nodeId: appConfig.nodeId || 'unknown',
                accountKey: appConfig.accountKey || 'unknown',
                bpsPoll: (() => { try {
                    return monitor.getDaaBps(30_000);
                }
                catch {
                    return 0;
                } })(),
                bpsEvent: (() => { try {
                    return monitor.getDaaEventBpsRaw(30_000);
                }
                catch {
                    return 0;
                } })(),
                bpsDisplay: (() => { try {
                    return monitor.getDaaEventBps(30_000);
                }
                catch {
                    return 0;
                } })(),
            };
        },
        getDiagnostic: () => (0, diagnostic_1.buildDiagnosticReport)({
            manager, monitor, config, gamification, stratum, monitoring,
            agentBridge,
            kasmapRealtime,
        }),
        getRecentActivity: (limit) => (0, activity_buffer_1.getRecentActivity)(limit),
        getLogPath: (name) => {
            return name === 'perf-stalls'
                ? require('path').join(electron_1.app.getPath('userData'), 'perf-stalls.log')
                : require('path').join(electron_1.app.getPath('userData'), 'updater.log');
        },
    });
    // Start agent bridge
    agentBridge.start();
    // Auto-start AFTER renderer is ready
    mainWindow?.webContents.once('did-finish-load', async () => {
        // Send initial gamification stats
        mainWindow?.webContents.send('gamification:stats-update', gamification.current);
        // Start update checker
        updater.checkOnStartup();
        // Show storage size in activity feed. Async/fresh so the cold cache
        // doesn't print "Storage: 0.0 B" at every startup — wait for the
        // background walk to finish (1-5 s) and emit the real number.
        config.getDataSizeFresh().then((dataSize) => {
            const network = appConfig.network || 'mainnet';
            if (dataSize) {
                mainWindow?.webContents.send('node:activity', `Storage: ${dataSize} (${network})`);
            }
        }).catch(() => { });
        if (appConfig.autoStart) {
            try {
                if (isRemote) {
                    mainWindow?.webContents.send('node:activity', `Connecting to remote node: ${appConfig.remoteUrl}`);
                    monitor.start(() => 0);
                    monitor.setState('syncing');
                }
                else {
                    // Pre-flight disk check — if user's data dir drive is below the
                    // recommended threshold, show a blocking dialog and DO NOT start
                    // kaspad. Prevents the "install, auto-start, crash with disk
                    // full 20 min later" scenario for users with low-free-space drives.
                    const freeBytes = (0, disk_monitor_1.getFreeBytes)(appConfig.dataDir);
                    const totalBytes = (0, disk_monitor_1.getTotalBytes)(appConfig.dataDir);
                    // Threshold: 40 GB. Kaspa typical ~30 GB, peaks ~100 GB, buffer for
                    // non-Kaspa growth on user's drive. Conservative but not paranoid.
                    const MIN_FREE_FOR_AUTOSTART_BYTES = 40 * 1024 * 1024 * 1024;
                    if (freeBytes > 0 && freeBytes < MIN_FREE_FOR_AUTOSTART_BYTES) {
                        const freeGB = (freeBytes / 1_073_741_824).toFixed(1);
                        const totalGB = totalBytes > 0 ? (totalBytes / 1_073_741_824).toFixed(0) : '?';
                        const { dialog } = await Promise.resolve().then(() => __importStar(require('electron')));
                        const result = await dialog.showMessageBox(mainWindow || undefined, {
                            type: 'warning',
                            buttons: ['Start anyway', 'Don\u2019t start', 'Check again'],
                            defaultId: 1,
                            cancelId: 1,
                            noLink: true,
                            title: 'Not enough free disk space',
                            message: `Your disk has only ${freeGB} GB free of ${totalGB} GB.`,
                            detail: `Kaspa typically needs 30 GB and can grow to 100+ GB during busy periods. ` +
                                `With less than 40 GB free, your node is likely to crash soon after starting.\n\n` +
                                `What you can do:\n` +
                                `\u2022 Free up space on this drive\n` +
                                `\u2022 Use an external USB 3.0+ SSD (500 GB recommended)\n` +
                                `\u2022 Or start anyway if you know what you\u2019re doing (MyKAI will pause Kaspa if it runs low)`,
                        });
                        if (result.response === 1) {
                            mainWindow?.webContents.send('node:activity', 'Node start blocked — not enough free disk space.');
                            // Mark as paused so user sees it in Health card and knows why
                            autoPausedForDisk = true;
                            diskMonitor?.setPausedExternally();
                            throw new Error('Insufficient disk space for auto-start');
                        }
                        if (result.response === 2) {
                            // "Check again" — the user may have just freed up space. Recheck.
                            const recheckFree = (0, disk_monitor_1.getFreeBytes)(appConfig.dataDir);
                            if (recheckFree < MIN_FREE_FOR_AUTOSTART_BYTES) {
                                mainWindow?.webContents.send('node:activity', 'Still not enough free space after recheck.');
                                autoPausedForDisk = true;
                                diskMonitor?.setPausedExternally();
                                throw new Error('Insufficient disk space for auto-start');
                            }
                            // Space freed; proceed with start
                        }
                        // response === 0 (Start anyway) falls through
                    }
                    mainWindow?.webContents.send('node:activity', 'Auto-starting kaspad...');
                    await manager.start();
                    monitor.start(() => manager.uptime);
                }
                mainWindow?.webContents.send('node:activity', 'kaspad started successfully');
                // Start heartbeats
                if (appConfig.kasmap.enabled && appConfig.kasmap.token) {
                    kasmap.start(getHeartbeatData);
                }
                if (appConfig.contributeMonitoring) {
                    // Rate-limit Tier-2 auto-diagnostic to once per hour per node.
                    let lastDiagnosticSentAt = 0;
                    monitoring.start(() => {
                        // Read-and-reset velocity counters per heartbeat
                        const daaScoreAdvances = monitor._daaScoreAdvances;
                        const sinkBlueScoreAdvances = monitor._sinkBlueScoreAdvances;
                        monitor._daaScoreAdvances = 0;
                        monitor._sinkBlueScoreAdvances = 0;
                        // ─── Pre-send hook: health + Tier 2 + Tier 3 ────────────────
                        // Runs once per heartbeat (5 min default). Stage quality hints
                        // and diagnostic (if triggered or requested) on the contributor
                        // so they get included in the outgoing payload.
                        try {
                            const health = lastHealthBroadcast || (0, health_checks_1.runHealthChecks)(buildHealthInputs());
                            monitoring.setNextQualityHints(health.qualityHints);
                            // Consent gate: T2 auto-attach and T3 server-pull both require
                            // the "Share error diagnostics" opt-in. T1 baseline (this
                            // heartbeat) still flows regardless via contributeMonitoring.
                            const diagnosticsAllowed = config.get('shareErrorDiagnostics') !== false;
                            const daaStaleMs = Date.now() - lastSyncAdvance;
                            const lastIpcFromRendererAt = (0, ipc_handlers_1.getLastIpcFromRendererAt)();
                            const trigger = diagnosticsAllowed ? (0, diagnostic_payload_1.shouldAttachDiagnostic)({
                                manager, monitor, health,
                                lastHeartbeatOk: monitoring.status.lastSendTime
                                    ? monitoring.status.lastSendOk : null,
                                heartbeatMissedCount: monitoring.status.heartbeatMisses,
                                daaScoreStaleMs: (monitor.status.state === 'synced' ? 0 : daaStaleMs),
                                utxoRebuildElapsedMs: manager.utxoRebuildElapsedSec * 1000,
                                systemRamFreeBytes: os_1.default.freemem(),
                                clockOffsetMs: Math.abs((0, clock_offset_1.getClockOffset)()),
                                autoPausedForDisk,
                                lastIpcFromRendererAt,
                                kasmapRealtime,
                            }) : null;
                            const now = Date.now();
                            // The previous_session_* triggers are one-shot reports of how
                            // the prior session ended — they bypass the per-hour rate limit
                            // because there's only one of them per session start. Other
                            // triggers stay rate-limited so a chronic condition (heartbeats
                            // missed, etc.) doesn't flood Insights.
                            const isPrevSessionTrigger = trigger === 'previous_session_clean'
                                || trigger === 'previous_session_unclean';
                            const rateLimitOk = isPrevSessionTrigger || (now - lastDiagnosticSentAt > 60 * 60_000);
                            // Tier 3 takes priority — server explicitly asked. Still
                            // requires the user to have opted in (diagnosticsAllowed); a
                            // pending request is silently dropped if they've disabled.
                            if (monitoring.isDiagnosticRequested && diagnosticsAllowed) {
                                monitoring.setNextDiagnostic(3, (0, diagnostic_payload_1.buildDiagnosticPayload)({
                                    manager, monitor, config, health,
                                    trigger: 'server_requested',
                                    processUptimeSec: process.uptime(),
                                    recentKaspadLogs: [...manager.recentLogLines],
                                    startupErrorReason: manager.startupErrorReason,
                                    kasmapRealtime, agentBridge, lastIpcFromRendererAt,
                                }));
                                monitoring.clearDiagnosticRequest();
                                lastDiagnosticSentAt = now;
                                mainWindow?.webContents.send('node:activity', 'Sent diagnostic to support (requested)');
                            }
                            else if (trigger && rateLimitOk) {
                                monitoring.setNextDiagnostic(2, (0, diagnostic_payload_1.buildDiagnosticPayload)({
                                    manager, monitor, config, health,
                                    trigger,
                                    processUptimeSec: process.uptime(),
                                    recentKaspadLogs: [...manager.recentLogLines],
                                    startupErrorReason: manager.startupErrorReason,
                                    kasmapRealtime, agentBridge, lastIpcFromRendererAt,
                                }));
                                // Don't bump the per-hour rate-limit clock for the one-shot
                                // previous_session report — it shouldn't suppress a real
                                // condition that fires later in this same session.
                                if (!isPrevSessionTrigger)
                                    lastDiagnosticSentAt = now;
                                // Mark the previous-session record as reported so the trigger
                                // doesn't fire again on subsequent heartbeats.
                                if (isPrevSessionTrigger)
                                    (0, session_log_1.markPreviousSessionReported)();
                                // Silent for `previous_session_clean` — graceful restarts
                                // are the common case and "Sent diagnostic to help diagnose
                                // an issue" alarmed non-tech users on healthy launches. The
                                // payload still flows to Insights for support correlation;
                                // only the activity-feed line is suppressed. Other triggers
                                // get the friendlier message from activityMessageForTrigger.
                                if (trigger !== 'previous_session_clean') {
                                    mainWindow?.webContents.send('node:activity', activityMessageForTrigger(trigger));
                                }
                            }
                            else if (monitoring.isDiagnosticRequested && !diagnosticsAllowed) {
                                // Consent is off but server asked — drop the request silently.
                                monitoring.clearDiagnosticRequest();
                            }
                        }
                        catch { /* never block heartbeat on pre-send hook errors */ }
                        const net = (0, network_info_1.getCachedNetworkInfo)();
                        return {
                            status: manager.state,
                            daaScore: monitor.status.daaScore,
                            headerCount: monitor.status.headerCount,
                            blockCount: monitor.status.blockCount,
                            startTimestamp: manager.startTimestamp,
                            nodeVersion: monitor.status.serverVersion,
                            networkType: net?.primary_type,
                            networkLinkSpeedMbps: net?.link_speed_mbps ?? null,
                            networkHasIpv6: net?.has_ipv6 || false,
                            peerCount: monitor.status.peerCount || manager.peerCount,
                            currentTps: Math.round(gamification.current.currentTps || 0),
                            mempoolSize: monitor.status.mempoolSize || 0,
                            network: monitor.status.networkName || 'mainnet',
                            sinkHash: monitor.status.sinkHash,
                            pruningPointHash: monitor.status.pruningPointHash,
                            // Blue-score snapshots for server-side finality / pruning
                            // computations: block_finality_passed = (sinkBlueScore −
                            // block.blueScore) > 432_000 ; block_pruning_passed =
                            // pruningPointBlueScore > block.blueScore.
                            sinkBlueScore: monitor._sinkBlueScore,
                            pruningPointBlueScore: monitor._pruningPointBlueScore,
                            clockOffsetMs: (0, clock_offset_1.getClockOffset)(),
                            storageBytes: config.getDataSizeBytes(),
                            ...(0, host_specs_1.getHostSpecs)(),
                            daaScoreAdvances,
                            sinkBlueScoreAdvances,
                            // Mining stats (per heartbeat cycle)
                            miningActive: stratum.state === 'running',
                            minerCount: stratum.stats.workers.length,
                            totalHashrateGhs: stratum.stats.totalHashrate,
                            blocksFound: stratum.blocksThisCycle,
                            rewardKas: stratum.rewardThisCycle,
                            // Lifetime gamification stats (cumulative). Read from the same
                            // store that backs the dashboard tiles ("BLOCKS VALIDATED",
                            // "TOTAL TIME ONLINE", etc.) so what the user sees locally is
                            // exactly what Insights aggregates cloud-side. Required for
                            // paste-accountKey recovery (Theme 5 of the 0.3.3 plan).
                            blocksValidated: gamification.current.blocksValidated || 0,
                            transactionsSeen: gamification.current.transactionsSeen || 0,
                            totalUptimeSeconds: gamification.current.totalUptimeSeconds || 0,
                            longestStreakSeconds: gamification.current.longestStreakSeconds || 0,
                            peakTps: gamification.current.peakTps || 0,
                            firstSyncCompleted: gamification.current.firstSyncCompleted || false,
                            sharesAccepted: gamification.current.sharesAccepted || 0,
                        };
                    });
                }
            }
            catch (err) {
                console.error('Auto-start failed:', err);
                mainWindow?.webContents.send('node:activity', `Auto-start failed: ${err.message}`);
            }
        }
    });
}
const gotLock = electron_1.app.requestSingleInstanceLock();
if (!gotLock) {
    electron_1.app.quit();
}
else {
    electron_1.app.on('second-instance', (_event, argv) => {
        // Update the tooltip so we can tell the second-instance path was taken
        if (tray) {
            const argsPreview = argv.map(a => a.replace(/.*[\\/]/, '')).slice(0, 5).join(' ');
            tray.setToolTip(`MyKAI Node — 2nd instance\nargs: ${argsPreview}`);
        }
        if (mainWindow) {
            if (mainWindow.isMinimized())
                mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });
    electron_1.app.whenReady().then(initialize);
    electron_1.app.on('before-quit', async (event) => {
        if (isQuitting)
            return;
        isQuitting = true;
        event.preventDefault();
        // Mark the session log as cleanly ended FIRST. If anything below throws
        // and the process exits abnormally, the file still records the user's
        // intent to shut down — Insights can distinguish "user clicked quit then
        // shutdown hung" from "process was force-killed mid-run".
        try {
            (0, session_log_1.recordSessionEnd)('before-quit');
        }
        catch { /* ignore */ }
        // Flush the startup CPU profile if it's still running (user closed
        // before the 60 s timer fired). The post-Profiler.stop callback is
        // async, but we await it via promise so the file lands before
        // app.exit(0) below — otherwise the inspector teardown races the
        // process exit and the profile JSON never reaches disk.
        if ((0, cpu_profiler_1.isProfilingActive)()) {
            await new Promise((resolve) => {
                (0, cpu_profiler_1.stopStartupProfile)(electron_1.app.getPath('userData'), () => resolve());
            });
        }
        // Stop stratum first (depends on kaspad)
        try {
            await stratum.stop();
        }
        catch { }
        (0, clock_offset_1.stopClockSync)();
        kasmapRealtime.disconnect();
        agentBridge.stop();
        monitoring.stop();
        kasmap.stop();
        monitor.stop();
        // Flush any pending debounced counter updates to disk before we exit.
        try {
            gamification.flush();
        }
        catch { }
        try {
            await manager.stop();
        }
        catch { /* ignore */ }
        // v0.5: shard storage cleanup — persist pending writes and close DB.
        if (shardPruneTimer) {
            clearInterval(shardPruneTimer);
            shardPruneTimer = null;
        }
        if (shardStorage) {
            try {
                shardStorage.close();
            }
            catch { /* ignore */ }
            shardStorage = null;
        }
        electron_1.app.exit(0);
    });
    electron_1.app.on('window-all-closed', () => { });
}
//# sourceMappingURL=main.js.map