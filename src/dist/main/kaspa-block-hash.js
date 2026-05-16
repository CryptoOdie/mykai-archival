"use strict";
/**
 * Kaspa BlockHash — re-implementation of rusty-kaspa's canonical
 * header hashing in JS.
 *
 * Used by the parent-chain walker (parent-chain-walker.js) to verify
 * untrusted-source blocks: re-hash the header bytes, compare to the
 * claimed hash. Mathematically impossible to forge under BLAKE2b-256
 * second-preimage resistance.
 *
 * Canonical reference: rusty-kaspa/consensus/core/src/hashing/header.rs
 * Hash function:       BLAKE2b-256 KEYED with key bytes "BlockHash"
 *                      (NOT personalization — BLAKE2 keyed mode, per
 *                       blake2b_simd's Params::key() in rusty-kaspa).
 *
 * Field serialization order — this is THE SECURITY-CRITICAL ORDER.
 * Any drift produces wrong hashes silently. Tests pinned against
 * mainnet vectors are mandatory; do not modify this list without
 * cross-referencing rusty-kaspa's canonical header_hash().
 *
 *   1.  version              u16 LE
 *   2.  parents_by_level     u64 LE count, then per level:
 *                              u64 LE parent_count, then 32-byte hashes
 *   3.  hash_merkle_root     32 B
 *   4.  accepted_id_merkle_root  32 B
 *   5.  utxo_commitment      32 B
 *   6.  timestamp            u64 LE (milliseconds since epoch)
 *   7.  bits                 u32 LE
 *   8.  nonce                u64 LE
 *   9.  daa_score            u64 LE
 *   10. blue_score           u64 LE   ← BEFORE blue_work (the #1 footgun)
 *   11. blue_work            length-prefixed big-int bytes (u64 LE length, then bytes BE)
 *   12. pruning_point        32 B
 *
 * Note: rusty-kaspa's blue_work field is `BlueWorkType` (a U192-equivalent).
 * It's serialized as: u64 LE byte length, then big-endian bytes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeBlockHash = computeBlockHash;
exports.verifyClaimedHash = verifyClaimedHash;

const { blake2b } = require('@noble/hashes/blake2.js');

/** Personalization-by-key for Kaspa block hashing. */
const KEY_BLOCK_HASH = Buffer.from('BlockHash', 'utf-8');

/**
 * Write a uint64 (number or bigint) as 8 LE bytes into the writer.
 */
function _writeU64LE(bufList, n) {
    const v = typeof n === 'bigint' ? n : BigInt(n);
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v & 0xffffffffffffffffn);
    bufList.push(b);
}
function _writeU32LE(bufList, n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(Number(n) & 0xffffffff);
    bufList.push(b);
}
function _writeU16LE(bufList, n) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(Number(n) & 0xffff);
    bufList.push(b);
}
function _writeHash(bufList, hashHex) {
    if (!hashHex || !/^[0-9a-fA-F]{64}$/.test(hashHex)) {
        // Pad to 32 zero bytes for malformed input — will produce a
        // non-canonical hash, caller's verify step rejects.
        bufList.push(Buffer.alloc(32));
        return;
    }
    bufList.push(Buffer.from(hashHex, 'hex'));
}

/**
 * Build the canonical pre-image bytes for a Kaspa block header.
 * Input: a header object as returned by kaspad wRPC (camelCase fields).
 */
