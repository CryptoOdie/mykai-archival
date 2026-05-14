"use strict";
/**
 * Disk space monitor for auto-pause / auto-resume.
 *
 * Prevents the scenario where kaspad writes until the disk fills up,
 * then crashes mid-write, often corrupting the UTXO index and leaving
 * the user stuck in a rebuild loop.
 *
 * State machine with hysteresis (prevents flapping around the threshold):
 *
 *   ┌──────────────┐   free < 5GB    ┌──────────────┐
 *   │     OK       │ ──────────────→ │   PAUSED     │
 *   │ kaspad runs  │                 │ kaspad stopped│
 *   └──────────────┘ ←────────────── └──────────────┘
 *                       free > 10GB
 *
 * Checks every 5 minutes (same cadence as heartbeats — disk doesn't
 * change meaningfully faster than that; 60s would be wasteful).
 *
 * On pause: calls manager.stop() for clean kaspad shutdown (SIGTERM,
 * 15s grace, DB flushed cleanly). This matters — a hard-kill from ENOSPC
 * leaves UTXO index in unknown state and triggers rebuild on next start.
 *
 * On resume: calls manager.start() as if user had clicked Start. If the
 * user has manually stopped the node (e.g., via "Stop Node" button in
 * Settings), the `autoPausedForDisk` flag is cleared and we don't auto-
 * resume. User intent always wins.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiskMonitor = void 0;
exports.getFreeBytes = getFreeBytes;
exports.getTotalBytes = getTotalBytes;
const fs_1 = __importDefault(require("fs"));
const events_1 = require("events");
// v0.4: thresholds scale with storage mode. Pruned needs ~30 GB headroom;
// archival can write tens of GB in burst during pruning-point advance.
// Pause threshold is the floor (below this we stop kaspad); resume threshold
// adds hysteresis to prevent flapping.
const THRESHOLDS_BY_MODE = {
    pruned:    { pauseGB: 5,  resumeGB: 10 },
    retention: { pauseGB: 20, resumeGB: 40 },
    archival:  { pauseGB: 50, resumeGB: 100 },
};
const GB = 1024 * 1024 * 1024;
const CHECK_INTERVAL_MS = 5 * 60_000; // 5 minutes
class DiskMonitor extends events_1.EventEmitter {
    dataDir;
    storageMode;
    timer = null;
    _state = 'ok';
    _lastFreeBytes = 0;
    _lastCheckAt = 0;
    constructor(dataDir, storageMode = 'pruned') {
        super();
        this.dataDir = dataDir;
        this.storageMode = storageMode;
    }
    /** Hot-update storage mode without restarting the monitor.
     *  Called from ipc-handlers.js::config:set when nodeStorageMode changes. */
    setStorageMode(mode) {
        const valid = ['pruned', 'retention', 'archival'];
        if (valid.includes(mode)) {
            this.storageMode = mode;
        }
    }
    /** Current pause/resume thresholds for the active storage mode. */
    getThresholds() {
        const t = THRESHOLDS_BY_MODE[this.storageMode] || THRESHOLDS_BY_MODE.pruned;
        return { pauseBytes: t.pauseGB * GB, resumeBytes: t.resumeGB * GB };
    }
    /** Current free-bytes snapshot (from the most recent check). */
    get lastFreeBytes() { return this._lastFreeBytes; }
    /** Current auto-pause state. */
    get state() { return this._state; }
    /** External override: mark as paused (e.g., when auto-paused by app on startup). */
    setPausedExternally() {
        this._state = 'paused';
    }
    /**
     * Called externally when user manually resumes or the node otherwise
     * leaves the paused state. Sets internal state to 'ok' so we don't
     * double-pause on the next tick.
     */
    setOkExternally() {
        this._state = 'ok';
    }
    /** Start periodic monitoring. Fires first check immediately. */
    start() {
        this.stop();
        this.check(); // immediate
        this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    /** Force an immediate check (e.g., after user frees up space). */
    checkNow() {
        this.check();
        return this._lastFreeBytes;
    }
    check() {
        const free = getFreeBytes(this.dataDir);
        this._lastFreeBytes = free;
        this._lastCheckAt = Date.now();
        if (free <= 0)
            return; // couldn't read; don't act on bad data
        const { pauseBytes, resumeBytes } = this.getThresholds();
        if (this._state === 'ok' && free < pauseBytes) {
            this._state = 'paused';
            this.emit('pause-needed', { freeBytes: free, thresholdBytes: pauseBytes, storageMode: this.storageMode });
        }
        else if (this._state === 'paused' && free > resumeBytes) {
            this._state = 'ok';
            this.emit('resume-ok', { freeBytes: free, storageMode: this.storageMode });
        }
    }
}
exports.DiskMonitor = DiskMonitor;
/**
 * Read free bytes on the filesystem containing `path`.
 * Node 18+ provides fs.statfsSync which returns block counts;
 * free bytes = bavail * bsize. Returns 0 on error.
 */
function getFreeBytes(path) {
    try {
        // statfsSync added in Node 18.15
        // @ts-ignore — types are on Node 18+
        const stats = fs_1.default.statfsSync(path);
        return stats.bavail * stats.bsize;
    }
    catch {
        return 0;
    }
}
/**
 * Read total bytes on the filesystem containing `path`.
 * Used for showing "X GB free of Y GB" to users.
 */
function getTotalBytes(path) {
    try {
        // @ts-ignore
        const stats = fs_1.default.statfsSync(path);
        return stats.blocks * stats.bsize;
    }
    catch {
        return 0;
    }
}
//# sourceMappingURL=disk-monitor.js.map