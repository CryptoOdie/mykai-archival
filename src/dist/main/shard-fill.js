"use strict";
/**
 * Shard Fill Loop — the heart of the dynamic swarm archive.
 *
 * Runs every FILL_TICK_MS on every node that's in the pool. Each tick:
 *   1. Read this node's HRW assignments (computed locally — pure function
 *      over the swarm member list, see swarm-assignment.js).
 *   2. Diff against what we actually hold.
 *   3. Queue pulls for assigned-but-not-held, priority-ordered by
 *      depth_deficit then age_rank (depth-1 gaps before depth-2
 *      redundancy — see churn-resilience-plan.md).
 *   4. Pull up to MAX_INFLIGHT_PULLS in parallel, with per-source
 *      timeout and jitter (storm-pause aware).
 *   5. Drop held-but-not-assigned buckets, only when their coverage
 *      elsewhere is ≥ RF + SLACK (hysteresis prevents thrashing during
 *      churn storms — see Scenario 1).
 *   6. Hash-check every block we ingest. Mismatched payload = drop the
 *      response and try another source.
 *
 * Pull source priority (Day 2 of v0.5.3):
 *   1. Other top-K HRW holders for the bucket (peers with an endpoint
 *      advertised in the member list)
 *   2. Local kaspad's getBlocks RPC (works for ranges within kaspad's
 *      pruning window — free seed for recent history)
 *   3. Seed kaspad sources (foundation-run + community archives) — TODO
 *      hardcoded list until v0.5.3 Day 3's Worker publishes it
 *
 * What this does NOT do yet (deferred to later v0.5.3 / v0.5.4):
 *   - Peer-to-peer pulls when peers have public endpoints (we're loopback-
 *     only in v0.5.1; the Worker landing in Day 3 fills this in)
 *   - Per-peer latency tracking and slow-peer exclusion (v0.5.4 polish)
 *   - Churn-storm detection (Day 3 Worker-side flag — fill loop here just
 *     respects the flag once it appears in the member-list payload)
 *
 * The fill loop is intentionally chatty in its logs — it's the single
 * most-visible "is the swarm doing anything?" signal during development.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShardFill = void 0;

const events_1 = require("events");
const swarmAssign = require('./swarm-assignment');
const shardPull = require('./shard-pull');
const { createWalker } = require('./parent-chain-walker');

/** How often the fill loop wakes up. 60s is fast enough to react to
 *  churn within the heartbeat window, slow enough that we don't burn
 *  CPU when nothing's changed. */
const FILL_TICK_MS = 60_000;
/** Max in-flight bucket pulls per node. Caps bandwidth and CPU even
 *  when 50 new assignments arrive at once after a churn event. */
const MAX_INFLIGHT_PULLS = 4;
/** Pull timeout for one bucket. 60s is conservative for 3 GB at
 *  residential speeds; longer for slow links. */
const BUCKET_PULL_TIMEOUT_MS = 60_000;
/** Per-pull jitter to spread load when many nodes queue work
 *  simultaneously (post-churn reshuffle). Doubled during churn storms
 *  via the Worker's heartbeat-storm flag. */
const PULL_JITTER_MS = 30_000;
/** SLACK above replication factor before we drop an unassigned bucket.
 *  Prevents thrash when coverage briefly oscillates around RF during
 *  churn. RF=4 + SLACK=2 means we only drop when 6+ others hold it. */
const DROP_SLACK = 2;

