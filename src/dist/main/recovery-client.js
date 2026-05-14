"use strict";
/**
 * Recovery client — paste-key lookup against Insights.
 *
 * Theme 5 of the 0.3.3 plan. When a user has lost their local
 * Documents\MyKAI\identity.json AND %APPDATA%\Roaming\MyKAI Node\
 * AND can't find their old accountKey on their own (password manager,
 * old screenshot, etc.), they need a recovery path.
 *
 * Privacy-clean recovery model:
 *   - Input: accountKey OR nodeId. Nothing else.
 *   - No IP lookup. No hardware fingerprint. No nodeName fuzzy match.
 *   - The cloud's reply is read-only — server doesn't store anything new
 *     from the request, doesn't log the requesting IP/UA persistently.
 *
 * If user has neither key, recovery is impossible — same model as a
 * wallet seed phrase. The Documents-file durability fix (Theme 1)
 * handles 95%+ of cases automatically, so reaching this client-side
 * recovery path means the user already escaped that safety net.
 *
 * Endpoint contract (locked with Insights dev, shipped 97d098c;
 * domain consolidated to mykai.dev 2026-05-03 — Vercel URL retired):
 *   POST https://mykai.dev/api/recover-by-key
 *   Content-Type: application/json
 *   Body: { "key": "acc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" |
 *                  "node_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
 *
 *   200 with { matches: RecoveryMatch[] }
 *   200 with { matches: [] } on no-match (NOT 404)
 *   400 on malformed key
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RecoveryError = exports.KEY_REGEX = void 0;
exports.lookupByKey = lookupByKey;
const https_1 = __importDefault(require("https"));
const http_agent_1 = require("./util/http-agent");
const http_body_1 = require("./util/http-body");
const RECOVERY_URL = 'https://mykai.dev/api/recover-by-key';
/** Server-validated regex. Matches `acc_<32hex>` OR `node_<32hex>`.
 *  Same regex used server-side for input validation — keep them in sync.
 *  (Server would reject anything else with 400 anyway, but checking
 *  client-side too gives faster UX feedback and avoids a network round
 *  trip when the user mis-pastes.) */
exports.KEY_REGEX = /^(acc|node)_[0-9a-f]{32}$/;
class RecoveryError extends Error {
    code;
    status;
    constructor(code, message, status) {
        super(message);
        this.code = code;
        this.status = status;
        this.name = 'RecoveryError';
    }
}
exports.RecoveryError = RecoveryError;
/** Look up nodes by accountKey or nodeId. Throws RecoveryError on any
 *  failure mode — caller should catch and surface a friendly message
 *  to the user. */
function lookupByKey(key) {
    if (!exports.KEY_REGEX.test(key)) {
        return Promise.reject(new RecoveryError('invalid-format', 'Key must be in the form acc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx or node_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx (32 hex characters after the prefix).'));
    }
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ key });
        const url = new URL(RECOVERY_URL);
        const req = https_1.default.request({
            method: 'POST',
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'User-Agent': 'MyKAI-Node-Recovery',
                'Accept': 'application/json',
            },
            timeout: 15000,
            agent: http_agent_1.sharedHttpsAgent,
        }, (res) => {
            (0, http_body_1.readBody)(res, 1_000_000)
                .then((raw) => {
                if (res.statusCode === undefined || res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new RecoveryError('http', `Server responded ${res.statusCode}`, res.statusCode));
                    return;
                }
                try {
                    const parsed = JSON.parse(raw);
                    if (!Array.isArray(parsed?.matches)) {
                        reject(new RecoveryError('parse', 'Server response missing `matches` array.'));
                        return;
                    }
                    resolve(parsed);
                }
                catch (err) {
                    reject(new RecoveryError('parse', `Could not parse server response: ${err.message}`));
                }
            })
                .catch((err) => reject(new RecoveryError('network', err?.message ?? String(err))));
        });
        req.on('error', (err) => reject(new RecoveryError('network', err.message)));
        req.on('timeout', () => {
            req.destroy();
            reject(new RecoveryError('timeout', 'Lookup timed out after 15 seconds. Check your internet connection and try again.'));
        });
        req.write(body);
        req.end();
    });
}
//# sourceMappingURL=recovery-client.js.map