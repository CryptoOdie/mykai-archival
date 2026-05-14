"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Gamification = void 0;
const electron_store_1 = __importDefault(require("electron-store"));
const identity_backup_1 = require("./identity-backup");
/** Sompi-per-KAS conversion. Kaspa's smallest unit. We accumulate mining
 *  rewards as integer sompi internally to avoid IEEE-754 drift over
 *  thousands of blocks (15.2 KAS × 1000 = 15200.000000000002 in float),
 *  and divide back to KAS only at the display boundary. */
const SOMPI_PER_KAS = 100_000_000;
const MILESTONE_DEFS = [
    { id: 'first-sync', label: 'First Sync', description: 'Completed your first blockchain sync', check: s => s.firstSyncCompleted },
    { id: 'blocks-1k', label: '1K Blocks', description: 'Validated 1,000 blocks', check: s => s.blocksValidated >= 1000 },
    { id: 'blocks-10k', label: '10K Blocks', description: 'Validated 10,000 blocks', check: s => s.blocksValidated >= 10000 },
    { id: 'blocks-100k', label: '100K Blocks', description: 'Validated 100,000 blocks', check: s => s.blocksValidated >= 100000 },
    { id: 'blocks-1m', label: '1M Blocks', description: 'Validated 1,000,000 blocks', check: s => s.blocksValidated >= 1000000 },
    { id: 'uptime-1h', label: '1 Hour', description: 'Node online for 1 hour straight', check: s => s.currentStreakSeconds >= 3600 },
    { id: 'uptime-24h', label: '24 Hours', description: 'Node online for 24 hours straight', check: s => s.currentStreakSeconds >= 86400 },
    { id: 'uptime-7d', label: '7 Days', description: 'Node online for 7 days straight', check: s => s.currentStreakSeconds >= 604800 },
    { id: 'tps-100', label: 'Speed Demon', description: 'Saw 100+ transactions per second', check: s => s.peakTps >= 100 },
    { id: 'tps-500', label: 'Turbo Mode', description: 'Saw 500+ transactions per second', check: s => s.peakTps >= 500 },
    { id: 'tx-1m', label: '1M Transactions', description: 'Processed 1,000,000 transactions', check: s => s.transactionsSeen >= 1000000 },
    // Mining milestones
    { id: 'first-share', label: 'First Share', description: 'Your miner submitted its first valid share', check: s => s.sharesAccepted >= 1 },
    { id: 'shares-1k', label: '1K Shares', description: 'Miners submitted 1,000 valid shares', check: s => s.sharesAccepted >= 1000 },
    { id: 'block-found', label: 'Block Found!', description: 'Your miner found a block and earned KAS', check: s => s.blocksFound >= 1 },
];
class Gamification {
    store;
    stats;
    newMilestones = [];
    /** Read-through reference to ConfigStore so we know which
     *  identity_acc_<key>.json file to mirror our stats to. Required —
     *  Gamification can't write to a keyed file without knowing the key. */
    config;
    constructor(config) {
        this.store = new electron_store_1.default({ name: 'mykai-node-gamification' });
        this.stats = this.load();
        this.config = config ?? null;
    }
    get current() {
        return { ...this.stats };
    }
    get pendingMilestones() {
        const m = [...this.newMilestones];
        this.newMilestones = [];
        return m;
    }
    load() {
        // Migrate legacy `totalRewardKas` (float) into `totalRewardSompi` (int)
        // on first load post-upgrade. Once both fields exist, sompi is the
        // authoritative source and kas is computed from it.
        const persistedSompi = this.store.get('totalRewardSompi');
        const legacyKas = this.store.get('totalRewardKas') || 0;
        const sompi = typeof persistedSompi === 'number'
            ? persistedSompi
            : Math.round(legacyKas * SOMPI_PER_KAS);
        return {
            blocksValidated: this.store.get('blocksValidated') || 0,
            transactionsSeen: this.store.get('transactionsSeen') || 0,
            peakTps: this.store.get('peakTps') || 0,
            currentTps: 0,
            totalUptimeSeconds: this.store.get('totalUptimeSeconds') || 0,
            currentStreakSeconds: 0,
            longestStreakSeconds: this.store.get('longestStreakSeconds') || 0,
            firstSyncCompleted: this.store.get('firstSyncCompleted') || false,
            sharesAccepted: this.store.get('sharesAccepted') || 0,
            blocksFound: this.store.get('blocksFound') || 0,
            totalRewardSompi: sompi,
            totalRewardKas: sompi / SOMPI_PER_KAS,
            milestones: this.store.get('milestones') || [],
        };
    }
    // Debounced disk-write coalescing. electron-store's `set()` writes the full
    // config file synchronously every call; with blocks arriving ~40×/sec on
    // busy mainnet, that was tens of disk syncs per second. Coalesce to one
    // write every 5 s. All callers invoke save() the same way — if a timer is
    // already scheduled, their update will land in the next flush.
    _saveTimer = null;
    // Wall-clock anchor for updateUptime — keeps `totalUptimeSeconds` in step
    // with real elapsed time even when the 10s tick fires late (event-loop
    // stall) or after a sleep/resume cycle. 0 == "first call this session".
    _lastUptimeTickMs = 0;
    static SAVE_DEBOUNCE_MS = 5_000;
    save() {
        if (this._saveTimer)
            return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            // Hot-path debounced save — defer the actual disk write off the
            // current tick so the 5 s timer doesn't block the event loop in
            // the middle of a notification flood. Hotfix #3 of 0.3.5.
            this._saveDeferred();
        }, Gamification.SAVE_DEBOUNCE_MS);
    }
    /** Force an immediate synchronous write. Use on app quit, where we
     *  WANT the synchronous behavior to guarantee the save happens before
     *  the process exits. The hot-path `save()` uses `_saveDeferred()`
     *  instead. */
    flush() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        this._saveImmediate();
    }
    /** Wipe all lifetime stats from electron-store. Used ONLY by the
     *  explicit "Reset identity" Settings button — never from automatic
     *  cleanup, migration, or error-recovery paths. Caller is expected to
     *  also wipe the Documents identity backup + relaunch the app. */
    resetAllStats() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        // Clear electron-store keys
        this.store.delete('blocksValidated');
        this.store.delete('transactionsSeen');
        this.store.delete('peakTps');
        this.store.delete('totalUptimeSeconds');
        this.store.delete('longestStreakSeconds');
        this.store.delete('firstSyncCompleted');
        this.store.delete('sharesAccepted');
        this.store.delete('blocksFound');
        this.store.delete('totalRewardSompi');
        this.store.delete('totalRewardKas');
        this.store.delete('milestones');
        // Reset in-memory state too so any pending stat increments don't
        // resurrect old values before the relaunch lands.
        this.stats = {
            blocksValidated: 0,
            transactionsSeen: 0,
            peakTps: 0,
            currentTps: 0,
            totalUptimeSeconds: 0,
            currentStreakSeconds: 0,
            longestStreakSeconds: 0,
            firstSyncCompleted: false,
            sharesAccepted: 0,
            blocksFound: 0,
            totalRewardSompi: 0,
            totalRewardKas: 0,
            milestones: [],
        };
    }
    /** Snapshot the persistable subset of stats. Used by both the
     *  deferred and immediate save paths so they can never write
     *  partial / inconsistent state. */
    _snapshotForPersistence() {
        return {
            blocksValidated: this.stats.blocksValidated,
            transactionsSeen: this.stats.transactionsSeen,
            peakTps: this.stats.peakTps,
            totalUptimeSeconds: this.stats.totalUptimeSeconds,
            longestStreakSeconds: this.stats.longestStreakSeconds,
            firstSyncCompleted: this.stats.firstSyncCompleted,
            sharesAccepted: this.stats.sharesAccepted,
            blocksFound: this.stats.blocksFound,
            // Persist sompi as the authoritative integer; keep totalRewardKas
            // for any downstream reader that grabs the file directly (older
            // builds, analytics tools) — the value is derived from sompi so
            // they stay in sync.
            totalRewardSompi: this.stats.totalRewardSompi,
            totalRewardKas: this.stats.totalRewardKas,
            milestones: this.stats.milestones,
        };
    }
    /** Hot-path save — captures the snapshot synchronously (cheap, no I/O)
     *  but defers the actual disk write to the next event-loop tick. The
     *  setImmediate boundary lets the activity-feed setInterval, renderer
     *  IPC, and incremental GC run BEFORE we burn 50–130 ms doing 11
     *  sequential synchronous electron-store writes. Diagnostic on
     *  2026-04-28 showed this exact pattern firing every 5 s with
     *  consistent 50–130 ms cost — biggest remaining stall source on a
     *  healthy machine. Hotfix #3 of 0.3.5. */
    _saveDeferred() {
        const snapshot = this._snapshotForPersistence();
        setImmediate(() => {
            const t0 = Date.now();
            // electron-store accepts an object: ONE atomic write to disk
            // instead of 11 sequential ones. The debounced timer plus the
            // setImmediate yield plus this batching turns the worst
            // single-tick block from ~130 ms to ~10–20 ms — and even that
            // happens off the hot tick, so the loop doesn't observe it.
            this.store.set(snapshot);
            const dt = Date.now() - t0;
            if (dt > 50) {
                try {
                    require('./perf-stalls').recordSlowStoreWrite('gamification', '_saveDeferred(batched 11 keys)', dt);
                }
                catch { /* perf-stalls not init — skip */ }
            }
            // Mirror lifetime stats into Documents\MyKAI\identity_acc_<key>.json.
            // Best-effort, async inside writeBackupPartial, errors swallowed.
            const accountKey = this.config?.getAccountKey();
            if (accountKey) {
                (0, identity_backup_1.writeBackupPartial)(accountKey, {
                    blocksValidated: snapshot.blocksValidated,
                    transactionsSeen: snapshot.transactionsSeen,
                    totalUptimeSeconds: snapshot.totalUptimeSeconds,
                    longestStreakSeconds: snapshot.longestStreakSeconds,
                    peakTps: snapshot.peakTps,
                    firstSyncCompleted: snapshot.firstSyncCompleted,
                    sharesAccepted: snapshot.sharesAccepted,
                    blocksFound: snapshot.blocksFound,
                    totalRewardSompi: snapshot.totalRewardSompi,
                });
            }
        });
    }
    /** Synchronous flush. Used ONLY by app-quit (`flush()`) where we need
     *  the write to complete before the process exits. NOT called from the
     *  hot path — see `_saveDeferred()` for that. */
    _saveImmediate() {
        const t0 = Date.now();
        const snapshot = this._snapshotForPersistence();
        this.store.set(snapshot);
        const dt = Date.now() - t0;
        if (dt > 50) {
            try {
                require('./perf-stalls').recordSlowStoreWrite('gamification', '_saveImmediate(quit-flush)', dt);
            }
            catch { /* perf-stalls not init — skip */ }
        }
        const accountKey = this.config?.getAccountKey();
        if (accountKey) {
            (0, identity_backup_1.writeBackupPartial)(accountKey, {
                blocksValidated: snapshot.blocksValidated,
                transactionsSeen: snapshot.transactionsSeen,
                totalUptimeSeconds: snapshot.totalUptimeSeconds,
                longestStreakSeconds: snapshot.longestStreakSeconds,
                peakTps: snapshot.peakTps,
                firstSyncCompleted: snapshot.firstSyncCompleted,
                sharesAccepted: snapshot.sharesAccepted,
                blocksFound: snapshot.blocksFound,
                totalRewardSompi: snapshot.totalRewardSompi,
            });
        }
    }
    addBlocks(count) {
        this.stats.blocksValidated += count;
        this.checkMilestones();
        this.save();
    }
    addTransactions(count) {
        this.stats.transactionsSeen += count;
        this.checkMilestones();
        this.save();
    }
    setTps(tps) {
        this.stats.currentTps = tps;
        if (tps > this.stats.peakTps) {
            this.stats.peakTps = tps;
            this.save();
        }
        this.checkMilestones();
    }
    updateUptime(uptimeSeconds) {
        this.stats.currentStreakSeconds = uptimeSeconds;
        if (uptimeSeconds > this.stats.longestStreakSeconds) {
            this.stats.longestStreakSeconds = uptimeSeconds;
        }
        // Increment by *actual* wall-clock elapsed time since the last tick,
        // clamped to [0, 30s]. Previous code blindly added 10 per call, which:
        //   - drifted behind real time on event-loop stalls (tick fires late),
        //   - jumped forward by 10 after a long sleep/resume even though hours
        //     of wall-clock had elapsed (laptop sleep was actually OK; the
        //     issue was the *next* tick after wake adding only 10 total).
        // The 30s cap keeps a sleep/resume from inflating the lifetime stat
        // when the immediate post-resume tick runs after hours away.
        const now = Date.now();
        const elapsedSec = this._lastUptimeTickMs > 0
            ? Math.min(30, Math.max(0, Math.round((now - this._lastUptimeTickMs) / 1000)))
            : 0;
        this._lastUptimeTickMs = now;
        this.stats.totalUptimeSeconds += elapsedSec;
        this.checkMilestones();
        // Save every 60 seconds to avoid excessive writes
        if (uptimeSeconds % 60 === 0)
            this.save();
    }
    markSynced() {
        if (!this.stats.firstSyncCompleted) {
            this.stats.firstSyncCompleted = true;
            this.save();
            this.checkMilestones();
        }
    }
    resetStreak() {
        this.stats.currentStreakSeconds = 0;
        this.stats.currentTps = 0;
    }
    addShares(count) {
        this.stats.sharesAccepted += count;
        this.checkMilestones();
        this.save();
    }
    addMiningBlock(rewardKas = 15.2) {
        this.stats.blocksFound++;
        // Accumulate in integer sompi to dodge float drift (15.2 × 1000 =
        // 15200.000000000002 in IEEE-754). Math.round handles the rare case
        // where the caller passes a value with sub-sompi precision.
        const sompi = Math.round(rewardKas * SOMPI_PER_KAS);
        this.stats.totalRewardSompi += sompi;
        this.stats.totalRewardKas = this.stats.totalRewardSompi / SOMPI_PER_KAS;
        this.checkMilestones();
        this.save();
    }
    checkMilestones() {
        for (const def of MILESTONE_DEFS) {
            const alreadyUnlocked = this.stats.milestones.some(m => m.id === def.id);
            if (!alreadyUnlocked && def.check(this.stats)) {
                const milestone = {
                    id: def.id,
                    label: def.label,
                    description: def.description,
                    unlockedAt: Date.now(),
                };
                this.stats.milestones.push(milestone);
                this.newMilestones.push(milestone);
                this.save();
            }
        }
    }
}
exports.Gamification = Gamification;
//# sourceMappingURL=gamification.js.map