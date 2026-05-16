"use strict";
/**
 * Kaspa transaction hashing — re-implementation of rusty-kaspa's
 * canonical tx serialization in JS. Two distinct functions:
 *
 *   computeTxHash(tx, includePostCrescendoMass)
 *     - Keyed BLAKE2b-256 with "TransactionHash"
 *     - FULL encoding: includes signature script, sig_op_count, payload
 *     - Includes mass commitment field if mass > 0 (post-Crescendo)
 *     - THIS IS WHAT block.header.hashMerkleRoot COMMITS TO
 *
 *   computeTxId(tx)
 *     - Keyed BLAKE2b-256 with "TransactionID"
 *     - Coinbase tx: FULL encoding (id == hash for coinbase)
 *     - Non-coinbase: EXCLUDE_SIGNATURE_SCRIPT | EXCLUDE_MASS_COMMIT
 *       (sig script written as empty var_bytes, sig_op_count omitted,
 *        mass omitted)
 *     - Used for outpoint references; NOT for merkle root
 *
 * Canonical reference: rusty-kaspa/consensus/core/src/hashing/tx.rs
 *
 * SECURITY-CRITICAL: byte order and var_bytes framing must match
 * rusty-kaspa exactly. Drift produces wrong hashes silently. Verified
 * against rusty-kaspa's 8 in-tree test vectors (see kaspa-merkle.test.js).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeTxHash = computeTxHash;
exports.computeTxId = computeTxId;
exports.EncodingFlags = void 0;

const { blake2b } = require('@noble/hashes/blake2.js');

const KEY_TX_HASH = Buffer.from('TransactionHash', 'utf-8');
const KEY_TX_ID = Buffer.from('TransactionID', 'utf-8');

// Coinbase subnetwork ID = 20 bytes [01, 00, ..., 00]
const SUBNETWORK_ID_COINBASE_HEX = '0100000000000000000000000000000000000000';

const EncodingFlags = Object.freeze({
    FULL: 0,
    EXCLUDE_SIGNATURE_SCRIPT: 1 << 0,
    EXCLUDE_MASS_COMMIT: 1 << 1,
});
exports.EncodingFlags = EncodingFlags;

// ── byte writers ───────────────────────────────────────────────────

function _writeU16LE(parts, n) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(Number(n) & 0xffff);
    parts.push(b);
}
function _writeU32LE(parts, n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(Number(n) >>> 0);
    parts.push(b);
}
function _writeU64LE(parts, n) {
    const v = typeof n === 'bigint' ? n : BigInt(String(n ?? 0));
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v & 0xffffffffffffffffn);
    parts.push(b);
}
function _writeU8(parts, n) {
    parts.push(Buffer.from([Number(n) & 0xff]));
}
function _writeLen(parts, n) {
    // rusty-kaspa's write_len writes a u64 LE length prefix.
    _writeU64LE(parts, n);
}
function _writeVarBytes(parts, bytes) {
    _writeLen(parts, bytes.length);
    parts.push(bytes);
}
function _writeFixedHash(parts, hex, byteLen) {
    if (!hex || typeof hex !== 'string') {
        parts.push(Buffer.alloc(byteLen));
        return;
    }
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    const buf = Buffer.from(clean, 'hex');
    if (buf.length !== byteLen) {
        // Pad-or-truncate to expected length. A mismatch will produce a
        // non-canonical hash and the caller's verify step rejects.
        const out = Buffer.alloc(byteLen);
        buf.copy(out, 0, 0, Math.min(buf.length, byteLen));
        parts.push(out);
        return;
    }
    parts.push(buf);
}

function _hexToBuf(hex) {
    if (!hex) return Buffer.alloc(0);
    const clean = (typeof hex === 'string' && hex.startsWith('0x')) ? hex.slice(2) : hex;
    return Buffer.from(clean || '', 'hex');
}

// ── canonical serializers ──────────────────────────────────────────

function _writeOutpoint(parts, outpoint) {
    // transaction_id: 32 bytes
    _writeFixedHash(parts, outpoint?.transactionId, 32);
    // index: u32 LE
    _writeU32LE(parts, outpoint?.index ?? 0);
}

function _writeInput(parts, input, flags) {
    _writeOutpoint(parts, input?.previousOutpoint || {});
    if ((flags & EncodingFlags.EXCLUDE_SIGNATURE_SCRIPT) === 0) {
        _writeVarBytes(parts, _hexToBuf(input?.signatureScript));
        _writeU8(parts, input?.sigOpCount ?? 0);
    } else {
        // Empty var_bytes — u64 LE 0, no sig_op_count byte.
        _writeVarBytes(parts, Buffer.alloc(0));
    }
    _writeU64LE(parts, input?.sequence ?? 0);
}

function _writeOutput(parts, output) {
    _writeU64LE(parts, output?.value ?? 0);
    const spk = output?.scriptPublicKey || {};
    _writeU16LE(parts, spk.version ?? 0);
    // kaspad RPC names this `scriptPublicKey` (the bytes) inside the
    // outer `scriptPublicKey` object — also seen as `script` in some
    // shapes. Accept both.
    const scriptHex = spk.scriptPublicKey || spk.script || '';
    _writeVarBytes(parts, _hexToBuf(scriptHex));
}

function _writeTransaction(parts, tx, flags) {
    // version: u16 LE
    _writeU16LE(parts, tx.version ?? 0);

    // inputs: u64 LE len + each input
    const inputs = tx.inputs || [];
    _writeLen(parts, inputs.length);
    for (const input of inputs) _writeInput(parts, input, flags);

    // outputs: u64 LE len + each output
    const outputs = tx.outputs || [];
    _writeLen(parts, outputs.length);
    for (const output of outputs) _writeOutput(parts, output);

    // lockTime: u64 LE
    _writeU64LE(parts, tx.lockTime ?? 0);
    // subnetworkId: 20 raw bytes
    _writeFixedHash(parts, tx.subnetworkId, 20);
    // gas: u64 LE
    _writeU64LE(parts, tx.gas ?? 0);
    // payload: var_bytes
    _writeVarBytes(parts, _hexToBuf(tx.payload));

    // Mass commitment: included only when EXCLUDE_MASS_COMMIT is clear
    // AND mass > 0. Per KIP-0009, coinbase mass must be 0 in consensus
    // so the field has no effect for coinbase even with FULL encoding.
    if ((flags & EncodingFlags.EXCLUDE_MASS_COMMIT) === 0) {
        const mass = tx.mass;
        const massBig = mass == null ? 0n : (typeof mass === 'bigint' ? mass : BigInt(String(mass)));
        if (massBig > 0n) {
            _writeU64LE(parts, massBig);
        }
    }
}

function _isCoinbase(tx) {
    const sn = (tx?.subnetworkId || '').toLowerCase();
    return sn === SUBNETWORK_ID_COINBASE_HEX;
}

// ── public API ─────────────────────────────────────────────────────

/**
 * Compute the canonical Kaspa transaction hash (used in hashMerkleRoot).
 * @param {object} tx                      kaspad wRPC tx shape
 * @param {boolean} includeMassCommitment  true for post-Crescendo
 * @returns {string} 64-char lowercase hex
 */
