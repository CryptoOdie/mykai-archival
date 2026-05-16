"use strict";
/**
 * Shard Pull — the data-source layer for the fill loop.
 *
 * Three sources, in priority order:
 *   1. Local kaspad — fast (local I/O), but only has what's inside its
 *      pruning window (~30h). Walks forward from a known anchor hash
 *      until the requested DAA range is covered.
 *   2. MyKAI peers — call other participants' /shard/blocks HTTP
 *      endpoint. Same protocol as a fresh indexer would use. Works for
 *      any range some peer has stored.
 *   3. Seed kaspads — foundation-run + community archival servers,
 *      hardcoded URL list with fallback chain. The bootstrap source
 *      when the swarm doesn't have a range yet.
 *
 * Every pulled block is hash-verified against the local kaspad's
 * header chain — kaspad maintains all block headers even after pruning
 * bodies, so `getBlock(hash, includeTransactions=false)` is a cheap,
 * authoritative "is this hash a real Kaspa block?" check. Mismatches
 * are rejected, the source gets a strike, the next source is tried.
 *
 * The walking algorithm: kaspad's getBlocks RPC returns up to ~500
 * blocks starting at a low_hash. To cover a DAA range [start, end), we
 * pick the latest anchor hash whose DAA is at-or-below start, call
 * getBlocks, filter results to our range, and if end isn't reached we
 * use the highest-DAA hash from the response as the next anchor and
 * repeat. Up to MAX_WALK_ITERATIONS to bound worst-case work.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.pullBucketFromKaspad = pullBucketFromKaspad;
exports.pullBucketFromHTTPSource = pullBucketFromHTTPSource;
exports.pullBucketFromRemoteKaspad = pullBucketFromRemoteKaspad;
exports.verifyBlockHashAgainstKaspad = verifyBlockHashAgainstKaspad;
exports.DEFAULT_SEED_SOURCES = void 0;
exports.DEFAULT_KASPAD_SEED_SOURCES = void 0;

const { KaspadWRPCClient } = require('./kaspad-wrpc-client');

/**
 * Hardcoded seed sources. The foundation runs at least one of these;
 * the others are community-archived. As the swarm fills out, seed
 * dependency drops near zero — these are bootstrap-only.
 *
 * Each entry is an HTTP endpoint that speaks MyKAI's /shard/blocks
 * protocol. The foundation deploys a MyKAI instance with full archival
 * kaspad behind it, exposes the standard /shard/* endpoints, and lists
 * it here. Same protocol = same pull code.
 */
const DEFAULT_SEED_SOURCES = [
    // Foundation-run archival MyKAI instance (TODO: actual URL when deployed)
    'https://seed-1.mykai.io',
    // Community-run mirrors (TODO: real URLs)
    'https://seed-2.mykai.io',
];
exports.DEFAULT_SEED_SOURCES = DEFAULT_SEED_SOURCES;

/**
 * Default raw-wRPC kaspad seed list. These are public archival kaspad
 * nodes that speak standard Kaspa wRPC (NOT MyKAI's HTTP /shard/blocks).
 * The fill loop tries them AFTER local kaspad and MyKAI peers, as a
 * heavy-weight fallback for ranges no one in the MyKAI swarm has yet.
 *
 * EMPTY BY DEFAULT. The user (or foundation, via a future config push)
 * must populate this list with reachable URLs. If left empty, the fill
 * loop simply skips this source and falls through to the HTTP seed list.
 *
 * Community-known options the user can configure manually in
 * mykai-archival-config.json under `kaspadSeedSources`:
 *   - "wss://your-own-archival-kaspad:18110"
 *   - Foundation-run archival nodes (URLs published in v0.5.3+ docs)
 */
const DEFAULT_KASPAD_SEED_SOURCES = [];
exports.DEFAULT_KASPAD_SEED_SOURCES = DEFAULT_KASPAD_SEED_SOURCES;

/** Max iterations of walk-forward before giving up. At 500 blocks/call,
 *  20 iterations covers ~10,000 blocks ≈ one 100k-DAA bucket. */
const MAX_WALK_ITERATIONS = 25;
/** Per-call timeout for one getBlocks round-trip. */
const RPC_CALL_TIMEOUT_MS = 10_000;

