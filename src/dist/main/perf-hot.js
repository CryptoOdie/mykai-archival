"use strict";
// Per-handler performance tracker for finding the source of event-loop lag.
//
// Why this exists: loop-lag.ts measures *that* the event loop is slow
// (p50 107ms is way above what 64 WS msgs/sec should produce). It doesn't
// tell us *why*. perf-hot.ts wraps suspect hot paths with performance.now()
// timing and dumps a per-handler breakdown every 30s so we can see which
// handler is actually consuming the most ms/sec.
//
// Off by default. Activate with `MYKAI_PERF_HOT=1` env var. Overhead per
// `track()` call is ~1µs (one performance.now() pair + one Map lookup +
// one float add). Negligible compared to the work being measured.
//
// Output is console.log only — it's a developer diagnostic. If we want to
// keep a snapshot in Insights heartbeats later, exposing getSnapshot() is
// straightforward.
//
// Lifecycle: import + call startPerfDump() once near app startup. The
// PerformanceObserver for GC events stays installed for the process
// lifetime; cheap.
Object.defineProperty(exports, "__esModule", { value: true });
exports.track = track;
exports.trackAsync = trackAsync;
exports.startMark = startMark;
exports.endMark = endMark;
exports.startPerfDump = startPerfDump;
exports.stopPerfDump = stopPerfDump;
exports.isPerfHotEnabled = isPerfHotEnabled;
const perf_hooks_1 = require("perf_hooks");
const ENABLED = process.env.MYKAI_PERF_HOT === '1';
const buckets = new Map();
function bucketFor(name) {
    let b = buckets.get(name);
    if (!b) {
        b = { name, count: 0, totalNs: 0, maxNs: 0 };
        buckets.set(name, b);
    }
    return b;
}
function record(name, ns) {
    const b = bucketFor(name);
    b.count++;
    b.totalNs += ns;
    if (ns > b.maxNs)
        b.maxNs = ns;
}
/** Sync wrapper. Returns the result of fn(); records timing under `name`. */
function track(name, fn) {
    if (!ENABLED)
        return fn();
    const start = perf_hooks_1.performance.now();
    try {
        return fn();
    }
    finally {
        record(name, (perf_hooks_1.performance.now() - start) * 1_000_000);
    }
}
/** Async wrapper. Awaits the promise; records the full elapsed time. */
async function trackAsync(name, fn) {
    if (!ENABLED)
        return fn();
    const start = perf_hooks_1.performance.now();
    try {
        return await fn();
    }
    finally {
        record(name, (perf_hooks_1.performance.now() - start) * 1_000_000);
    }
}
/** Manual timing — for inline scopes that aren't easily wrappable. */
function startMark() {
    return ENABLED ? perf_hooks_1.performance.now() : 0;
}
function endMark(name, mark) {
    if (!ENABLED || mark === 0)
        return;
    record(name, (perf_hooks_1.performance.now() - mark) * 1_000_000);
}
let dumpTimer = null;
let lastDumpTs = 0;
/** Start a 30-second periodic dump to console. Idempotent; safe to call
 *  multiple times. No-op if MYKAI_PERF_HOT isn't set. */
function startPerfDump(intervalMs = 30_000) {
    if (!ENABLED)
        return;
    if (dumpTimer)
        return;
    lastDumpTs = Date.now();
    // GC observer — captures V8 garbage-collection pause times. These don't
    // run in any user-space handler, so they wouldn't be caught by track()
    // alone. If GC is a meaningful contributor (>10ms/sec total pause), we
    // want to see that distinctly.
    try {
        const gcObs = new perf_hooks_1.PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                record(`gc.${entry.detail?.kind ?? 'unknown'}`, entry.duration * 1_000_000);
            }
        });
        gcObs.observe({ entryTypes: ['gc'] });
    }
    catch (err) {
        console.error('[perf-hot] GC observer setup failed:', err.message);
    }
    dumpTimer = setInterval(() => {
        const now = Date.now();
        const windowSec = (now - lastDumpTs) / 1000;
        lastDumpTs = now;
        const sorted = [...buckets.values()].sort((a, b) => b.totalNs - a.totalNs);
        const lines = [];
        lines.push('');
        lines.push(`=== PERF-HOT SNAPSHOT (last ${windowSec.toFixed(1)}s) ===`);
        lines.push('  rank  name                                              count       total/s    max     avg');
        lines.push('  ----  ------------------------------------------------  --------  ----------  ------  ------');
        let rank = 0;
        let totalAccountedNs = 0;
        // Show 60 entries instead of 25 so the count-only histograms
        // (daa.interarrival.*, daa.scoreDelta.*, blockAdded.interarrival.*)
        // all fit. Each of those is a 0-duration bucket that loses the
        // total/sec sort, so the smaller buckets fall off the bottom.
        for (const b of sorted.slice(0, 60)) {
            rank++;
            const totalMsPerSec = (b.totalNs / 1_000_000 / windowSec);
            const maxMs = b.maxNs / 1_000_000;
            const avgMs = b.totalNs / b.count / 1_000_000;
            lines.push('  ' +
                String(rank).padStart(4) + '  ' +
                b.name.padEnd(48) + '  ' +
                String(b.count).padStart(8) + '  ' +
                (totalMsPerSec.toFixed(2) + 'ms').padStart(10) + '  ' +
                (maxMs.toFixed(2) + 'ms').padStart(6) + '  ' +
                (avgMs.toFixed(3) + 'ms').padStart(7));
            totalAccountedNs += b.totalNs;
        }
        const totalMsPerSec = totalAccountedNs / 1_000_000 / windowSec;
        lines.push(`  ----`);
        lines.push(`  TOTAL accounted across all buckets: ${totalMsPerSec.toFixed(1)} ms/sec of CPU work`);
        lines.push(`  (loop-lag p50 will be roughly this number if tracked work is the dominant contributor)`);
        console.log(lines.join('\n'));
        // Reset for next window
        for (const b of buckets.values()) {
            b.count = 0;
            b.totalNs = 0;
            b.maxNs = 0;
        }
    }, intervalMs);
    // Don't keep the process alive just for this timer
    dumpTimer.unref?.();
    console.log('[perf-hot] tracking enabled, snapshot every ' + intervalMs + 'ms');
}
function stopPerfDump() {
    if (dumpTimer) {
        clearInterval(dumpTimer);
        dumpTimer = null;
    }
}
/** True if MYKAI_PERF_HOT is set. Lets call sites short-circuit before
 *  building the wrapped function (e.g. avoid arrow-fn allocation). */
function isPerfHotEnabled() {
    return ENABLED;
}
//# sourceMappingURL=perf-hot.js.map