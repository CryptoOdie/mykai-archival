"use strict";
/**
 * Swarm Assignment — pure logic for "which buckets should this node hold?"
 *
 * v0.5.3 makes MyKAI a real distributed archive. The whole question of "who
 * holds what" is answered by weighted rendezvous hashing (HRW). Given the
 * current member list, every node arrives at the same answer for every
 * bucket independently. No coordinator decides.
 *
 * The contract:
 *   - bucket: a DAA-score range, 100,000 wide. bucket_id = floor(daa / 100k)
 *   - members: [{ nodeId, budgetGB, ... }, ...] published by the foundation
 *     Worker or fetched from peer fallback
 *   - replicationFactor (RF=4): each bucket is owned by its top-4 nodes by
 *     HRW score across the member list
 *   - assignments(myNodeId, ...): "the buckets where I rank in the top-4
 *     and have budget left to hold them"
 *
 * Why HRW and not consistent hashing rings:
 *   When a node drops, only buckets where that node was in the top-K shift,
 *   and they move to the (formerly K+1-th) next-highest scoring node.
 *   Blast radius is perfectly localized. No vnode tables to agree on, no
 *   ring rotation. Five lines of math. See agent research synthesis 1.
 *
 * Why weighted by budget:
 *   A 1000 GB node should hold ~100× more buckets than a 10 GB node. The
 *   Schindelhauer-Schomaker weight formula makes this fall out for free:
 *     score = -weight / ln(uniform_hash(bucket_id, node_id))
 *   The higher the weight, the higher the score on more buckets.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUCKET_DAA_SIZE = void 0;
exports.bucketIdForDaa = bucketIdForDaa;
exports.daaRangeForBucket = daaRangeForBucket;
exports.hrwScore = hrwScore;
exports.computeAssignments = computeAssignments;
exports.computeBucketHolders = computeBucketHolders;

const crypto_1 = require("crypto");

/**
 * Bucket width in DAA units. 100,000 DAA at 10 BPS ≈ 17 min of chain history.
 * Coarse enough that even small swarms cover meaningful spans; fine enough
 * that a 40 GB user's ~13 buckets still spread across history rather than
 * being one giant lump.
 */
const BUCKET_DAA_SIZE = 100_000;
exports.BUCKET_DAA_SIZE = BUCKET_DAA_SIZE;

/** Replication factor. RF=4 means each bucket aims for 4 holders.
 *  Agent 3 (erasure-coding math) made this the lock — at 60% volunteer
 *  uptime, replication beats erasure coding on every axis that matters
 *  to a residential-laptop swarm. */
const REPLICATION_FACTOR = 4;

/**
 * Map a DAA score to its bucket id.
 * @param {number} daaScore
 * @returns {number}
 */
function bucketIdForDaa(daaScore) {
    return Math.floor(daaScore / BUCKET_DAA_SIZE);
}

/**
 * Inverse — the DAA range a bucket id covers.
 * @param {number} bucketId
 * @returns {{ startDaa: number, endDaa: number }} half-open [start, end)
 */
function daaRangeForBucket(bucketId) {
    return {
        startDaa: bucketId * BUCKET_DAA_SIZE,
        endDaa: (bucketId + 1) * BUCKET_DAA_SIZE,
    };
}

/**
 * Internal: hash a (bucket, node) pair to a uniform float in (0, 1).
 * We use SHA-256 (built into Node), take the first 8 bytes, and divide
 * by 2^64. Plenty uniform for HRW; the cryptographic strength doesn't
 * matter — only collision resistance for ranking does.
 */
function _uniformHash(bucketId, nodeId) {
    const h = (0, crypto_1.createHash)('sha256')
        .update(`${bucketId}|${nodeId}`)
        .digest();
    // First 8 bytes as a big-endian uint64. Divide by 2^64.
    // JS doesn't have native uint64; use BigInt then back to Number.
    let n = 0n;
    for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(h[i]);
    // Avoid exactly 0 — log(0) is -Infinity which would dominate scores.
    if (n === 0n) n = 1n;
    return Number(n) / 1.8446744073709552e19; // 2^64 as float
}

/**
 * Weighted Rendezvous Hashing score. Higher score = node "wants" the bucket
 * more. Each node computes this locally; the top-RF nodes by score across
 * the member list are the bucket's owners.
 *
 * Formula: score = -weight / ln(u), where u is uniform in (0, 1).
 * Schindelhauer-Schomaker 2005; used by GitHub's HRW load balancer, Apache
 * Ignite, Twitter EventBus.
 *
 * @param {number|string} bucketId
 * @param {string} nodeId
 * @param {number} budgetGB  used as the HRW weight
 * @returns {number}
 */
