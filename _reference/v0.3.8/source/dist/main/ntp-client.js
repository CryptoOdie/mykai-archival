"use strict";
/**
 * Minimal NTP v3 client (RFC 5905) over UDP.
 *
 * Replaces our previous HTTP-Date-header probe for clock offset measurement.
 * Benefits:
 *  - Millisecond precision (HTTP Date header is 1-second quantized)
 *  - Symmetric round-trip math using 4 timestamps (T1, T2, T3, T4)
 *  - Proven protocol, used by every real NTP client
 *  - No reliance on random HTTPS servers' clock accuracy
 *
 * Insights dev's request: once all nodes in the fleet report honest
 * NTP-based offsets, they can drop the fleet-median dead-zone gate
 * (which exists specifically to compensate for our HTTP-based noise).
 *
 * Protocol: 48-byte packet.
 *   Byte 0: LI=0, VN=3, Mode=3 (client)
 *   Bytes 24-31: originate timestamp (we set T1 before sending)
 *   Server fills receive (T2) and transmit (T3) timestamps.
 *   Client records T4 on packet arrival.
 *
 * Offset formula: offset = ((T2 - T1) + (T3 - T4)) / 2
 *                 delay  = (T4 - T1) - (T3 - T2)
 *
 * Timestamps in NTP format: seconds since 1900-01-01 UTC + fractional part
 * in 2^-32 units. JS Date uses 1970-01-01 Unix epoch — add 2208988800 sec.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.queryNtp = queryNtp;
const dgram_1 = __importDefault(require("dgram"));
const NTP_PORT = 123;
const NTP_EPOCH_OFFSET_SEC = 2_208_988_800; // seconds from 1900 to 1970
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_SERVERS = [
    'pool.ntp.org',
    'time.cloudflare.com',
    'time.google.com',
];
/**
 * Query the first responsive server in the list. Returns null if all fail.
 * Caller should use this in fallback-chain style: try pool.ntp.org first,
 * fall back to HTTP probe if UDP is blocked (some corporate firewalls).
 */
async function queryNtp(servers = DEFAULT_SERVERS, timeoutMs = DEFAULT_TIMEOUT_MS) {
    for (const server of servers) {
        try {
            const result = await queryOneServer(server, timeoutMs);
            return result;
        }
        catch {
            // Try next server
        }
    }
    return null;
}
function queryOneServer(server, timeoutMs) {
    return new Promise((resolve, reject) => {
        const socket = dgram_1.default.createSocket('udp4');
        const packet = buildClientPacket();
        // T1 is set in the packet; T4 is recorded when we get the reply.
        const t1 = Date.now();
        const timer = setTimeout(() => {
            try {
                socket.close();
            }
            catch { /* ignore */ }
            reject(new Error('NTP timeout'));
        }, timeoutMs);
        socket.once('message', (msg) => {
            const t4 = Date.now();
            clearTimeout(timer);
            try {
                socket.close();
            }
            catch { /* ignore */ }
            try {
                const { t2, t3 } = parseResponse(msg);
                const offsetMs = Math.round(((t2 - t1) + (t3 - t4)) / 2);
                const delayMs = Math.max(0, (t4 - t1) - (t3 - t2));
                resolve({ offsetMs, delayMs, server });
            }
            catch (err) {
                reject(err);
            }
        });
        socket.once('error', (err) => {
            clearTimeout(timer);
            try {
                socket.close();
            }
            catch { /* ignore */ }
            reject(err);
        });
        socket.send(packet, NTP_PORT, server, (err) => {
            if (err) {
                clearTimeout(timer);
                try {
                    socket.close();
                }
                catch { /* ignore */ }
                reject(err);
            }
        });
    });
}
/**
 * Build a 48-byte NTP v3 client request packet.
 * Sets byte 0 = 0x1B (LI=0, VN=3, Mode=3) and leaves the rest zero —
 * we don't bother setting our T1 timestamp in the originate field because
 * we compute offsets locally. Some servers echo it back; we don't need it.
 */
function buildClientPacket() {
    const buf = Buffer.alloc(48);
    buf[0] = 0x1b; // 00 011 011 = LI=0, VN=3, Mode=3 (client)
    return buf;
}
function parseResponse(buf) {
    if (buf.length < 48)
        throw new Error('NTP response too short');
    // Receive timestamp (T2) — bytes 32-39
    const t2 = readNtpTimestamp(buf, 32);
    // Transmit timestamp (T3) — bytes 40-47
    const t3 = readNtpTimestamp(buf, 40);
    return { t2, t3 };
}
/** Read an 8-byte NTP timestamp starting at `offset`. Returns ms since unix epoch. */
function readNtpTimestamp(buf, offset) {
    const seconds = buf.readUInt32BE(offset);
    const fractional = buf.readUInt32BE(offset + 4);
    // Convert fractional part (2^-32 units) to milliseconds
    const fracMs = (fractional / 0x1_0000_0000) * 1000;
    // NTP epoch → Unix epoch → milliseconds
    return (seconds - NTP_EPOCH_OFFSET_SEC) * 1000 + fracMs;
}
//# sourceMappingURL=ntp-client.js.map