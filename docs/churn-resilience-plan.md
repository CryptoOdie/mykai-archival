# Churn Resilience — How the Swarm Heals as People Come and Go

**Companion to:** `coverage-distribution-plan.md`, `virtual-archive-nodes-plan.md`
**Scope:** Make every churn scenario explicit and handled.
**Ship target:** Most of it lands in v0.5.3 Day 2 (the fill loop); the rest in v0.5.4

---

## The baseline assumption

This isn't a system where people stay. **People drop in and out constantly.** Some users will stay online 24/7 for years. Some will run MyKAI for 30 minutes during a Saturday afternoon. Most will fall in between, with residential connections that flap, laptops that sleep, ISPs that drop, and life that intervenes.

A design that assumes stable participation is a design that fails. The swarm must **continuously self-heal** as a baseline mode of operation — not as exception handling.

---

## What's already built in (from v0.5.3 Day 1)

Three load-bearing mechanisms already exist:

1. **Weighted Rendezvous Hashing (HRW)** as the assignment primitive. When a node disappears from the member list, HRW automatically re-ranks every bucket. Whoever was rank K+1 for a bucket becomes rank K — they're now responsible. **No coordinator decision required.** Every other node, computing locally, arrives at the same new assignments.

2. **5-minute heartbeat with last-good cache.** Nodes publish their state every 5 min; the Worker drops a node from the member list after 2 missed heartbeats (~15 min). The cache means a transient Worker outage doesn't blank the swarm view.

3. **Drop hysteresis (SLACK = 2 above RF).** A node only sheds a bucket when it's no longer assigned AND the bucket's coverage elsewhere is ≥ RF + 2. This prevents thrash when membership flickers.

These three together handle the *common* case of churn: one node drops, the swarm notices within ~15 min, other nodes reassign within ~60s of the next fill cycle, gaps close within minutes-to-hours.

**What's NOT yet handled** is everything below.

---

## The seven churn scenarios that need explicit policy

### Scenario 1 — Cascading drops (churn storms)

One ISP outage takes 200 nodes offline simultaneously. Every other node sees a wave of new assignments. If they all pull from the same remaining peers, the pullers get hammered.

**Policy:** *Heartbeat-surge detector + freeze-drops mode.*
- The Worker tracks the rolling rate of member removals over the last hour.
- If > 20% of the swarm drops within 1h, set a `churn_storm: true` flag in the response.
- Nodes seeing this flag **stop dropping buckets** (only fill).
- Pull jitter doubles (0-120s) to spread load.
- Storm clears when removal rate falls below 5%/hour for two consecutive hours.

### Scenario 2 — Flapping nodes (in and out repeatedly)

A user with a flaky residential connection joins, gets assigned 13 buckets, drops 4 minutes later, comes back, gets re-assigned. Every flap causes minor HRW reshuffling for every other node.

**Policy:** *Probationary period before counting in HRW.*
- New joiners are `vetted: false` for the first 15 min.
- Unvetted nodes are visible in the member list (UI can show them as "joining") but their HRW score is set to -∞ — they don't get bucket assignments.
- After 15 min of continuous heartbeats, the Worker flips them to `vetted: true`.
- A flap during the probation period restarts the 15-min clock.

This handles **flapping at the membership level** without protocol changes for the rest of the system.

### Scenario 3 — Cold-start joiner (massive backlog of pulls)

A fresh node opts into the pool with 40 GB budget. They wake up with 13 assigned buckets, all of which they need to pull. From whom?