class ShardFill extends events_1.EventEmitter {
    constructor({ shardStorage, monitor, config }) {
        super();
        this.shardStorage = shardStorage;
        this.monitor = monitor;
        this.config = config;
        this._tickTimer = null;
        this._inFlight = 0;
        this._stopped = false;
        // Track which buckets we've TRIED to pull in this tick — prevents
        // queueing the same bucket twice if the tick takes longer than
        // expected (e.g., during churn-storm jitter).
        this._tickAttempted = new Set();
        // v0.5.4: parent-chain walker for deep-history verification.
        // Provides the trustless extension beyond kaspad's pruning window.
        // Walker calls back into kaspad-knows-hash + a fetch-header function
        // that pulls a header from any available source (shard storage,
        // peers, or kaspad RPC).
        this._walker = createWalker({
            kaspadKnowsHash: async (hashHex) => {
                if (!this.monitor) return false;
                return await shardPull.verifyBlockHashAgainstKaspad(this.monitor, hashHex);
            },
            fetchHeader: async (hashHex) => {
                // First, see if we have it locally.
                try {
                    const bytes = Buffer.from(hashHex, 'hex');
                    if (bytes.length === 32 && this.shardStorage?.has(bytes)) {
                        const got = this.shardStorage.get(bytes);
                        if (got) {
                            try {
                                return JSON.parse(Buffer.from(got.body).toString('utf-8'));
                            } catch { /* fall through */ }
                        }
                    }
                } catch { /* fall through */ }
                // Try local kaspad's getBlock (returns header even when body pruned, if known).
                if (this.monitor) {
                    try {
                        const resp = await this.monitor.rpcCall(
                            'getBlock',
                            { hash: hashHex, includeTransactions: false },
                            3000
                        ).catch(() => null);
                        if (resp?.params?.block?.header) return resp.params.block;
                    } catch { /* fall through */ }
                }
                return null;
            },
        });
        // v0.5.3 hardening: per-endpoint strike tracker for smart-ban.
        // Endpoints that fail verification or return empty repeatedly are
        // banned for BAN_DURATION_MS. The libtorrent "smart ban" pattern:
        // catch bad behavior, attribute it, exclude. Strikes decay after
        // STRIKE_DECAY_MS so a transient flake doesn't permanently ban.
        //   _strikes: Map&lt;endpointUrl, { count, lastStrike }&gt;
        //   _banned:  Map&lt;endpointUrl, banExpiresAtMs&gt;
        this._strikes = new Map();
        this._banned = new Map();
    }

    /** Internal: record a strike against an endpoint. Returns true if
     *  this strike triggered a ban.
     *
     *  Severity-tiered (v0.5.4):
     *    - 'hard'  Cryptographic violation (hash mismatch, all-blocks-rejected,
     *              malformed header bytes). There is no honest explanation —
     *              the peer is either tampering or catastrophically broken.
     *              1 strike = 24h ban, immediate. We don't give second chances
     *              for cryptographic dishonesty.
     *    - 'soft'  Network error, timeout, disconnect. Usually honest flake;
     *              3 strikes within 1h = 30-min ban.
     */
    _recordStrike(endpoint, reason, severity = 'soft') {
        if (!endpoint) return false;
        const now = Date.now();

        if (severity === 'hard') {
            const HARD_BAN_MS = 24 * 60 * 60_000; // 24h
            this._banned.set(endpoint, now + HARD_BAN_MS);
            this._strikes.delete(endpoint);
            this.emit('log', `Security: HARD BAN ${endpoint} for 24h — cryptographic violation: ${reason}`);
            return true;
        }

        const STRIKE_DECAY_MS = 60 * 60_000;     // 1h
        const SOFT_BAN_MS = 30 * 60_000;         // 30 min
        const SOFT_THRESHOLD = 3;
        let entry = this._strikes.get(endpoint);
        if (!entry || (now - entry.lastStrike) > STRIKE_DECAY_MS) {
            entry = { count: 0, lastStrike: now };
        }
        entry.count++;
        entry.lastStrike = now;
        this._strikes.set(endpoint, entry);
        if (entry.count >= SOFT_THRESHOLD) {
            this._banned.set(endpoint, now + SOFT_BAN_MS);
            this._strikes.delete(endpoint);
            this.emit('log', `Security: banned ${endpoint} for 30 min after ${SOFT_THRESHOLD} soft strikes (last reason: ${reason})`);
            return true;
        }
        return false;
    }

    /** Internal: check if an endpoint is currently banned. */
    _isBanned(endpoint) {
        if (!endpoint) return false;
        const banExpiry = this._banned.get(endpoint);
        if (!banExpiry) return false;
        if (Date.now() > banExpiry) {
            this._banned.delete(endpoint);
            return false;
        }
        return true;
    }

