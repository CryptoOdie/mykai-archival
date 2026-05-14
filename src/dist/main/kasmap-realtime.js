"use strict";
/**
 * KasMap Realtime — Supabase Realtime integration
 *
 * Connects to KasMap's Supabase Realtime channel to broadcast:
 * - Transaction events (KasMap user transactions only)
 * - Block events (new blocks with miner + parent data)
 * - Presence (online/offline status for Node Runner badge)
 *
 * Flow:
 * 1. POST /api/node/connect with KasMap token → get short-lived Supabase JWT
 * 2. Connect to Supabase Realtime channel with that JWT
 * 3. Track presence (online status)
 * 4. Broadcast tx/block events
 * 5. Refresh JWT proactively before it expires
 *
 * Robustness — three independent mechanisms keep this honest:
 *   A) Proactive refresh: setTimeout at (jwt_exp - 10min) triggers a clean
 *      disconnect + reconnect with a fresh JWT. Primary refresh path.
 *   B) Wall-clock check (checkJwtAge): called from main.ts's 10-s tick.
 *      Catches missed timers from laptop sleep or starved event loops —
 *      setTimeout can't be trusted across suspend/resume.
 *   C) Post-connect status handler: if Supabase Realtime reports CHANNEL_ERROR
 *      or CLOSED after the initial subscribe (e.g. server-side JWT rejection,
 *      network partition), we immediately tear down and mark disconnected
 *      so the 10-s reconnect tick in main.ts can try again — WITH backoff.
 *
 * Failure handling — backoff + circuit breaker:
 *   - On any connect failure, teardown the Supabase client immediately
 *     (previously it was orphaned, leaving an internal WebSocket loop that
 *     hammered the server with the stale JWT — this is what produced the
 *     1.1M failed-auth-requests-per-day incident).
 *   - Exponential backoff between retries: 2s → 5s → 15s → 30s → 60s →
 *     120s → 300s (capped). Respected by main.ts's reconnect tick.
 *   - After 10 consecutive failures the circuit opens and we stop trying
 *     entirely until app restart (or user re-saves KasMap settings).
 *     Surfaces a Health card entry so users aren't left in silent failure.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KasMapRealtime = void 0;
const supabase_js_1 = require("@supabase/supabase-js");
const https_1 = __importDefault(require("https"));
const http_1 = __importDefault(require("http"));
const http_body_1 = require("./util/http-body");
const http_agent_1 = require("./util/http-agent");
const CONNECT_URL = 'https://www.kasmap.org/api/node/connect';
/**
 * Lightweight refresh endpoint — no DB writes, no node registration, just
 * mints a fresh Supabase JWT from the existing km_node_ token. Used for
 * proactive refresh (scheduleRefresh) so we don't pay the full /connect
 * cost every time the JWT needs rotation.
 *
 * Falls back to CONNECT_URL if this endpoint returns a non-2xx — covers
 * the case where the server hasn't deployed it yet, or the token needs
 * re-validation.
 */
const REFRESH_URL = 'https://www.kasmap.org/api/node/realtime-token';
/**
 * Fallback refresh window if we can't parse the JWT's `exp` claim.
 * Older KasMap builds issued 1-hour JWTs; newer ones may issue 24-hour.
 * We prefer the server-provided exp whenever parseable.
 */