function computeTxHash(tx, includeMassCommitment = true) {
    if (!tx) throw new Error('computeTxHash: tx is required');
    const flags = includeMassCommitment ? EncodingFlags.FULL : EncodingFlags.EXCLUDE_MASS_COMMIT;
    const parts = [];
    _writeTransaction(parts, tx, flags);
    const out = blake2b(Buffer.concat(parts), { dkLen: 32, key: KEY_TX_HASH });
    return Buffer.from(out).toString('hex');
}

/**
 * Compute the canonical Kaspa transaction ID. Note: coinbase txs use
 * FULL encoding (so id == hash for coinbase up to the hasher key);
 * non-coinbase txs exclude signature script and mass.
 * @param {object} tx  kaspad wRPC tx shape
 * @returns {string}   64-char lowercase hex
 */
function computeTxId(tx) {
    if (!tx) throw new Error('computeTxId: tx is required');
    const flags = _isCoinbase(tx)
        ? EncodingFlags.FULL
        : (EncodingFlags.EXCLUDE_SIGNATURE_SCRIPT | EncodingFlags.EXCLUDE_MASS_COMMIT);
    const parts = [];
    _writeTransaction(parts, tx, flags);
    const out = blake2b(Buffer.concat(parts), { dkLen: 32, key: KEY_TX_ID });
    return Buffer.from(out).toString('hex');
}
