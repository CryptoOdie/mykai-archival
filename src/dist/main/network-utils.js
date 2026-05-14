"use strict";
/**
 * Network Utilities
 *
 * Detects LAN and public IP addresses for mining connection URLs.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLanIp = getLanIp;
exports.getPublicIp = getPublicIp;
exports.getStratumUrl = getStratumUrl;
const os_1 = __importDefault(require("os"));
const https_1 = __importDefault(require("https"));
/**
 * Get the first non-internal IPv4 address (LAN IP).
 * Prefers Ethernet over WiFi.
 */
function getLanIp() {
    const interfaces = os_1.default.networkInterfaces();
    let fallback = '127.0.0.1';
    // Priority: Ethernet > WiFi > anything else
    const priorityNames = ['Ethernet', 'eth0', 'en0', 'Wi-Fi', 'wlan0'];
    for (const name of priorityNames) {
        const iface = interfaces[name];
        if (iface) {
            for (const addr of iface) {
                if (addr.family === 'IPv4' && !addr.internal) {
                    return addr.address;
                }
            }
        }
    }
    // Fallback: any non-internal IPv4
    for (const [, iface] of Object.entries(interfaces)) {
        if (!iface)
            continue;
        for (const addr of iface) {
            if (addr.family === 'IPv4' && !addr.internal) {
                if (fallback === '127.0.0.1')
                    fallback = addr.address;
            }
        }
    }
    return fallback;
}
/**
 * Get public IP address via ipify. Only call when user has opted in.
 */
async function getPublicIp() {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(''), 5000);
        const req = https_1.default.get('https://api.ipify.org', (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                clearTimeout(timer);
                resolve(raw.trim());
            });
        });
        req.on('error', () => { clearTimeout(timer); resolve(''); });
    });
}
/**
 * Format a stratum connection URL.
 */
function getStratumUrl(ip, port) {
    return `stratum+tcp://${ip}:${port}`;
}
//# sourceMappingURL=network-utils.js.map