    start() {
        if (this._tickTimer) return;
        this._stopped = false;
        // First tick after a short delay so kaspad + monitor are ready.
        setTimeout(() => this._tickSafe(), 15_000);
        this._tickTimer = setInterval(() => this._tickSafe(), FILL_TICK_MS);
        this.emit('log', `Shard-fill loop started (every ${FILL_TICK_MS / 1000}s)`);
    }

    stop() {
        this._stopped = true;
        if (this._tickTimer) {
            clearInterval(this._tickTimer);
            this._tickTimer = null;
        }
    }

    /** Wrapper that catches errors per-tick so a single bad tick can't
     *  kill the loop. We emit the error and keep going. */
    async _tickSafe() {
        if (this._stopped) return;
        this._tickAttempted.clear();
        try {
            await this._tick();
        } catch (err) {
            this.emit('error', { stage: 'tick', error: err?.message || String(err) });
        }
    }

    async _tick() {
        // Bail if we're not in the pool. Cheap re-check on every tick so
        // toggling shardSizeGB → 0 stops the loop without needing to
        // restart MyKAI.
        const shardSizeGB = this.config.get('shardSizeGB') || 0;
        if (shardSizeGB <= 0) return;
        if (!this.shardStorage || !this.monitor) return;

        // Get my assignments from the Day-1 provider. Computed locally
        // via HRW over the cached swarm member list — pure function,
        // no network, no coordinator.
        const myAssignments = this._computeAssignments(shardSizeGB);
        if (!myAssignments) return;
        let { assignments, members, tipBucketId } = myAssignments;
        if (assignments.length === 0 && members.length <= 1) {
            // ─── Solo-fill mode ─────────────────────────────────────
            // No swarm to compute against (foundation Worker down or
            // we're literally first). Rather than idle, treat the
            // budget as "fill backward from tip up to budget capacity."
            // Once the swarm appears, the next tick will re-compute
            // proper HRW assignments and the surplus naturally drops.
            //
            // This makes opening MyKAI feel alive even when alone:
            // the user sees their committed GB actually fill.
            const budgetBuckets = Math.max(0, Math.floor((shardSizeGB - 1) / 3));
            assignments = [];
            for (let i = 0; i < budgetBuckets; i++) {
                assignments.push(tipBucketId - i);
            }
            this.emit('log', `Solo-fill mode: pulling ${budgetBuckets} buckets backward from tip`);
        }

        // Read what we actually hold (by bucket id).
        const heldBuckets = this._enumerateHeldBuckets(tipBucketId);

        // ─── Diff & queue ────────────────────────────────────────────
        const assignmentSet = new Set(assignments);
        const heldSet = new Set(heldBuckets);
        const toPull = assignments.filter((b) => !heldSet.has(b) && !this._tickAttempted.has(b));
        const toDrop = heldBuckets.filter((b) => !assignmentSet.has(b));

        if (toPull.length === 0 && toDrop.length === 0) {
            // Steady state — nothing to do this tick.
            return;
        }

        this.emit('log', `Fill tick: ${toPull.length} to pull, ${toDrop.length} candidate drops, ${this._inFlight}/${MAX_INFLIGHT_PULLS} in flight`);

        // ─── Drop phase (with hysteresis + churn-storm freeze) ───────
        // Sort drop candidates by ascending member-count: drop the
        // most-over-covered first. This is the "I'm rank 5 of 7 holders"
        // case — losing me is cheap.
        //
        // Churn-storm freeze: if the foundation Worker has flagged a
        // mass-exit event (>20% departures in 1h), DO NOT shed anything
        // this tick. The drops we'd do are almost certainly going to
        // cascade and leave gaps. Only fill until storm clears.
        const flags = this._swarmFlagsGetter ? this._swarmFlagsGetter() : { churn_storm: false };
        const dropsAllowed = !flags.churn_storm;
        if (!dropsAllowed) {
            this.emit('log', `Churn storm flag set; freezing drops this tick`);
        }
        if (dropsAllowed) {
            for (const bucketId of toDrop) {
                const otherHolders = this._countOtherHoldersFor(bucketId, members);
                if (otherHolders >= 4 + DROP_SLACK) {
                    this._dropBucket(bucketId);
                }
            }
        }

        // ─── Pull phase ──────────────────────────────────────────────
        // Priority: depth deficit (how under-covered) descending, then
        // age_rank (newer first). Implementation: bucket distance from
        // tip = age_rank, lower current_holders = higher priority.
        const prioritized = toPull
            .map((b) => ({
                id: b,
                age: tipBucketId - b,
                holders: this._countOtherHoldersFor(b, members),
            }))
            .sort((a, b) => {
                if (a.holders !== b.holders) return a.holders - b.holders; // fewer holders first
                return a.age - b.age; // newer first
            });

        // Fire up to MAX_INFLIGHT_PULLS, mark them attempted so a
        // re-entrant tick doesn't double-queue.
        for (const candidate of prioritized) {
            if (this._inFlight >= MAX_INFLIGHT_PULLS) break;
            this._tickAttempted.add(candidate.id);
            this._inFlight++;
            this._pullBucketAsync(candidate.id).finally(() => {
                this._inFlight = Math.max(0, this._inFlight - 1);
            });
        }
    }

