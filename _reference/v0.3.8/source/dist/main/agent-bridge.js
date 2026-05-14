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
const events_1 = require("events");
const http_body_1 = require("./util/http-body");
const DEFAULT_PORT = 17111;
const MAX_LINES_PARAM = 500;
const MAX_LOG_RESPONSE_BYTES = 1 * 1024 * 1024;
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