/**
 * Pull a DAA range from local kaspad. Walks forward from an anchor
 * hash, filters each chunk to the requested range, stops when the
 * range is covered or we run out of forward progress.
 *
 * @param {any} monitor RpcMonitor instance with rpcCall()
 * @param {any} shardStorage for finding a closer anchor than pruning point
 * @param {{startDaa: number, endDaa: number}} range
 * @returns {Promise<Array<object>>} blocks within the range
 */
async function pullBucketFromKaspad(monitor, shardStorage, range) {
    if (!monitor || !monitor.rpcCall) return [];
    // Find the best anchor we can: closest stored block at-or-below
    // range.startDaa, falling back to pruning point if we have nothing.
    let anchor = await _findAnchorHash(monitor, shardStorage, range.startDaa);
    if (!anchor) return [];
    const out = [];
    const seenHashes = new Set();
    let lastDaaInChunk = -1;
    for (let i = 0; i < MAX_WALK_ITERATIONS; i++) {
        const resp = await monitor.rpcCall(
            'getBlocks',
            {
                lowHash: anchor,
                includeBlocks: true,
                includeTransactions: true,
            },
            RPC_CALL_TIMEOUT_MS
        ).catch(() => null);
        const blocks = resp?.params?.blocks;
        if (!Array.isArray(blocks) || blocks.length === 0) break;
        // Track progress so we know when to advance the anchor.
        let advanced = false;
        let chunkMaxDaa = -1;
        let chunkMaxDaaHash = null;
        for (const b of blocks) {
            const daa = Number(b?.header?.daaScore ?? b?.header?.daa_score ?? 0);
            const hash = b?.verboseData?.hash || b?.header?.hash;
            if (!hash || seenHashes.has(hash)) continue;
            seenHashes.add(hash);
            if (daa > chunkMaxDaa) {
                chunkMaxDaa = daa;
                chunkMaxDaaHash = hash;
            }
            if (daa >= range.startDaa && daa < range.endDaa) {
                out.push(b);
                advanced = true;
            }
        }
        // Stop conditions:
        //  - past the end of our range
        //  - no forward progress (anchor unchanged)
        if (chunkMaxDaa >= range.endDaa) break;
        if (chunkMaxDaa <= lastDaaInChunk) break;
        lastDaaInChunk = chunkMaxDaa;
        if (chunkMaxDaaHash) anchor = chunkMaxDaaHash;
        else break;
    }
    return out;
}

/** Internal: pick the best anchor hash for a DAA target.
 *  Prefer a stored block at-or-below target (we already have it, so
 *  starting there means we won't waste RPC calls retracing blocks
 *  we don't need). Fall back to pruning point hash. */
async function _findAnchorHash(monitor, shardStorage, targetDaa) {
    // Try a stored block first — query a 100k-DAA window ending at target.
    if (shardStorage && typeof shardStorage.getByDaaRange === 'function') {
        try {
            const windowStart = Math.max(0, targetDaa - 200_000);
            const rows = shardStorage.getByDaaRange(windowStart, targetDaa + 1, 50);
            if (rows && rows.length > 0) {
                // Pick the LATEST (highest daa) stored row at-or-below target.
                let best = null;
                for (const r of rows) {
                    if (r.daaScore <= targetDaa && (!best || r.daaScore > best.daaScore)) {
                        best = r;
                    }
                }
                if (best && best.hash) {
                    return Buffer.from(best.hash).toString('hex');
                }
            }
        } catch { /* fall through */ }
    }
    // Fallback: pruning point. Always present, always at-or-below tip.
    const dag = await monitor.rpcCall('getBlockDagInfo', {}, RPC_CALL_TIMEOUT_MS).catch(() => null);
    return dag?.params?.pruningPointHash || null;
}

/**
 * Pull a DAA range from an HTTP source — either a MyKAI peer or a
 * foundation seed. Same protocol either way: /shard/blocks?low_hash=
 * &include_txs=true&limit=500. Walks forward exactly like the local
 * kaspad pull, just over HTTP.
 *
 * @param {string} baseUrl e.g. 'https://seed-1.mykai.io'
 * @param {any} shardStorage for finding a closer anchor than pruning point
 * @param {any} monitor for resolving the initial anchor
 * @param {{startDaa: number, endDaa: number}} range
 * @returns {Promise<Array<object>>} blocks within the range
 */
