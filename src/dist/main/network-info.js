"use strict";
/**
 * Network interface profile for the local node.
 *
 * Answers questions like:
 *   - Is this user on Ethernet, Wi-Fi, or cellular?
 *   - What's their adapter's reported link speed?
 *   - Do they have IPv6?
 *
 * Critical context for Insights when interpreting slow IBD / high orphan
 * counts / peer-instability patterns (e.g. KE Mlolongo + PH Calamba + IN
 * Shimla — need to distinguish "user on 4G" from "user on cable but far
 * from peers"). Without this data, all three patterns look identical.
 *
 * Privacy:
 *   - No MAC addresses, SSIDs, local IP ranges, or gateway IPs sent
 *   - Adapter hardware description (e.g. "Intel Wi-Fi 6 AX201") included
 *     only in T2/T3 diagnostic; not in T1 baseline bronze
 *   - Cross-platform: Node's os.networkInterfaces() for basics; PowerShell
 *     enrichment on Windows for link speed + adapter type
 *
 * Cost:
 *   - Cached 5 min; one PowerShell spawn per cache miss (~100-300ms)
 *   - Fire-and-forget; errors silently fall back to the Node-only view
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getNetworkInfo = getNetworkInfo;
exports.getCachedNetworkInfo = getCachedNetworkInfo;
exports.warmCache = warmCache;
const os_1 = __importDefault(require("os"));
const child_process_1 = require("child_process");
let _cached = null;
let _lastUpdate = 0;
const CACHE_TTL_MS = 5 * 60_000;
/**
 * Cached network profile. First call probes; subsequent calls within 5 min
 * return the cached value. Always returns a result (falls back to Node-only
 * info if the Windows enrichment fails).
 */
async function getNetworkInfo() {
    if (_cached && Date.now() - _lastUpdate < CACHE_TTL_MS)
        return _cached;
    const base = detectFromNode();
    let enriched = base;
    if (process.platform === 'win32') {
        try {
            const ps = await detectFromPowerShell();
            enriched = { ...base, ...ps };
        }
        catch { /* fall back to base */ }
    }
    _cached = enriched;
    _lastUpdate = Date.now();
    return enriched;
}
/** Blocking synchronous read from the cache, for the heartbeat hot path. */
function getCachedNetworkInfo() {
    return _cached;
}
/** Cross-platform core: what we can learn without spawning anything. */
function detectFromNode() {
    const interfaces = os_1.default.networkInterfaces();
    let hasIPv6 = false;
    let count = 0;
    let primaryType = 'unknown';
    for (const [name, addrs] of Object.entries(interfaces)) {
        if (!addrs)
            continue;
        const active = addrs.filter(a => !a.internal);
        if (active.length === 0)
            continue;
        count++;
        // IPv6: any non-loopback, non-link-local address
        if (active.some(a => a.family === 'IPv6' && !a.address.startsWith('fe80'))) {
            hasIPv6 = true;
        }
        // Best-effort type from interface name. PowerShell enrichment overrides
        // this with authoritative media type on Windows.
        if (primaryType === 'unknown') {
            const lower = name.toLowerCase();
            if (lower.includes('wi-fi') || lower.includes('wlan') || lower.includes('wireless')) {
                primaryType = 'wifi';
            }
            else if (lower.includes('ethernet') || lower.includes('local area')) {
                primaryType = 'ethernet';
            }
            else if (lower.includes('cellular') || lower.includes('mobile') || lower.includes('wwan')) {
                primaryType = 'cellular';
            }
        }
    }
    return {
        primary_type: primaryType,
        link_speed_mbps: null,
        has_ipv6: hasIPv6,
        adapter_name: '',
        interfaces_count: count,
        has_default_route: count > 0,
    };
}
/** Windows-only enrichment: adapter type + link speed from Get-NetAdapter. */
function detectFromPowerShell() {
    return new Promise((resolve, reject) => {
        const ps = `$a = Get-NetAdapter | Where-Object Status -eq 'Up' | Sort-Object -Property LinkSpeed -Descending | Select-Object -First 1; if ($null -eq $a) { '{}' } else { ConvertTo-Json @{ Name = $a.Name; Description = $a.InterfaceDescription; LinkSpeed = $a.LinkSpeed; Media = $a.PhysicalMediaType } -Compress }`;
        const child = (0, child_process_1.spawn)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
            windowsHide: true,
        });
        let out = '';
        const timer = setTimeout(() => {
            try {
                child.kill();
            }
            catch { /* ignore */ }
            reject(new Error('Timeout'));
        }, 5000);
        child.stdout?.on('data', (d) => { out += d.toString(); });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('exit', () => {
            clearTimeout(timer);
            try {
                const p = JSON.parse(out.trim() || '{}');
                const media = String(p.Media || '').toLowerCase();
                let type;
                if (media.includes('wireless') || media.includes('802.11'))
                    type = 'wifi';
                else if (media.includes('802.3') || media.includes('ethernet'))
                    type = 'ethernet';
                else if (media.includes('wwan') || media.includes('cellular'))
                    type = 'cellular';
                else if (media)
                    type = 'other';
                // LinkSpeed comes as a string like "1 Gbps" / "300 Mbps" / "100 Mbps".
                // Parse into Mbps.
                const speedStr = String(p.LinkSpeed || '').toLowerCase();
                let linkSpeed = null;
                const gbpsMatch = speedStr.match(/([\d.]+)\s*gbps/);
                const mbpsMatch = speedStr.match(/([\d.]+)\s*mbps/);
                if (gbpsMatch)
                    linkSpeed = Math.round(parseFloat(gbpsMatch[1]) * 1000);
                else if (mbpsMatch)
                    linkSpeed = Math.round(parseFloat(mbpsMatch[1]));
                const partial = {
                    adapter_name: String(p.Description || ''),
                };
                if (type)
                    partial.primary_type = type;
                if (linkSpeed != null)
                    partial.link_speed_mbps = linkSpeed;
                resolve(partial);
            }
            catch (e) {
                reject(e);
            }
        });
    });
}
/** Kick off an async refresh at app startup so the first heartbeat has fresh data. */
function warmCache() {
    getNetworkInfo().catch(() => { });
}
//# sourceMappingURL=network-info.js.map