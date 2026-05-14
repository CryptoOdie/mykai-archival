"use strict";
/**
 * Clock Offset Detector
 *
 * Measures the difference between the local system clock and a reliable
 * remote server. Applies the offset to all timestamps sent to Insights,
 * so nodes with drifted clocks (common on Windows) still report accurate
 * propagation times.
 *
 * No admin privileges needed — we don't touch the system clock.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.correctedNow = correctedNow;
exports.getClockOffset = getClockOffset;
exports.startClockSync = startClockSync;
exports.stopClockSync = stopClockSync;
exports.remeasureNow = remeasureNow;
const https_1 = __importDefault(require("https"));
const http_agent_1 = require("./util/http-agent");
const ntp_client_1 = require("./ntp-client");
const PROBE_URL = 'https://mykai.dev/api/time';
const FALLBACK_URLS = [
    'https://cloudflare.com/cdn-cgi/trace',
    'https://www.google.com',
];
const REFRESH_INTERVAL = 30 * 60 * 1000; // re-measure every 30 minutes
const WARN_THRESHOLD_MS = 2000; // warn if clock is off by > 2 seconds
let _offsetMs = 0; // positive = local clock is behind, negative = ahead
let _lastMeasured = 0;
let _timer = null;
let _onWarning = null;
let _measuring = false; // in-flight guard — see measureOffset()
/**
 * Returns a corrected timestamp (Date.now() + offset).
 * Use this instead of Date.now() for any timestamp sent to Insights.
 */
function correctedNow() {
    return Date.now() + _offsetMs;
}
/** Current measured offset in ms (positive = local clock behind UTC) */
function getClockOffset() {
    return _offsetMs;
}
/**
 * Start periodic clock offset measurement.
 * @param onWarning — called when offset exceeds threshold (for UI notification)
 */
function startClockSync(onWarning) {
    _onWarning = onWarning || null;
    measureOffset(); // immediate first measurement
    _timer = setInterval(measureOffset, REFRESH_INTERVAL);
}
function stopClockSync() {
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
}
/** Force an immediate offset re-measurement (e.g. after a user-triggered fix). */
function remeasureNow() {
    measureOffset();
}
async function measureOffset() {
    // In-flight guard. Without this, if a probe takes longer than the 30-min
    // refresh interval (unlikely but possible on hanging TLS handshakes), the
    // interval tick would spawn a parallel probe. Probes all write to the same
    // global offset; overlapping runs caused stale values and leaked sockets.
    if (_measuring)
        return;
    _measuring = true;
    try {
        // Primary: NTP via UDP. Millisecond precision, uses 4-timestamp symmetric
        // math instead of HTTP Date header's 1-second quantization. Insights dev
        // asked for this — once fleet reports honest NTP offsets, they can drop
        // the fleet-median dead-zone gate.
        const ntp = await (0, ntp_client_1.queryNtp)();
        if (ntp !== null) {
            _offsetMs = ntp.offsetMs;
            _lastMeasured = Date.now();
            if (Math.abs(_offsetMs) > WARN_THRESHOLD_MS && _onWarning) {
                _onWarning(_offsetMs);
            }
            return;
        }
        // Fallback: HTTP Date header probing for networks that block UDP/123
        // (corporate firewalls, some hotel Wi-Fi). Keeps the old behavior.
        const urls = [PROBE_URL, ...FALLBACK_URLS];
        for (const url of urls) {
            try {
                const offset = await probeUrl(url);
                if (offset !== null) {
                    _offsetMs = offset;
                    _lastMeasured = Date.now();
                    if (Math.abs(_offsetMs) > WARN_THRESHOLD_MS && _onWarning) {
                        _onWarning(_offsetMs);
                    }
                    return;
                }
            }
            catch {
                // Try next URL
            }
        }
        // All failed — keep previous offset (or 0 if never measured)
    }
    finally {
        _measuring = false;
    }
}
function probeUrl(url) {
    return new Promise((resolve, reject) => {
        const localBefore = Date.now();
        const req = https_1.default.request(url, { method: 'HEAD', timeout: 5000, agent: http_agent_1.sharedHttpsAgent }, (res) => {
            const localAfter = Date.now();
            const dateHeader = res.headers['date'];
            res.resume(); // drain response
            if (!dateHeader) {
                resolve(null);
                return;
            }
            const serverTime = new Date(dateHeader).getTime();
            if (isNaN(serverTime)) {
                resolve(null);
                return;
            }
            // Account for network round-trip: assume server timestamp is midpoint
            const localMid = (localBefore + localAfter) / 2;
            const offset = serverTime - localMid;
            resolve(Math.round(offset));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
    });
}
//# sourceMappingURL=clock-offset.js.map