function hrwScore(bucketId, nodeId, budgetGB) {
    const u = _uniformHash(bucketId, nodeId);
    // u is strictly > 0 (we guarded against 0 above), so ln(u) is finite
    // and negative; dividing by it gives a positive score.
    // Math.max guards against extreme degenerate weight cases.
    return -Math.max(1, budgetGB) / Math.log(u);
}

/**
 * For one bucket, return the ordered list of (nodeId, score) pairs sorted
 * by score descending. The top RF entries are the bucket's intended
 * holders. Used by computeAssignments and computeBucketHolders.
 *
 * @param {number} bucketId
 * @param {Array<{nodeId: string, budgetGB: number}>} members
 * @returns {Array<{nodeId: string, score: number}>}
 */
function _rankBucket(bucketId, members) {
    const scored = members.map((m) => ({
        nodeId: m.nodeId,
        score: hrwScore(bucketId, m.nodeId, m.budgetGB || 1),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored;
}

/**
 * The RF top nodes for a given bucket — the canonical holder list for
 * routing. An indexer asking "who has bucket X?" gets this list and
 * tries them in order.
 *
 * @param {number} bucketId
 * @param {Array<{nodeId: string, budgetGB: number}>} members
 * @param {number} [rf] replication factor; defaults to RF=4
 * @returns {Array<string>} nodeIds, in descending score order
 */
function computeBucketHolders(bucketId, members, rf = REPLICATION_FACTOR) {
    if (!members || members.length === 0) return [];
    const ranked = _rankBucket(bucketId, members);
    return ranked.slice(0, rf).map((r) => r.nodeId);
}

/**
 * The set of buckets THIS node should be holding right now. Two-stage:
 *
 *   1. For each candidate bucket in [floorBucket, tipBucket], compute my
 *      HRW score and rank against the rest of the swarm. If I'm in the
 *      top RF, this bucket is "mine to consider."
 *   2. Among "mine to consider" buckets, sort by my own score descending
 *      and walk down until I fill my assignable budget. Buckets beyond
 *      my budget fall through to other holders naturally.
 *
 * The deliberate property: even with weighted HRW, a node can't be
 * "assigned" more than its budget allows. If its top-RF rank for bucket
 * X doesn't fit in budget, the bucket effectively falls to rank RF+1
 * (and someone else covers it). Coverage emerges from the swarm-wide
 * sum of these local decisions.
 *
 * @param {string} myNodeId
 * @param {number} myBudgetGB
 * @param {Array<{nodeId: string, budgetGB: number}>} members
 * @param {Array<number>} candidateBucketIds  buckets in scope (tip down to floor)
 * @param {object} [opts]
 * @param {number} [opts.bucketSizeGB=3]  approximate size of one bucket in GB
 * @param {number} [opts.hotTailGB=1]     budget reserved for live tip capture
 * @param {number} [opts.rf=4]            replication factor
 * @returns {Array<number>} bucket IDs assigned to this node, in HRW-score order
 */
function computeAssignments(myNodeId, myBudgetGB, members, candidateBucketIds, opts = {}) {
    const bucketSizeGB = opts.bucketSizeGB || 3;
    const hotTailGB = opts.hotTailGB || 1;
    const rf = opts.rf || REPLICATION_FACTOR;
    if (!members || members.length === 0) return [];
    if (!candidateBucketIds || candidateBucketIds.length === 0) return [];
    // Find myself in the member list to confirm I'm visible to the swarm.
    // (If I'm not, the foundation Worker hasn't acknowledged my heartbeat
    // yet — assignments would be wrong. Better to fall back to empty than
    // race with a stale view.)
    const meVisible = members.some((m) => m.nodeId === myNodeId);
    if (!meVisible) return [];
    const assignableBudgetGB = Math.max(0, myBudgetGB - hotTailGB);
    const budgetBuckets = Math.floor(assignableBudgetGB / bucketSizeGB);
    if (budgetBuckets <= 0) return [];
    // Stage 1: find buckets where I'm in the top-RF.
    const mine = [];
    for (const bucketId of candidateBucketIds) {
        const ranked = _rankBucket(bucketId, members);
        const myRank = ranked.findIndex((r) => r.nodeId === myNodeId);
        if (myRank >= 0 && myRank < rf) {
            mine.push({ bucketId, myScore: ranked[myRank].score });
        }
    }
    // Stage 2: sort by my own score and take the top budgetBuckets.
    // The highest-score buckets are the ones where I'm "most assigned"
    // (closest to the top of the rank). If my budget can't hold them
    // all, the lowest-score ones effectively fall to rank RF+1.
    mine.sort((a, b) => b.myScore - a.myScore);
    return mine.slice(0, budgetBuckets).map((b) => b.bucketId);
}
//# sourceMappingURL=swarm-assignment.js.map
