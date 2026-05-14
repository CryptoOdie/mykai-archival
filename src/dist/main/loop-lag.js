"use strict";
/**
 * Main-thread event-loop delay meter.
 *
 * Started at module load so percentile data is already warm by the time
 * diagnostic.ts reads it. Extracted into its own module to avoid circular
 * imports (main.ts → ipc-handlers.ts → diagnostic.ts → main.ts).
 *
 * IMPORTANT: Node's `monitorEventLoopDelay` records the actual interval
 * between consecutive sampling-timer fires. With resolution=N, the
 * baseline sample is exactly N (ticks fire every N ms by design). The
 * histogram percentiles therefore report `target_interval + actual_lag`,
 * not `actual_lag` alone. Subtract RESOLUTION_MS from each percentile to
 * get the lag value that means "extra delay above the scheduled tick."
 *
 * Resolution kept at 100 ms because the sampling cost is negligible and
 * it's fine-grained enough to catch the 200-500 ms stalls we care about
 * (large sync JSON.stringify + gzip on multi-MB Insights payloads, e.g.).
 * Going to resolution=10 (the Node default) would 10× the timer fires
 * with no actionable benefit — we don't act on sub-50ms anomalies.
 *
 * Background: prior versions of this module subtracted nothing, which
 * meant p50 always reported `~RESOLUTION_MS + Windows kernel timer slop`
 * regardless of actual loop health. Across multiple sessions that read
 * as "your event loop has 107ms p50 lag" — alarming and false. Real p50
 * lag is typically <10ms on a healthy node.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLoopLagPercentiles = getLoopLagPercentiles;
const perf_hooks_1 = require("perf_hooks");
const RESOLUTION_MS = 100;
const hist = (0, perf_hooks_1.monitorEventLoopDelay)({ resolution: RESOLUTION_MS });
hist.enable();
function getLoopLagPercentiles() {
    // Histogram reports nanoseconds; convert to ms then subtract the
    // resolution baseline so "lag" = "extra delay above the scheduled tick."
    // Math.max(..., 0) handles the (rare) case where a percentile bucket
    // dips slightly below the resolution baseline due to integer rounding.
    return {
        p50Ms: Math.max(0, Math.round(hist.percentile(50) / 1e6) - RESOLUTION_MS),
        p99Ms: Math.max(0, Math.round(hist.percentile(99) / 1e6) - RESOLUTION_MS),
        maxMs: Math.max(0, Math.round(hist.max / 1e6) - RESOLUTION_MS),
    };
}
//# sourceMappingURL=loop-lag.js.map