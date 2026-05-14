"use strict";
/**
 * System load snapshot — averaged CPU%, memory pressure, top processes.
 *
 * Why this exists: today (2026-04-28) we spent the day chasing a
 * "performance bug" that turned out to be the user's machine running
 * 143 Edge processes + Claude + multiple browsers + Docker + ... while
 * also asking it to run a Kaspa full node. The diagnostic had per-core
 * CPU% but no aggregated view, and `os.loadavg()` returns 0 on Windows
 * — so there was no signal that "your system is on fire, MyKAI is
 * being CPU-starved."
 *
 * After PC restart with fewer apps running: BPS converged perfectly,
 * mempool read correctly, freezes stopped. Everything we built today
 * (3-rate truth table, perf-stalls.log, caps, yields, clamp) was
 * over-engineered for the actual root cause, which was system load.
 *
 * This module provides:
 *   - getSystemLoad(): Promise<SystemLoad>  one-shot snapshot
 *   - startCpuTracking(): begins continuous CPU sampling
 *   - System overload heuristic + advisory string
 *
 * Top-process enumeration uses PowerShell `Get-Process` because Windows
 * has no portable equivalent in Node's stdlib. ~250 ms execution time
 * the first call (PowerShell startup), <50 ms afterwards. Cached for
 * 5 s to avoid spawning on every diagnostic.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startCpuTracking = startCpuTracking;
exports.getProcessSnapshot = getProcessSnapshot;
exports.getTopProcesses = getTopProcesses;
exports.getSystemLoad = getSystemLoad;
exports.renderOverloadAdvisory = renderOverloadAdvisory;
const os_1 = __importDefault(require("os"));
const child_process_1 = require("child_process");
// CPU sampling state — populated by startCpuTracking() and read on
// each getSystemLoad() call. We compute aggregated CPU% as a delta
// between two samples (~5 s apart) the same way htop does.
let lastCpuSample = null;
let cpuPctAvgCached = 0;
/** Sample CPU times across all cores. Returns aggregated total/idle
 *  in milliseconds since boot. Diff two samples to compute %busy. */
function sampleCpuTimes() {
    const cpus = os_1.default.cpus();
    let total = 0;
    let idle = 0;
    for (const c of cpus) {
        total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
        idle += c.times.idle;
    }
    return { total, idle };
}
/** Begin sampling CPU% every 5 s. Idempotent. Call once at app
 *  startup; the cached value is read by getSystemLoad(). */
function startCpuTracking() {
    if (lastCpuSample)
        return;
    lastCpuSample = { ts: Date.now(), ...sampleCpuTimes() };
    setInterval(() => {
        const now = Date.now();
        const cur = sampleCpuTimes();
        if (lastCpuSample) {
            const totalDelta = cur.total - lastCpuSample.total;
            const idleDelta = cur.idle - lastCpuSample.idle;
            if (totalDelta > 0) {
                cpuPctAvgCached = Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
            }
        }
        lastCpuSample = { ts: now, ...cur };
    }, 5_000);
}
let processSnapshotCache = null;
const TOP_PROCESS_CACHE_MS = 5_000;
/** Substring-match identifier for "this is one of OUR processes worth
 *  surfacing by name." Lowercase comparison. Matches kaspad.exe and
 *  the various Electron processes (MyKAI Node.exe, plus child renderer
 *  / GPU / utility processes which all carry "MyKAI Node" in their
 *  name on Windows). */
function isOwnProcess(name) {
    const lower = name.toLowerCase();
    return lower.includes('mykai') || lower.includes('kaspad');
}
/** Enumerate processes by CPU% via PowerShell, returning two slices:
 *
 *    top — the top-N by CPU descending (privacy-redacted to "other"
 *          at the diagnostic-rendering layer except for ours)
 *    own — every kaspad/MyKAI process found in a wider window, with
 *          rank populated. Lets the diagnostic always show "where am
 *          I in the system-wide CPU sort" even when ours is below the
 *          top-N cutoff.
 *
 *  Returns { top: [], own: [] } on platforms other than Windows or
 *  on enumeration failure (best-effort diagnostic — never throws). */
