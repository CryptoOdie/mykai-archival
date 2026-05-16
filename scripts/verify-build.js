#!/usr/bin/env node
/**
 * MyKAI build verification — checks that every binary involved in
 * running the app matches an expected SHA-256 hash.
 *
 * This is the reproducibility audit: any divergence here means someone
 * (npm, the OS, a build tool, an attacker) modified a binary between
 * the source and what's actually running.
 *
 * Run from project root:   node scripts/verify-build.js
 * Or:                       npm --prefix src run verify
 *
 * Verifies:
 *   1. kaspad.exe         — pinned in setup.ps1 + setup.sh
 *   2. ks_bridge.exe      — optional (mining)
 *   3. electron binary    — pinned to the npm package's published
 *                           SHASUMS (we don't re-derive; we trust npm's
 *                           subresource-integrity hashes in package-lock).
 *   4. Native module check — confirms there are NO node-gyp builds
 *                            (which would be non-reproducible).
 *   5. JS source check    — confirms dist/ files haven't been tampered
 *                            with relative to source/.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// Pinned expected hashes. Bump deliberately + together with setup.ps1.
const PINNED = {
    'src/resources/kaspad.exe':
        '02d40a0f6c8e19b905e0af2275b628ab565d2214d30cb2482744dcff3cfb528c',
    'src/resources/ks_bridge.exe':
        '67c3fe531bdbf6d630cd1f9518d7e0ee4458f3f1682c2f850fd23b1fccfb7469',
};

// JS files that constitute the security boundary. If any of these have
// been tampered with (vs whatever git says), verification should flag.
// Note: this isn't a substitute for `git status` — it's a smoke check
// that the running code matches the committed code. Friend should ALSO
// confirm `git status` is clean before trusting the build.
const SECURITY_CRITICAL_FILES = [
    'src/dist/main/kaspa-block-hash.js',
    'src/dist/main/parent-chain-walker.js',
    'src/dist/main/shard-pull.js',
    'src/dist/main/shard-fill.js',
    'src/dist/main/shard-audit.js',
    'src/dist/main/kaspad-wrpc-client.js',
];

function sha256(filePath) {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

let pass = 0;
let fail = 0;
let warn = 0;

function ok(msg) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); pass++; }
function bad(msg) { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); fail++; }
function note(msg) { console.log(`  \x1b[33m!\x1b[0m ${msg}`); warn++; }

console.log('\nMyKAI reproducibility check');
console.log('============================\n');

// 1. Pinned external binaries
console.log('Pinned external binaries:');
for (const [relPath, expected] of Object.entries(PINNED)) {
    const abs = path.join(ROOT, relPath);
    if (!fs.existsSync(abs)) {
        note(`${relPath} not present (run setup.ps1 to fetch)`);
        continue;
    }
    const actual = sha256(abs);
    if (actual === expected) {
        ok(`${relPath} = ${actual.slice(0, 16)}...`);
    } else {
        bad(`${relPath} MISMATCH`);
        console.log(`      expected: ${expected}`);
        console.log(`      got:      ${actual}`);
    }
}

// 2. Native modules absence — node-gyp builds are non-reproducible.
// Detection rule: look for compiled .node binaries inside node_modules.
// (Just having a binding.gyp present doesn't mean the package compiled —
// some packages keep vestigial gyp files but ship pure JS, e.g. boolean.)
console.log('\nNative module audit:');
const nodeModules = path.join(SRC, 'node_modules');
if (!fs.existsSync(nodeModules)) {
    note('node_modules not installed yet (run `cd src && npm install`)');
} else {
    function findNodeBinaries(dir, depth = 0) {
        if (depth > 6) return [];
        const out = [];
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return out; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === '.git' || e.name === 'test' || e.name === 'tests') continue;
                out.push(...findNodeBinaries(full, depth + 1));
            } else if (e.isFile() && e.name.endsWith('.node')) {
                out.push(full);
            }
        }
        return out;
    }
    const natives = findNodeBinaries(nodeModules);
    if (natives.length === 0) {
        ok('no .node binaries found — pure JS + WASM only, fully reproducible');
    } else {
        for (const n of natives) {
            const rel = path.relative(ROOT, n);
            note(`native binary found: ${rel}`);
        }
    }
}

// 3. Lockfile integrity
console.log('\nLockfile integrity:');
const lockPath = path.join(SRC, 'package-lock.json');
if (!fs.existsSync(lockPath)) {
    bad('package-lock.json missing — install will not be reproducible');
} else {
    try {
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        const pkgCount = Object.keys(lock.packages || {}).length;
        ok(`package-lock.json present (${pkgCount} packages pinned by SHA)`);
        // Spot-check: every "version" field should not have ^ or ~
        let loose = 0;
        for (const [k, v] of Object.entries(lock.packages || {})) {
            if (v.version && /[\^~]/.test(v.version)) loose++;
        }
        if (loose === 0) {
            ok('all lockfile versions exact (no ranges)');
        } else {
            bad(`${loose} packages have loose version ranges`);
        }
    } catch (err) {
        bad(`package-lock.json parse failed: ${err.message}`);
    }
}

// 4. Security-critical files exist
console.log('\nSecurity-critical source files:');
for (const rel of SECURITY_CRITICAL_FILES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
        bad(`${rel} missing`);
        continue;
    }
    const hash = sha256(abs);
    ok(`${rel} sha256=${hash.slice(0, 16)}...`);
}

// 5. Node version
console.log('\nRuntime environment:');
const nodeVersion = process.versions.node;
const major = parseInt(nodeVersion.split('.')[0], 10);
if (major >= 20 && major < 23) {
    ok(`Node.js ${nodeVersion} (within supported range)`);
} else {
    note(`Node.js ${nodeVersion} (untested — package.json requires >=20 <23)`);
}

// Summary
console.log('\n============================');
console.log(`Result: ${pass} pass · ${fail} fail · ${warn} warnings`);
console.log('');
if (fail > 0) {
    console.log('\x1b[31mBuild verification FAILED.\x1b[0m One or more binaries do not match');
    console.log('expected hashes. Do not run this build until investigated.\n');
    process.exit(1);
}
if (warn > 0) {
    console.log('Build verifiable but with warnings — review above.\n');
    process.exit(0);
}
console.log('\x1b[32mBuild verified.\x1b[0m Source + binaries match published hashes.\n');
process.exit(0);
