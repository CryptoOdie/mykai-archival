"use strict";
/**
 * Structured diagnostic payload for Tier 2 (auto-attach on heartbeat) and
 * Tier 3 (server-requested pull).
 *
 * Separate from the user-facing markdown diagnostic in `diagnostic.ts`:
 *   - markdown: for humans (copy-paste to support chat)
 *   - this file: for Insights server ingest (JSON blob, stable field names)
 *
 * Privacy:
 *   - Same redaction rules as the markdown diagnostic
 *   - accountKey omitted; nodeId handled by caller
 *   - Peer IPs NOT included (too identifying; peer IDs / user agents OK)
 *   - Paths normalized (<home> instead of C:\Users\<name>\...)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDiagnosticPayload = buildDiagnosticPayload;
exports.shouldAttachDiagnostic = shouldAttachDiagnostic;
const os_1 = __importDefault(require("os"));
const clock_offset_1 = require("./clock-offset");
const network_info_1 = require("./network-info");
const loop_lag_1 = require("./loop-lag");
const session_log_1 = require("./session-log");
function buildDiagnosticPayload(opts) {
    const { manager, monitor, config, health, trigger, processUptimeSec } = opts;
    const cfg = config.getAll();
    const s = monitor.status;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const monitorVersion = require('../../package.json').version;
    const mem = process.memoryUsage();
    return {
        trigger,
        built_at: Date.now(),
        health_overall: health.qualityHints.overall,
        active_issues: (health.checks || [])
            .filter(c => c.severity !== 'ok')
            .map(c => ({ id: c.id, severity: c.severity, title: c.title })),
        kaspad: {
            running: manager.pid !== null,
            pid: manager.pid,
            uptime_seconds: Math.floor(manager.uptime),
            restarts_this_session: manager.restartsInSession,
            recent_log: (opts.recentKaspadLogs || []).slice(-10),
            startup_error_reason: opts.startupErrorReason ?? null,
        },
        node: {
            state: s.state || manager.state,
            network: s.networkName || cfg.network || '',
            // Default fallback is 'public' to match the rest of the codebase
            // (config-store.ts:66, kaspad-manager.ts:28, main.ts:384). The
            // previous 'private' fallback was a leftover from an older
            // private-first policy and would silently flip Tier-2 Insights
            // heartbeats to private even when kaspad and KasMap correctly
            // reported the node as public — making the cohort look smaller
            // than it really is.
            visibility: cfg.nodeVisibility || 'public',
            daa_score: s.daaScore || 0,
            header_count: s.headerCount || 0,
            block_count: s.blockCount || 0,
            peer_count: s.peerCount || manager.peerCount || 0,
            sync_detail: s.syncDetail || '',
        },
        runtime: {
            monitor_version: monitorVersion,
            rss_bytes: mem.rss,
            heap_used_bytes: mem.heapUsed,
            heap_total_bytes: mem.heapTotal,
            node_main_uptime_seconds: Math.floor(processUptimeSec),
        },
        system: {
            platform: process.platform,
            os_release: os_1.default.release(),
            ram_total_bytes: os_1.default.totalmem(),
            ram_free_bytes: os_1.default.freemem(),
            cpu_count: os_1.default.cpus().length,
            clock_offset_ms: (0, clock_offset_1.getClockOffset)(),
        },
        network: (() => {
            const n = (0, network_info_1.getCachedNetworkInfo)();
            return {
                primary_type: n?.primary_type || 'unknown',
                link_speed_mbps: n?.link_speed_mbps ?? null,
                has_ipv6: n?.has_ipv6 || false,
                adapter_name: n?.adapter_name || '',
                interfaces_count: n?.interfaces_count || 0,
                has_default_route: n?.has_default_route || false,
            };
        })(),
        config: {
            node_mode: cfg.nodeMode || 'bundled',
            outpeers: cfg.outpeers || 0,
            ram_scale: cfg.ramScale || 0,
            utxo_index: !!cfg.utxoIndex,
            auto_start: cfg.autoStart !== false,
            auto_update: cfg.autoUpdate !== false,
            contribute_monitoring: !!cfg.contributeMonitoring,
            kasmap_enabled: !!(cfg.kasmap?.enabled),
            mining_enabled: !!cfg.miningEnabled,
            stratum_bind: cfg.stratumBind,
        },
        // ─── Extension blocks ────────────────────────────────────────────────
        // Each block is built unconditionally from sources we always have
        // (manager/monitor) and conditionally from sources passed through opts
        // (kasmapRealtime, agentBridge, lastIpcFromRendererAt).
        process_health: (() => {
            const lag = (0, loop_lag_1.getLoopLagPercentiles)();
            return {
                event_loop_lag_p50_ms: lag.p50Ms,
                event_loop_lag_p99_ms: lag.p99Ms,
                event_loop_lag_max_ms: lag.maxMs,
                wsrpc_buffered_bytes: monitor.wsRpcBufferedBytes,
                listener_counts: {
                    manager_state_change: manager.listenerCount('state-change'),
                    monitor_status: monitor.listenerCount('status'),
                    monitor_block_added: monitor.listenerCount('block-added'),
                    agent_watch_tx: opts.agentBridge ? opts.agentBridge.listenerCount('watch-tx') : 0,
                },
            };
        })(),
        subscriptions: (() => {
            const rates = monitor.getNotifyRates();
            const stats = monitor.getNotifyStats();
            return {
                subscribed: monitor.isSubscribed,
                last_block_added_age_ms: monitor.lastBlockAddedTs ? Date.now() - monitor.lastBlockAddedTs : 0,
                block_added_bps_10s: Number(rates.blockAddedBps.toFixed(2)),
                notify_raw_bps_10s: Number(rates.notifyRawBps.toFixed(2)),
                rpc_raw_bps_10s: Number(rates.rpcRawBps.toFixed(2)),
                block_added_accepts: stats.blockAddedAccepts,
                block_added_drops_no_candidate: stats.blockAddedDrops.noCandidateBlock,
                block_added_drops_no_hash: stats.blockAddedDrops.noHash,
            };
        })(),
        ...(opts.kasmapRealtime ? {
            kasmap: (() => {
                const rt = opts.kasmapRealtime;
                const st = rt.getStatus();
                return {
                    realtime_connected: st.connected,
                    realtime_connecting: st.connecting,
                    circuit_open: st.circuitOpen,
                    consecutive_failures: st.consecutiveFailures,
                    last_error_reason: st.lastErrorReason,
                    next_retry_in_ms: st.nextRetryInMs,
                };
            })(),
        } : {}),
        ...(typeof opts.lastIpcFromRendererAt === 'number' ? {
            renderer_health: (() => {
                const ageMs = Date.now() - opts.lastIpcFromRendererAt;
                return {
                    last_ipc_from_renderer_age_ms: ageMs,
                    responsive: ageMs < 60_000,
                };
            })(),
        } : {}),
        ...(() => {
            const prev = (0, session_log_1.getPreviousSession)();
            if (!prev)
                return {};
            return {
                previous_session: {
                    started_at: prev.started_at,
                    ended_at: prev.ended_at,
                    ended_clean: prev.ended_clean,
                    end_reason: prev.end_reason,
                    monitor_version: prev.monitor_version,
                    uptime_seconds: prev.uptime_seconds,
                },
            };
        })(),
    };
}
/**
 * Evaluate trigger conditions. Returns the first matching trigger reason
 * (for the `trigger` field) or null if no diagnostic should be attached.
 *
 * Checks run in priority order — first match wins. Callers should combine
 * this with rate limiting (1 per hour per node).
 */
