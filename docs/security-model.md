# MyKAI Security Model

**Status:** Authoritative description of the trust chain, threat model, and mitigations as of v0.5.3.
**Audience:** Anyone integrating MyKAI as an archival data source, auditing it, or contributing to it.

---

## The one-line claim

**Every block MyKAI serves to a downstream consumer can be cryptographically verified as authentic Kaspa history by that consumer, using only their own local kaspad's PoW-validated header chain.**

If this claim ever becomes false, it's a security bug that needs an emergency fix. Everything below is the chain of reasoning and the defenses that make it true.

---

## The trust chain

MyKAI's archival authenticity inherits from kaspad. The chain is:

```
kaspad genesis (hardcoded in rusty-kaspa source)
        ↓ trusted because the binary is signed and reproducible
kaspad's IBD via Kaspa P2P network with PoW + GhostDAG consensus
        ↓ trusted because honest majority of network hashpower
kaspad's local header chain (BLAKE2b-256 keyed "BlockHash")
        ↓ available even after body pruning, ~85 GB for full history
MyKAI's hash-check verification against that chain
        ↓ math: if peer-served bytes hash to a value kaspad endorses,
          the bytes are real Kaspa history. No exception.
Indexer / explorer consuming MyKAI's served blocks
        ↓ re-verifies locally against their own kaspad. Never trusts
          MyKAI's response as source-of-truth.
```

**MyKAI establishes no new trust.** It inherits all of kaspad's guarantees and inherits all of kaspad's failure modes.

---

## What is mathematically guaranteed

These properties hold by cryptographic construction. Breaking them requires breaking BLAKE2b-256 second-preimage resistance (2²⁵⁶ work, infeasible on any technology that exists or is on any credible roadmap).

| Property | Why it holds |
|---|---|
| Bytes that hash to canonical block X **are** block X | Hash function is collision-resistant |
| A peer cannot forge a new "block X" with different content | Same — second-preimage resistance |
| A peer cannot modify transactions in a real block | Header commits to `hash_merkle_root` over txs |
| A peer cannot modify a block's parents | Header commits to `parents_by_level` |
| A peer cannot modify timestamp, difficulty, nonce, or any other consensus field | All in the header pre-image |

**Empirical record:** zero documented incidents in 14 years of blockchain history where this construction was defeated at the cryptographic layer. Every failure was at a different layer (eclipse, consensus rules, indexer trust model, client bug).

---

## Threat model — what an adversary CAN try

| # | Attack | Caught by | Status in v0.5.3 |
|---|---|---|---|
| 1 | Serve garbage bytes | Hash check against kaspad header chain | ✓ Live |
| 2 | Serve a fake block | Hash check (mathematically impossible to construct) | ✓ Live |
| 3 | Modify transactions in a real block | Header merkle root commitment | ⚠ Deferred — see *Known Limitations* §1 |
| 4 | Modify parents / timestamp / difficulty | Header is the hash pre-image | ✓ Live |
| 5 | Lie about `verboseData` (derived fields) | Stripped on ingest before storage | ✓ Live |
| 6 | Lie about advertised swarm coverage | Three-strike eviction in fill loop | ✓ Live (smart-ban) |
| 7 | Serve real blocks but omit some from range | Contiguity check on range responses | ⚠ Deferred — see §2 |
| 8 | Serve real blocks in wrong DAA-score order | Monotonicity check on ingest | ⚠ Deferred — see §3 |
| 9 | Slow-loris / connection exhaustion | Rate limits + smart-ban scoring | ✓ Live |
| 10 | Eclipse during kaspad's *first* IBD sync | Pin pruning-point hash at install | ⚠ Deferred — see §4 |
| 11 | Cross-network confusion (mainnet blocks into TN12 store) | `network_id` binding on first launch | ✓ Live |
| 12 | Resource amplification (small request → huge response) | Hard caps on `/shard/blocks` and `/shard/block-range` | ✓ Live (≤500 / ≤5000 blocks per response) |
| 13 | Coordinated mass DDoS | Per-IP rate limits + concurrent connection caps + smart-ban | ✓ Live |
| 14 | Compromised kaspad binary | Signed release verification | ⚠ User-side (document expected SHA-256) |

---

## What's live in v0.5.3

