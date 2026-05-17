"use strict";
/**
 * Minimal kaspad wRPC client — connects to a remote kaspad's JSON-RPC
 * WebSocket and makes one-off or persistent RPC calls. Used by the
 * fill loop as a "remote kaspad seed" source: pull blocks directly
 * from foundation-run or community-operated archival kaspads when our
 * local kaspad has pruned them and no MyKAI peer holds them.
 *
 * Same protocol the existing rpc-monitor.js uses for local kaspad,
 * extracted here as a standalone reusable client. Persistent WebSocket
 * so a full bucket walk (~25 RPC calls) doesn't re-handshake each time.
 *
 * Public API:
 *   const client = new KaspadWRPCClient(url);
 *   await client.rpcCall(method, params, timeoutMs);
 *   client.close();
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KaspadWRPCClient = void 0;
const events_1 = require("events");
const ws_1 = __importDefault(require("ws"));

const CONNECT_TIMEOUT_MS = 8000;
const DEFAULT_RPC_TIMEOUT_MS = 10_000;

class KaspadWRPCClient extends events_1.EventEmitter {
    constructor(url) {
        super();
        this.url = url;
        this.ws = null;
        this.nextId = 1;
        this.pending = new Map();
        this._connecting = null; // promise while connecting, null otherwise
        this._closed = false;
    }

    async _ensureConnected() {
        if (this._closed) throw new Error('client closed');
        if (this.ws && this.ws.readyState === ws_1.default.OPEN) return;
        if (this._connecting) return this._connecting;
        this._connecting = new Promise((resolve, reject) => {
            const ws = new ws_1.default(this.url, {
                handshakeTimeout: CONNECT_TIMEOUT_MS,
                perMessageDeflate: false,
            });
            this.ws = ws;
            const onOpen = () => {
                ws.off('error', onError);
                this._connecting = null;
                this.emit('connected');
                resolve();
            };
            const onError = (err) => {
                ws.off('open', onOpen);
                this._connecting = null;
                this._failAllPending(err);
                this.ws = null;
                reject(err);
            };
            ws.once('open', onOpen);
            ws.once('error', onError);
            ws.on('message', (data) => this._handleMessage(data));
            ws.on('close', () => {
                this._connecting = null;
                this._failAllPending(new Error('connection closed'));
                this.ws = null;
            });
        });
        return this._connecting;
    }

    _handleMessage(data) {
        let msg;
        try {
            // Kaspa wRPC returns u64 fields as raw JSON numbers. Values
            // above 2^53 lose precision in JSON.parse, which silently
            // produces wrong block hashes when re-serialized. Pre-process
            // the problem fields into strings so they survive parsing.
            // Same trick rpc-monitor.js uses; ported here because this
            // client is the production path for remote-archival pulls
            // (Source 3 in shard-fill.js) which are exactly the source
            // class we treat as untrusted.
            let raw = data.toString();
            const BIG_FIELDS = ['nonce', 'sequence', 'lockTime', 'mass', 'value', 'gas', 'daaScore', 'blueScore', 'timestamp'];
            for (const f of BIG_FIELDS) {
                raw = raw.replace(new RegExp(`"${f}":\\s*(\\d{16,})`, 'g'), `"${f}":"$1"`);
            }
            msg = JSON.parse(raw);
        }
        catch { return; }
        // Kaspa wRPC response shape: { id, method, params: { ...data } }
        // or { id, error: { ... } }.
        if (msg.id == null) return;
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
            entry.reject(new Error(msg.error.message || 'rpc error'));
        } else {
            entry.resolve(msg);
        }
    }

    _failAllPending(err) {
        for (const [, p] of this.pending.entries()) {
            clearTimeout(p.timer);
            try { p.reject(err); } catch { /* swallow */ }
        }
        this.pending.clear();
    }

    /**
     * Make a wRPC call. Auto-connects on first use. Caller is
     * responsible for `.close()` when done with the client.
     */
    async rpcCall(method, params = {}, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
        await this._ensureConnected();
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`wRPC ${method} timeout`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
            } catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(err);
            }
        });
    }

    close() {
        this._closed = true;
        this._failAllPending(new Error('client closed'));
        if (this.ws) {
            try { this.ws.close(); } catch { /* swallow */ }
            this.ws = null;
        }
    }
}
exports.KaspadWRPCClient = KaspadWRPCClient;
//# sourceMappingURL=kaspad-wrpc-client.js.map