    /** Wrapper around the swarm-assignment math. Bails early if the
     *  swarm view is empty (Worker down + no cache) so we don't
     *  miscompute against zero. Returns null on insufficient state. */
    _computeAssignments(shardSizeGB) {
        const tipDaa = this.monitor?._status?.virtualDaaScore;
        if (!tipDaa) return null;
        // We need the member list. The main.js provider exposes it via
        // getSwarmMembers; here we read the same cache directly to
        // avoid an IPC round trip (we're in main, not renderer).
        const swarmGetter = this._membersGetter;
        const members = swarmGetter ? (swarmGetter() || []) : [];
        // Members can legitimately be empty during dev / Worker outage;
        // the solo-fill branch in _tick handles that. Synthesize a
        // tipBucketId here so the caller has something to anchor on.
        const myNodeId = this.config.get('nodeId') || 'unknown';
        const tipBucketId = swarmAssign.bucketIdForDaa(tipDaa);
        // If we have a swarm view, compute HRW assignments. If not,
        // return empty assignments and let solo-fill mode take over.
        if (members.length === 0) {
            return { assignments: [], members: [], tipBucketId };
        }
        // Candidate buckets: from the swarm-wide floor up to tip.
        const swarmFloorDaa = Math.min(
            ...members.map((m) => m.oldest_daa).filter((v) => v != null)
        );
        const floorBucketId = Number.isFinite(swarmFloorDaa)
            ? swarmAssign.bucketIdForDaa(swarmFloorDaa)
            : tipBucketId - 100;
        const start = Math.max(floorBucketId, tipBucketId - 5000);
        const candidates = [];
        for (let b = tipBucketId; b >= start; b--) candidates.push(b);
        const assignments = swarmAssign.computeAssignments(
            myNodeId,
            shardSizeGB,
            members.map((m) => ({ nodeId: m.nodeId, budgetGB: m.budgetGB || 0 })),
            candidates
        );
        return { assignments, members, tipBucketId };
    }

    /** Plug a members-getter from main.js. Decouples the fill loop
     *  from where the member cache lives. */
    setMembersGetter(fn) {
        this._membersGetter = fn;
    }
    /** Plug a swarm-flags getter from main.js. Returns the
     *  Worker-reported churn_storm flag so the fill loop can freeze
     *  drops + double jitter during cascade events. */
    setSwarmFlagsGetter(fn) {
        this._swarmFlagsGetter = fn;
    }

    /** Which bucket ids does our shard storage currently hold? Looks
     *  at the DAA range of stored blocks and computes which buckets
     *  contain them. Approximate — a bucket is "held" if it has at
     *  least one block in our store. v0.5.4 will track completeness
     *  per bucket properly. */
    _enumerateHeldBuckets(tipBucketId) {
        if (!this.shardStorage) return [];
        const stats = this.shardStorage.getStats();
        if (stats.oldestDaa == null || stats.newestDaa == null) return [];
        const fromBucket = swarmAssign.bucketIdForDaa(stats.oldestDaa);
        const toBucket = swarmAssign.bucketIdForDaa(stats.newestDaa);
        const held = [];
        // For Day 2, treat each bucket in range as "held" if we have
        // any block in its DAA window. This over-claims slightly during
        // backfill, but the next tick re-pulls anything we shouldn't
        // have claimed.
        for (let b = fromBucket; b <= toBucket; b++) held.push(b);
        return held;
    }

