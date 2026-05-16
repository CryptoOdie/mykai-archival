# Trustless Verification — v0.5.4 + v0.5.5 Build Plan

**Goal:** Honor the security covenant. Every block in MyKAI's pool must be cryptographically verifiable against local kaspad's PoW-validated header chain. No source ever trusted. Math is the auditor.

**Two ships:**
- **v0.5.4** — Parent-chain walking → unlocks verifying full Kaspa history
- **v0.5.5** — Random challenge audits → keeps already-held data honest

**Total cost:** ~3-4 days of focused work, ~600 LOC end-to-end.

---

## v0.5.4 — Parent-chain walking

### What it does

Today's `verifyBlockHashAgainstKaspad` calls `kaspad.getBlock(hash, headers_only=true)`. Works for recent history; fails for deep history because kaspad doesn't retain most pre-pruning-point headers.

The walker fills the gap: given an unverifiable block, walk its parent hashes BACKWARD step by step, verifying each link by re-hashing the parent's header bytes. Stop when we reach a known canonical hash (in kaspad's chain or pruning proof skeleton). If the walk succeeds → cryptographic proof the block is canonical. If it fails (orphan branch, broken chain, no anchor) → reject.

### Cryptographic primitive

- **BLAKE2b-256** keyed with personalization `"BlockHash"`
- Library: `@noble/hashes/blake2b` (pure JS, no native deps)
- Output: 32 bytes
- Verification: re-serialize header → hash → compare to claimed hash

### Header serialization order (the precision step)

From `rusty-kaspa/consensus/core/src/hashing/header.rs::hash()`. The byte order is:

```
1.  version            → u16 LE
2.  parents_by_level   → u64 LE level count
                         for each level:
                           u64 LE parent count
                           32-byte parent hash × count
3.  hash_merkle_root   → 32 B
4.  accepted_id_merkle_root → 32 B  (note: KIP-15 changes semantic, NOT layout)
5.  utxo_commitment    → 32 B
6.  timestamp          → u64 LE (milliseconds since epoch)
7.  bits               → u32 LE
8.  nonce              → u64 LE
9.  daa_score          → u64 LE
10. blue_score         → u64 LE        ← BEFORE blue_work — #1 footgun
11. blue_work          → length-prefixed big-int bytes
12. pruning_point      → 32 B
```

### Files

| File | Purpose | Est LOC |
|---|---|---|
| `src/dist/main/kaspa-block-hash.js` | BLAKE2b "BlockHash" + header serializer | ~120 |
| `src/dist/main/parent-chain-walker.js` | Walk with cache + cycle detection + max-hop limit | ~150 |
| `src/dist/main/shard-pull.js` | Add walker as fallback in `verifyBlockHashAgainstKaspad` | +30 |
| `src/dist/main/shard-fill.js` | Pass block body context to verify | +20 |
| `test/test-vectors.json` | Pinned mainnet block hashes for regression | ~50 |
| **Total** | | **~370 LOC** |

### Walker algorithm

```
walkToKnownAnchor(block, kaspadOracle, fetchHeaderFn):
  visited = new Set()
  current = block
  hops = 0
  MAX_HOPS = 100,000  // sane upper bound

  while hops < MAX_HOPS:
    hash = computeBlockHash(current.header)

    if kaspadOracle.knows(hash):
      return { verified: true, hops, anchor: hash }

    if visited.has(hash): return { verified: false, reason: 'cycle' }
    visited.add(hash)

    // pick first parent; walk it
    parents = current.header.parents_by_level.flat()
    if parents.length === 0:
      return { verified: false, reason: 'no parents' }

    parentHash = parents[0]
    parentBlock = fetchHeaderFn(parentHash)
    if !parentBlock: return { verified: false, reason: 'missing parent' }

    // verify parent's header hashes to claimed parentHash
    if computeBlockHash(parentBlock.header) !== parentHash:
      return { verified: false, reason: 'hash mismatch at hop ' + hops }

    current = parentBlock
    hops++

  return { verified: false, reason: 'max hops exceeded' }
```

### Cache strategy

Once a chain segment is verified, every block on the segment is canonical. Cache `Map<hash, true>` of all verified hashes — they're inherited from a single successful walk. A second walk through the same segment short-circuits at the first cached hash.

Cache size: hash is 32 bytes, key is hex string ~64 bytes, value is boolean. 1 million cached hashes ≈ 100 MB RAM. Reasonable.

### Risks + mitigations

| Risk | Mitigation |
|---|---|
| Header byte-order drift vs rusty-kaspa | Pin 100 mainnet test vectors; CI fails on any drift |
| Adversarial cycle in parent chain | Cycle detection in `visited` set + max-hop limit |
| Parent block unavailable from source | Fail walk; mark bucket as needing different source |
| `blue_work` length-prefix encoding | Use rusty-kaspa source as ground truth; test against real blocks |
| KIP-15 SequencingCommitment semantic flip | Layout unchanged; semantic change doesn't affect hash. Document but no code change. |

### Test plan

1. **Unit:** 100 mainnet blocks pinned in `test-vectors.json`. Our `computeBlockHash` must match kaspad's reported hash for every one.
2. **Walker correctness:** known-canonical block + valid chain → walker succeeds.
3. **Walker adversarial:** fake chain with self-consistent hashes but no real anchor → walker rejects.
4. **Cycle test:** synthetic chain that loops → walker rejects with `reason: 'cycle'`.
5. **Cache:** verify same chain twice; second walk hits cache, returns in < 1 ms.
6. **Live test:** pull deep-history block from a real archival kaspad seed; walker verifies it.

