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
    // v0.4: remote recovery lookup is DISABLED in this sovereign-fork.
    //
    // The original v0.3.x flow phoned home to https://mykai.dev/api/recover-by-key
    // (a Supabase-backed identity registry) when a user pasted an accountKey
    // and no local match was found. This is anti-sovereign-ethos: identity
    // recovery should not depend on a remote registry.
    //
    // Local recovery via Documents\MyKAI\identity_acc_*.json files is the
    // primary mechanism and works without network access (see
    // identity-backup.js for the architectural background). The caller in
    // ipc-handlers.js::recovery:lookup already tries local first and falls
    // back here — we just refuse remote lookups, returning a clear error.
    //
    // To re-enable remote lookups in a future build, restore the HTTPS
    // request body from git history at commit pre-Phase-D, but only behind
    // explicit opt-in config (sovereign-fork ethos).
    if (!exports.KEY_REGEX.test(key)) {
        return Promise.reject(new RecoveryError('invalid-format', 'Key must be in the form acc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx or node_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx (32 hex characters after the prefix).'));
    }
    return Promise.reject(new RecoveryError(
        'remote-disabled',
        'Remote recovery lookup is disabled in this sovereign-fork build. Local recovery via Documents\\MyKAI\\identity_acc_<key>.json still works. If you have a key but no local file, you cannot recover via the network — please use a backup of identity.json if you have one.',
        404
    ));
}
//# sourceMappingURL=recovery-client.js.map