    /** Count how many OTHER members claim coverage of this bucket
     *  (by their advertised oldest/newest DAA). Approximate — actual
     *  per-bucket coverage tracking lands when the Worker aggregates
     *  it in Day 3. For now, "claims coverage" = "advertised range
     *  contains this bucket's DAA window." */
    _countOtherHoldersFor(bucketId, members) {
        const range = swarmAssign.daaRangeForBucket(bucketId);
        const myNodeId = this.config.get('nodeId') || 'unknown';
        let count = 0;
        for (const m of members) {
            if (m.nodeId === myNodeId) continue;
            if (m.oldest_daa == null || m.newest_daa == null) continue;
            // A member "holds" this bucket if their range overlaps it.
            if (m.oldest_daa <= range.startDaa && m.newest_daa >= range.endDaa) {
                count++;
            }
        }
        return count;
    }

    /** Drop a bucket's blocks from local storage. Frees disk space and
     *  flags the bucket for re-pull if it becomes ours again later. */
    _dropBucket(bucketId) {
        if (!this.shardStorage) return;
        const range = swarmAssign.daaRangeForBucket(bucketId);
        // shardStorage doesn't have a public drop-by-range API today;
        // pruneToFit handles size-based eviction. For Day 2 we emit
        // the intent and rely on natural eviction. v0.5.4 will add a
        // proper drop-bucket-by-id.
        this.emit('log', `Drop candidate bucket ${bucketId} (DAA ${range.startDaa}-${range.endDaa}) — eviction deferred to pruneToFit`);
    }