const FALLBACK_REFRESH_MS = 50 * 60 * 1000; // 50 min, assumes 1h JWT
const REFRESH_LEAD_MS = 10 * 60 * 1000; // refresh 10 min before exp
const MIN_REFRESH_MS = 5 * 60 * 1000; // don't schedule refresh in <5 min
/** Backoff schedule (ms) between failed connect attempts. Index = failures-1. */
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
/** After this many consecutive failures, stop retrying entirely. */
const CIRCUIT_OPEN_THRESHOLD = 10;
class KasMapRealtime {
    config;
    supabase = null;
    channel = null;
    refreshTimer = null;
    // Connection state
    _connected = false;
    _connecting = false;
    _connectedAt = 0; // wall-clock ms when current session connected
    _jwtExpAt = 0; // wall-clock ms when current JWT expires (from `exp` claim)
    // User identity (populated by /api/node/connect response)
    _nodeId = '';
    _userId = '';
    _kasmapName = '';
    _nodeStatus = 'synced';
    // Failure tracking
    _consecutiveFailures = 0;
    _nextRetryAt = 0; // wall-clock ms; refuse to connect before this
    _circuitOpen = false;
    _lastErrorReason = null;
    constructor(config) {
        this.config = config;
    }
    get isConnected() { return this._connected; }
    /**
     * True while a connect() call is in flight. Used by main.ts auto-reconnect
     * so the 10-s tick doesn't fire a parallel connect() when the first hasn't
     * returned yet (historically this leaked Supabase clients on flaky networks).
     */
    get isConnecting() { return this._connecting; }
    get kasmapName() { return this._kasmapName; }
    get circuitOpen() { return this._circuitOpen; }
    get consecutiveFailures() { return this._consecutiveFailures; }
    get lastErrorReason() { return this._lastErrorReason; }
    getStatus() {
        return {
            connected: this._connected,
            connecting: this._connecting,
            circuitOpen: this._circuitOpen,
            consecutiveFailures: this._consecutiveFailures,
            nextRetryInMs: Math.max(0, this._nextRetryAt - Date.now()),
            lastErrorReason: this._lastErrorReason,
        };
    }
    updateConfig(config) {
        const wasEnabled = this.config.enabled && !!this.config.token;
        const isEnabled = config.enabled && !!config.token;
        this.config = config;
        if (!isEnabled) {
            this.disconnect(); // full reset — user disabled integration
        }
        else if (!wasEnabled && isEnabled) {
            // Re-enabling after disable: reset the circuit so the 10-s tick can reconnect.
            this.resetFailureState();
        }
    }
    /**
     * User-initiated retry — clears the circuit breaker immediately so the
     * next tick attempts to reconnect. Used when user saves KasMap settings
     * or clicks "Retry KasMap" in the Health card.
     */
    resetCircuit() {
        this.resetFailureState();
    }
    async connect(kaspadVersion, daaScore, peerCount) {
        if (!this.config.enabled || !this.config.token)
            return false;
        // Circuit breaker + backoff — these gates prevent rapid-fire retries.
        if (this._circuitOpen)
            return false;
        if (Date.now() < this._nextRetryAt)
            return false;
        // In-flight guard — main.ts's 10-s tick must not fire parallel connects.
        if (this._connecting || this._connected)
            return this._connected;
        this._connecting = true;
        try {
            await this.performConnect(kaspadVersion, daaScore, peerCount);
            // Success — reset failure counters so backoff is a clean slate next time.
            this.resetFailureState();
            return true;
        }
        catch (err) {
            this._consecutiveFailures++;
            this._lastErrorReason = this.classifyError(err);
            // Critical: tear down the Supabase client synchronously so its internal
            // WebSocket retry loop does not keep hammering the server with the
            // stale JWT between our explicit retries.
            this.tearDown();
            if (this._consecutiveFailures >= CIRCUIT_OPEN_THRESHOLD) {
                this._circuitOpen = true;
            }
            else {
                this.applyBackoff();
            }
            return false;
        }
        finally {
            this._connecting = false;
        }
    }
    /**
     * Wall-clock guardrail called from main.ts's 10-s tick. Catches missed
     * refresh timers — setTimeout is not reliable across laptop sleep/resume
     * or JS event-loop starvation, so we also check real wall-clock age.
     *
     * Returns true if the session was torn down (caller can log it).
     */
    checkJwtAge() {
        if (!this._connected)
            return false;
        if (this._jwtExpAt === 0 && this._connectedAt === 0)
            return false;
        const now = Date.now();
        // Expiry deadline — prefer JWT's own exp, else fallback age limit.
        const deadline = this._jwtExpAt > 0
            ? this._jwtExpAt - REFRESH_LEAD_MS
            : this._connectedAt + FALLBACK_REFRESH_MS;
        if (now >= deadline) {
            // Timer missed it (probably laptop sleep). Force reconnect on next tick.
            this.tearDown();
            return true;
        }
        return false;
    }
    /**
     * Full reset. Clears circuit + failure state. Called when user disables
     * integration, saves new config, or on app shutdown.
     */
    disconnect() {
        this.tearDown();
        this.resetFailureState();
    }
    // Broadcast a transaction event (KasMap user transactions only)
    sendTx(tx) {
        if (!this._connected || !this.channel)
            return;
        this.channel.send({ type: 'broadcast', event: 'tx', payload: tx });
    }
    // Broadcast a block event
    sendBlock(block) {
        if (!this._connected || !this.channel)
            return;
        this.channel.send({ type: 'broadcast', event: 'block', payload: block });
    }
    // Update presence status (synced/syncing/online)
    async updateStatus(status) {
        this._nodeStatus = status;
        if (!this._connected || !this.channel)
            return;
        await this.channel.track({
            nodeId: this._nodeId,
            userId: this._userId,
            kasmapName: this._kasmapName,
            status,
            online_at: new Date().toISOString(),
        });
    }
    // ─── internals ─────────────────────────────────────────────────────────
    async performConnect(kaspadVersion, daaScore, peerCount) {
        // Step 1: /api/node/connect — short-lived JWT, DB write, node registration.
        // Called every connect attempt so we always start from a fresh JWT,
        // never reusing a cached one that may have expired server-side.
        const response = await this.httpPost(CONNECT_URL, {
            kaspadVersion,
            daaScore,
            peerCount,
        }, {
            'Authorization': `Bearer ${this.config.token}`,
        });
        if (!response.success || !response.supabase) {
            throw new Error('token-rejected');
        }
        this._nodeId = response.nodeId;
        this._userId = response.userId;
        this._kasmapName = response.kasmapName || '';
        this._jwtExpAt = this.parseJwtExp(response.supabase.jwt);
        // Step 2: Supabase client.
        //
        // CRITICAL — the `apikey` slot (second arg of createClient) MUST be the
        // project's permanent anon key, NOT the minted user JWT. Supabase
        // Realtime rejects user-role JWTs in the apikey slot with 401
        // `"Invalid API key"`. That was the actual root cause of the infamous
        // 1.1M failed-auth-requests-per-day issue — nothing to do with RLS,
        // JWT signatures, or public-vs-private channels.
        //
        // Pattern:
        //   createClient(url, anonKey)   → connect to Realtime (apikey gate)
        //   realtime.setAuth(userJwt)    → authenticated role for RLS + broadcast
        if (!response.supabase.anonKey) {
            // Older KasMap server versions only returned `jwt` — need to upgrade
            // the KasMap side. Surface this clearly so users/support see what's wrong.
            throw new Error('server-missing-anonkey');
        }
        this.supabase = (0, supabase_js_1.createClient)(response.supabase.url, response.supabase.anonKey, {
            realtime: { params: { eventsPerSecond: 20 } },
        });
        // Swap in the user JWT so our authenticated role is used for Realtime
        // (presence, broadcast, RLS gating). Must happen BEFORE subscribe.
        this.supabase.realtime.setAuth(response.supabase.jwt);
        // Step 3: channel with presence.
        //
        // `private: true` enables Supabase's Realtime authorization so the user
        // JWT we set above is honored for RLS evaluation. KasMap's server-side
        // configuration disables RLS on realtime.messages (kasmap:live is a
        // public broadcast, so per-user gating adds no value), which means any
        // authenticated-role JWT is allowed through.
        this.channel = this.supabase.channel(response.supabase.channel, {
            config: {
                broadcast: { self: false },
                presence: { key: this._nodeId },
                private: true,
            },
        });
        // Step 4: subscribe, then track presence.
        // The subscribe callback fires for the INITIAL subscribe AND for every
        // subsequent state change — that's how we detect a post-connect
        // disconnection (JWT expiry, server kick, network partition) and flip
        // _connected back to false so main.ts's reconnect tick sees it.
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Subscribe timeout')), 10_000);
            let resolved = false;
            this.channel.subscribe(async (status) => {
                if (resolved) {
                    // Post-initial-connect state change. If the server kicks us or
                    // the JWT expires server-side, we'll see CHANNEL_ERROR / CLOSED /
                    // TIMED_OUT here. Tear down so the 10-s tick can reconnect fresh.
                    if (status === 'CHANNEL_ERROR' || status === 'CLOSED' || status === 'TIMED_OUT') {
                        this._connected = false;
                        // Defer teardown one tick to avoid re-entering supabase-js internals
                        // from inside its own event callback.
                        setImmediate(() => this.tearDown());
                    }
                    return;
                }
                if (status === 'SUBSCRIBED') {
                    clearTimeout(timeout);
                    resolved = true;
                    try {
                        await this.channel.track({
                            nodeId: this._nodeId,
                            userId: this._userId,
                            kasmapName: this._kasmapName,
                            status: this._nodeStatus,
                            online_at: new Date().toISOString(),
                        });
                    }
                    catch { /* presence track can fail transiently; not fatal */ }
                    this._connected = true;
                    this._connectedAt = Date.now();
                    resolve();
                }
                else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    clearTimeout(timeout);
                    resolved = true;
                    reject(new Error(`channel-${status.toLowerCase()}`));
                }
            });
        });
        // Step 5: schedule the next proactive JWT refresh.
        this.scheduleRefresh(kaspadVersion);
    }
    /**
     * Destroy Supabase client + channel and mark disconnected, WITHOUT touching
     * failure counters. Used on every failure path so the supabase-js internal
     * WebSocket retry loop is killed before we return.
     */
    tearDown() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        if (this.channel) {
            try {
                this.channel.unsubscribe();
            }
            catch { /* already gone */ }
            this.channel = null;
        }
        if (this.supabase) {
            try {
                this.supabase.removeAllChannels();
            }
            catch { /* already gone */ }
            this.supabase = null;
        }
        this._connected = false;
        this._connectedAt = 0;
        this._jwtExpAt = 0;
    }
    resetFailureState() {
        this._consecutiveFailures = 0;
        this._nextRetryAt = 0;
        this._circuitOpen = false;
        this._lastErrorReason = null;
    }
    applyBackoff() {
        const idx = Math.min(this._consecutiveFailures - 1, BACKOFF_MS.length - 1);
        this._nextRetryAt = Date.now() + BACKOFF_MS[idx];
    }
    classifyError(err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/401/.test(msg) || /unauthor/i.test(msg))
            return 'auth-failed';
        if (/token-rejected/.test(msg))
            return 'token-rejected';
        if (/server-missing-anonkey/.test(msg))
            return 'server-missing-anonkey';
        if (/timeout/i.test(msg) || /timed_out/i.test(msg))
            return 'timeout';
        if (/channel-/i.test(msg))
            return 'channel-error';
        if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH/i.test(msg))
            return 'network';
        return 'unknown';
    }
    /**
     * Pulls the `exp` claim from the JWT payload (no signature check — we trust
     * the server-minted JWT). Returns 0 if unparseable, which triggers the
     * fallback refresh window.
     */
    parseJwtExp(jwt) {
        try {
            const parts = jwt.split('.');
            if (parts.length < 2)
                return 0;
            // JWT uses base64url; node's Buffer decodes standard base64, so swap chars.
            const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
            const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
            if (typeof payload.exp === 'number')
                return payload.exp * 1000;
        }
        catch { /* fall through */ }
        return 0;
    }
    scheduleRefresh(kaspadVersion) {
        if (this.refreshTimer)
            clearTimeout(this.refreshTimer);
        // Prefer the JWT's own exp; fall back to a fixed 50 min (old 1h JWT).
        const now = Date.now();
        const delayMs = this._jwtExpAt > 0
            ? Math.max(this._jwtExpAt - REFRESH_LEAD_MS - now, MIN_REFRESH_MS)
            : FALLBACK_REFRESH_MS;
        this.refreshTimer = setTimeout(() => this.refreshJwt(kaspadVersion), delayMs);
    }
    /**
     * Proactive JWT refresh. Two-tier strategy:
     *   1. Hit /api/node/realtime-token (lightweight — no DB write) and rotate
     *      the token on the existing Supabase client via `realtime.setAuth()`.
     *      The WebSocket stays open, subscriptions stay live. Zero user-visible
     *      disruption, and it costs KasMap ~nothing server-side.
     *   2. If that fails (endpoint not yet deployed, token revoked, network
     *      blip), fall back to the full teardown + /api/node/connect path.
     *      Same behavior as before — safe regression.
     *
     * If step 2 also fails, the connect() catch applies backoff and main.ts's
     * 10-s tick takes over.
     */
    async refreshJwt(kaspadVersion) {
        if (!this._connected || !this.supabase)
            return;
        // Attempt 1: lightweight token rotation
        try {
            const response = await this.httpPost(REFRESH_URL, {}, {
                'Authorization': `Bearer ${this.config.token}`,
            });
            // Tolerate either { jwt } or { supabase: { jwt } } response shapes —
            // server API may evolve and we don't want to hard-couple to one.
            const newJwt = response?.jwt || response?.supabase?.jwt;
            if (newJwt && typeof newJwt === 'string') {
                this._jwtExpAt = this.parseJwtExp(newJwt);
                this._connectedAt = Date.now();
                // Seamless token swap — subscriptions and presence stay intact.
                this.supabase.realtime.setAuth(newJwt);
                this.scheduleRefresh(kaspadVersion);
                return;
            }
            // Non-success body — fall through to heavy path.
        }
        catch { /* fall through to heavy path */ }
        // Attempt 2: heavy fallback — full reconnect via /api/node/connect
        this.tearDown();
        await this.connect(kaspadVersion, 0, 0);
    }
    httpPost(url, body, headers = {}) {
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
                    ...headers,
                },
                timeout: 10_000,
            }, async (res) => {
                try {
                    const respBody = await (0, http_body_1.readBody)(res);
                    // Non-2xx response — don't parse as success.
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(respBody));
                    }
                    catch {
                        resolve({ success: res.statusCode === 200 });
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
exports.KasMapRealtime = KasMapRealtime;
//# sourceMappingURL=kasmap-realtime.js.map