**Policy:** *Rate-limited parallel pull with seed fallback.*
- **Max 4 concurrent pulls per node** (already in the v0.5.1 rate limiter for serving; mirror it for pulling).
- For each assigned bucket, pull from the OTHER top-K HRW holders (the ones that *aren't* me). Try them in HRW-score order.
- Per-pull timeout: 60s for a 3 GB bucket on residential (conservative).
- If 2 peers fail to deliver: fall back to a **seed kaspad source** (foundation-run or community).
- Background-priority: cap total pull bandwidth at 10% of measured upstream (or 5 Mbit/s, whichever is smaller).

Result: a 40 GB cold-start fills in ~1 hour at full bandwidth or ~10 hours throttled. Steady-state stays low.

### Scenario 4 — Multi-gap fill (many simultaneous assignments)

If 50 people drop simultaneously, every other node potentially gets several new assignments at once. Naive: serially fill them all.

**Policy:** *Priority-ordered queue with depth_deficit + age_rank.*
- Sort assignments by `priority = (target_RF - current_holders) × 1000 + age_rank`
- Process top 4 concurrently (the rate-limit cap)
- After each completes, the next-highest-priority bucket dequeues
- This means a node with 50 new assignments still respects the per-peer rate limit but works through them as fast as bandwidth allows
- Crucially: the priority means **depth-1 gaps are filled before depth-2 buckets are even started** — the swarm doesn't waste bandwidth on redundancy while there are bare holes elsewhere

### Scenario 5 — Slow or unresponsive peer

I try to pull bucket X from User A. They're online (heartbeat valid) but their connection is slow or their machine is busy. Pull takes 5 minutes when it should take 30 seconds.

**Policy:** *Per-peer latency tracking + temporary exclusion.*
- Track rolling p95 pull latency per peer.
- If 3 consecutive pulls from a peer exceed 60s for a 3 GB bucket, mark them **slow** for 30 min.
- Pulls preferentially route to non-slow peers in HRW rank order.
- Slow peers are still in the member list (still serve as a fallback) — they're just deprioritized.
- After 30 min, they're re-evaluated on the next pull attempt.

### Scenario 6 — Bucket partially held / claimed but not actually served

A node claims to hold bucket X but actually only has half the blocks in the [start_daa, end_daa) range (e.g., they joined mid-bucket and missed some). An indexer/peer asks for that bucket and gets a partial response.

**Policy:** *Binary bucket completeness + reader-driven strike system.*
- A node may **only claim** a bucket in its heartbeat if it has ALL blocks in the bucket's DAA range.
- Internally: a bucket is `complete: true` once the local block count for that range matches the expected count (kaspad confirms how many blocks are in a DAA range).
- If a reader requests a bucket and gets a 404 or partial, they report to the Worker.
- 3 strikes in 24h = 7-day exclusion from the assignment pool (the same strike system already in `coverage-distribution-plan.md`).

This is binary, simple, no fractional-bucket bookkeeping. A node either has the bucket or it doesn't.

### Scenario 7 — Disk pressure forces a drop

A user reduces their `shardSizeGB` from 100 to 40. Or their disk fills with non-MyKAI data. Or they bought a smaller drive. The fill loop now has to *drop* some buckets they're holding to fit within budget.

**Policy:** *Drop by lowest HRW rank first (least "mine").*
- Among my held buckets, sort by my HRW rank (rank K means I'm the K-th-most-canonical holder).
- Drop the highest-rank-numbered ones first (the ones where I'm rank 4 of 4, say — meaning rank 5 will pick it up cleanly).
- Re-check coverage after each drop: if dropping bucket B would push it below RF and no other node is well-positioned to take it, hold off and drop the next candidate instead.
- This is reverse-priority of the fill order — drop what you're least responsible for.

---

## The fill-loop pseudocode that handles all seven

```
every 60 seconds:
  if heartbeat-storm-flag from Worker:
    drops_allowed = false
    jitter_multiplier = 2
  else:
    drops_allowed = true
    jitter_multiplier = 1

  members = cached member list (vetted nodes only)
  my_assignments = computeAssignments(myId, myBudget, members, candidates)
  my_holdings  = local complete buckets

  # Filling
  pull_queue = (my_assignments - my_holdings) sorted by priority(bucket)
  for bucket in pull_queue:
    if in_flight_pulls >= 4: break
    delay = jitter(0, 60 * jitter_multiplier seconds)
    schedule_pull(bucket, delay):
      peers = other_topK_holders_of(bucket) (excluding slow peers)
      for peer in peers:
        result = pull_with_timeout(peer, bucket, 60s)
        if result.ok: break
      if not result.ok:
        result = pull_from_seed(bucket)
      if result.ok:
        verify_block_hashes(result.blocks)
        mark_bucket_complete(bucket)

  # Shedding (only if drops allowed)
  if drops_allowed:
    extra = (my_holdings - my_assignments) sorted by my_hrw_rank descending
    for bucket in extra:
      if coverage_elsewhere(bucket) >= RF + 2:
        drop(bucket)

  # Latency tracking
  for completed pull:
    update_peer_latency_stats(peer, duration)
    if peer.consecutive_slow_pulls >= 3:
      mark_peer_slow_for(peer, 30 min)
```

That's the whole fill loop. Every scenario above is one branch in this code.

---

## How "multiple gaps from constant churn" actually plays out

**Time T=0:** swarm has 1000 nodes. Archive #1 is 100% complete (every bucket held by ≥1 node). Archive #2 is 100% complete. Archive #3 is 73% built.

**Time T=5min:** A residential ISP loses 80 of those 1000 nodes simultaneously.

**Time T=5–10min:** Their heartbeats lapse. Worker removes them from the member list at T+15min. `churn_storm: true` flag set (80/1000 = 8% drop, just under the 20% threshold — so no storm freeze yet, but jitter doubles).

**Time T=15min:** Every remaining node sees updated member list on its next heartbeat tick. Each recomputes HRW. Approximately 80 × 13 buckets ÷ 920 nodes ≈ each remaining node gets ~1.1 new assignments. (Most of those are buckets they were already rank-5 for and now rank-4.)

**Time T=15-30min:** Fill loops execute. Priority queue surfaces depth-1 gaps first — there are maybe a dozen buckets that lost their *only* depth-1 holder. Those get pulled first (in parallel, max 4 per node, jittered, with peer-rank routing). Within minutes, depth-1 coverage is restored.

**Time T=30-60min:** Depth-2 gaps fill. Some buckets that were at depth 4 are now at depth 3 — within RF+SLACK, no urgent action.

**Time T=1-2 hours:** Archive #3's progress percentage may have dropped slightly (some bucket recoveries are still in flight) but Archives #1 and #2 are back to 100%.

**Time T=2-4 hours:** Steady state restored. The ISP comes back, those 80 nodes reconnect — they go into probationary period for 15 min. After probation, they're re-vetted and re-enter the HRW assignment pool. The drop policy notices over-coverage and trims back.

**Total swarm-level downtime for any archive:** roughly zero, because the system absorbed an 8% simultaneous departure into routine fill work.

This is what "self-healing" looks like in practice. **No human intervention. No coordinator decision. No data loss. Just math, running every 60 seconds on every node.**

---

## What was already in the architecture vs. what's new in this plan

| Mechanism | Status |
|---|---|
| HRW reassignment on member-list change | **Done in Day 1** |
| 5-min heartbeat with cache fallback | **Done in Day 1** |
| Drop hysteresis (SLACK = 2) | **Day 2 — designed, ships with fill loop** |
| Priority queue (depth_deficit + age) | **Day 2** |
| Rate-limited parallel pulls (max 4) | **Day 2** |
| Pull-timeout + per-peer routing in HRW order | **Day 2** |
| Seed source fallback | **Day 2** |
| Hash verification on every pulled block | **Day 2** |
| Heartbeat-surge / churn-storm detection | **New for Day 3 (Worker side)** |
| Probationary period (vetted flag) | **New for Day 3 (Worker side)** |
| Per-peer latency tracking + slow-peer exclusion | **New, ships v0.5.4** |
| Binary bucket completeness | **Day 2** |
| Disk-pressure drop policy | **Day 2** |
| Reader-driven strike system (3-strikes 7-day exclusion) | **Day 3 (Worker side)** |

So the answer to *"is this all built in?"* is:
- The protocol primitives (HRW, heartbeats, cache, hysteresis, priority math) are already on disk from Day 1
- The fill-loop policies (rate limit, pull strategy, drop strategy, hash verify) land on Day 2
- The Worker-side defenses (churn storm, probation, strikes) land on Day 3
- The peer latency tracking lands in v0.5.4 polish

**Nothing about the existing v0.5.3 build sequence changes.** This plan is making every churn behavior explicit so we don't accidentally rely on the math doing something it doesn't.

---

## Honest limits

- **15-min minimum detection latency.** A node that drops at T=0 won't be reassigned until ~T+15min. Lower this and you get flap thrash. The 15-min window is a deliberate trade.
- **Bandwidth-bound healing.** A massive cascade (50%+ swarm loss) won't heal in minutes — it'll heal over hours, bounded by residential pull bandwidth. The Worker's UI shows current healing progress so users see it's working.
- **Seed dependency during early swarm.** Until coverage is dense, some buckets only exist on the seed kaspad source. If seeds are unreachable, those buckets temporarily can't be pulled. The UI shows this honestly: "12 buckets are seed-only and seed is unreachable; will retry."
- **Adversarial churn (deliberate flap attacks).** A node that flips between online/offline every 14 minutes (just under the probation timer) could in theory game the system. Mitigation: probation timer increases on repeat offenders (1st: 15min, 2nd: 1h, 3rd: 24h). Land in v0.5.5 if it becomes a real issue.

---

## The principle

**Churn isn't a failure mode. It's the steady state.**

The design assumes people will be constantly arriving and leaving, that connections will flap, that ISPs will outage, that laptops will sleep. Every mechanism in the fill loop is built around that assumption — not as a special case, but as the default. When you watch the bar fill smoothly while 8% of the swarm just disappeared, that's not luck — it's a system that *expected* exactly that to happen.

The user reading this plan should leave with the understanding that **MyKAI is designed for churn from the protocol level up.** Drop-ins and drop-outs aren't exceptions to handle — they're the normal operating mode. The math runs every 60 seconds on every node, and the swarm is always, quietly, healing itself.
