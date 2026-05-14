"use strict";
/**
 * Host hardware specs + live usage.
 *
 * Reports what the container/machine has available (respects cgroup limits
 * on Linux). Used for Insights to show node operators what they're running on
 * and how busy each core actually is — helpful for matching cloud tiers and
 * seeing Kaspa multi-core utilization as the protocol evolves.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHostSpecs = getHostSpecs;
const os_1 = __importDefault(require("os"));
let _lastSnapshot = null;
/**
 * Capture per-core CPU usage over the window since the last call.
 * First call returns zeros (no prior snapshot to diff against).
 */
function sampleCpuPercentPerCore() {
    const cpus = os_1.default.cpus();
    const snapshot = cpus.map(c => {
        const t = c.times;
        const idle = t.idle;
        const total = t.user + t.nice + t.sys + t.idle + t.irq;
        return { idle, total };
    });
    if (!_lastSnapshot || _lastSnapshot.length !== snapshot.length) {
        _lastSnapshot = snapshot;
        return snapshot.map(() => 0);
    }
    const percents = snapshot.map((cur, i) => {
        const prev = _lastSnapshot[i];
        const idleDelta = cur.idle - prev.idle;
        const totalDelta = cur.total - prev.total;
        if (totalDelta <= 0)
            return 0;
        const busy = 1 - idleDelta / totalDelta;
        return Math.max(0, Math.min(100, Math.round(busy * 100)));
    });
    _lastSnapshot = snapshot;
    return percents;
}
/**
 * Parse a Node.js CPU model string into non-identifying bucket values.
 * Strips the specific model number to prevent fingerprinting.
 *
 * Examples:
 *   "Intel(R) Xeon(R) CPU E5-2670 v2 @ 2.50GHz"  -> Intel / Xeon / 2.5
 *   "AMD Ryzen 9 7950X3D 16-Core Processor"       -> AMD / Ryzen / 0
 *   "Apple M2 Pro"                                 -> Apple / M / 0
 *   "12th Gen Intel(R) Core(TM) i7-12700K"        -> Intel / Core / 0
 */
function parseCpuModel(raw) {
    const s = raw.replace(/\(R\)|\(TM\)/g, '').replace(/\s+/g, ' ').trim();
    const lower = s.toLowerCase();
    let vendor = '';
    if (lower.includes('intel'))
        vendor = 'Intel';
    else if (lower.includes('amd'))
        vendor = 'AMD';
    else if (lower.includes('apple'))
        vendor = 'Apple';
    else if (lower.includes('arm') || lower.match(/cortex/i))
        vendor = 'ARM';
    let family = '';
    const families = ['Xeon', 'Core', 'Ryzen', 'EPYC', 'Threadripper', 'Athlon', 'Pentium', 'Celeron', 'Atom'];
    for (const f of families) {
        if (lower.includes(f.toLowerCase())) {
            family = f;
            break;
        }
    }
    // Apple M1/M2/M3... — keep just the "M" prefix, not the exact chip rev
    if (!family && vendor === 'Apple' && /\bm\d/i.test(s))
        family = 'M';
    let clockGhz = 0;
    const clockMatch = s.match(/(\d+(?:\.\d+)?)\s*GHz/i);
    if (clockMatch)
        clockGhz = Math.round(parseFloat(clockMatch[1]) * 10) / 10;
    return { vendor, family, clockGhz };
}
function getHostSpecs() {
    const cpus = os_1.default.cpus();
    const load = os_1.default.loadavg(); // [1m, 5m, 15m]; returns [0,0,0] on Windows
    const cpuInfo = parseCpuModel(cpus[0]?.model || '');
    // Modern Intel CPUs (12th gen+) don't embed `@ X.XX GHz` in the model
    // string, so parseCpuModel returns 0. Fall back to os.cpus()[0].speed
    // which reports the base clock in MHz. Round to 1 decimal GHz.
    let clockGhz = cpuInfo.clockGhz;
    if (clockGhz === 0 && cpus[0]?.speed) {
        clockGhz = Math.round((cpus[0].speed / 1000) * 10) / 10;
    }
    return {
        ramBytes: os_1.default.totalmem(), // raw bytes, no rounding
        ramFreeBytes: os_1.default.freemem(), // raw bytes, Insights computes % if needed
        cpuCount: cpus.length,
        cpuVendor: cpuInfo.vendor,
        cpuFamily: cpuInfo.family,
        cpuClockGhz: clockGhz,
        cpuLoad1m: Math.round((load[0] || 0) * 100) / 100,
        cpuPercentPerCore: sampleCpuPercentPerCore(),
        platform: process.platform,
    };
}
//# sourceMappingURL=host-specs.js.map