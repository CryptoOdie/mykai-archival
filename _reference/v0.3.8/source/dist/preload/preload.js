"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('mykai', {
    node: {
        start: () => electron_1.ipcRenderer.invoke('node:start'),
        stop: () => electron_1.ipcRenderer.invoke('node:stop'),
        restart: () => electron_1.ipcRenderer.invoke('node:restart'),
        status: () => electron_1.ipcRenderer.invoke('node:status'),
        health: () => electron_1.ipcRenderer.invoke('node:health'),
        /** Stops kaspad, deletes the entire kaspa chain data folder
         *  (~37 GB), restarts kaspad on a fresh sync. Preserves identity.
         *  Renderer should show a 5-sec hold-to-confirm BEFORE calling
         *  this — irreversible, costs 2-4 hours of resync. */
        resetChainData: () => electron_1.ipcRenderer.invoke('node:reset-chain-data'),
        onStatusUpdate: (cb) => { electron_1.ipcRenderer.on('node:status-update', (_e, s) => cb(s)); },
        onHealth: (cb) => { electron_1.ipcRenderer.on('node:health', (_e, h) => cb(h)); },
        onActivity: (cb) => { electron_1.ipcRenderer.on('node:activity', (_e, msg) => cb(msg)); },
        onMilestone: (cb) => { electron_1.ipcRenderer.on('node:milestone', (_e, m) => cb(m)); },
        onSyncPhase: (cb) => { electron_1.ipcRenderer.on('node:sync-phase', (_e, phase) => cb(phase)); },
        onUtxoResync: (cb) => { electron_1.ipcRenderer.on('node:utxo-resync', (_e, data) => cb(data)); },
        onAlerts: (cb) => { electron_1.ipcRenderer.on('node:alerts', (_e, alerts) => cb(alerts)); },
    },
    gamification: {
        stats: () => electron_1.ipcRenderer.invoke('gamification:stats'),
        milestones: () => electron_1.ipcRenderer.invoke('gamification:milestones'),
        onStatsUpdate: (cb) => { electron_1.ipcRenderer.on('gamification:stats-update', (_e, s) => cb(s)); },
    },
    finality: {
        stats: () => electron_1.ipcRenderer.invoke('finality:stats'),
        onUpdate: (cb) => { electron_1.ipcRenderer.on('node:finality-stats', (_e, s) => cb(s)); },
        onChainFlip: (cb) => { electron_1.ipcRenderer.on('node:chain-flip', (_e, f) => cb(f)); },
    },
    health: {
        agentStatus: () => electron_1.ipcRenderer.invoke('health:agent-status'),
        onAgentStatus: (cb) => { electron_1.ipcRenderer.on('node:agent-status', (_e, s) => cb(s)); },
    },
    kasmap: {
        status: () => electron_1.ipcRenderer.invoke('kasmap:status'),
        verify: (token) => electron_1.ipcRenderer.invoke('kasmap:verify', token),
        retry: () => electron_1.ipcRenderer.invoke('kasmap:retry'),
    },
    config: {
        get: () => electron_1.ipcRenderer.invoke('config:get'),
        set: (updates) => electron_1.ipcRenderer.invoke('config:set', updates),
        hasExistingData: () => electron_1.ipcRenderer.invoke('config:hasExistingData'),
        dataSize: () => electron_1.ipcRenderer.invoke('config:dataSize'),
        /** Wipe accountKey + nodeId + all lifetime stats from electron-store
         *  AND Documents\MyKAI\identity.json, then relaunch the app for a
         *  fresh identity. The renderer should show a confirmation dialog
         *  BEFORE calling this — it's irreversible. */
        resetIdentity: () => electron_1.ipcRenderer.invoke('config:reset-identity'),
    },
    recovery: {
        /** Look up nodes by accountKey or nodeId. Returns
         *  { ok: true, matches: [...] } or { ok: false, code, error }.
         *  Code is one of 'invalid-format' | 'network' | 'http' | 'parse'
         *  | 'timeout' | 'unknown' — the renderer can pick a friendlier
         *  message per code. */
        lookup: (key) => electron_1.ipcRenderer.invoke('recovery:lookup', key),
        /** Apply a chosen RecoveryMatch — restore accountKey + nodeId +
         *  stat snapshot to local stores, then relaunch the app. The
         *  match payload should be one entry from the lookup() result's
         *  matches array. */
        apply: (match) => electron_1.ipcRenderer.invoke('recovery:apply', match),
    },
    firstRun: {
        /** Subscribe to the first-run prompt event. Fires once shortly
         *  after the renderer mounts IF the main process detected this is
         *  a genuine first launch (electron-store had no accountKey AND
         *  Documents\MyKAI\identity.json didn't exist). Reinstalls that
         *  auto-restored from Documents will not fire this event. */
        onPrompt: (cb) => { electron_1.ipcRenderer.on('firstRun:show-prompt', () => cb()); },
    },
    drives: {
        list: () => electron_1.ipcRenderer.invoke('drives:list'),
        chooseFolder: (defaultPath) => electron_1.ipcRenderer.invoke('drives:choose-folder', defaultPath),
    },
    dataDir: {
        current: () => electron_1.ipcRenderer.invoke('data-dir:current'),
        move: (newDir) => electron_1.ipcRenderer.invoke('data-dir:move', newDir),
        onProgress: (cb) => { electron_1.ipcRenderer.on('data-dir:progress', (_e, p) => cb(p)); },
    },
    update: {
        check: () => electron_1.ipcRenderer.invoke('update:check'),
        installKaspad: () => electron_1.ipcRenderer.invoke('update:install-kaspad'),
        installApp: () => electron_1.ipcRenderer.invoke('update:install-app'),
        dismiss: (version) => electron_1.ipcRenderer.invoke('update:dismiss', version),
        status: () => electron_1.ipcRenderer.invoke('update:status'),
        onKaspadAvailable: (cb) => { electron_1.ipcRenderer.on('update:kaspad-available', (_e, info) => cb(info)); },
        onAppAvailable: (cb) => { electron_1.ipcRenderer.on('update:app-available', (_e, info) => cb(info)); },
        onAppDownloaded: (cb) => { electron_1.ipcRenderer.on('update:app-downloaded', (_e, info) => cb(info)); },
        onProgress: (cb) => { electron_1.ipcRenderer.on('update:progress', (_e, p) => cb(p)); },
        onAppProgress: (cb) => { electron_1.ipcRenderer.on('update:app-progress', (_e, p) => cb(p)); },
        onStep: (cb) => { electron_1.ipcRenderer.on('update:step', (_e, msg) => cb(msg)); },
        onComplete: (cb) => { electron_1.ipcRenderer.on('update:kaspad-complete', (_e, info) => cb(info)); },
        onError: (cb) => { electron_1.ipcRenderer.on('update:error', (_e, msg) => cb(msg)); },
        onState: (cb) => { electron_1.ipcRenderer.on('update:state', (_e, state) => cb(state)); },
    },
    clipboard: {
        copy: (text) => electron_1.ipcRenderer.invoke('clipboard:copy', text),
    },
    diagnostic: {
        build: () => electron_1.ipcRenderer.invoke('diagnostic:build'),
    },
    clock: {
        fixNow: () => electron_1.ipcRenderer.invoke('clock:fix-now'),
    },
    mining: {
        start: () => electron_1.ipcRenderer.invoke('mining:start'),
        stop: () => electron_1.ipcRenderer.invoke('mining:stop'),
        status: () => electron_1.ipcRenderer.invoke('mining:status'),
        logs: () => electron_1.ipcRenderer.invoke('mining:logs'),
        connectionUrls: () => electron_1.ipcRenderer.invoke('mining:connection-urls'),
        validateAddress: (addr) => electron_1.ipcRenderer.invoke('mining:validate-address', addr),
        onStatusUpdate: (cb) => { electron_1.ipcRenderer.on('mining:status-update', (_e, s) => cb(s)); },
        onLog: (cb) => { electron_1.ipcRenderer.on('mining:log', (_e, l) => cb(l)); },
        onBlockFound: (cb) => { electron_1.ipcRenderer.on('mining:block-found', () => cb()); },
    },
    cloud: {
        generateScript: () => electron_1.ipcRenderer.invoke('cloud:generate-script'),
        accountKey: () => electron_1.ipcRenderer.invoke('cloud:account-key'),
        status: () => electron_1.ipcRenderer.invoke('cloud:status'),
    },
    shell: {
        openExternal: (url) => electron_1.ipcRenderer.invoke('shell:open-external', url),
        openDataFolder: () => electron_1.ipcRenderer.invoke('shell:open-data-folder'),
        /** Opens Documents\MyKAI\ in the OS file explorer so users can drag
         *  identity.json to OneDrive / USB / etc. for offsite backup.
         *  Creates the folder lazily if absent. */
        openBackupFolder: () => electron_1.ipcRenderer.invoke('shell:open-backup-folder'),
    },
    app: {
        version: () => electron_1.ipcRenderer.invoke('app:version'),
    },
    window: {
        minimize: () => electron_1.ipcRenderer.send('window:minimize'),
        maximize: () => electron_1.ipcRenderer.send('window:maximize'),
        close: () => electron_1.ipcRenderer.send('window:close'),
    },
});
//# sourceMappingURL=preload.js.map