# Coverage Distribution — The Smart System

**Status:** Final design after 5-agent research synthesis + efficiency double-check
**Supersedes:** Earlier rough plan
**Ship target:** v0.5.3
**Cost:** 4 working days

---

## What this fixes

Today, every MyKAI node only captures from the local kaspad's live `blockAdded`. With a 40 GB budget, each node holds ~24 hours of chain tip and rolls the oldest off. Five thousand nodes all doing this = the swarm collectively holds **24 hours, copied 5000 times**. The "distributed archive" is fiction.

This ship makes it real: nodes get **automatically assigned** historical DAA-bucket ranges to backfill. The pool becomes a living archive where the user's 40 GB actually goes toward unique historical data, and the swarm collectively covers months or years of chain history.

---

## The whole algorithm in 6 pieces

```
1. TIP is implicit. Every running node captures the last ~1 hour
   from local kaspad's blockAdded for free. Reserved 1 GB of budget.

2. ASSIGNMENT is computed locally via weighted rendezvous hashing.
   Given the public member list, every node arrives at the same answer
   for "which buckets should I hold?" No coordinator decides.

3. MEMBERSHIP is published to a foundation Cloudflare Worker every
   5 minutes:  { nodeId, budgetGB, oldestDAA, newestDAA, kaspadTip }
   The Worker is just a phone book. If down, fall back to a hardcoded
   bootstrap-peer list. Never load-bearing.

4. FILL LOOP runs every 60 seconds:
     a. Fetch member list (cached)
     b. Compute my HRW assignments
     c. Drop buckets not on the list (with hysteresis: only if also
        over-covered elsewhere)
     d. Pull missing buckets from peers (preferred) or seed kaspad

5. VERIFY every pulled block's hash against the header chain.
   Free — same check the indexer would do. Mismatch → try another peer.

6. STRIKES from the Worker exclude liars from future routing.
   1% random spot-check per day; three 404s in 24h = 7-day exclusion.
```

That's it. **No SWIM gossip. No Bloom filters. No class hierarchy.** HRW does all the work because assignment is deterministic from membership.

---

## The locked numbers

| Parameter | Value | Why |
|---|---|---|
| Replication factor (RF) | **4** | Survives losing 3 of 4 holders. Agent 3 math killed erasure coding at 60% volunteer uptime. |
| Bucket size | **100,000 DAA ≈ 3 GB** | ~17 min of chain at 10 BPS. Coarse enough for fast HRW, fine enough for budget granularity. |
| Hot tail reserve | **1 GB / ~1 hour** | Live tip captured implicitly. Not assignable. |
| Heartbeat interval | **5 min** | Volunteer-grade. Detect-fast-respond-slow principle. |
| Fill cycle interval | **60 sec** | Tighter than heartbeat so churn detection isn't a bottleneck. |
| Drop hysteresis (SLACK) | **2 above RF** | Don't shed until coverage ≥ RF+2 elsewhere. Prevents thrashing. |
| Spot-check rate | **1% claims/day** | Low overhead. Reader 404s also count. |
| Strike timeout | **7 days exclusion** | Forgiving but firm. |

### The HRW math

For each (bucket, node) pair:
```
score = -node.budgetGB / ln(blake3(bucketId || nodeId))
```

A node holds buckets where its score ranks in the **top 4** across all currently-active members. As nodes join/leave, only buckets where that node's rank crossed in/out of the top-4 shift — perfectly localized blast radius.

Weighted by budget means a 1000 GB node naturally gets ~100× more buckets than a 10 GB node, with no special-casing.

---

## What's deliberately NOT in this ship

- **SWIM gossip / `memberlist` library.** Built for 10K-node datacenter clusters with second-precision failure detection. We're at 1-100 residential laptops where decisions happen over hours. Heartbeats to a Worker are simpler and sufficient.
- **Bloom-filter coverage gossip.** Unnecessary because HRW is deterministic. Members publish their budget; everyone computes everyone else's assignments locally.
- **Three storage classes (Tip / Recent / Historical) with different RFs.** Cut for over-engineering. RF=4 everywhere; tip emerges as natural over-coverage near the chain frontier.
- **Erasure coding.** Math doesn't work at 60% volunteer uptime — needed low-rate codes erase the storage advantage, repair traffic is 10×. Revisit at v0.7+ if swarm > 200 stable nodes.
- **Proof-of-storage.** Filecoin needs it (miners are paid to lie); MyKAI doesn't. Lazy verification + reader 404s + spot-check + strikes is enough.
- **Continuous rebalancing.** Lazy event-driven shifting via HRW recomputation is sufficient.
- **Real-time failure detection.** A 5-minute heartbeat miss isn't an emergency. Repair triggers on sustained absence, not blips.

All of these can be layered on later when the swarm earns the complexity. None are forward-incompatible.

---

## The four day build order

| Day | Work | Files |
|---|---|---|
| **1** | HRW assignment math + member registry | `src/dist/main/swarm-assignment.js` (new), `main.js` extensions |
| **2** | Fill loop: compute → pull → drop with hysteresis | `src/dist/main/shard-fill.js` (new) |
| **3** | Foundation Cloudflare Worker (~150 LOC TypeScript) | Out-of-band repo + deploy |
| **4** | Bar shows real participants + 5-node smoke test | `src/src/renderer/app.js` |

If Day 3 Worker isn't ready: hardcode 3-5 bootstrap-peer URLs in the binary, system works against direct peer queries. Worker is a convenience, not a dependency.

---

## Failure modes

| Failure | Impact | Mitigation |
|---|---|---|
| Foundation Worker down | Stale assignments | Last-known cache; fall back to hardcoded peer list after 1h |
| Worker compromised | Could lie about membership | Workers signs responses with a static key; nodes verify offline |
| 50% of swarm vanishes simultaneously | Many buckets drop below RF | Heartbeat surge detector pauses drops; only fills until storm clears |
| Peer claims to have bucket but 404s | Indexer/other node rotates | Worker logs strike; 3 strikes in 24h = 7d exclusion |
| Cold start, no peers exist | Bootstrap peer list + foundation seed kaspad source | Always-available fallback |
| Adversary spawns Sybil nodes | They get assignment but never serve | Lazy verification + strikes; they're auto-evicted within a day |
| User reduces shardSizeGB | Buckets they held drop off | Other nodes pick them up on next fill cycle |
| User leaves entirely | Same as above | Other nodes pick up on next cycle (≤ 1 min latency) |

---

## What the user sees

Today (v0.5.1.5): coverage bar shows their one stripe vs chain tip. "local only — foundation aggregator unreachable."

After v0.5.3:
- Their own stripe extends backward as the fill loop pulls historical buckets
- Other participants' stripes appear with deterministic colors
- The bar visibly fills: replication-1 first, then 2, then 3 (emergent from HRW)
- Users can see in real-time that their committed GB is actually being used for unique historical data
- Hovering shows "Node 4abc · 12 days of history" without revealing IP or accountKey

---

## The principle

**Don't ship machinery that's not load-bearing today.** SWIM + Bloom filters + multi-class redundancy is the right answer at 10K nodes with paid SLAs. At 1-100 residential laptops on a v0.5 ship, it's bureaucracy. HRW + heartbeats + hash verification is the same correctness with a quarter of the surface area.

Ship the simple thing. Earn the complexity later.
