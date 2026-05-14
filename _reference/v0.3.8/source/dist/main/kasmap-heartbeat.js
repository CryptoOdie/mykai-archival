"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KasMapHeartbeat = exports.KASMAP_DEFAULTS = void 0;
const https_1 = __importDefault(require("https"));
const http_1 = __importDefault(require("http"));
const http_body_1 = require("./util/http-body");
const http_agent_1 = require("./util/http-agent");
exports.KASMAP_DEFAULTS = {
    enabled: false,
    token: '',
};
const HEARTBEAT_URL = 'https://www.kasmap.org/api/node/heartbeat';
const HEARTBEAT_INTERVAL = 5 * 60 * 1000; // 5 minutes
class KasMapHeartbeat {
    config;
    interval = null;
    lastResult = null;
    getNodeData = null;
    constructor(config) {
        this.config = config;
    }
    updateConfig(config) {
        this.config = config;
        if (!config.enabled || !config.token) {
            this.stop();
        }
    }
    start(getNodeData) {
        this.getNodeData = getNodeData;
        this.stop();
        if (!this.config.enabled || !this.config.token)
            return;
        this.sendHeartbeat();
        this.scheduleNext();
    }
    stop() {
        if (this.interval) {
            clearTimeout(this.interval);
            this.interval = null;
        }
    }
    get status() {
        return {
            connected: this.interval !== null,
            intervalMs: HEARTBEAT_INTERVAL,
            lastResult: this.lastResult,
        };
    }
    async verify(token) {
        try {
            const response = await this.httpPost('https://www.kasmap.org/api/node/connect', {
                kaspadVersion: '1.0.1',
                daaScore: 0,
                peerCount: 0,
            }, {
                'Authorization': `Bearer ${token}`,
            });
            if (response.success && response.kasmapName) {
                return { ok: true, username: response.kasmapName };
            }
            return { ok: false, error: response.error || 'Invalid token' };
        }
        catch (err) {
            return { ok: false, error: err.message };
        }
    }
    scheduleNext() {
        if (this.interval)
            clearTimeout(this.interval);
        this.interval = setTimeout(() => {
            this.sendHeartbeat();
            this.scheduleNext();
        }, HEARTBEAT_INTERVAL);
    }
    async sendHeartbeat() {
        if (!this.getNodeData || !this.config.token)
            return;
        const data = this.getNodeData();
        const payload = {
            nodeId: data.nodeId,
            nodeName: data.nodeName,
            status: data.status,
            daaScore: data.daaScore,
            kaspadVersion: data.kaspadVersion,
            isPublic: data.isPublic,
            uptimeSeconds: data.uptimeSeconds,
            blocksValidated: data.blocksValidated,
            transactionsSeen: data.transactionsSeen,
        };
        try {
            const result = await this.httpPost(HEARTBEAT_URL, payload, {
                'Authorization': `Bearer ${this.config.token}`,
            });
            this.lastResult = { ok: result.ok, message: result.message || 'OK', time: Date.now() };
        }
        catch (err) {
            this.lastResult = { ok: false, message: err.message, time: Date.now() };
        }
    }
    httpPost(url, body, extraHeaders = {}) {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify(body);
            const parsed = new URL(url);
            const isHttps = parsed.protocol === 'https:';
            const mod = isHttps ? https_1.default : http_1.default;
            const agent = isHttps ? http_agent_1.sharedHttpsAgent : http_agent_1.sharedHttpAgent;
            const req = mod.request({
                hostname: parsed.hostname,
                port: parsed.port,
                agent,
                path: parsed.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                    ...extraHeaders,
                },
                timeout: 10000,
            }, async (res) => {
                try {
                    const body = await (0, http_body_1.readBody)(res);
                    try {
                        resolve(JSON.parse(body));
                    }
                    catch {
                        resolve({ ok: res.statusCode === 200, message: body });
                    }
                }
                catch (err) {
                    reject(err);
                }
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.write(data);
            req.end();
        });
    }
}
exports.KasMapHeartbeat = KasMapHeartbeat;
//# sourceMappingURL=kasmap-heartbeat.js.map