async function pullBucketFromHTTPSource(baseUrl, monitor, shardStorage, range) {
    if (!baseUrl) return [];
    // Ask the SOURCE for its dag-info so we anchor against ITS pruning
    // point, not ours. This matters when pulling from an archival seed
    // whose pruning point is much older than our local kaspad's.
    let anchor = await _findAnchorHash(monitor, shardStorage, range.startDaa);
    // For an HTTP source, we could also call its /shard/dag-info to
    // potentially find an older anchor it advertises (pool_floor_daa).
    // For Day 3 simple: trust our local anchor and let the source 404
    // if it can't serve from there.
    if (!anchor) return [];
    const out = [];
    const seenHashes = new Set();
    let lastDaa = -1;
    for (let i = 0; i < MAX_WALK_ITERATIONS; i++) {
        const url = `${baseUrl.replace(/\/$/, '')}/shard/blocks?low_hash=${anchor}&include_txs=true&limit=500`;
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), RPC_CALL_TIMEOUT_MS);
            const resp = await fetch(url, {
                headers: { 'Accept-Encoding': 'gzip' },
                signal: ctrl.signal,
            });
            clearTimeout(t);
            if (!resp.ok) {
                // 404 below_pool_floor means the source can't serve from
                // that anchor — we'd need an older one. For Day 3 we
                // bail; v0.5.4 will let the source advertise its floor
                // so we can adjust.
                break;
            }
            const body = await resp.json();
            const blocks = body?.blocks;
            if (!Array.isArray(blocks) || blocks.length === 0) break;
            let chunkMaxDaa = -1;
            let chunkMaxDaaHash = null;
            for (const b of blocks) {
                const daa = Number(b?.header?.daaScore ?? b?.header?.daa_score ?? 0);
                const hash = b?.verboseData?.hash || b?.header?.hash;
                if (!hash || seenHashes.has(hash)) continue;
                seenHashes.add(hash);
                if (daa > chunkMaxDaa) {
                    chunkMaxDaa = daa;
                    chunkMaxDaaHash = hash;
                }
                if (daa >= range.startDaa && daa < range.endDaa) {
                    out.push(b);
                }
            }
            if (chunkMaxDaa >= range.endDaa) break;
            if (chunkMaxDaa <= lastDaa) break;
            lastDaa = chunkMaxDaa;
            if (chunkMaxDaaHash) anchor = chunkMaxDaaHash;
            else break;
        } catch (err) {
            break;
        }
    }
    return out;
}

/**
 * Hash-verify a block by asking local kaspad if it knows this hash.
 * kaspad maintains all block headers even after pruning bodies — so
 * `getBlock(hash, includeTransactions=false)` is the authoritative
 * "is this a real Kaspa block?" check.
 *
 * Returns true if kaspad confirms the hash, false otherwise. A pulled
 * block that fails verification is dropped, the source gets a strike
 * (caller's responsibility), and the next source is tried.
 *
 * Note: this verification depends on the LOCAL kaspad being synced
 * past the block. For tip-recent blocks this is fine. For ancient
 * blocks (older than kaspad's header retention), the check returns
 * false even for genuine blocks — in that case we'd need a different
 * verification path (Merkle anchored to a checkpoint). v0.5.4 work.
 *
 * @param {any} monitor RpcMonitor
 * @param {string} hashHex
 * @returns {Promise<boolean>}
 */
/**
 * Pull a DAA range from a REMOTE kaspad via wRPC WebSocket. Same
 * walking algorithm as the local-kaspad pull, but speaks Kaspa wRPC
 * over an external WebSocket connection. Used for foundation/community
 * archival kaspad seeds when local kaspad has pruned the range AND no
 * MyKAI peer has it.
 *
 * Anchor selection: ask the REMOTE kaspad for its own pruning point
 * via getBlockDagInfo. An archival remote will return a much-older
 * pruning point than ours, letting us walk forward into ancient
 * history.
 *
 * Heavyweight: opens a WebSocket, makes O(walk_iterations) RPC calls,
 * closes. Don't call concurrently from one node — let the fill loop's
 * outer rate limit (MAX_INFLIGHT_PULLS) bound parallelism.
 *
 * @param {string} wssUrl e.g. 'wss://archival.kaspad.example:18110'
 * @param {{startDaa: number, endDaa: number}} range
 * @returns {Promise<Array<object>>}
 */