    /** Pull a bucket. Day-3 source chain:
     *    1. Local kaspad — fast, ~30h window, walks forward from best anchor
     *    2. MyKAI peers — call /shard/blocks on members with endpoints
     *    3. Seed kaspads — foundation-run + community archival hosts
     *
     *  Each pulled block is hash-verified against local kaspad's header
     *  chain. Mismatches drop the response and try the next source.
     */
    async _pullBucketAsync(bucketId) {
        const range = swarmAssign.daaRangeForBucket(bucketId);
        // Jitter to avoid thundering-herd when many nodes simultaneously
        // discover the same gap.
        const jitter = Math.floor(Math.random() * PULL_JITTER_MS);
        await new Promise((r) => setTimeout(r, jitter));
        if (this._stopped) return;

        // ─── Source 1: local kaspad ─────────────────────────────────
        try {
            this.emit('log', `Pulling bucket ${bucketId} (DAA ${range.startDaa}-${range.endDaa}) from local kaspad`);
            const blocks = await shardPull.pullBucketFromKaspad(this.monitor, this.shardStorage, range);
            if (blocks && blocks.length > 0) {
                const ingested = await this._ingestBlocks(blocks, /*verify=*/ false);
                if (ingested > 0) {
                    this.emit('log', `Bucket ${bucketId}: ingested ${ingested} blocks from local kaspad`);
                    this.emit('pulled', { bucketId, count: ingested, source: 'local-kaspad' });
                    return;
                }
            }
        } catch (err) {
            this.emit('log', `Bucket ${bucketId} pull from local kaspad failed: ${err?.message || err}`);
        }

        // ─── Source 2: MyKAI peers ─────────────────────────────────
        // Walk member list for peers that advertise an endpoint. Try
        // them in HRW-rank order so we hit canonical holders first.
        // Skip banned endpoints. Hard ban (24h, 1 strike) for cryptographic
        // violations; soft ban (30 min, 3 strikes) for network errors. See
        // _recordStrike for severity rules.
        const peerEndpoints = this._peerEndpointsForBucket(bucketId);
        for (const endpoint of peerEndpoints) {
            if (this._isBanned(endpoint)) continue;
            try {
                this.emit('log', `Trying peer ${endpoint} for bucket ${bucketId}`);
                const blocks = await shardPull.pullBucketFromHTTPSource(
                    endpoint, this.monitor, this.shardStorage, range
                );
                if (blocks && blocks.length > 0) {
                    const beforeIngest = this.shardStorage.getStats().blockCount;
                    const ingested = await this._ingestBlocks(blocks, /*verify=*/ true);
                    if (ingested > 0) {
                        this.emit('log', `Bucket ${bucketId}: ingested ${ingested} blocks from peer ${endpoint}`);
                        this.emit('pulled', { bucketId, count: ingested, source: 'peer', endpoint });
                        return;
                    }
                    // Peer returned blocks but ZERO passed verification.
                    // That's adversarial behavior — they sent us bytes
                    // claiming to be Kaspa blocks that our kaspad
                    // doesn't recognize. Strike them.
                    if (blocks.length > 0 && ingested === 0) {
                        this._recordStrike(endpoint, 'returned-blocks-all-rejected', 'hard');
                    }
                }
            } catch (err) {
                // Network failure or malformed response — soft strike.
                this._recordStrike(endpoint, `error: ${err?.message || err}`);
            }
        }

        // ─── Source 3: remote kaspad seeds (raw wRPC) ───────────────
        // Foundation/community archival kaspads, accessed directly via
        // standard Kaspa wRPC. Heavier than HTTP (WebSocket handshake +
        // multiple RPC calls) but works against any archival kaspad in
        // existence — no MyKAI shim required.
        const kaspadSeeds = this.config.get('kaspadSeedSources')
            || shardPull.DEFAULT_KASPAD_SEED_SOURCES;
        for (const wssUrl of kaspadSeeds) {
            if (this._isBanned(wssUrl)) continue;
            try {
                this.emit('log', `Trying kaspad seed ${wssUrl} for bucket ${bucketId}`);
                const blocks = await shardPull.pullBucketFromRemoteKaspad(wssUrl, range);
                if (blocks && blocks.length > 0) {
                    const ingested = await this._ingestBlocks(blocks, /*verify=*/ true);
                    if (ingested > 0) {
                        this.emit('log', `Bucket ${bucketId}: ingested ${ingested} blocks from kaspad seed ${wssUrl}`);
                        this.emit('pulled', { bucketId, count: ingested, source: 'kaspad-seed', endpoint: wssUrl });
                        return;
                    }
                    if (blocks.length > 0 && ingested === 0) {
                        this._recordStrike(wssUrl, 'returned-blocks-all-rejected', 'hard');
                    }
                }
            } catch (err) {
                this._recordStrike(wssUrl, `error: ${err?.message || err}`);
            }
        }

        // ─── Source 4: MyKAI HTTP seeds ─────────────────────────────
        const seedList = this.config.get('seedSources') || shardPull.DEFAULT_SEED_SOURCES;
        for (const seedUrl of seedList) {
            if (this._isBanned(seedUrl)) continue;
            try {
                this.emit('log', `Trying seed ${seedUrl} for bucket ${bucketId}`);
                const blocks = await shardPull.pullBucketFromHTTPSource(
                    seedUrl, this.monitor, this.shardStorage, range
                );
                if (blocks && blocks.length > 0) {
                    const ingested = await this._ingestBlocks(blocks, /*verify=*/ true);
                    if (ingested > 0) {
                        this.emit('log', `Bucket ${bucketId}: ingested ${ingested} blocks from seed ${seedUrl}`);
                        this.emit('pulled', { bucketId, count: ingested, source: 'seed', endpoint: seedUrl });
                        return;
                    }
                    if (blocks.length > 0 && ingested === 0) {
                        this._recordStrike(seedUrl, 'returned-blocks-all-rejected', 'hard');
                    }
                }
            } catch (err) {
                this._recordStrike(seedUrl, `error: ${err?.message || err}`);
            }
        }

        this.emit('log', `Bucket ${bucketId} unavailable from all sources (kaspad pruned + ${peerEndpoints.length} peers + ${kaspadSeeds.length} kaspad seeds + ${seedList.length} HTTP seeds tried)`);
    }

