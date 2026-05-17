#!/usr/bin/env node
/**
 * Validate kaspa-tx-hash.js + kaspa-merkle.js against rusty-kaspa's
 * canonical in-tree test vectors.
 *
 * Source: rusty-kaspa/consensus/core/src/hashing/tx.rs::tests
 *         rusty-kaspa/consensus/core/src/merkle.rs::tests
 *
 * If this script passes, our JS implementations are bit-for-bit
 * equivalent to rusty-kaspa for the cases it covers. We treat that as
 * the same correctness floor rusty-kaspa CI uses.
 *
 * Run: node scripts/test-tx-hash.js
 */
'use strict';

const path = require('path');
const txHash = require(path.join(__dirname, '..', 'src', 'dist', 'main', 'kaspa-tx-hash.js'));
const merkle = require(path.join(__dirname, '..', 'src', 'dist', 'main', 'kaspa-merkle.js'));

// Subnet IDs (20-byte hex)
const SN_NATIVE   = '0000000000000000000000000000000000000000';
const SN_COINBASE = '0100000000000000000000000000000000000000';
const SN_REGISTRY = '0200000000000000000000000000000000000000';

// Hash::from_u64_word(0) → 32 zero bytes
const ZERO32 = '0000000000000000000000000000000000000000000000000000000000000000';

function bytesToHex(bytes) {
    return Buffer.from(bytes).toString('hex');
}

// Re-create rusty-kaspa's 8 test vectors as JS data
const inputsCommon = [{
    previousOutpoint: { transactionId: ZERO32, index: 2 },
    signatureScript: '0102',
    sequence: 7,
    sigOpCount: 5,
}];
const outputsCommon = [{
    value: 1564,
    scriptPublicKey: { version: 7, scriptPublicKey: '0102030405' },
}];
const inputsAlt = [{
    previousOutpoint: {
        transactionId: '59b3d6dc6cdc660c389c3fdb5704c48c598d279cdf1bab54182db586a4c95dd5',
        index: 2,
    },
    signatureScript: '0102',
    sequence: 7,
    sigOpCount: 5,
}];

const tests = [
    {
        name: 'Test #1: empty tx',
        tx: { version: 0, inputs: [], outputs: [], lockTime: 0, subnetworkId: SN_NATIVE, gas: 0, payload: '' },
        id:   '2c18d5e59ca8fc4c23d9560da3bf738a8f40935c11c162017fbf2c907b7e665c',
        hash: 'c9e29784564c269ce2faaffd3487cb4684383018ace11133de082dce4bb88b0b',
    },
    {
        name: 'Test #2: 1 input, no outputs',
        tx: { version: 1, inputs: inputsCommon, outputs: [], lockTime: 0, subnetworkId: SN_NATIVE, gas: 0, payload: '' },
        id:   'dafa415216d26130a899422203559c809d3efe72e20d48505fb2f08787bc4f49',
        hash: 'e4045023768d98839c976918f80c9419c6a93003724eda97f7c61a5b68de851b',
    },
    {
        name: 'Test #3: 1 in, 1 out',
        tx: { version: 1, inputs: inputsCommon, outputs: outputsCommon, lockTime: 0, subnetworkId: SN_NATIVE, gas: 0, payload: '' },
        id:   'd1cd9dc1f26955832ccd12c27afaef4b71443aa7e7487804baf340952ca927e5',
        hash: 'e5523c70f6b986cad9f6959e63f080e6ac5f93bc2a9e0e01a89ca9bf6908f51c',
    },
    {
        name: 'Test #4: v2 + lockTime + gas',
        tx: { version: 2, inputs: inputsCommon, outputs: outputsCommon, lockTime: 54, subnetworkId: SN_NATIVE, gas: 3, payload: '' },
        id:   '59b3d6dc6cdc660c389c3fdb5704c48c598d279cdf1bab54182db586a4c95dd5',
        hash: 'b70f2f14c2f161a29b77b9a78997887a8e727bb57effca38cd246cb270b19cd5',
    },
    {
        name: 'Test #5: same as #4 but different outpoint',
        tx: { version: 2, inputs: inputsAlt, outputs: outputsCommon, lockTime: 54, subnetworkId: SN_NATIVE, gas: 3, payload: '' },
        id:   '9d106623860567915b19cea33af486286a31b4bfc68627c6d4d377287afb40ad',
        hash: 'cd575e69fbf5f97fbfd4afb414feb56f8463b3948d6ac30f0ecdd9622672fab9',
    },
    {
        name: 'Test #6: coinbase subnet',
        tx: { version: 2, inputs: inputsAlt, outputs: outputsCommon, lockTime: 54, subnetworkId: SN_COINBASE, gas: 3, payload: '' },
        id:   '3fad809b11bd5a4af027aa4ac3fbde97e40624fd40965ba3ee1ee1b57521ad10',
        hash: 'b4eb5f0cab5060bf336af5dcfdeb2198cc088b693b35c87309bd3dda04f1cfb9',
    },
    {
        name: 'Test #7: registry subnet',
        tx: { version: 2, inputs: inputsAlt, outputs: outputsCommon, lockTime: 54, subnetworkId: SN_REGISTRY, gas: 3, payload: '' },
        id:   'c542a204ab9416df910b01540b0c51b85e6d4e1724e081e224ea199a9e54e1b3',
        hash: '31da267d5c34f0740c77b8c9ebde0845a01179ec68074578227b804bac306361',
    },
    {
        name: 'Test #8: registry + payload',
        tx: { version: 2, inputs: inputsAlt, outputs: outputsCommon, lockTime: 54, subnetworkId: SN_REGISTRY, gas: 3, payload: '010203' },
        id:   '1f18b18ab004ff1b44dd915554b486d64d7ebc02c054e867cc44e3d746e80b3b',
        hash: 'a2029ebd66d29d41aa7b0c40230c1bfa7fe8e026fb44b7815dda4e991b9a5fad',
    },
];