function shouldAttachDiagnostic(state) {
    const s = state.monitor.status;
    const nodeState = s.state || state.manager.state;
    if (state.autoPausedForDisk)
        return 'disk_auto_paused';
    if (nodeState === 'error')
        return 'node_state_error';
    // A single crash-during-sync is worth a diagnostic — don't wait for three.
    // This catches OOM-during-IBD (IN Shimla pattern) on the first occurrence,
    // not after the user has crashed and retried twice.
    if (state.manager.startupErrorReason === 'crashed_during_sync')
        return 'crashed_during_sync';
    // User-initiated restart (Restart Node button, manual Stop+Start cycle):
    // the most-valuable moment for support to capture state. One-shot flag
    // is consumed here — fires exactly once on the first heartbeat after a
    // user-driven restart, then resets. Higher priority than crash-loop and
    // the steady-state stall triggers because we want this report to land
    // even if other conditions also match. Theme E of the 0.3.4 plan.
    if (state.manager.consumeUserRestartFlag())
        return 'user_initiated_restart';
    if (state.manager.restartsInSession >= 3)
        return 'kaspad_crash_loop';
    if (state.lastHeartbeatOk === false)
        return 'prev_heartbeat_failed';
    if (state.heartbeatMissedCount >= 2)
        return 'heartbeats_missed';
    if (state.clockOffsetMs > 5_000)
        return 'clock_drift';
    // daa_stalled fires when DAA hasn't advanced in >10 minutes. Suppressed
    // during UTXO rebuild because DAA legitimately doesn't advance while
    // kaspad is rebuilding the index (10–30 min one-time recovery after an
    // unclean shutdown). Pre-fix: every 5-min heartbeat during a rebuild
    // attached a full Tier-2 diagnostic with this trigger — flooding
    // Insights with 6+ noise reports per affected user, each one with the
    // same actionable answer ("kaspad is rebuilding, no user/dev action
    // needed"). The lighter-weight per-heartbeat payload still carries
    // active_issues: [{id: 'utxo-rebuild'}] so the rebuild state is
    // observable on the Insights side without the heavyweight attachment.
    // After this gate, daa_stalled fires only on GENUINE stalls (DAA
    // frozen AND no rebuild active) which IS actionable.
    if (state.daaScoreStaleMs > 10 * 60_000 && state.utxoRebuildElapsedMs === 0)
        return 'daa_stalled';
    // UTXO rebuild longer than 3h is unusual — attach diagnostic so Insights
    // can see patterns in which users/hardware get stuck. Health card warns
    // the user at 2h, fails at 6h with a restart action. The 3h T2 trigger
    // sits between the two, giving us data before the fail state.
    if (state.utxoRebuildElapsedMs > 3 * 60 * 60_000)
        return 'utxo_rebuild_long';
    if (state.systemRamFreeBytes > 0 && state.systemRamFreeBytes < 100_000_000)
        return 'low_memory';
    if (state.health.overall === 'fail')
        return 'health_fail';
    // ─── One-shot startup triggers ─────────────────────────────────────────
    // Fire on the first heartbeat after startup if there's a prior-session
    // record to report. After the heartbeat builder calls
    // markPreviousSessionReported(), isPreviousSessionPending() returns false
    // and these triggers stop firing for the rest of the session.
    // Higher priority than the steady-state extension triggers below — we
    // want this report to land even if the new session immediately hits
    // event_loop_stalled or another condition.
    //
    // UX note: `previous_session_clean` fires on every healthy restart (the
    // common case) and intentionally produces NO activity-feed message —
    // see main.ts heartbeat pre-send hook. The data still ships to Insights
    // so the dev can correlate session lifecycle when supporting users; only
    // the user-facing line is suppressed because non-tech users found
    // "diagnostic sent" alarming on graceful launches. The unclean variant
    // does surface an activity-feed line ("Reporting last session's
    // unexpected shutdown to support") because that's worth knowing.
    if ((0, session_log_1.isPreviousSessionPending)()) {
        const prev = (0, session_log_1.getPreviousSession)();
        if (prev && prev.ended_clean)
            return 'previous_session_clean';
        if (prev && !prev.ended_clean)
            return 'previous_session_unclean';
    }
    // ─── Extension triggers ────────────────────────────────────────────────
    // Lower priority than all existing triggers (added at the end), so today's
    // attach behavior is unchanged on existing failure modes.
    // Renderer hung OR main hung. Both produce the same signal — main hasn't
    // received an IPC from renderer in >60s — but the cause is different:
    //   - Renderer hung: renderer's own setIntervals can't fire, so no IPC.
    //     Main is healthy; the heartbeat still ships.
    //   - Main hung: the IPC arrived but main never processed it; lastIpcAt
    //     stays frozen because main's `track()` wrapper never ran.
    // We disambiguate by reading the event-loop histogram. If main itself
    // stalled long enough to be plausibly responsible (max > 60s, same
    // threshold as the IPC age), the trigger label points the operator at
    // main directly; otherwise it points at the renderer. The data attached
    // to the heartbeat is identical either way — only the label changes.
    const lag = (0, loop_lag_1.getLoopLagPercentiles)();
    if (typeof state.lastIpcFromRendererAt === 'number'
        && nodeState !== 'stopped'
        && Date.now() - state.lastIpcFromRendererAt > 60_000) {
        return lag.maxMs > 60_000 ? 'main_event_loop_stalled' : 'renderer_unresponsive';
    }
    // Main thread blocked sustained — sync stringify, sync fs walk, sync
    // crypto, etc. p99 > 500ms over the histogram window means the loop has
    // had at least one stall that long; chronic causes will show up reliably
    // every heartbeat once the histogram has accumulated.
    //
    // Cold-start grace: in the first ~60s of a process the histogram is
    // dominated by the inevitable Electron init + first heartbeat clone +
    // first GC cycle, which can produce a single ~500-700ms outlier. With
    // few samples in the histogram, that one outlier dominates p99 and
    // fires this trigger on every fresh launch — pure noise. Skip if
    // process uptime is short AND the signature looks like a single
    // outlier (max == p99, meaning the highest sample IS the 99th
    // percentile, only happens with sparse data). Real chronic stalls
    // produce many samples above 500ms and won't be suppressed.
    const COLD_START_GRACE_SEC = 60;
    const looksLikeColdStartOutlier = lag.maxMs === lag.p99Ms;
    if (lag.p99Ms > 500
        && !(looksLikeColdStartOutlier && process.uptime() < COLD_START_GRACE_SEC)) {
        return 'event_loop_stalled';
    }
    // Listener leak — the canonical "renderer reload re-registered handlers
    // without clearing old ones" failure mode, plus any equivalent in main.
    // Threshold of 10 is well above the steady-state of 1 for these emitters.
    const maxListeners = Math.max(state.manager.listenerCount('state-change'), state.monitor.listenerCount('status'), state.monitor.listenerCount('block-added'));
    if (maxListeners > 10)
        return 'listener_count_high';
    // KasMap circuit breaker open — sustained auth/connection failures.
    // We've already given up retrying for the current backoff window;
    // attaching diagnostics tells Insights the pattern (which error reason).
    if (state.kasmapRealtime?.circuitOpen)
        return 'kasmap_circuit_open';
    // wRPC backpressure — outbound writes to kaspad are queuing because
    // kaspad isn't reading fast enough. >1 MB sustained == real congestion.
    if (state.monitor.wsRpcBufferedBytes > 1_000_000)
        return 'wsrpc_backpressure';
    return null;
}
//# sourceMappingURL=diagnostic-payload.js.map