async function getProcessSnapshot(limit = 5) {
    if (process.platform !== 'win32')
        return { top: [], own: [] };
    if (processSnapshotCache && Date.now() - processSnapshotCache.ts < TOP_PROCESS_CACHE_MS) {
        return processSnapshotCache.data;
    }
    try {
        const data = await new Promise((resolve, reject) => {
            // Get-Process gives CPU = total CPU-seconds since process start
            // (NOT instantaneous %). To get current % we'd need two samples
            // ~1 s apart. Cheaper alternative: typeperf or Get-Counter.
            // Get-Counter gives instantaneous % but is heavier.
            //
            // Compromise: use Get-Process CPU column AND WS (working set)
            // sorted by CPU descending. Recent-CPU dominates the ordering
            // for short-lived processes, so it surfaces "what's been busy
            // lately" which is what we actually want for diagnostic
            // attribution. Not as precise as instantaneous %, but free and
            // correlates well with "what's hogging the machine."
            //
            // Fetch a wide window so we can always surface ours regardless of
            // their rank in the system-wide CPU sort. On busy machines (e.g.
            // 32-core with 100+ active processes) MyKAI's 4 Electron processes
            // (main + renderer + GPU + utility) each contribute only 1-3%
            // recent-CPU individually, so they routinely fall below rank 30 on
            // machines with several heavy apps. Bumping the floor to 500 covers
            // any realistic process-table size — Get-Process + ConvertTo-Json on
            // 500 entries is ~100 ms on Windows, still well below the 250 ms
            // PowerShell-spawn cost which dominates the call. Cached for 5 s
            // anyway, so this fires once per diagnostic at most.
            const fetchCount = Math.max(limit * 5, 500);
            const ps = `Get-Process | Where-Object { $_.CPU -ne $null } | Sort-Object CPU -Descending | Select-Object -First ${fetchCount} Name,CPU,WS | ConvertTo-Json -Compress`;
            (0, child_process_1.exec)(`powershell.exe -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { timeout: 3000, windowsHide: true }, (err, stdout) => {
                if (err)
                    return reject(err);
                try {
                    const raw = stdout.trim();
                    if (!raw)
                        return resolve({ top: [], own: [] });
                    const parsed = JSON.parse(raw);
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    // Convert CPU-seconds to a normalized "% of total CPU time
                    // since this process started" — rough, but the DESCENDING
                    // sort is what matters more than the absolute number.
                    // We cap-display as relative weight rather than %.
                    const totalCpu = arr.reduce((sum, p) => sum + (p.CPU || 0), 0) || 1;
                    const all = arr.map((p, idx) => ({
                        name: String(p.Name || 'unknown'),
                        cpuPct: Math.round(((p.CPU || 0) / totalCpu) * 100),
                        memMB: Math.round((p.WS || 0) / (1024 * 1024)),
                        rank: idx + 1,
                    }));
                    // top-N: drop rank since position is implicit. own: keep
                    // rank — that's the whole point of this slice.
                    const top = all.slice(0, limit).map(p => {
                        const { rank: _r, ...rest } = p; // strip rank for top-N
                        return rest;
                    });
                    const own = all.filter(p => isOwnProcess(p.name));
                    resolve({ top, own });
                }
                catch (parseErr) {
                    reject(parseErr);
                }
            });
        });
        processSnapshotCache = { ts: Date.now(), data };
        return data;
    }
    catch {
        return { top: [], own: [] };
    }
}
/** @deprecated Use getProcessSnapshot() — kept for transitional
 *  back-compat with any caller still using the old name. Returns
 *  only the top-N slice. */
async function getTopProcesses(limit = 5) {
    return (await getProcessSnapshot(limit)).top;
}
/** Compute heuristic overload flags. Thresholds are deliberately
 *  conservative — false positives erode user trust. Hotfix #4
 *  (2026-04-29) tightened these after observing the warning fire on
 *  a healthy machine just because Claude (a Chrome tab) used 25% of
 *  recent-CPU on a 32-core box where avg CPU was 20%.
 *
 *  Rule: only fire when there is GENUINE system pressure — not when
 *  one moderately-busy app shows up in the top-5. The two real signals:
 *
 *  1. Aggregated CPU > 60% — the whole machine is busy, our
 *     single-threaded JS may struggle to get scheduled.
 *  2. Memory > 90% — Windows starts paging, which freezes any app
 *     mid-write.
 *
 *  Per-process flags are demoted to NEEDING those system-level
 *  conditions to be true; we no longer fire on per-process alone.
 *  The top-process list is still in the `## System load` diagnostic
 *  section so the user can see WHO's hogging CPU when the advisory
 *  does fire. */
function computeOverload(load) {
    const reasons = [];
    if (load.cpuPctAvg > 60) {
        reasons.push(`CPU averaged ${load.cpuPctAvg.toFixed(0)}% across ${load.cpuCores} cores`);
    }
    if (load.memPct > 90) {
        reasons.push(`Memory ${load.memPct.toFixed(0)}% used (${load.memUsedGB.toFixed(1)} GB / ${load.memTotalGB.toFixed(1)} GB)`);
    }
    return { overloaded: reasons.length > 0, reasons };
}
/** One-shot snapshot of system load. Async because top-process
 *  enumeration spawns PowerShell. Always resolves — never throws. */
async function getSystemLoad() {
    const cpuCores = os_1.default.cpus().length;
    const memTotal = os_1.default.totalmem();
    const memFree = os_1.default.freemem();
    const memUsed = memTotal - memFree;
    const memTotalGB = memTotal / (1024 ** 3);
    const memUsedGB = memUsed / (1024 ** 3);
    const memPct = (memUsed / memTotal) * 100;
    const { top: topProcesses, own: ownProcesses } = await getProcessSnapshot(5);
    const partial = {
        cpuPctAvg: cpuPctAvgCached,
        cpuCores,
        memUsedGB,
        memTotalGB,
        memPct,
        topProcesses,
        ownProcesses,
    };
    const flags = computeOverload(partial);
    return { ...partial, ...flags };
}
/** Render a one-line overload advisory for the diagnostic header.
 *  Empty string when not overloaded. */
function renderOverloadAdvisory(load) {
    if (!load.overloaded)
        return '';
    return `> ⚠️ **System under heavy load.** MyKAI may be CPU-starved by other apps.\n> ${load.reasons.map(r => `- ${r}`).join('\n> ')}\n> _Close the heavy apps and re-test before reporting MyKAI bugs — most "freeze" reports trace back to this._\n`;
}
//# sourceMappingURL=system-load.js.map