let pass = 0;
let fail = 0;
function check(label, expected, actual) {
    if (expected.toLowerCase() === actual.toLowerCase()) {
        console.log(`  \x1b[32m✓\x1b[0m ${label}`);
        pass++;
    } else {
        console.log(`  \x1b[31m✗\x1b[0m ${label}`);
        console.log(`      expected: ${expected}`);
        console.log(`      got:      ${actual}`);
        fail++;
    }
}

console.log('\nKaspa tx-hash + merkle canonical test vectors');
console.log('=============================================\n');

for (const t of tests) {
    console.log(t.name);
    check('  TxID',   t.id,   txHash.computeTxId(t.tx));
    // The tests run on pre-Crescendo (no mass set) so EXCLUDE_MASS does
    // not change the result vs FULL — but the canonical hash function
    // hash() in rusty-kaspa uses FULL. We mirror that with includeMass=true.
    check('  TxHash', t.hash, txHash.computeTxHash(t.tx, /*includeMass=*/ true));
}

// Merkle root determinism + ZERO_HASH for empty
console.log('\nMerkle root sanity:');
const emptyRoot = merkle.calcMerkleRoot([]);
check('empty → ZERO_HASH', ZERO32, bytesToHex(emptyRoot));

// Compute a merkle root over our 8 test-vector tx hashes and pin it.
// This is a deterministic regression vector — any change to the merkle
// algorithm or tx hasher will perturb it.
const allHashes = tests.map(t => t.hash);
const root8 = bytesToHex(merkle.calcMerkleRoot(allHashes));
console.log(`  merkle(8 vectors) = ${root8}`);
// Pin once verified:
const EXPECTED_ROOT_8 = '779a4bcf2fcdc266253b939ed0e62b7a1d9161fb28c98d1576cca7ce8918f9b5';
check('merkle(8) regression pin', EXPECTED_ROOT_8, root8);

console.log('\n=============================================');
console.log(`Result: ${pass} pass · ${fail} fail`);
if (fail > 0) {
    console.log('\n\x1b[31mTest vectors FAILED.\x1b[0m kaspa-tx-hash / kaspa-merkle drift from rusty-kaspa.\n');
    process.exit(1);
}
console.log('\n\x1b[32mAll canonical vectors pass.\x1b[0m\n');
process.exit(0);
