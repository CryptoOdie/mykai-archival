"use strict";
/**
 * Node health checks — plain-English, user-first.
 *
 * Each check reads the current node state and returns a HealthCheck result.
 * The same list is consumed by:
 *   1. The UI Health card (renderer)   — for user-facing warnings + actions
 *   2. Tier-2 auto-diagnostic trigger  — for deciding when to attach a
 *      diagnostic object to the next heartbeat
 *   3. Heartbeat quality_hints payload — for Insights to tier data quality
 *
 * Design principles (for non-tech users):
 *  - Plain English, no jargon ("Your computer clock is off" not "NTP drift")
 *  - Network-benefit framing ("helps the Kaspa network see blocks accurately")
 *  - Every warning has either a one-click fix OR an explanation of what to
 *    try next. No dead ends.
 *  - Do not punish geographic reality — users on slow/flaky regional ISPs
 *    should NOT see warnings just because their peer count fluctuates.
 *    Only flag zero-peer conditions that reflect a real failure.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runHealthChecks = runHealthChecks;
const os_1 = __importDefault(require("os"));
const clock_offset_1 = require("./clock-offset");
/** Milliseconds. Warnings fire at these thresholds. */
const CLOCK_WARN_MS = 5_000; // per Insights dev — 5s is quality threshold
const CLOCK_FAIL_MS = 30_000; // clearly broken clock
const ZERO_PEERS_WARN_MS = 5 * 60_000; // 5 min with 0 peers — allows generous startup time before flagging
const SYNC_STALL_WARN_MS = 30 * 60_000; // 30 min no DAA/header advance while syncing
const KASPAD_CRASH_LOOP_COUNT = 3; // restarts in last hour
const RAM_PRESSURE_IBD_PCT = 85; // warn only during IBD — steady-state high-RAM is user's other apps
const UTXO_REBUILD_WARN_SEC = 2 * 60 * 60; // 2h — unusual but not broken yet
const UTXO_REBUILD_FAIL_SEC = 6 * 60 * 60; // 6h — almost certainly stuck after unclean shutdown
function runHealthChecks(inputs) {
    const { manager, monitor, zeroPeersSince = 0, syncStalledSince = 0, autoPausedForDisk = false, freeDiskBytes = 0, kasmapEnabled = false, kasmapCircuitOpen = false, kasmapLastError = null } = inputs;
    const checks = [];
    const state = monitor.status.state || manager.state;
    const offsetMs = Math.abs((0, clock_offset_1.getClockOffset)());
    // ─── Disk auto-pause (highest-priority warning) ──────────────────────
    // When the disk monitor has paused kaspad to protect its DB from
    // filling up, show a calm message explaining what happened and that
    // free'ing up space will auto-resume the node.
    if (autoPausedForDisk) {
        const freeGB = (freeDiskBytes / 1_073_741_824).toFixed(1);
        checks.push({
            id: 'disk-auto-paused',
            severity: 'fail',
            title: `Paused to protect your node — your disk is almost full (${freeGB} GB free)`,
            detail: 'MyKAI paused Kaspa so it doesn\u2019t run out of space and break. Free up some room and MyKAI will resume automatically \u2014 no restart needed.',
            actions: [
                { label: 'Open data folder', action: 'open-data-folder' },
                { label: 'Copy diagnostic info', action: 'copy-diagnostic' },
            ],
        });
    }
    // ─── Clock accuracy (network-benefit framing) ─────────────────────────
    if (offsetMs > CLOCK_FAIL_MS) {
        const secs = Math.round(offsetMs / 1000);
        checks.push({
            id: 'clock',
            severity: 'fail',
            title: `Your computer clock is ${secs} seconds off`,
            detail: 'Fix it so your node helps the Kaspa network see blocks accurately.',
            actions: [{ label: 'Fix now', action: 'fix-clock' }],
        });
    }
    else if (offsetMs > CLOCK_WARN_MS) {
        const secs = Math.round(offsetMs / 1000);
        checks.push({
            id: 'clock',
            severity: 'warn',
            title: `Your computer clock is ${secs} seconds off`,
            detail: 'Fix it so your node helps the Kaspa network see blocks accurately.',
            actions: [{ label: 'Fix now', action: 'fix-clock' }],
        });
    }
    else {
        checks.push({ id: 'clock', severity: 'ok', title: 'Clock is accurate', actions: [] });
    }
    // ─── Zero peers (real failure only, no volatility shame) ──────────────
    // Suppress entirely during UTXO rebuild — kaspad doesn't accept peer
    // connections while rebuilding its index, so 0 peers is expected for
    // the 15min-2h rebuild duration. Showing a scary red "Can't find peers"
    // warning here is a false positive that contradicts the UTXO rebuild
    // message we're already showing.
    const peerCount = monitor.status.peerCount || manager.peerCount || 0;
    const utxoRebuildActive = manager.utxoRebuildElapsedSec > 0;
    if (!utxoRebuildActive && peerCount === 0 && zeroPeersSince > 0 && Date.now() - zeroPeersSince > ZERO_PEERS_WARN_MS) {
        checks.push({
            id: 'peers',
            severity: 'fail',
            title: 'Can\u2019t find any peers right now',
            detail: 'Your node needs to connect to at least one other Kaspa node to work. Try waiting, restarting, or copying a diagnostic for support.',
            actions: [
                { label: 'Wait and see', action: 'dismiss' },
                { label: 'Restart node', action: 'restart-node' },
                { label: 'Copy diagnostic info', action: 'copy-diagnostic' },
            ],
        });
    }
    else if (!utxoRebuildActive) {
        checks.push({ id: 'peers', severity: 'ok', title: `${peerCount} peers connected`, actions: [] });
    }
    // ─── Sync stalled (real stall only — slow ≠ stalled) ─────────────────
    // Suppress entirely during UTXO rebuild — kaspad's DAA score legitimately
    // doesn't advance while it rebuilds the UTXO index after an unclean
    // shutdown (10-30 min one-time recovery operation). The rebuild is
    // already surfaced as the `utxo-rebuild` warn check above; firing
    // sync-stalled on top of it produces a confusing double-alert and the
    // suggested "Restart node" action RESETS the rebuild progress to zero,
    // sending users into a loop. Same pattern as the zero-peers check above
    // (which also suppresses during rebuild). Reported by Morris on 0.3.3
    // who hit "Sync hasn't moved in 52 minutes" repeatedly while kaspad was
    // legitimately rebuilding — every Restart click sent him back to 0.
    if (state === 'syncing' && !utxoRebuildActive && syncStalledSince > 0 && Date.now() - syncStalledSince > SYNC_STALL_WARN_MS) {
        const stalledMin = Math.round((Date.now() - syncStalledSince) / 60_000);
        checks.push({
            id: 'sync-stalled',
            severity: 'warn',
            title: `Sync hasn\u2019t moved in ${stalledMin} minutes`,
            detail: 'Your node is connected but not processing new blocks. Check your internet, or restart the node.',
            actions: [
                { label: 'Wait and see', action: 'dismiss' },
                { label: 'Restart node', action: 'restart-node' },
                { label: 'Copy diagnostic info', action: 'copy-diagnostic' },
            ],
        });
    }
    // ─── UTXO rebuild in progress ────────────────────────────────────────
    // Kaspad wipes and rebuilds its UTXO index whenever the prior shutdown
    // was unclean (laptop lid closed during sync, power loss, crash) and on
    // first install. Real user pattern: laptop went to sleep after 1 h of
    // power-management idle, rebuild discarded, user saw "still rebuilding"
    // 8 h later with no idea why. CRITICAL that the "don't let it sleep"
    // warning shows from minute ONE, not after hours, so users can prevent
    // the wasted-setup scenario instead of learning about it after the fact.
    const utxoElapsedSec = manager.utxoRebuildElapsedSec;
    if (utxoElapsedSec > 0) {
        const h = Math.floor(utxoElapsedSec / 3600);
        const m = Math.floor((utxoElapsedSec % 3600) / 60);
        const elapsed = h > 0 ? `${h}h ${m}m` : `${m}m`;
        if (utxoElapsedSec >= UTXO_REBUILD_FAIL_SEC) {
            checks.push({
                id: 'utxo-rebuild',
                severity: 'fail',
                title: `Setting up your node has been running for ${elapsed}`,
                detail: 'This usually takes 1-2 hours. Your node may be stuck. Try restarting it — if it keeps restarting from zero, copy a diagnostic for support.',
                actions: [
                    { label: 'Restart node', action: 'restart-node' },
                    { label: 'Copy diagnostic info', action: 'copy-diagnostic' },
                ],
            });
        }
        else {
            // From minute 1, warn: keep running + prevent sleep. Update the
            // elapsed number but the core message stays the same.
            const title = utxoElapsedSec >= UTXO_REBUILD_WARN_SEC
                ? `Still setting up your node (${elapsed} so far)`
                : `Setting up your node (${elapsed} so far)`;
            const detail = utxoElapsedSec >= UTXO_REBUILD_WARN_SEC
                ? 'This is taking a while but is usually normal on slower disks. Keep MyKAI running and don\u2019t let your computer sleep — closing the app or sleeping will restart from scratch.'
                : 'First-time setup — usually 1-2 hours. Keep MyKAI running and don\u2019t let your computer sleep. If the app closes or your computer sleeps, this will restart from scratch.';
            checks.push({
                id: 'utxo-rebuild',
                severity: 'warn',
                title,
                detail,
                actions: [{ label: 'OK, got it', action: 'dismiss' }],
            });
        }
    }
    // ─── Memory pressure during IBD ───────────────────────────────────────
    // Only flag during syncing/starting — steady-state high-RAM use is the
    // user's other apps, not our concern. But during initial block download
    // kaspad is memory-hungry and an OOM crash wastes hours of sync progress.
    // Confirmed pattern across 3 users (PH, zombie NL, IN Shimla): high RAM
    // use → kaspad OOM kill → node disappears from the fleet mid-IBD.
    if (state === 'syncing' || state === 'starting') {
        const total = os_1.default.totalmem();
        const free = os_1.default.freemem();
        const usedPct = total > 0 ? Math.round(((total - free) / total) * 100) : 0;
        if (usedPct >= RAM_PRESSURE_IBD_PCT) {
            checks.push({
                id: 'memory-pressure-ibd',
                severity: 'warn',
                title: `Your computer is low on memory (${usedPct}% used)`,
                detail: 'First-time sync needs memory. Close other apps for a smoother sync — kaspad may crash and lose its progress otherwise.',
                actions: [{ label: 'OK, got it', action: 'dismiss' }],
            });
        }
    }
    // ─── Kaspad crash loop ────────────────────────────────────────────────
    if (manager.restartsInSession >= KASPAD_CRASH_LOOP_COUNT) {
        checks.push({
            id: 'kaspad-crashes',
            severity: 'fail',
            title: `Your node has restarted ${manager.restartsInSession} times`,
            detail: 'Kaspad keeps failing. Copy a diagnostic so we can see what went wrong.',
            actions: [
                { label: 'Copy diagnostic info', action: 'copy-diagnostic' },
                { label: 'Restart node', action: 'restart-node' },
            ],
        });
    }
    // ─── KasMap integration offline ──────────────────────────────────────
    // Only shown when user has KasMap enabled AND the circuit breaker has
    // tripped after repeated auth failures. Kaspad itself is unaffected —
    // this is purely about the KasMap social/presence channel. 'warn' not
    // 'fail' so it doesn't alarm users: their node is still contributing.
    if (kasmapEnabled && kasmapCircuitOpen) {
        const isAuth = kasmapLastError === 'auth-failed' || kasmapLastError === 'token-rejected';
        checks.push({
            id: 'kasmap-offline',
            severity: 'warn',
            title: 'KasMap integration is offline',
            detail: isAuth
                ? 'Your KasMap sign-in may have expired. Your node is still running normally \u2014 only the KasMap social features are affected. Click Retry to reconnect.'
                : 'Can\u2019t reach KasMap right now. Your node is still running normally \u2014 only the KasMap social features are affected. Click Retry to reconnect.',
            actions: [
                { label: 'Retry', action: 'retry-kasmap' },
                { label: 'Dismiss', action: 'dismiss' },
            ],
        });
    }
    // ─── Aggregate health ─────────────────────────────────────────────────
    const overall = checks.some(c => c.severity === 'fail')
        ? 'fail'
        : checks.some(c => c.severity === 'warn') ? 'warn' : 'ok';
    // ─── Quality hints for Insights (heartbeat payload) ───────────────────
    const clock_quality = offsetMs > CLOCK_FAIL_MS ? 'bad'
        : offsetMs > CLOCK_WARN_MS ? 'drift'
            : 'good';
    const sync_phase = state === 'error' ? 'error'
        : state === 'synced' ? 'synced'
            : state === 'starting' ? 'starting'
                : syncStalledSince > 0 && Date.now() - syncStalledSince > SYNC_STALL_WARN_MS ? 'stalled'
                    : (monitor.status.blockCount || 0) > 0 && (monitor.status.headerCount || 0) > 0
                        && (monitor.status.blockCount || 0) < (monitor.status.headerCount || 0)
                        ? 'syncing_blocks'
                        : 'syncing_headers';
    const overallHint = overall === 'fail' ? 'error'
        : overall === 'warn' ? 'degraded'
            : 'healthy';
    return {
        overall,
        checks,
        qualityHints: {
            clock_quality,
            sync_phase,
            overall: overallHint,
        },
    };
}
//# sourceMappingURL=health-checks.js.map