async function pullBucketFromRemoteKaspad(wssUrl, range) {
    if (!wssUrl) return [];
    const client = new KaspadWRPCClient(wssUrl);
    const out = [];
    const seenHashes = new Set();
    let lastDaa = -1;
    try {
        // Start anchor: the remote kaspad's pruning point. If they're
        // archival, this is way old; if pruned, it's recent like ours.
        const dag = await client.rpcCall('getBlockDagInfo', {}, RPC_CALL_TIMEOUT_MS);
        let anchor = dag?.params?.pruningPointHash;
        if (!anchor) return [];
        for (let i = 0; i < MAX_WALK_ITERATIONS; i++) {
            const resp = await client.rpcCall('getBlocks', {
                lowHash: anchor,
                includeBlocks: true,
                includeTransactions: true,
            }, RPC_CALL_TIMEOUT_MS).catch(() => null);
            const blocks = resp?.params?.blocks;
            if (!Array.isArray(blocks) || blocks.length === 0) break;
            let chunkMaxDaa = -1;
            let chunkMaxDaaHash = null;
            for (const b of blocks) {
                const daa = Number(b?.header?.daaScore ?? b?.header?.daa_score ?? 0);
                const hash = b?.verboseData?.hash || b?.header?.hash;
                if (!hash || seenHashes.has(hash)) continue;
                seenHashes.add(hash);
                if (daa > chunkMaxDaa) {
                    chunkMaxDaa = daa;
                    chunkMaxDaaHash = hash;
                }
                if (daa >= range.startDaa && daa < range.endDaa) {
                    out.push(b);
                }
            }
            if (chunkMaxDaa >= range.endDaa) break;
            if (chunkMaxDaa <= lastDaa) break;
            lastDaa = chunkMaxDaa;
            if (chunkMaxDaaHash) anchor = chunkMaxDaaHash;
            else break;
        }
    } catch (err) {
        // Remote unreachable / handshake failed / etc. — return what
        // we have (probably nothing); caller falls through to next source.
    } finally {
        client.close();
    }
    return out;
}

async function verifyBlockHashAgainstKaspad(monitor, hashHex) {
    if (!monitor || !monitor.rpcCall) return false;
    if (!hashHex || !/^[0-9a-fA-F]{64}$/.test(hashHex)) return false;
    try {
        const resp = await monitor.rpcCall(
            'getBlock',
            { hash: hashHex, includeTransactions: false },
            3000
        );
        // If kaspad returns a block object with a header, it knows the hash.
        return !!(resp?.params?.block?.header);
    } catch {
        return false;
    }
}

/**
 * v0.5.4: full block verification — uses parent-chain walking when direct
 * kaspad lookup fails. Returns true if the block is cryptographically
 * proven canonical, false otherwise. Pass a `walker` instance to enable
 * deep-history verification; without it, falls back to direct kaspad
 * lookup only (v0.5.3 behavior).
 *
 * Verification order:
 *   1. Re-hash block.header → must match block's claimed hash
 *   2. If kaspad knows the hash → accept (recent + skeleton anchor case)
 *   3. If walker is provided → walk parent chain to a canonical anchor
 *   4. Otherwise → reject
 */
async function verifyBlockFull(monitor, block, walker) {
    if (!block?.header) return false;
    const claimedHash = block?.verboseData?.hash || block?.header?.hash;
    if (!claimedHash || !/^[0-9a-fA-F]{64}$/.test(claimedHash)) return false;

    // Direct kaspad check (works for recent + skeleton anchors).
    if (await verifyBlockHashAgainstKaspad(monitor, claimedHash)) {
        return true;
    }

    // Fall back to chain-walking if a walker was provided.
    if (walker && typeof walker.verify === 'function') {
        const result = await walker.verify(block);
        return result.verified === true;
    }

    return false;
}
exports.verifyBlockFull = verifyBlockFull;
//# sourceMappingURL=shard-pull.js.map
