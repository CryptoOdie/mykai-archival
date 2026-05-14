"use strict";
/**
 * Performance stalls + divergences logger.
 *
 * Why this exists: the BPS regression we chased on 2026-04-28 had us
 * speculating about GC pauses, sync I/O, and notification floods for
 * hours without proof. This module turns the lights on. Always-on
 * (no env gate), writes to userData/perf-stalls.log, surfaces last 50
 * entries in the diagnostic dump.
 *
 * Captures four classes of event:
 * 1. Event-loop stalls > 100 ms (Node's monitorEventLoopDelay)
 * 2. GC pauses > 50 ms (PerformanceObserver on 'gc')
 * 3. Rate divergences (poll vs event vs display BPS disagree by >20%)
 * 4. Slow electron-store .set() writes > 50 ms
 * 5. Clamp fires (getDaaEventBps clamped above 50 BPS)
 *
 * Each entry leads with a human-readable one-line summary so a
 * sleep-deprived developer can scan 50 entries in seconds. Structured
 * detail follows below for forensic depth.
 *
 * Decoupled from the rest of the codebase: callers register context
 * providers (recentActivity, bufferSizes, socketSizes, rates) at
 * startup; perf-stalls calls them when an event fires. Modules that
 * detect an event (a clamp, a slow write, a divergence) call
 * `record*()` directly — no module shape coupling.
 *
 * File rotation: simple ring of last ~2 MB on disk. When the log
 * exceeds 2 MB, drop the oldest 1 MB. Keeps the file readable and
 * predictable in size; the diagnostic only needs the last 50 entries
 * anyway.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTopStalls = getTopStalls;
exports.init = init;
exports.recordDivergence = recordDivergence;
exports.recordSlowStoreWrite = recordSlowStoreWrite;
exports.recordHandlerTiming = recordHandlerTiming;
exports.recordSlowHandler = recordSlowHandler;
exports.recordClampFire = recordClampFire;
exports.getRecentEntriesText = getRecentEntriesText;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const perf_hooks_1 = require("perf_hooks");
const STALL_THRESHOLD_MS = 100;
const GC_THRESHOLD_MS = 50;
const DIVERGENCE_THRESHOLD_BPS = 2.0; // poll vs event delta > 2 BPS = signal
const STORE_WRITE_THRESHOLD_MS = 50;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const TRUNCATE_TO_BYTES = 1 * 1024 * 1024;
/** Lifetime top-N stall ring. Updated on every recordStall(); read by
 *  diagnostic.ts. Trivial compute — sort+truncate of a 3-item array per
 *  stall event (and stall events are bounded by the 100 ms threshold,
 *  so under healthy operation we record maybe 0-5 per hour). */
const TOP_STALLS_N = 3;
const topStalls = [];
function maybeAddToTopStalls(record) {
    // Insert + sort desc by duration, then truncate to N. O(N log N) on
    // an N=3 list = nanoseconds; allocation noise would dwarf this.
    topStalls.push(record);
    topStalls.sort((a, b) => b.durationMs - a.durationMs);
    if (topStalls.length > TOP_STALLS_N)
        topStalls.length = TOP_STALLS_N;
}
/** Top-N stalls observed since process start, sorted by durationMs
 *  descending. Empty array if no stalls have hit the 100 ms threshold
 *  yet (the typical healthy state). Returns a defensive copy so callers
 *  can't mutate our internal ring. */