function _buildHeaderPreImage(header) {
    const parts = [];

    // Canonical reference: rusty-kaspa consensus/core/src/hashing/header.rs::hash_override_nonce_time
    // Cross-validated against test vectors from local mainnet kaspad.

    // 1. version (u16 LE)
    _writeU16LE(parts, header.version || 0);

    // 2. parents_by_level — Vec<Vec<Hash>>
    //    write_len(level_count) [u64 LE], then for each level:
    //      write_var_array: write_len(parent_count) [u64 LE] + each 32-B hash
    //    kaspad JSON field name: parentsByLevel
    //    Each level is a flat array of hash hex strings.
    const parents = header.parentsByLevel || header.parents || [];
    _writeU64LE(parts, parents.length);
    for (const level of parents) {
        const hashes = Array.isArray(level) ? level : (level?.parentHashes || []);
        _writeU64LE(parts, hashes.length);
        for (const h of hashes) {
            _writeHash(parts, h);
        }
    }

    // 3. hash_merkle_root (32 B)
    _writeHash(parts, header.hashMerkleRoot);

    // 4. accepted_id_merkle_root (32 B; SequencingCommitment post-Crescendo, same offset)
    _writeHash(parts, header.acceptedIdMerkleRoot);

    // 5. utxo_commitment (32 B)
    _writeHash(parts, header.utxoCommitment);

    // 6. timestamp (u64 LE, ms since epoch)
    _writeU64LE(parts, header.timestamp || 0);

    // 7. bits (u32 LE)
    _writeU32LE(parts, header.bits || 0);

    // 8. nonce (u64 LE)
    //    CRITICAL: Kaspa nonces are u64 and routinely exceed 2^53, the
    //    largest precise JS Number. Always convert via BigInt to preserve
    //    the exact value. If `nonce` arrives as a JS number, it may have
    //    already lost precision — upstream parsers (rpc-monitor) wrap big
    //    nonces in quotes before JSON.parse to keep them as strings.
    const nonceBig = typeof header.nonce === 'bigint'
        ? header.nonce
        : BigInt(String(header.nonce || 0));
    _writeU64LE(parts, nonceBig);

    // 9. daa_score (u64 LE)
    _writeU64LE(parts, header.daaScore || 0);

    // 10. blue_score (u64 LE)   ← BEFORE blue_work
    _writeU64LE(parts, header.blueScore || 0);

    // 11. blue_work — write_blue_work in rusty-kaspa does:
    //      let be_bytes = work.to_be_bytes();                 // 24 bytes for U192
    //      let start = first_nonzero_index_or_end;
    //      write_var_bytes(&be_bytes[start..])                // u64 LE len + bytes
    //    So: take the big-endian bytes, strip leading zeros, write as var_bytes.
    //    kaspad's JSON returns it as a hex string with leading zeros already.
    let blueWorkHex = (header.blueWork || '').replace(/^0x/, '');
    // Pad to even length so hex parses cleanly.
    if (blueWorkHex.length % 2 !== 0) blueWorkHex = '0' + blueWorkHex;
    let blueWorkBytes = blueWorkHex.length > 0
        ? Buffer.from(blueWorkHex, 'hex')
        : Buffer.alloc(0);
    // Strip leading zero BYTES (not hex digits).
    let firstNonZero = 0;
    while (firstNonZero < blueWorkBytes.length && blueWorkBytes[firstNonZero] === 0) {
        firstNonZero++;
    }
    const stripped = blueWorkBytes.subarray(firstNonZero);
    _writeU64LE(parts, stripped.length);
    parts.push(stripped);

    // 12. pruning_point (32 B)
    _writeHash(parts, header.pruningPoint);

    return Buffer.concat(parts);
}

/**
 * Compute the canonical BlockHash for a Kaspa header.
 * @param {object} header  kaspad-shaped header object (camelCase fields)
 * @returns {string}       64-char lowercase hex
 */
function computeBlockHash(header) {
    if (!header) throw new Error('computeBlockHash: header is required');
    const preimage = _buildHeaderPreImage(header);
    // BLAKE2b-256 keyed with "BlockHash"
    const out = blake2b(preimage, { dkLen: 32, key: KEY_BLOCK_HASH });
    return Buffer.from(out).toString('hex');
}

/**
 * Compare a header's computed hash against a claimed hash. Returns
 * true on byte-for-byte match. Used as the load-bearing primitive
 * for parent-chain walking.
 * @param {object} header
 * @param {string} claimedHashHex
 * @returns {boolean}
 */
function verifyClaimedHash(header, claimedHashHex) {
    if (!claimedHashHex || !/^[0-9a-fA-F]{64}$/.test(claimedHashHex)) return false;
    try {
        const computed = computeBlockHash(header);
        return computed.toLowerCase() === claimedHashHex.toLowerCase();
    } catch {
        return false;
    }
}
//# sourceMappingURL=kaspa-block-hash.js.map