### Defense 1: Hash verification against local kaspad
Every block pulled from an untrusted source (peer or seed) is passed through `shardPull.verifyBlockHashAgainstKaspad`, which calls `kaspad.getBlock(hash, headers_only=true)`. If kaspad doesn't recognize the hash, the block is silently rejected. Implementation: `src/dist/main/shard-pull.js`.

### Defense 2: verboseData stripping
Both the live `blockAdded` capture path (in `main.js`) and the fill loop's ingest path (`shard-fill.js::_ingestBlocks`) strip `verboseData` from blocks before storage. Only `header` and `transactions` are persisted — both are committed to the header hash, so they're tamper-evident. Derived metadata (which kaspad regenerates from its own GhostDAG state) is the responsibility of the consumer.

### Defense 3: Network binding
On first shard storage initialization, the network name (mainnet / TN12 / devnet / simnet) is recorded in the meta table. Every subsequent launch verifies the configured network matches the stored binding. Mismatch is fatal — shard storage shuts down with a clear error. Implementation: `shard-storage.js::bindNetwork`.

### Defense 4: Smart-ban peer scoring
Peers and seed endpoints that return blocks failing hash verification, or that error repeatedly, accumulate strikes. Three strikes within an hour → 30-minute ban. Banned endpoints are skipped on every subsequent pull attempt until the ban expires. Implementation: `shard-fill.js::_recordStrike` + `_isBanned`.

### Defense 5: Rate limiting + resource caps
`/shard/blocks` is capped at 500 blocks per response. `/shard/block-range` is capped at 5000 blocks per response. The agent-bridge applies per-connection in-flight limits (2 heavyweight requests per socket, 4 globally) and returns `503 Retry-After: 1` on exceed. zstd / gzip compression is server-negotiated for ~4× bandwidth reduction. Implementation: `agent-bridge.js`.