function getTopStalls() {
    return topStalls.map(r => ({ ...r }));
}
const emptyContext = () => ({
    recentActivity: [],
    recentMethods: [],
    bufferSizes: {},
    socketBuffered: { rpc: 0, notify: 0 },
    rates: { poll: 0, event: 0, display: 0 },
});
let contextProvider = emptyContext;
let logPath = '';
let initialized = false;
let recentGc = null;
let recentEntriesRing = []; // last 50 summary lines for fast diagnostic read
const RECENT_RING_SIZE = 50;
/** Wire this at app startup once `app.getPath('userData')` is available. */
function init(userDataDir, provider) {
    if (initialized)
        return;
    initialized = true;
    logPath = path_1.default.join(userDataDir, 'perf-stalls.log');
    contextProvider = provider;
    // Initialize CPU baseline so the first stall has a meaningful delta.
    _lastCpuSample = process.cpuUsage();
    _lastCpuSampleTs = Date.now();
    // GC observer — captures every major/incremental/minor pause. We
    // only persist the ones over GC_THRESHOLD_MS (typically major GCs).
    // Smaller pauses still get cached in `recentGc` for ~1 s in case
    // they coincide with a stall log entry that wants to attribute it.
    try {
        const gcObs = new perf_hooks_1.PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                const kind = entry.detail?.kind ?? 0;
                const type = gcKindName(kind);
                const durationMs = entry.duration;
                recentGc = { type, durationMs, ts: Date.now() };
                if (durationMs > GC_THRESHOLD_MS) {
                    recordGc(type, durationMs);
                }
            }
        });
        gcObs.observe({ entryTypes: ['gc'] });
    }
    catch (err) {
        appendRaw(`[init-warn] GC observer failed: ${err?.message ?? err}\n`);
    }
    // Event-loop delay monitor. resolution=20ms means the histogram
    // samples loop delay every ~20ms. We poll .max each second; if a
    // stall happened, .max captures the worst tick in the last second.
    try {
        const histogram = (0, perf_hooks_1.monitorEventLoopDelay)({ resolution: 20 });
        histogram.enable();
        setInterval(() => {
            const maxMs = histogram.max / 1_000_000;
            if (maxMs > STALL_THRESHOLD_MS) {
                recordStall(maxMs);
            }
            histogram.reset();
        }, 1000);
    }
    catch (err) {
        appendRaw(`[init-warn] monitorEventLoopDelay failed: ${err?.message ?? err}\n`);
    }
    // Per-method handler timing accumulator. Dump every 5s during the
    // first 60 s of process uptime — that's the window where the catch-
    // up freeze hits, and where we want per-method totals to identify
    // which method is consuming loop time when no SINGLE call exceeds
    // the slow-handler threshold (50 ms) but the cumulative does.
    handlerTimingsStartedAt = Date.now();
    const handlerDumpTimer = setInterval(() => {
        dumpHandlerTimings();
        if ((Date.now() - handlerTimingsStartedAt) > 60_000) {
            // After the startup window settles, stop dumping. The per-call
            // recordSlowHandler() (50 ms threshold) stays active for any
            // future single-call slowness.
            clearInterval(handlerDumpTimer);
        }
    }, 5_000);
}
/** Map V8 GC `detail.kind` numeric flags to a human label. */
function gcKindName(kind) {
    // perf_hooks doesn't export the constants; values from V8 source.
    if (kind & 1)
        return 'major';
    if (kind & 2)
        return 'minor';
    if (kind & 4)
        return 'incremental';
    if (kind & 8)
        return 'weakcb';
    return 'unknown';
}
// CPU usage tracking — sample at module init + reset on each stall.
// Tells us BUSY vs BLOCKED: high cpuPct = main was burning CPU on
// something we haven't instrumented; low cpuPct = main was blocked
// on sync I/O / native binding / kernel call. The freeze is one or
// the other, not a third thing.
let _lastCpuSample = { user: 0, system: 0 };
let _lastCpuSampleTs = 0;
function recordStall(durationMs) {
    if (!initialized)
        return;
    const nowMs = Date.now();
    const ctx = safeContext();
    const ts = new Date(nowMs).toISOString();
    const biggestBuf = pickBiggestBuffer(ctx.bufferSizes);
    const diverged = isDiverged(ctx.rates);
    const divergenceFlag = diverged ? 'DIVERGED' : 'OK';
    const gcWithinWindow = recentGc && (nowMs - recentGc.ts < 1000) ? recentGc : null;
    // Sub-millisecond GC pauses (typical incremental marking) round to
    // 0 with toFixed(0) and look like a parser bug. Use 1-decimal so a
    // 0.4 ms incremental pause shows as "0.4ms" not "0ms" — confirms the
    // observer is working AND surfaces the actual cost.
    const gcSegment = gcWithinWindow
        ? `GC=yes:${gcWithinWindow.type} ${gcWithinWindow.durationMs.toFixed(1)}ms`
        : 'GC=none';
    // CPU delta over the period since the last stall (or init).
    // If the stall is due to user code burning CPU, cpuPct ≈ 100.
    // If it's due to sync I/O blocking the main thread, cpuPct ≈ 0.
    const cpuDelta = process.cpuUsage(_lastCpuSample);
    const cpuMsUsed = (cpuDelta.user + cpuDelta.system) / 1000;
    const wallMs = Math.max(1, nowMs - _lastCpuSampleTs);
    const cpuPct = Math.round((cpuMsUsed / wallMs) * 100);
    const cpuVerdict = cpuPct > 60 ? 'BUSY' : cpuPct > 15 ? 'mixed' : 'BLOCKED';
    const cpuSegment = `cpu=${cpuPct}%/${cpuVerdict}(${cpuMsUsed.toFixed(0)}msCPU/${wallMs}msWall)`;
    // Reset baseline for next stall window.
    _lastCpuSample = process.cpuUsage();
    _lastCpuSampleTs = nowMs;
    const summary = `[STALL] ${ts} ${durationMs.toFixed(0)}ms | ${cpuSegment} | poll=${ctx.rates.poll.toFixed(1)} event=${ctx.rates.event.toFixed(1)} ${divergenceFlag} | ${gcSegment} | biggest_buffer: ${biggestBuf.name}=${biggestBuf.size} | wsNotify.buffered=${formatKb(ctx.socketBuffered.notify)}`;
    const detail = renderDetail(ctx);
    appendEntry(summary, detail);
    // Update the lifetime top-N tracker with a structured record. The
    // diagnostic uses this to surface the worst stalls of the session
    // with their timestamps and likely cause — answers "when did the
    // 14-second event-loop max come from, and what was happening?"
    // without requiring users to scroll through perf-stalls.log.
    maybeAddToTopStalls({
        ts: nowMs,
        durationMs,
        cpuPct,
        cpuVerdict,
        cpuMsUsed,
        wallMs,
        gcType: gcWithinWindow?.type,
        gcDurationMs: gcWithinWindow?.durationMs,
        biggestBuffer: biggestBuf.size > 0 ? { name: biggestBuf.name, size: biggestBuf.size } : undefined,
        notifyBufferedBytes: ctx.socketBuffered.notify,
        poll: ctx.rates.poll,
        event: ctx.rates.event,
        display: ctx.rates.display,
        diverged,
    });
}
function recordGc(type, durationMs) {
    if (!initialized)
        return;
    const ts = new Date().toISOString();
    const summary = `[GC]    ${ts} ${type} ${durationMs.toFixed(1)}ms`;
    appendEntry(summary, '');
}
/** Called when the rate-divergence check trips. Pass current rates + context. */
function recordDivergence(poll, event, display) {
    if (!initialized)
        return;
    const ts = new Date().toISOString();
    const ctx = safeContext();
    const summary = `[DIVERGE] ${ts} poll=${poll.toFixed(1)} event=${event.toFixed(1)} display=${display.toFixed(1)} | Δpoll-event=${(poll - event).toFixed(1)}`;
    const detail = renderDetail(ctx);
    appendEntry(summary, detail);
}
/** Called from electron-store wrappers when a .set() call exceeds threshold. */
function recordSlowStoreWrite(storeName, key, durationMs) {
    if (!initialized)
        return;
    if (durationMs < STORE_WRITE_THRESHOLD_MS)
        return;
    const ts = new Date().toISOString();
    const summary = `[STORE] ${ts} ${storeName}.set('${key}') took ${durationMs.toFixed(0)}ms`;
    appendEntry(summary, '');
}
/** Per-handler call timings (call count + total ms + max ms per
 *  method) accumulated since last dump. Dumped every 5 seconds
 *  during the first 60 seconds of process uptime via the periodic
 *  dumper started in init(). Reveals where loop time is going
 *  during the startup catch-up freeze even when no SINGLE call is
 *  slow — many small calls × N still add up. */
