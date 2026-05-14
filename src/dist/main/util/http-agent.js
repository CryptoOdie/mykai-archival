"use strict";
/**
 * Shared keep-alive HTTP/HTTPS agents.
 *
 * Problem this solves: without keep-alive, every outbound heartbeat / clock
 * probe / KasMap POST / GitHub update check opens a fresh TCP connection
 * that then lands in TIME_WAIT for ~2 minutes. After an 11-hour uptime a
 * real user's main process had accumulated 401 socket handles (48
 * Established + ~353 in TIME_WAIT / Bound), causing periodic freezes
 * from event-loop pressure and filling the ephemeral port pool.
 *
 * Fix: a single shared Agent per protocol, with keepAlive=true. Every
 * module that makes outbound HTTP(S) requests uses these agents, which
 * reuse TCP connections when possible. Expected steady-state sockets:
 * 3-5, not hundreds.
 *
 * Tuning:
 *  - keepAliveMsecs: 60s — covers the gap between our 5-min heartbeats
 *    (which is less than keep-alive TTL on Vercel/Cloudflare so sockets
 *    stay warm); the 60s keepalive probe is sent every minute while idle.
 *  - maxSockets: 10 — more than enough for our concurrent outbound needs
 *    (heartbeat + kasmap + clock probe rarely overlap).
 *  - maxFreeSockets: 4 — retained in the pool between requests.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sharedHttpAgent = exports.sharedHttpsAgent = void 0;
const https_1 = __importDefault(require("https"));
const http_1 = __importDefault(require("http"));
exports.sharedHttpsAgent = new https_1.default.Agent({
    keepAlive: true,
    keepAliveMsecs: 60_000,
    maxSockets: 10,
    maxFreeSockets: 4,
    timeout: 60_000,
});
exports.sharedHttpAgent = new http_1.default.Agent({
    keepAlive: true,
    keepAliveMsecs: 60_000,
    maxSockets: 10,
    maxFreeSockets: 4,
    timeout: 60_000,
});
//# sourceMappingURL=http-agent.js.map