### Defense 6: Hash-source provenance
Blocks pulled from local kaspad skip hash verification (already validated by kaspad's consensus). Blocks pulled from peers or seeds always go through the round-trip verification. The two paths are explicitly distinguished by the `verify` parameter in `_ingestBlocks`.

---

## Known limitations (deferred to later releases)

### §1 — Body merkle root verification
**Status:** Not implemented.
**Gap:** A peer could in theory serve a block whose header hash matches kaspad's known canonical hash, but whose transaction body has been altered via CVE-2012-2459-class merkle tree malleability (duplicated-pair patterns in the tree). The header check accepts; the body is wrong.
**Severity:** Medium. Detected immediately by any consumer that re-validates the body, which is standard practice for indexers. MyKAI's own claim ("we serve hash-verified blocks") remains true at the header level.
**Fix:** Implement Kaspa's BLAKE2b-256-keyed transaction hashing + merkle tree construction in JS (~150 LOC), then recompute the root from served body bytes and compare to header's `hash_merkle_root`. Reject duplicated-pair patterns explicitly. Estimated effort: 1 day.
**Workaround for consumers:** Re-validate the merkle root yourself before trusting the body bytes. The header's `hash_merkle_root` is the authoritative commitment.

### §2 — Range contiguity verification
**Status:** Not implemented.
**Gap:** A malicious peer can return only some of the blocks in a requested DAA range, censoring specific blocks while passing per-block hash verification. The consumer sees a "complete" response that's actually missing entries.
**Fix:** On range responses, verify the parent-hash chain forms a contiguous path through all returned blocks. Missing parents = censorship signal = strike. Estimated effort: ~30 LOC.
**Workaround for consumers:** Verify the range is dense (no DAA gaps beyond expected DAG branching) before trusting it as complete history.

### §3 — DAA-score ordering check
**Status:** Not implemented.
**Gap:** Wrong-order responses don't corrupt data but waste consumer cycles and may exploit assumption bugs.
**Fix:** Sort by `daa_score` on ingest; warn (not reject) on non-monotonic responses. ~10 LOC.

### §4 — Pruning-point pinning on install
**Status:** Not implemented.
**Gap:** A user installing MyKAI fresh while their kaspad is eclipsed (extremely rare but possible) could end up with a header chain rooted in a fake history. All subsequent MyKAI verification would inherit that lie.
**Severity:** Low. Eclipsing a Bitcoin/Kaspa node during IBD requires either 32+ distinct /24 networks (Heilman 2015) or controlling the user's network at the ISP level.
**Fix:** Pin a known-good pruning-point hash from a recent epoch in the binary; refuse to proceed if kaspad's pruning point doesn't chain back to it. This is the "assumevalid" pattern from Bitcoin Core. Estimated effort: requires foundation publication of the canonical pinned hash + ~50 LOC.

### §5 — Consensus-version tag on archived blocks
**Status:** Not implemented.
**Gap:** When the Kaspa covenant fork (KIP-17 + KIP-20) activates (~June 2026), blocks at and after the activation height use slightly different consensus rules. Blocks before don't. A peer running pre-fork software could serve technically-valid-by-old-rules blocks that are invalid under post-fork rules.
**Severity:** Low until the fork lands. After the fork, medium — but kaspad's own header chain rejects bad-version blocks anyway.
**Fix:** Tag every archived block with the consensus version it was validated under. Quarantine peers running pre-fork software in post-fork window. Estimated effort: schema migration + ~30 LOC.

### §6 — Hasher re-implementation regression suite
**Status:** Not implemented.
**Gap:** If MyKAI ever re-implements the BlockHash function in JS (e.g., to verify hashes without a kaspad round trip), drift from rusty-kaspa's canonical implementation would produce silently-wrong results.
**Fix:** Pin ~100 known mainnet + TN12 block hashes with their canonical bytes; CI must re-hash and match exactly on every build. Estimated effort: ~half day.
**Workaround:** v0.5.3 doesn't re-implement the hasher in JS; we only ask kaspad whether it recognizes a hash. The risk only materializes if we add local re-hashing.

---

## Failure modes that remain even with all defenses

1. **Compromised local kaspad binary.** If a user runs a maliciously patched kaspad, its header chain is whatever the attacker chose. Defense: signed releases, reproducible builds, document expected SHA-256 in MyKAI's install instructions.

2. **Compromised local kaspad data directory.** Same effect as above. Defense: disk integrity monitoring is out of MyKAI's scope; user-side concern.

3. **Disk / RAM bit-flips on consumer hardware.** Real but rare; usually surfaces as parent-link mismatches and kaspad refuses to start, rather than silent corruption. ECC RAM mitigates; consumer laptops don't have it.

4. **Sufficiently advanced cryptanalysis of BLAKE2b-256.** Currently impossible. If it happens, every blockchain in existence has a worse problem than MyKAI.

5. **A novel class of attack we haven't anticipated.** This document is current as of agent research May 2026 across three independent deep-research investigations. New attack research is welcome and should be addressed promptly via security advisories.

---

## Contract for downstream consumers

If you're integrating MyKAI as an archival data source (indexer, explorer, analytics tool, research project), you should:

1. **Re-verify every block's header hash** against your own kaspad's header chain. Don't trust MyKAI's response blindly. This is the load-bearing check.
2. **Regenerate `verboseData` locally** from canonical bytes if you need it. Don't expect MyKAI to send it.
3. **Verify range completeness** via parent-hash chain linkage when requesting a DAA range. Detect gaps.
4. **Verify body merkle root** matches `header.hash_merkle_root`. Reject duplicated-pair patterns (CVE-2012-2459 defense).
5. **Treat MyKAI as a CACHE, not a source of truth.** The source of truth is the Kaspa P2P network and your own kaspad. MyKAI just makes historical data fast to retrieve.

If you follow this contract, the worst MyKAI can do to you is fail to serve. It cannot poison your data.

---

## Verification and audit recommendations

For high-stakes use cases (a public block explorer, an exchange's indexer, academic research):

1. Run two independent kaspad nodes; cross-verify every block's hash on both.
2. Spot-check ~0.1% of received blocks by re-pulling the same range from a different MyKAI peer and comparing byte-for-byte.
3. Verify `network_id` on each MyKAI peer matches your expected network.
4. Maintain an out-of-band channel to verify the MyKAI binary checksum on each peer in your pool.
5. Periodically re-verify pruning-point continuity from genesis using a `--archival` kaspad if available.

These are belt-and-suspenders measures. The math doesn't require them. They catch failures in the operational stack (compromised kaspad binaries, disk corruption, software bugs) that the cryptographic core can't see.

---

## The principle

**MyKAI is a cache, not a chain.** The chain is Kaspa; the chain's authority is its proof-of-work consensus; MyKAI just makes already-validated history retrievable. Every defense in this document is about ensuring MyKAI does its caching job faithfully and detectably, so consumers can verify and trust the result the same way they'd verify and trust any single kaspad's response.

If we ever ship a feature that lets MyKAI assert something the cryptography can't independently confirm, we've broken the model. Don't.
