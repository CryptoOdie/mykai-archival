"use strict";
/**
 * Agent Bridge — HTTP listener on :17111
 *
 * The node owns this port. Local AI agent / assistant POSTs to it
 * (announce, watch-tx) and GETs from it (node state, diagnostic,
 * activity, logs).
 *
 * Endpoints:
 *   GET  /health             — simple health check (node is running)
 *   GET  /node-state         — JSON snapshot of node state
 *   GET  /recent-activity    — last N activity-feed lines (?limit=N, max 500)
 *   GET  /diagnostic         — full diagnostic markdown
 *   GET  /logs/perf-stalls   — tail of userData/perf-stalls.log (?lines=N, max 500)
 *   GET  /logs/updater       — tail of userData/updater.log (?lines=N, max 500)
 *   POST /node-status        — agent announces connect/disconnect
 *   POST /watch-tx           — agent asks node to watch for a transaction
 *
 * Security model:
 *   - localhost-bind only (127.0.0.1, never 0.0.0.0)
 *   - Origin-header rejection (CSRF defense; native apps don't send Origin)
 *   - Host-header validation (defense-in-depth against DNS rebinding)
 *   - 256 KB body cap on POSTs
 *   - ?lines=N parameter capped at 500 server-side
 *   - 1 MB cap on log-tail response bodies
 *   - X-Content-Type-Options: nosniff + Cache-Control: no-store on all responses
 *   - No auth — relies on localhost-trust (token auth deferred to 0.3.6)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentBridge = void 0;
const http_1 = __importDefault(require("http"));
const fs_1 = __importDefault(require("fs"));
const zlib_1 = __importDefault(require("zlib"));
const events_1 = require("events");
const http_body_1 = require("./util/http-body");
const DEFAULT_PORT = 17111;
const MAX_LINES_PARAM = 500;
const MAX_LOG_RESPONSE_BYTES = 1 * 1024 * 1024;
// v0.5.1: rate-limiter for heavyweight explorer endpoints. The biggest
// risk on residential laptops isn't bandwidth — it's that a 500-block
// JSON.stringify monopolizes the Electron main event loop for 100-200 ms
// and the renderer drops frames. Capping in-flight large requests is
// the single largest renderer-jank mitigation we ship.
const EXPLORER_GLOBAL_MAX_INFLIGHT = 4;
const EXPLORER_PER_SOCKET_MAX_INFLIGHT = 2;
// Yield to the event loop every N blocks while streaming the response.
// Each setImmediate gives HTTP I/O, kaspad notifications, and renderer
// IPC a chance to drain. 25 blocks is the sweet spot from the Phase-C
// research: small enough to keep frame budgets, large enough that the
// yield overhead doesn't dominate.
const EXPLORER_YIELD_EVERY_N = 25;
// In-flight counters for the rate limiter. Module-scope so they survive
// across `start()` / `stop()` cycles in dev (they reset on full restart).
const _explorerInflight = {
    global: 0,
    perSocket: new WeakMap(),
};
function _explorerTryAcquire(socket) {
    const cur = _explorerInflight.perSocket.get(socket) || 0;
    if (_explorerInflight.global >= EXPLORER_GLOBAL_MAX_INFLIGHT) return false;
    if (cur >= EXPLORER_PER_SOCKET_MAX_INFLIGHT) return false;
    _explorerInflight.global++;
    _explorerInflight.perSocket.set(socket, cur + 1);
    return true;
}
function _explorerRelease(socket) {
    if (_explorerInflight.global > 0) _explorerInflight.global--;
    const cur = _explorerInflight.perSocket.get(socket) || 0;
    if (cur <= 1) _explorerInflight.perSocket.delete(socket);
    else _explorerInflight.perSocket.set(socket, cur - 1);
}
// Encoding negotiation. zstd is the right pick on JSON of mixed-entropy
// content (kaspa blocks have hash/sig fields with high entropy and lots
// of repetitive structural keys — gzip ratio ~1.3-1.6, zstd ~4-5×).
// Node 23.8+ ships createZstdCompress; older bundles fall back to gzip.
// gzip is the universal fallback because every HTTP client supports it.
// identity (no compression) is honored only if the client refuses both,
// to avoid silently breaking pre-compression clients.
function _pickEncoding(acceptHeader) {
    if (!acceptHeader || typeof acceptHeader !== 'string') return 'identity';
    const lower = acceptHeader.toLowerCase();
    if (typeof zlib_1.default.createZstdCompress === 'function' && lower.includes('zstd')) return 'zstd';
    if (lower.includes('gzip')) return 'gzip';
    if (lower.includes('identity') || lower.includes('*')) return 'identity';
    return 'identity';
}
function _makeEncoder(encoding) {
    if (encoding === 'zstd' && typeof zlib_1.default.createZstdCompress === 'function') {
        return zlib_1.default.createZstdCompress();
    }
    if (encoding === 'gzip') {
        // level 1 — speed over ratio. The dominant cost on residential
        // hardware is CPU per response, not bytes-on-wire; we already
        // prefer zstd when available.
        return zlib_1.default.createGzip({ level: 1 });
    }
    return null;
}
// setImmediate-as-Promise: tiny helper so streaming loops can `await
// _yieldImm()` to give the event loop a tick.
function _yieldImm() {
    return new Promise((r) => setImmediate(r));
}
class AgentBridge extends events_1.EventEmitter {
    server = null;
    _agentConnected = false;
    _agentLastSeen = 0;
    _agentName = '';
    _watchedTxs = new Map();
    port;
    _expectedHost;
    providers = null;
    constructor(port = DEFAULT_PORT) {
        super();
        this.port = port;
        this._expectedHost = `127.0.0.1:${this.port}`;
    }
    /** Wire data sources after the rest of the app is initialized. Call once.
     *  Without this, GET /node-state, /diagnostic, /recent-activity, and the
     *  /logs/* endpoints respond 503 (service unavailable). */
    setDataProviders(providers) {
        this.providers = providers;
    }
    get isAgentConnected() {
        // Agent is connected if we heard from it in the last 60 seconds
        return this._agentConnected && (Date.now() - this._agentLastSeen) < 60000;
    }
    get agentName() {
        return this._agentName;
    }
    get watchedTxs() {
        return Array.from(this._watchedTxs.values());
    }
    // Called by kaspad-manager when blocks are accepted — check for watched txs
    checkBlockForTx(blockHashes) {
        // In the future, we could query kaspad for tx details in each block
        // For now, we rely on the tx hash appearing in kaspad logs
    }
    // Called when a watched tx hash appears in kaspad logs
    confirmTx(txId) {
        const tx = this._watchedTxs.get(txId);
        if (tx && !tx.confirmed) {
            tx.confirmed = true;
            tx.confirmTimestamp = Date.now();
            this.emit('tx-confirmed', tx);
        }
    }
    start() {
        if (this.server)
            return;
        this.server = http_1.default.createServer(async (req, res) => {
            // ─── Security gate: Origin rejection (CSRF defense) ─────────────
            // The agent bridge is for native CLI / desktop apps on the same
            // machine — never browsers. Any request with an Origin header is
            // a browser, hence rejected. This catches the standard CSRF
            // vector and also handles Electron renderers (which set
            // Origin: null, which arrives as the truthy string "null" and
            // is correctly rejected here).
            const origin = req.headers.origin;
            if (origin) {
                return this._respond(res, 403, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Origin not allowed' }));
            }
            // ─── Security gate: Host header validation (DNS-rebinding) ──────
            // Defense-in-depth: even though Origin-rejection covers browser-
            // initiated rebinding, a non-browser client could craft a request
            // with no Origin and a malicious Host. Reject anything not
            // exactly 127.0.0.1:<port>.
            const hostHeader = req.headers.host;
            if (hostHeader !== this._expectedHost) {
                return this._respond(res, 403, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Host not allowed' }));
            }
            if (req.method === 'OPTIONS') {
                return this._respond(res, 403, {}, '');
            }
            // ─── GET routes ────────────────────────────────────────────────
            if (req.method === 'GET') {
                const url = new URL(req.url || '/', `http://${this._expectedHost}`);
                const pathname = url.pathname;
                if (pathname === '/health') {
                    return this._respond(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, agentConnected: this.isAgentConnected }));
                }
                // Below endpoints require the data providers wired in main.ts
                if (!this.providers) {
                    return this._respond(res, 503, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Node not fully initialized — data providers unavailable' }));
                }
                if (pathname === '/node-state') {
                    try {
                        const state = this.providers.getNodeState();
                        return this._respond(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(state));
                    }
                    catch (err) {
                        return this._respond(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
                    }
                }
                if (pathname === '/recent-activity') {
                    const limit = this._parseLines(url.searchParams.get('limit'), 100);
                    try {
                        const lines = this.providers.getRecentActivity(limit);
                        return this._respond(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, lines }));
                    }
                    catch (err) {
                        return this._respond(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
                    }
                }
                if (pathname === '/diagnostic') {
                    try {
                        const md = await this.providers.getDiagnostic();
                        return this._respond(res, 200, { 'Content-Type': 'text/markdown; charset=utf-8' }, md);
                    }
                    catch (err) {
                        return this._respond(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
                    }
                }
                if (pathname === '/logs/perf-stalls' || pathname === '/logs/updater') {
                    const name = pathname === '/logs/perf-stalls' ? 'perf-stalls' : 'updater';
                    const lines = this._parseLines(url.searchParams.get('lines'), 100);
                    try {
                        const logPath = this.providers.getLogPath(name);
                        const tail = this._readLogTail(logPath, lines);
                        return this._respond(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, lines: tail }));
                    }
                    catch (err) {
                        return this._respond(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
                    }
                }
                // v0.5: shard-storage endpoints.
                //   GET /shard/stats       — current shard contribution stats
                //   GET /shard/block/:hash — retrieve one block by hex hash
                // Both return { ok: false, error: 'Shard storage not enabled' } when
                // the user has shardSizeGB == 0 (feature off). 200 with data otherwise.
                if (pathname === '/shard/stats') {
                    if (!this.providers.getShardStats) {
                        return this._respond(res, 503, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Shard storage not enabled (set shardSizeGB > 0 in Settings)' }));
                    }
                    try {
                        const stats = this.providers.getShardStats();
                        return this._respond(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, ...stats }));
                    }
                    catch (err) {
                        return this._respond(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
                    }
                }
                if (pathname.startsWith('/shard/block/')) {
                    if (!this.providers.getShardBlock) {
                        return this._respond(res, 503, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Shard storage not enabled' }));
                    }
                    const hashHex = pathname.slice('/shard/block/'.length);
                    if (!/^[0-9a-fA-F]{64}$/.test(hashHex)) {
                        return this._respond(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Invalid hash format — expect 32-byte hex' }));
                    }
                    try {
                        const block = this.providers.getShardBlock(hashHex);
                        if (!block) {
                            return this._respond(res, 404, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Block not in local shard' }));
                        }
                        return this._respond(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, daaScore: block.daaScore, sizeBytes: block.sizeBytes, capturedAt: block.capturedAt, body: block.body }));
                    }
                    catch (err) {
                        return this._respond(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
                    }
                }
                // ─── v0.5.1: explorer-backend endpoints ─────────────────────
                // Four new /shard/* routes that let simply-kaspa-indexer (and
                // any compatible explorer ingester) treat this MyKAI install
                // as a block-data source. Each provider returns null when the
                // user has explorer-mode OFF or paused — we surface that as a
                // 503 so the indexer rotates to a different pinned pool peer
                // instead of getting a confusing 404 / empty response.
                //
                // JSON responses on 200 are byte-identical to kaspad wRPC
                // shape (the indexer reuses rusty-kaspa's serde — see
                // docs/explorer-backend-plan.md). Error responses keep the
                // existing { ok: false, error } shape because they're for
                // human eyes (curl / logs).
                if (pathname === '/shard/dag-info') {
                    if (!this.providers.getShardDagInfo) {
                        return this._respond(res, 503, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Explorer mode not enabled' }));
                    }
                    try {
                        const info = await this.providers.getShardDagInfo();
                        if (!info) {
                            return this._respond(res, 503, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Explorer mode disabled or paused' }));
                        }
                        return this._respond(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(info));
                    }
                    catch (err) {
                        return this._respond(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
                    }
                }
                if (pathname === '/shard/blocks') {
                    if (!this.providers.getShardBlocksAfterLowHash) {
                        return this._respond(res, 503, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Explorer mode not enabled' }));
                    }
                    const lowHash = url.searchParams.get('low_hash');
                    if (!lowHash || !/^[0-9a-fA-F]{64}$/.test(lowHash)) {
                        return this._respond(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Missing or invalid low_hash (expect 32-byte hex)' }));
                    }
                    const includeTxs = url.searchParams.get('include_txs') !== 'false';
                    const limitRaw = parseInt(url.searchParams.get('limit') || '100', 10);
                    const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 100, 500));
                    // Rate-limit BEFORE doing any work. Excess requests get a
                    // short Retry-After so the indexer rotates to another peer.
                    if (!_explorerTryAcquire(req.socket)) {
                        return this._respond(res, 503, { 'Content-Type': 'application/json', 'Retry-After': '1' }, JSON.stringify({ ok: false, error: 'Too many in-flight large requests' }));
                    }
                    try {
                        const result = await this.providers.getShardBlocksAfterLowHash(lowHash, includeTxs, limit);
                        if (!result) {
                            _explorerRelease(req.socket);
                            return this._respond(res, 503, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Explorer mode disabled or paused' }));
                        }
                        if (result.below_floor) {
                            _explorerRelease(req.socket);
                            return this._respond(res, 404, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'below_pool_floor', pool_floor_daa: result.pool_floor_daa }));
                        }
                        // Streaming write — see _streamBlocksResponse for the
                        // setImmediate yielding + compression negotiation.
                        await this._streamBlocksResponse(req, res, result.block_hashes, result.blocksBytes);
                    }
                    catch (err) {
                        return this._respond(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
                    }
                    finally {
                        _explorerRelease(req.socket);
                    }
                    return;
                }
                if (pathname === '/shard/virtual-chain') {
                    if (!this.providers.getShardVirtualChain) {
                        return this._respond(res, 503, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Explorer mode not enabled' }));
                    }
                    const startHash = url.searchParams.get('start_hash');
                    if (!startHash || !/^[0-9a-fA-F]{64}$/.test(startHash)) {
                        return this._respond(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Missing or invalid start_hash (expect 32-byte hex)' }));
                    }
                    const tipDistRaw = parseInt(url.searchParams.get('tip_distance') || '50', 10);
                    const tipDistance = Math.max(1, Math.min(Number.isFinite(tipDistRaw) ? tipDistRaw : 50, 500));
                    try {
                        const result = await this.providers.getShardVirtualChain(startHash, tipDistance);
                        if (!result) {
                            return this._respond(res, 503, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Explorer mode disabled, paused, or pool participant lacks VC capability' }));
                        }
                        return this._respond(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(result));
                    }
                    catch (err) {
                        return this._respond(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
                    }
                }
                if (pathname === '/shard/block-range') {
                    if (!this.providers.getShardBlockRange) {
                        return this._respond(res, 503, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Explorer mode not enabled' }));
                    }
                    const fromDaaRaw = parseInt(url.searchParams.get('from_daa') || '', 10);
                    const toDaaRaw = parseInt(url.searchParams.get('to_daa') || '', 10);
                    if (!Number.isFinite(fromDaaRaw) || !Number.isFinite(toDaaRaw) || fromDaaRaw < 0 || toDaaRaw <= fromDaaRaw) {
                        return this._respond(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Missing or invalid from_daa / to_daa (need from_daa >= 0 and to_daa > from_daa)' }));
                    }
                    const toDaa = Math.min(toDaaRaw, fromDaaRaw + 5000);
                    const includeTxs = url.searchParams.get('include_txs') !== 'false';
                    if (!_explorerTryAcquire(req.socket)) {
                        return this._respond(res, 503, { 'Content-Type': 'application/json', 'Retry-After': '1' }, JSON.stringify({ ok: false, error: 'Too many in-flight large requests' }));
                    }
                    try {
                        const result = await this.providers.getShardBlockRange(fromDaaRaw, toDaa, includeTxs);
                        if (!result) {
                            _explorerRelease(req.socket);
                            return this._respond(res, 503, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Explorer mode disabled or paused' }));
                        }
                        // Same streaming path — blocksBytes only (no
                        // block_hashes wrapper for block-range responses).
                        await this._streamBlocksResponse(req, res, null, result.blocksBytes);
                    }
                    catch (err) {
                        return this._respond(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
                    }
                    finally {
                        _explorerRelease(req.socket);
                    }
                    return;
                }
                return this._respond(res, 404, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Not found' }));
            }
            // ─── POST routes ───────────────────────────────────────────────
            if (req.method === 'POST') {
                (0, http_body_1.readBody)(req, 256 * 1024).then((body) => {
                    try {
                        const data = JSON.parse(body);
                        this.handlePost(req.url || '', data, res);
                    }
                    catch {
                        this._respond(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Invalid JSON' }));
                    }
                }).catch(() => {
                    this._respond(res, 413, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Request body too large' }));
                });
                return;
            }
            return this._respond(res, 404, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Method not allowed' }));
        });
        this.server.listen(this.port, '127.0.0.1', () => {
            this.emit('log', `Agent bridge listening on http://127.0.0.1:${this.port}`);
        });
        this.server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                this.emit('log', `Port ${this.port} already in use — agent bridge disabled`);
            }
            else {
                this.emit('log', `Agent bridge error: ${err.message}`);
            }
        });
    }
    stop() {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
    }
    handlePost(url, data, res) {
        switch (url) {
            case '/node-status': {
                // Agent announcing itself
                this._agentConnected = data.status !== 'disconnected';
                this._agentLastSeen = Date.now();
                this._agentName = data.name || 'Agent';
                if (data.status === 'connected') {
                    this.emit('agent-connected', this._agentName);
                }
                else if (data.status === 'disconnected') {
                    this._agentConnected = false;
                    this.emit('agent-disconnected');
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                break;
            }
            case '/watch-tx': {
                // Agent asking to watch a transaction
                const txId = data.txId;
                if (!txId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Missing txId' }));
                    return;
                }
                this._watchedTxs.set(txId, {
                    txId,
                    timestamp: Date.now(),
                    confirmed: false,
                });
                // Auto-cleanup after 10 minutes
                setTimeout(() => { this._watchedTxs.delete(txId); }, 10 * 60 * 1000);
                this.emit('watch-tx', txId);
                this._agentLastSeen = Date.now();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, watching: txId }));
                break;
            }
            default:
                this._respond(res, 404, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Not found' }));
        }
    }
    /** Wraps res.writeHead + res.end with defensive response headers
     *  applied uniformly. nosniff prevents browsers (if one ever gets
     *  past Origin-rejection) from interpreting markdown as HTML;
     *  no-store prevents caches from preserving accountKey-bearing
     *  responses across sessions. */
    _respond(res, status, headers, body) {
        const fullHeaders = {
            ...headers,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
        };
        res.writeHead(status, fullHeaders);
        res.end(body);
    }
    /**
     * v0.5.1: stream a `{block_hashes, blocks}` (or `{blocks}`) response
     * for the heavy explorer endpoints. Three things are happening here
     * that the naked JSON.stringify path couldn't do:
     *
     *   1. We write the response as a stream, so the giant 5-MB-ish
     *      response body never exists as a single allocation in V8's
     *      large-object space. Each block is a young-generation
     *      allocation that gets scavenged before the next.
     *
     *   2. We `await setImmediate` every EXPLORER_YIELD_EVERY_N blocks,
     *      giving the event loop a tick to deliver kaspad notifications,
     *      IPC events, and renderer compositor frames. Without this the
     *      MyKAI UI visibly stutters during multi-hundred-block reads.
     *
     *   3. We pipe through zstd (preferred) or gzip (fallback) based on
     *      the client's Accept-Encoding. Raw block JSON is ~4-5× smaller
     *      under zstd; the CPU cost is well under 5% of one core at the
     *      sustained rates Light-tier serving sees.
     *
     * `blockHashes` may be null for endpoints (block-range) that don't
     * include the hash array in the response.
     */
    async _streamBlocksResponse(req, res, blockHashes, blocksBytes) {
        const encoding = _pickEncoding(req.headers['accept-encoding']);
        const headers = {
            'Content-Type': 'application/json',
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
        };
        if (encoding !== 'identity') headers['Content-Encoding'] = encoding;
        // Hint to caches/proxies that the response varies with the
        // negotiated encoding. Defensive — local-only today, but the
        // header is correct.
        headers['Vary'] = 'Accept-Encoding';
        res.writeHead(200, headers);
        const encoder = _makeEncoder(encoding);
        // sink is what we write to — encoder if compressing, else res.
        const sink = encoder || res;
        if (encoder) encoder.pipe(res);
        const write = (chunk) => {
            // Apply backpressure: if the sink says it can't accept more
            // right now, wait for 'drain' before resuming. This is what
            // keeps the response from materializing an unbounded buffer
            // in memory when a slow consumer can't drink fast enough.
            if (!sink.write(chunk)) {
                return new Promise((resolve) => sink.once('drain', resolve));
            }
            return null;
        };
        try {
            // Open the JSON object.
            if (blockHashes) {
                await write('{"block_hashes":[');
                for (let i = 0; i < blockHashes.length; i++) {
                    const p1 = write(i === 0 ? '"' : ',"');
                    if (p1) await p1;
                    const p2 = write(blockHashes[i]);
                    if (p2) await p2;
                    const p3 = write('"');
                    if (p3) await p3;
                    if ((i + 1) % EXPLORER_YIELD_EVERY_N === 0) await _yieldImm();
                }
                await write('],"blocks":[');
            }
            else {
                await write('{"blocks":[');
            }
            for (let i = 0; i < blocksBytes.length; i++) {
                if (i > 0) {
                    const p = write(',');
                    if (p) await p;
                }
                // blocksBytes[i] is the raw kaspad-shape JSON the wRPC
                // BlockAdded notification produced. We write the bytes
                // directly — no JSON.parse, no JSON.stringify.
                const p = write(blocksBytes[i]);
                if (p) await p;
                if ((i + 1) % EXPLORER_YIELD_EVERY_N === 0) await _yieldImm();
            }
            await write(']}');
            if (encoder) {
                encoder.end();
            }
            else {
                res.end();
            }
        }
        catch (err) {
            // If the client aborts mid-stream we'll land here. Don't try
            // to write again — just close.
            try { res.destroy(); } catch { /* swallow */ }
            this.emit('log', `stream-blocks: ${err?.message || err}`);
        }
    }
    /** Parse and clamp the ?lines=N / ?limit=N query parameter. Returns
     *  the default if missing, NaN, negative, or zero. Caps at MAX_LINES_PARAM
     *  to prevent pathological reads. */
    _parseLines(raw, defaultValue) {
        if (raw == null)
            return defaultValue;
        const n = parseInt(raw, 10);
        if (!Number.isFinite(n) || n <= 0)
            return defaultValue;
        return Math.min(n, MAX_LINES_PARAM);
    }
    /** Read the last `lines` lines from a log file, capped at
     *  MAX_LOG_RESPONSE_BYTES bytes total to prevent runaway log files
     *  from causing memory pressure on the Electron main process. */
    _readLogTail(filePath, lines) {
        if (!fs_1.default.existsSync(filePath))
            return [];
        const stats = fs_1.default.statSync(filePath);
        if (stats.size === 0)
            return [];
        const readBytes = Math.min(stats.size, MAX_LOG_RESPONSE_BYTES);
        const fd = fs_1.default.openSync(filePath, 'r');
        try {
            const buf = Buffer.alloc(readBytes);
            fs_1.default.readSync(fd, buf, 0, readBytes, stats.size - readBytes);
            const text = buf.toString('utf8');
            const allLines = text.split(/\r?\n/);
            // If we read mid-line at the start (truncated), drop the partial
            // first line so the consumer doesn't see a malformed entry.
            if (stats.size > readBytes && allLines.length > 0)
                allLines.shift();
            // Filter blank trailing newlines
            const filtered = allLines.filter(l => l.length > 0);
            return filtered.slice(-lines);
        }
        finally {
            fs_1.default.closeSync(fd);
        }
    }
}
exports.AgentBridge = AgentBridge;
//# sourceMappingURL=agent-bridge.js.map