### Definition of done

- All test vectors pass
- Walker accepts canonical chains, rejects forged chains
- Wired into `verifyBlockHashAgainstKaspad` as fallback
- The fill loop's `_ingestBlocks` no longer rejects deep-history blocks when walker succeeds
- Smoke-tested against ≥2 mainnet archival kaspad sources

---

## v0.5.5 — Random challenge audits

### What it does

After blocks are in the pool, periodically test that peers actually still hold what they advertise. Catches:
- Peers who claimed to hold a range but never did (Sybil-claim attack)
- Peers who held data and then dropped it but didn't update their advertised range
- Peers who got compromised and started serving wrong bytes

### Trigger

Background loop, runs every 30 min. Each tick:
1. Read swarm member list (filter to vetted, online)
2. Pick a random subset (e.g., 5 peers)
3. For each peer, pick a random bucket from their advertised coverage
4. Pick a random block hash from local kaspad within that bucket's DAA range
5. Request `/shard/block/:hash` from the peer
6. Verify returned bytes match canonical hash (via v0.5.4 walker if needed)
7. Pass → silent. Fail → strike via existing smart-ban system.

Total challenge rate: ~10/hour per node × ~24h = 240 challenges/day per node. Network-wide cost is negligible.

### Files

| File | Purpose | Est LOC |
|---|---|---|
| `src/dist/main/shard-audit.js` | Random challenge sampler | ~120 |
| `src/dist/main/shard-fill.js` | Expose strike API to audit | +20 |
| `src/dist/main/main.js` | Wire audit loop alongside fill loop | +30 |
| **Total** | | **~170 LOC** |

### Algorithm

```
every 30 minutes:
  members = swarm.getActiveMembers()
  sample = random.choose(members, 5)
  for peer in sample:
    if !peer.endpoint: continue  // loopback-only peer, can't probe
    bucketId = random.choose(peer.advertised_buckets)
    range = daaRangeForBucket(bucketId)
    // pick a hash kaspad knows in this range — that's the canonical answer
    knownBlock = localKaspad.getBlocksByDaaRange(range, limit=1)
    if !knownBlock: continue  // we can't verify, skip
    expectedHash = knownBlock.hash

    response = await fetch(peer.endpoint + '/shard/block/' + expectedHash)
    if !response.ok:
      strike(peer, 'audit-404')
      continue

    body = await response.json()
    if body.header.hash !== expectedHash:
      strike(peer, 'audit-wrong-hash')
      continue

    // verify body using v0.5.4 walker
    verified = await verifyBlock(body)
    if !verified:
      strike(peer, 'audit-verification-failed')
```

### Configurable params

- `auditSampleRate`: default 1% (10/hour per node)
- `auditTriggerInterval`: default 30 min
- `auditPeersPerTick`: default 5
- All overridable in `mykai-archival-config.json` for testing

### Risks + mitigations

| Risk | Mitigation |
|---|---|
| Audit storm from many MyKAI nodes hammering one peer | Per-peer rate limit + jitter |
| Peer slow but honest → false-positive ban | 3-strike threshold + 1-hour decay window (existing smart-ban) |
| Auditor itself compromised | Doesn't matter — audits flow from kaspad's canonical answer, not auditor opinion |

### Definition of done

- Audit loop runs in background
- Strikes integrate with existing ban system
- Failed audits logged to activity feed
- Net effect: bad peers auto-evicted within hours; honest peers unaffected

---

## Combined implementation order

**Day 1 — Header serializer + hash:**
- Implement `kaspa-block-hash.js`
- Pin 10 test vectors, get them passing
- Expand to 100 test vectors

**Day 2 — Parent-chain walker:**
- Implement `parent-chain-walker.js` with cache
- Wire into `shard-pull.js::verifyBlockHashAgainstKaspad`
- Test adversarial cases

**Day 3 — Integration + live smoke test:**
- Wire walker into fill loop
- Configure a real archival kaspad seed URL
- Watch the fill loop pull deep-history blocks and verify them
- Validate against known canonical hashes

**Day 4 — Random challenge audits (v0.5.5):**
- Implement `shard-audit.js`
- Integrate with smart-ban strike system
- Wire startup, monitor for false-positive bans
- Tune sample rate based on observed CPU cost

---

## What this unlocks

After v0.5.4 ships:
- Pool stores blocks from ALL of Kaspa history, not just the pruning window
- Every block is cryptographically verified — no trust in any source
- The "100 archival nodes built from 10,000 users" vision becomes real
- Indexers and explorers can pull any historical block from the swarm with the same trust as pulling from their own kaspad

After v0.5.5 ships:
- Pool self-cleans bad peers via random challenges
- Long-term holding is enforced via probabilistic spot-check
- The swarm becomes self-policing without a coordinator

These two ships together close the security covenant. Everything past this is performance, UX, and feature expansion.

---

## The principle

**Math is the auditor. Cryptography does the work. Nobody is trusted. Anyone can re-verify.**

Every line of code in v0.5.4 + v0.5.5 serves this principle. If a feature proposal weakens it, the proposal gets rejected. If a mitigation strengthens it, the mitigation ships.

This is what makes MyKAI a real permissionless archive instead of just another federated pinning service.