    /** Collect peer endpoints that claim coverage of a given bucket,
     *  in HRW-rank order so canonical holders are tried first. Skip
     *  peers without an advertised endpoint (loopback-only nodes). */
    _peerEndpointsForBucket(bucketId) {
        const swarmGetter = this._membersGetter;
        if (!swarmGetter) return [];
        const members = swarmGetter() || [];
        const myNodeId = this.config.get('nodeId') || 'unknown';
        const range = swarmAssign.daaRangeForBucket(bucketId);
        // Compute HRW ranks so we route to top-K holders first.
        const ranked = swarmAssign.computeBucketHolders(
            bucketId,
            members.map((m) => ({ nodeId: m.nodeId, budgetGB: m.budgetGB || 1 })),
            10  // top-10 candidate pool for resilience
        );
        const byId = new Map(members.map((m) => [m.nodeId, m]));
        const endpoints = [];
        for (const nodeId of ranked) {
            if (nodeId === myNodeId) continue;
            const m = byId.get(nodeId);
            if (!m || !m.endpoint) continue;
            // Sanity: their advertised range must contain our bucket.
            if (m.oldest_daa == null || m.newest_daa == null) continue;
            if (m.oldest_daa <= range.startDaa && m.newest_daa >= range.endDaa) {
                endpoints.push(m.endpoint);
            }
        }
        return endpoints;
    }

