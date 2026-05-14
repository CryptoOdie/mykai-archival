"use strict";
/**
 * Recursive directory size walker.
 *
 * Used for the storageSizeBytes telemetry field. Shared between desktop
 * (walks the electron-store dataDir) and headless (walks MYKAI_DATA_DIR
 * when kaspad's data volume is mounted into the container).
 *
 * Sync `walkDirSize(path)` is the public API for all existing callers —
 * it returns the cached size instantly and never blocks the event loop.
 * An async background walker (`walkDirSizeAsync`) updates the cache on
 * demand; while it's running, the sync getter returns the previous value.
 *
 * Why: on a 30+ GB rusty-kaspa data directory (thousands of RocksDB
 * SSTables), a recursive `readdirSync` + `statSync` walk blocks the main
 * thread for ~500 ms – 2 s. That window is exactly when wRPC BlockAdded
 * notifications queue in the TCP receive buffer and drain as a spike —
 * the sustained underfeeding / burst pattern observed on mainnet nodes.
 * On Flux/shared hosting the stall is likely worse (slower I/O, noisy
 * neighbors), so moving the walk off the main thread matters even more
 * for headless telemetry quality.
 *
 * On cold start the sync getter returns 0 until the first background
 * walk completes (~1–5 s typical). The next heartbeat gets the real
 * value; acceptable tradeoff for the latency win.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.walkDirSize = walkDirSize;
exports.walkDirSizeFresh = walkDirSizeFresh;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// Cache so repeated calls (UI refresh, heartbeat, diagnostic button) don't
// each re-walk a 30+ GB DAG directory back-to-back. 30 s TTL means at
// most two walks per minute in the worst case.
let _cache = null;
let _refreshing = null;
const CACHE_TTL_MS = 30_000;
/** Recursive async size walker. Uses fs.promises so each readdir / stat
 *  yields to the event loop — BlockAdded notifications, IPC messages, and
 *  other microtasks interleave freely. Errors are swallowed per-entry:
 *  a permission failure on one file shouldn't abort the whole walk. */
async function walkDirSizeAsync(dirPath) {
    let totalSize = 0;
    const walk = async (dir) => {
        let entries;
        try {
            entries = await fs_1.default.promises.readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path_1.default.join(dir, entry.name);
            if (entry.isFile()) {
                try {
                    const st = await fs_1.default.promises.stat(fullPath);
                    totalSize += st.size;
                }
                catch { /* ignore */ }
            }
            else if (entry.isDirectory()) {
                await walk(fullPath);
            }
        }
    };
    await walk(dirPath);
    return totalSize;
}
/** If the cache is stale (or missing), kick an async walk in the background.
 *  Idempotent: concurrent callers all attach to the same in-flight promise. */
function maybeRefreshInBackground(dirPath) {
    if (_refreshing)
        return;
    const cacheFresh = _cache && _cache.path === dirPath
        && Date.now() - _cache.ts < CACHE_TTL_MS;
    if (cacheFresh)
        return;
    _refreshing = walkDirSizeAsync(dirPath)
        .then((bytes) => {
        _cache = { path: dirPath, bytes, ts: Date.now() };
        return bytes;
    })
        .catch(() => _cache?.bytes ?? 0)
        .finally(() => { _refreshing = null; });
}
/** Sync getter — returns immediately, never blocks the event loop. Returns
 *  the cached size for `dirPath`; if the cache is stale or missing, kicks
 *  off a background refresh but still returns the (possibly 0, possibly
 *  stale) cached value. The next call after the refresh completes will
 *  see the fresh number. */
function walkDirSize(dirPath) {
    if (!dirPath)
        return 0;
    if (!fs_1.default.existsSync(dirPath))
        return 0;
    maybeRefreshInBackground(dirPath);
    if (_cache && _cache.path === dirPath)
        return _cache.bytes;
    return 0;
}
/** Async variant for callers that want the authoritative current value
 *  and are willing to await it. Piggybacks on any in-flight background
 *  refresh so concurrent awaiters share one walk. */
async function walkDirSizeFresh(dirPath) {
    if (!dirPath)
        return 0;
    if (!fs_1.default.existsSync(dirPath))
        return 0;
    const cacheFresh = _cache && _cache.path === dirPath
        && Date.now() - _cache.ts < CACHE_TTL_MS;
    if (cacheFresh)
        return _cache.bytes;
    if (_refreshing) {
        try {
            return await _refreshing;
        }
        catch {
            return _cache?.bytes ?? 0;
        }
    }
    maybeRefreshInBackground(dirPath);
    try {
        return await _refreshing;
    }
    catch {
        return _cache?.bytes ?? 0;
    }
}
//# sourceMappingURL=dir-size.js.map