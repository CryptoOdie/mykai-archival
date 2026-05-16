"use strict";
/**
 * Kaspa merkle root — re-implementation of rusty-kaspa's
 * `kaspa_merkle::calc_merkle_root` + `consensus::merkle::calc_hash_merkle_root`.
 *
 * Algorithm:
 *   1. Empty input → ZERO_HASH (32 zero bytes).
 *   2. Pad leaf count to next power of two; missing leaves are `None`.
 *   3. Build level by level: pair (i, i+1). If both None, parent is None.
 *      If left present, right missing → parent = merkleHash(left, ZERO_HASH).
 *   4. Internal node hash = BLAKE2b-256 keyed "MerkleBranch" over (left||right).
 *   5. Root = top of tree.
 *
 * The block's `header.hashMerkleRoot` commits to the merkle root of
 * full tx hashes (computeTxHash, NOT computeTxId).
 *
 * Canonical reference: rusty-kaspa/crypto/merkle/src/lib.rs +
 *                       rusty-kaspa/consensus/core/src/merkle.rs
 *
 * SECURITY-CRITICAL: this is the second half of body-merkle verification
 * (paired with kaspa-tx-hash.js). Drift produces wrong roots silently.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.calcMerkleRoot = calcMerkleRoot;
exports.calcHashMerkleRoot = calcHashMerkleRoot;
exports.merkleHash = merkleHash;
exports.ZERO_HASH = void 0;

const { blake2b } = require('@noble/hashes/blake2.js');
const txHash = require('./kaspa-tx-hash.js');

const KEY_MERKLE_BRANCH = Buffer.from('MerkleBranch', 'utf-8');
const ZERO_HASH = Buffer.alloc(32);
exports.ZERO_HASH = ZERO_HASH;

function _nextPowerOfTwo(n) {
    if (n <= 1) return 1;
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

/**
 * Hash two 32-byte buffers under the MerkleBranch key.
 * @param {Buffer} left
 * @param {Buffer} right
 * @returns {Buffer} 32 bytes
 */
function merkleHash(left, right) {
    const buf = Buffer.concat([left, right], 64);
    const out = blake2b(buf, { dkLen: 32, key: KEY_MERKLE_BRANCH });
    return Buffer.from(out);
}

/**
 * Compute the merkle root of a list of leaf hashes (each 32 bytes).
 * Leaves may be provided as hex strings or Buffers.
 * @param {Array<string|Buffer>} hashes
 * @returns {Buffer} 32-byte root
 */
function calcMerkleRoot(hashes) {
    if (!hashes || hashes.length === 0) return Buffer.from(ZERO_HASH);
    const leaves = hashes.map(h => {
        if (Buffer.isBuffer(h)) return h;
        const clean = (typeof h === 'string' && h.startsWith('0x')) ? h.slice(2) : h;
        return Buffer.from(clean, 'hex');
    });

    const nextPot = _nextPowerOfTwo(leaves.length);
    const vecLen = 2 * nextPot - 1;
    // `null` denotes the Rust `None` variant.
    const merkles = new Array(vecLen).fill(null);
    for (let i = 0; i < leaves.length; i++) merkles[i] = leaves[i];

    let offset = nextPot;
    for (let i = 0; i < vecLen - 1; i += 2) {
        if (merkles[i] === null) {
            merkles[offset] = null;
        } else {
            const right = merkles[i + 1] ?? ZERO_HASH;
            merkles[offset] = merkleHash(merkles[i], right);
        }
        offset++;
    }
    return merkles[vecLen - 1];
}

/**
 * Compute the hashMerkleRoot for a block's transactions.
 * @param {Array<object>} transactions  kaspad wRPC tx shape
 * @param {boolean} postCrescendo       include mass commitment per tx
 * @returns {string} 64-char lowercase hex root
 */
function calcHashMerkleRoot(transactions, postCrescendo = true) {
    if (!transactions || transactions.length === 0) {
        return ZERO_HASH.toString('hex');
    }
    const leafHashes = transactions.map(tx => txHash.computeTxHash(tx, postCrescendo));
    const root = calcMerkleRoot(leafHashes);
    return root.toString('hex');
}