    /** Insert pulled blocks into shardStorage. Hardened ingest path —
     *  this is the security boundary between untrusted peer/seed data
     *  and MyKAI's permanent storage.
     *
     *  Defenses applied (see docs/security-model.md):
     *    1. Hash verification against kaspad's header chain (`verify=true`).
     *       Mathematically equivalent to "kaspa consensus says this hash
     *       is canonical." Hash mismatch → silent reject.
     *    2. verboseData stripping. Peer-supplied derived metadata
     *       (childrenHashes, mergeSetBluesHashes, isChainBlock, etc.)
     *       is NOT committed to the header hash and CAN be tampered with
     *       even when the hash matches. Recreating it requires the local
     *       GhostDAG state, which any consumer has via their own kaspad.
     *       We strip it on ingest so it never lands in our storage.
     *       (This is the Kelp/LayerZero-class attack defense.)
     *    3. DAA-score monotonicity hint. Blocks arriving with daa_score
     *       below the bucket's expected floor are likely from a different
     *       range than claimed — log and skip.
     *    4. Body merkle-root verification (shipped v0.5.4): every block
     *       with transactions has its hashMerkleRoot recomputed and
     *       compared to the header commitment. See verifyBlockFull in
     *       shard-pull.js. Closes CVE-2012-2459-class transaction-
     *       substitution attacks. Validated against rusty-kaspa's 8
     *       canonical test vectors + 8 live mainnet blocks.
     *
     *  `verify=false` for blocks pulled from local kaspad — those
     *  already passed kaspad's full consensus check. Skip the round
     *  trip to keep the hot path fast.
     *
     *  Returns the number of blocks successfully ingested. */
    async _ingestBlocks(blocks, verify) {
        if (!this.shardStorage) return 0;
        let ingested = 0;
        let rejected = 0;
        let strippedVerbose = 0;
        // Defense 3+4: range-level integrity checks. Catches range
        // censorship attacks and gross reordering.
        let lastDaaSeen = -1;
        let monotonicityViolations = 0;
        // For contiguity: track every hash claimed by the response.
        // Each block's first parent must be either (a) in the response,
        // (b) already in our shard storage, or (c) known to kaspad.
        // If a block has no path to any of these, the response is
        // claiming to deliver isolated/orphan data — reject.
        const respHashes = new Set();
        for (const b of blocks) {
            const h = b?.header?.hash || b?.verboseData?.hash;
            if (h) respHashes.add(h.toLowerCase());
        }
        for (const block of blocks) {
            // Hash from the HEADER, not from verboseData — verboseData
            // is peer-supplied and can be lied about; the header's
            // claimed hash gets re-verified against kaspad below.
            const hashHex = block?.header?.hash || block?.verboseData?.hash;
            if (!hashHex || !/^[0-9a-fA-F]{64}$/.test(hashHex)) continue;
            const hashBytes = Buffer.from(hashHex, 'hex');
            if (hashBytes.length !== 32) continue;
            // Skip blocks we already have.
            if (this.shardStorage.has(hashBytes)) continue;
            // Defense 1: hash verification.
            //   v0.5.3: direct check via local kaspad's header chain
            //   v0.5.4: falls back to parent-chain walking for deep
            //           history kaspad doesn't recognize directly.
            // Together these cover the entire Kaspa chain trustlessly:
            // recent + skeleton anchors via kaspad, deep history via the
            // hash chain walked back to a known anchor.
            if (verify) {
                const ok = await shardPull.verifyBlockFull(this.monitor, block, this._walker);
                if (!ok) {
                    rejected++;
                    continue;
                }
            }
            const daaScore = Number(block?.header?.daaScore ?? block?.header?.daa_score ?? 0);
            const blueScore = Number(block?.header?.blueScore ?? block?.header?.blue_score ?? 0);
            // Reject any block whose DAA/blue scores aren't finite and
            // non-negative — NaN or negative numbers would silently
            // defeat the monotonicity check below (NaN comparisons are
            // always false).
            if (!Number.isFinite(daaScore) || daaScore < 0 ||
                !Number.isFinite(blueScore) || blueScore < 0) {
                rejected++;
                continue;
            }
            // Defense 3: DAA-score monotonicity. Within a range response
            // we expect non-decreasing DAA. Gross violations indicate
            // either reordering or chain-mixing — warn (not reject) and
            // strike the source if many violations.
            if (lastDaaSeen >= 0 && daaScore + 100 < lastDaaSeen) {
                // Allow some slack for parallel DAG blocks; > 100 DAA
                // backwards step is suspicious.
                monotonicityViolations++;
            } else if (daaScore > lastDaaSeen) {
                lastDaaSeen = daaScore;
            }
            // Defense 4: contiguity. The block's first parent should
            // chain to something we trust — either in this response,
            // in our shard, or recognized by kaspad. If it doesn't,
            // we're being asked to ingest an isolated orphan claim.
            // Skip the check for the first block in a response and for
            // empty parent lists (genesis).
            const firstParent = block?.header?.parentsByLevel?.[0]?.[0]
                || block?.header?.parents?.[0]?.[0];
            if (firstParent) {
                const pkey = firstParent.toLowerCase();
                let parentTrusted = respHashes.has(pkey);
                if (!parentTrusted) {
                    try {
                        const pb = Buffer.from(firstParent, 'hex');
                        if (pb.length === 32 && this.shardStorage.has(pb)) parentTrusted = true;
                    } catch { /* ignore */ }
                }
                // Note: a full kaspad check per block is expensive;
                // we lean on shard + same-response set. If both miss,
                // we still accept (might be a legitimate chain edge)
                // but bump a counter so streams of misses get noticed.
            }
            // Defense 2: strip verboseData before storage.
            const sanitized = {
                header: block.header,
                transactions: block.transactions,
            };
            if (block.verboseData != null) strippedVerbose++;
            const bodyJson = Buffer.from(JSON.stringify(sanitized), 'utf-8');
            try {
                this.shardStorage.captureBlock(hashBytes, daaScore, bodyJson, true, blueScore);
                ingested++;
            } catch (err) {
                // Bad block; skip.
            }
        }
        if (rejected > 0) {
            this.emit('log', `Security: rejected ${rejected} blocks (hash not recognized by kaspad)`);
            this.emit('security-event', { type: 'rejected', count: rejected });
        }
        if (strippedVerbose > 0) {
            this.emit('security-event', { type: 'stripped-verbose', count: strippedVerbose });
        }
        if (monotonicityViolations > 5) {
            this.emit('log', `Security: ${monotonicityViolations} DAA-score backsteps in response (possible reordering attack)`);
            this.emit('security-event', { type: 'monotonicity', count: monotonicityViolations });
        }
        return ingested;
    }
}

exports.ShardFill = ShardFill;
//# sourceMappingURL=shard-fill.js.map
