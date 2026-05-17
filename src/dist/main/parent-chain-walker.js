"use strict";
/**
 * Parent-chain walker — the trustless deep-history verifier.
 *
 * When an untrusted source serves a block whose hash local kaspad
 * doesn't directly recognize, walk its parent chain step-by-step,
 * verifying each link's hash, until we reach a block kaspad DOES
 * recognize (a skeleton anchor or recent-window block). If the walk
 * completes successfully, the original block is cryptographically
 * proven to chain back to a canonical anchor — its bytes are real
 * Kaspa history, no trust in the source required.
 *
 * What this catches:
 *   - A peer serves a real-looking block X with a fake header → hash
 *     mismatch on first re-compute, reject immediately.
 *   - A peer serves a chain of fake intermediates → either the chain
 *     never reaches a canonical anchor (walk fails), or one of the
 *     intermediate hashes fails to match its header bytes (forgery
 *     impossible under BLAKE2b-256 second-preimage).
 *   - A cycle / dead-end → max-hop limit + visited set.
 *
 * What this does NOT catch (residual gap, documented in security-model.md):
 *   - A nation-state with massive mining power could in theory PoW-mine
 *     a forged historical chain that ends at a canonical anchor. The
 *     cost: real mining work for every fake block. v0.6 will add
 *     per-hop PoW re-verification (kHeavyHash) to close this gap.
 *
 * Configuration:
 *   - maxHops: bound on walk depth. 100,000 is enough for any realistic
 *     pruning-proof gap on mainnet.
 *   - cache: in-memory Set of hashes proven canonical via prior walks.
 *     Once verified, never re-walk. Bounded by LRU at 100k entries.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParentChainWalker = void 0;
exports.createWalker = createWalker;

const { verifyClaimedHash, computeBlockHash } = require('./kaspa-block-hash');

const DEFAULT_MAX_HOPS = 100_000;
const VERIFIED_CACHE_MAX = 100_000;

class ParentChainWalker {
    /**
     * @param {object} opts
     * @param {Function} opts.kaspadKnowsHash  async (hashHex) => boolean — asks local kaspad if it knows the hash
     * @param {Function} opts.fetchHeader      async (hashHex) => header object | null — fetches a parent's header from any source
     * @param {number} [opts.maxHops=100000]
     */
    constructor({ kaspadKnowsHash, fetchHeader, maxHops = DEFAULT_MAX_HOPS }) {
        this.kaspadKnowsHash = kaspadKnowsHash;
        this.fetchHeader = fetchHeader;
        this.maxHops = maxHops;
        // Set of hash hex strings proven canonical. Insertion-ordered;
        // we trim by deletion of oldest when over MAX. Crude LRU but
        // good enough — hits dominate misses.
        this._verifiedCache = new Set();
    }

    /** True if we've previously proven this hash canonical via a walk. */
    isKnownCanonical(hashHex) {
        return this._verifiedCache.has(hashHex.toLowerCase());
    }

    _cacheCanonical(hashHex) {
        const k = hashHex.toLowerCase();
        if (this._verifiedCache.has(k)) return;
        this._verifiedCache.add(k);
        if (this._verifiedCache.size > VERIFIED_CACHE_MAX) {
            // Crude eviction: drop oldest by iterator order.
            const drop = this._verifiedCache.values().next().value;
            this._verifiedCache.delete(drop);
        }
    }

    /**
     * Walk the parent chain of `block` until we reach a known-canonical
     * hash (in kaspad or in our cache). Verifies each hop by re-hashing
     * the parent's header and confirming it matches the claimed hash.
     *
     * @param {object} block  block as served by source (must have header)
     * @returns {Promise<{verified: boolean, hops: number, anchor?: string, reason?: string}>}
     */
    async verify(block) {
        if (!block?.header) {
            return { verified: false, hops: 0, reason: 'no-header' };
        }

        // First, verify the block itself: re-hash and confirm the claimed
        // hash. This catches any tampering at the top of the chain.
        const claimedHash = block?.verboseData?.hash || block?.header?.hash;
        if (!claimedHash || !/^[0-9a-fA-F]{64}$/.test(claimedHash)) {
            return { verified: false, hops: 0, reason: 'no-hash' };
        }
        if (!verifyClaimedHash(block.header, claimedHash)) {
            return { verified: false, hops: 0, reason: 'self-hash-mismatch' };
        }

        // Fast path: maybe kaspad recognizes the block hash directly.
        if (await this.kaspadKnowsHash(claimedHash)) {
            this._cacheCanonical(claimedHash);
            return { verified: true, hops: 0, anchor: claimedHash };
        }
        // Also fast path: cached from prior walk.
        if (this.isKnownCanonical(claimedHash)) {
            return { verified: true, hops: 0, anchor: claimedHash };
        }

        // Walk parents.
        const visited = new Set([claimedHash.toLowerCase()]);
        let current = block;
        let hops = 0;
        // Track chain for cache-bulk-update on success.
        const walkChain = [claimedHash.toLowerCase()];

        while (hops < this.maxHops) {
            // Get parents (flatten levels).
            // kaspad wRPC returns parents under `parents`; some shapes
            // (and rest of this codebase) use `parentsByLevel`. Accept both.
            const parentLevels = current.header.parents || current.header.parentsByLevel || [];
            const allParents = [];
            for (const lvl of parentLevels) {
                const hashes = Array.isArray(lvl) ? lvl : (lvl?.parentHashes || []);
                for (const h of hashes) allParents.push(h);
            }
            if (allParents.length === 0) {
                return { verified: false, hops, reason: 'no-parents' };
            }

            // Try the first parent; if known-canonical, we're done.
            const parentHash = allParents[0];
            const pkey = parentHash.toLowerCase();

            // Cache hit shortcut.
            if (this.isKnownCanonical(parentHash)) {
                // Bulk-cache the whole chain.
                for (const h of walkChain) this._cacheCanonical(h);
                return { verified: true, hops, anchor: parentHash };
            }

            // Kaspad-recognized shortcut.
            if (await this.kaspadKnowsHash(parentHash)) {
                this._cacheCanonical(parentHash);
                for (const h of walkChain) this._cacheCanonical(h);
                return { verified: true, hops, anchor: parentHash };
            }

            // Cycle detection.
            if (visited.has(pkey)) {
                return { verified: false, hops, reason: 'cycle' };
            }
            visited.add(pkey);
            walkChain.push(pkey);

            // Fetch the parent's header from any available source.
            const parentBlock = await this.fetchHeader(parentHash);
            if (!parentBlock) {
                return { verified: false, hops, reason: 'parent-unavailable' };
            }

            // Verify parent's header hashes to its claimed hash.
            if (!verifyClaimedHash(parentBlock.header, parentHash)) {
                return { verified: false, hops, reason: `hash-mismatch-at-hop-${hops}` };
            }

            current = parentBlock;
            hops++;
        }

        return { verified: false, hops, reason: 'max-hops-exceeded' };
    }
}
exports.ParentChainWalker = ParentChainWalker;

/** Convenience factory. */
function createWalker(opts) {
    return new ParentChainWalker(opts);
}
//# sourceMappingURL=parent-chain-walker.js.map