const handlerTimings = new Map();
let handlerTimingsStartedAt = 0;
/** Called from handleMessage's timing wrapper for EVERY call,
 *  regardless of duration. Cheap accumulator. Dumped periodically. */
function recordHandlerTiming(method, durationMs) {
    if (!initialized)
        return;
    let entry = handlerTimings.get(method);
    if (!entry) {
        entry = { calls: 0, totalMs: 0, maxMs: 0 };
        handlerTimings.set(method, entry);
    }
    entry.calls++;
    entry.totalMs += durationMs;
    if (durationMs > entry.maxMs)
        entry.maxMs = durationMs;
}
/** Called per handleMessage invocation when its duration exceeds the
 *  threshold. Writes a single line per slow call to perf-stalls.log
 *  so we can tally which methods are eating loop time during the
 *  startup catch-up freeze. Threshold is intentionally low (50 ms) so
 *  even moderately-slow handlers show up. */
function recordSlowHandler(method, durationMs) {
    if (!initialized)
        return;
    if (durationMs < 50)
        return;
    const ts = new Date().toISOString();
    const summary = `[HANDLER] ${ts} ${method} took ${durationMs.toFixed(0)}ms`;
    appendEntry(summary, '');
}
/** Dump per-method aggregated totals to the log, then reset
 *  accumulators. Sorted by total time descending so the dominant
 *  method floats to the top. Called periodically during the first
 *  60 s of process uptime — exactly the window where the catch-up
 *  freeze occurs. */
