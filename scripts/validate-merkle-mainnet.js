#!/usr/bin/env node
/**
 * Live-mainnet body-merkle validation.
 *
 * Pulls N recent blocks from a kaspad wRPC endpoint (with transactions),
 * computes hashMerkleRoot via our kaspa-merkle.js, and compares against
 * the value in each block's header. If every block matches, our JS
 * implementation is bit-for-bit equivalent to what kaspad accepts on
 * the live chain — same gate we used for header hashing.
 *
 * Usage:
 *   node scripts/validate-merkle-mainnet.js [wss://host:port] [N]
 *
 * Defaults: ws://127.0.0.1:17110 (local mainnet kaspad), N = 5
 */
'use strict';

const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'src', 'node_modules', 'ws'));
const merkle = require(path.join(__dirname, '..', 'src', 'dist', 'main', 'kaspa-merkle.js'));

// Local kaspad JSON wRPC port is 18110 (17110 is borsh — binary, different
// encoding, won't speak JSON). MyKAI's rpc-monitor uses 18110.
const url = process.argv[2] || 'ws://127.0.0.1:18110';
const N = parseInt(process.argv[3] || '5', 10);

// ── precision-safe JSON parse ──────────────────────────────────────
// Kaspa wRPC returns u64 fields as raw JSON numbers. Numbers above 2^53
// lose precision in JSON.parse. We pre-process problem fields into
// strings so they survive parsing intact. Same trick rpc-monitor.js
// uses for `nonce`, expanded to every field we touch in merkle work.
const BIG_NUM_FIELDS = ['nonce', 'sequence', 'lockTime', 'mass', 'value', 'gas', 'daaScore', 'blueScore', 'timestamp'];
function safeJsonParse(raw) {
    let safe = raw;
    for (const f of BIG_NUM_FIELDS) {
        const re = new RegExp(`"${f}":\\s*(\\d{16,})`, 'g');
        safe = safe.replace(re, `"${f}":"$1"`);
    }
    return JSON.parse(safe);
}

// ── minimal wRPC client ────────────────────────────────────────────
function rpcCall(ws, id, method, params) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 15000);
        ws._mykaiPending = ws._mykaiPending || new Map();
        ws._mykaiPending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
}

async function connect(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { handshakeTimeout: 8000, perMessageDeflate: false });
        ws.on('message', (data) => {
            let msg;
            try { msg = safeJsonParse(data.toString()); } catch { return; }
            const p = ws._mykaiPending?.get(msg.id);
            if (!p) return;
            clearTimeout(p.timer);
            ws._mykaiPending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message || 'rpc error'));
            else p.resolve(msg.params || msg.result || msg);
        });
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

// ── main ───────────────────────────────────────────────────────────
async function main() {
    console.log(`\nLive-mainnet body-merkle validation`);
    console.log(`====================================`);
    console.log(`Endpoint: ${url}`);
    console.log(`Blocks:   ${N}\n`);

    let ws;
    try {
        ws = await connect(url);
    } catch (err) {
        console.error(`✗ Could not connect to ${url}: ${err.message}`);
        console.error(`  Hint: start MyKAI (which runs kaspad), or pass a remote wRPC URL as argv[1].\n`);
        process.exit(2);
    }

    let id = 1;
    const dagInfo = await rpcCall(ws, id++, 'getBlockDagInfo', {});
    const tipHashes = dagInfo.tipHashes || dagInfo.virtualParentHashes || [];
    if (!tipHashes.length) {
        console.error('✗ No tip hashes from getBlockDagInfo'); ws.close(); process.exit(2);
    }
    console.log(`Network: ${dagInfo.networkName || '(unknown)'} · tip ${tipHashes[0].slice(0, 16)}…`);
    console.log(`Pulling ${N} blocks walking parents from tip...\n`);

    // Walk parents from tip to collect N blocks with diverse tx counts.
    const blocks = [];
    let cursor = tipHashes[0];
    const seen = new Set();
    while (blocks.length < N && cursor && !seen.has(cursor)) {
        seen.add(cursor);
        let block;
        try {
            block = await rpcCall(ws, id++, 'getBlock', { hash: cursor, includeTransactions: true });
        } catch (err) {
            console.error(`  ! getBlock ${cursor.slice(0, 16)}… failed: ${err.message}`);
            break;
        }
        // Response shape: { block: { header, transactions, ... } }
        const b = block.block || block;
        if (!b?.header) break;
        blocks.push(b);
        const parents = b.header.parents || b.header.parentsByLevel || [];
        const firstLevel = parents[0];
        const firstParent = Array.isArray(firstLevel)
            ? firstLevel[0]
            : (firstLevel?.parentHashes?.[0]);
        cursor = firstParent || null;
    }

    if (blocks.length === 0) {
        console.error('✗ No blocks retrieved.'); ws.close(); process.exit(2);
    }

    let pass = 0, fail = 0;
    for (const b of blocks) {
        const claimed = (b.header.hashMerkleRoot || '').toLowerCase();
        const txCount = (b.transactions || []).length;
        const blockHash = (b.verboseData?.hash || b.header.hash || '?').toLowerCase();

        // Try post-Crescendo first, fall back to pre-Crescendo.
        const post = merkle.calcHashMerkleRoot(b.transactions || [], true).toLowerCase();
        const matchedPost = post === claimed;
        let matchedPre = false;
        if (!matchedPost) {
            const pre = merkle.calcHashMerkleRoot(b.transactions || [], false).toLowerCase();
            matchedPre = pre === claimed;
        }
        const ok = matchedPost || matchedPre;
        const era = matchedPost ? 'post-Crescendo' : matchedPre ? 'pre-Crescendo' : '—';

        if (ok) {
            console.log(`  \x1b[32m✓\x1b[0m block ${blockHash.slice(0, 16)}…  txs=${txCount}  ${era}`);
            pass++;
        } else {
            console.log(`  \x1b[31m✗\x1b[0m block ${blockHash.slice(0, 16)}…  txs=${txCount}`);
            console.log(`      claimed: ${claimed}`);
            console.log(`      post:    ${post}`);
            fail++;
        }
    }

    ws.close();
    console.log(`\n====================================`);
    console.log(`Result: ${pass}/${blocks.length} pass · ${fail} fail\n`);
    if (fail > 0) {
        console.log('\x1b[31mLive validation FAILED.\x1b[0m kaspa-merkle.js diverges from kaspad on real blocks.\n');
        process.exit(1);
    }
    console.log('\x1b[32mAll live blocks pass.\x1b[0m Body merkle implementation matches mainnet kaspad.\n');
    process.exit(0);
}

main().catch((err) => {
    console.error(`\n✗ Unhandled error: ${err?.stack || err}\n`);
    process.exit(2);
});