function dumpHandlerTimings() {
    if (handlerTimings.size === 0)
        return;
    const now = Date.now();
    const windowSec = ((now - handlerTimingsStartedAt) / 1000).toFixed(1);
    const sorted = [...handlerTimings.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
    const lines = [`[HANDLER-TOTALS] ${new Date().toISOString()} window=${windowSec}s`];
    for (const [method, e] of sorted) {
        const avg = (e.totalMs / e.calls).toFixed(2);
        lines.push(`  ${method}: ${e.calls} calls, total ${e.totalMs}ms, max ${e.maxMs}ms, avg ${avg}ms`);
    }
    appendRaw(lines.join('\n') + '\n');
    // Also push the summary into the in-memory ring so the diagnostic
    // dump shows it (perf-stalls.log section embeds last 50 ring entries).
    recentEntriesRing.push(lines[0]);
    if (recentEntriesRing.length > RECENT_RING_SIZE)
        recentEntriesRing.shift();
    // Reset accumulators for the next window.
    handlerTimings.clear();
    handlerTimingsStartedAt = now;
}
/** Called from getDaaEventBps when output > 50 BPS forces a clamp.
 *
 *  CRITICAL: must NOT call safeContext() here — that re-enters
 *  contextProvider() which calls monitor.getDaaEventBps(...) which
 *  re-clamps and re-calls this function, infinitely recursing until
 *  V8's stack-overflow safety net kicks in. The CPU profile from
 *  2026-04-30 showed ~44 sync appendFileSync calls per single clamp
 *  trigger, accumulating ~6 s of disk I/O per peer-flood burst — the
 *  dominant cause of the startup freeze.
 *
 *  Fix: log only the local values (rawValue is the unclamped event BPS;
 *  clampedTo is the cap). Skip rates/poll context — those are recorded
 *  separately by recordDivergence on its own 10 s timer. */
function recordClampFire(rawValue, clampedTo) {
    if (!initialized)
        return;
    // Coalesce: many clamp triggers in a tight burst record once per second.
    // The clamp is a continuous condition during catch-up, not 44 distinct
    // events — one per second is plenty for forensic depth without spamming.
    const now = Date.now();
    if (now - _lastClampLogTs < 1000) {
        _suppressedClampCount++;
        return;
    }
    const ts = new Date(now).toISOString();
    const suffix = _suppressedClampCount > 0 ? ` (+${_suppressedClampCount} suppressed)` : '';
    const summary = `[CLAMP] ${ts} raw=${rawValue.toFixed(1)} clamped=${clampedTo.toFixed(1)}${suffix}`;
    _lastClampLogTs = now;
    _suppressedClampCount = 0;
    appendEntry(summary, '');
}
let _lastClampLogTs = 0;
let _suppressedClampCount = 0;
/** Used by the diagnostic builder to embed the last N entries. */
function getRecentEntriesText() {
    if (!initialized)
        return '_(perf-stalls module not initialized)_';
    if (recentEntriesRing.length === 0)
        return '_(no events recorded yet — clean run)_';
    return recentEntriesRing.join('\n');
}
// --- internal helpers ---
function safeContext() {
    try {
        return contextProvider();
    }
    catch {
        return emptyContext();
    }
}
function isDiverged(rates) {
    return Math.abs(rates.poll - rates.event) > DIVERGENCE_THRESHOLD_BPS;
}
function pickBiggestBuffer(sizes) {
    let best = { name: 'none', size: 0 };
    for (const [name, size] of Object.entries(sizes)) {
        if (size > best.size)
            best = { name, size };
    }
    return best;
}
function formatKb(bytes) {
    if (bytes < 1024)
        return `${bytes}B`;
    return `${Math.round(bytes / 1024)}KB`;
}
function formatBufferSizes(sizes) {
    return Object.entries(sizes).map(([k, v]) => `${k}=${v}`).join(', ');
}
function renderDetail(ctx) {
    const lines = [];
    if (ctx.recentActivity.length > 0) {
        lines.push('  recent_activity:');
        for (const line of ctx.recentActivity)
            lines.push(`    ${line}`);
    }
    if (ctx.recentMethods.length > 0) {
        lines.push(`  recent_methods: [${ctx.recentMethods.join(', ')}]`);
    }
    lines.push(`  buffers: ${formatBufferSizes(ctx.bufferSizes)}`);
    lines.push(`  sockets: wsRpc.bufferedAmount=${ctx.socketBuffered.rpc}, wsNotify.bufferedAmount=${ctx.socketBuffered.notify}`);
    return lines.join('\n');
}
function appendEntry(summary, detail) {
    // Update in-memory ring for the diagnostic
    recentEntriesRing.push(summary);
    if (recentEntriesRing.length > RECENT_RING_SIZE)
        recentEntriesRing.shift();
    // Persist to disk
    const block = detail ? `${summary}\n${detail}\n` : `${summary}\n`;
    appendRaw(block);
}
// Async write queue. The previous implementation called
// fs.appendFileSync (and fs.existsSync + fs.statSync) on every single
// event — and during peer-flood catch-up the clamp logger fired dozens
// of times per tick, plus each call was wrapped by Windows AV scanning
// the log file, accumulating 6+ seconds of sync I/O on the main loop
// per startup. CPU profile (2026-04-30) made this unambiguous.
//
// New design: each event push appends to an in-memory buffer and
// schedules a single drain via setTimeout. The drain joins the buffer
// and writes it asynchronously via fs.promises.appendFile — does not
// block the event loop. Rotation is checked once per minute on its own
// timer, not on every write. Worst-case data loss: ~500 ms of buffered
// entries if the process crashes between flushes — acceptable for a
// diagnostic logger.
const _writeBuffer = [];
let _flushScheduled = false;
let _rotationTimer = null;
function appendRaw(text) {
    if (!logPath)
        return;
    _writeBuffer.push(text);
    if (!_flushScheduled) {
        _flushScheduled = true;
        setTimeout(_drainWriteBuffer, 500);
    }
    if (!_rotationTimer) {
        _rotationTimer = setInterval(_rotateIfOversized, 60_000);
    }
}
function _drainWriteBuffer() {
    _flushScheduled = false;
    if (_writeBuffer.length === 0 || !logPath)
        return;
    const block = _writeBuffer.join('');
    _writeBuffer.length = 0;
    fs_1.default.promises.appendFile(logPath, block).catch(() => {
        // best-effort — never escalate from a diagnostic logger
    });
}
function _rotateIfOversized() {
    if (!logPath)
        return;
    fs_1.default.promises.stat(logPath).then(stats => {
        if (stats.size <= MAX_LOG_BYTES)
            return;
        return fs_1.default.promises.open(logPath, 'r').then(fh => {
            const buf = Buffer.alloc(TRUNCATE_TO_BYTES);
            return fh.read(buf, 0, TRUNCATE_TO_BYTES, stats.size - TRUNCATE_TO_BYTES)
                .then(() => fh.close())
                .then(() => {
                const firstNl = buf.indexOf(0x0a);
                const tail = firstNl >= 0 ? buf.slice(firstNl + 1).toString('utf8') : buf.toString('utf8');
                return fs_1.default.promises.writeFile(logPath, tail);
            });
        });
    }).catch(() => {
        // file may not exist yet, or transient FS error — ignore
    });
}
//# sourceMappingURL=perf-stalls.js.map