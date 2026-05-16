# Virtual Archive Nodes — The Swarm-of-Archives Plan

**Companion to:** `coverage-distribution-plan.md`
**Status:** Locked design
**Ship target:** v0.5.3 (math is already built) + v0.5.4 (the user-facing reframing)

---

## The vision in one paragraph

A Virtual Archive Node is **one complete copy of Kaspa's archival history**, made of slices held by many different users. As volunteers join, their slices first fill out Archive #1. When Archive #1 is complete (every block from pruning point to chain tip held by at least one user), the swarm begins forming Archive #2. Then #3, #4 — up to as many as the total committed storage can fund. **The pool isn't trying to be one archival node — it's trying to be N of them, where N grows with participation.** With 10,000 users at ~40 GB each, the math comfortably supports 100+ parallel virtual archive nodes.

---

## Why this isn't a new algorithm — it's a better name

The math we already locked in v0.5.3 (weighted HRW + depth-first priority + RF=N) IS this system. We were calling it "replication factor 4" — a database-engineering term that means nothing to a user. The accurate user-facing description is **"the swarm builds 4 complete archival nodes."** Same math, vastly better mental model.

The rank a user gets from HRW for a given bucket maps directly to which archive they're contributing to:

```
Bucket X has top-4 holders by HRW score:
  Rank 1: User A  →  contributing to Archive #1
  Rank 2: User B  →  contributing to Archive #2
  Rank 3: User C  →  contributing to Archive #3
  Rank 4: User D  →  contributing to Archive #4
```

A user with multiple buckets in their assignment contributes to multiple archive nodes simultaneously. User A might be in Archive #1 for buckets they're "first-rank" for, Archive #3 for buckets they're "third-rank" for, etc. Their stripe on the visualization spans whichever archives they touch.

**Same algorithm. New framing. Real difference.**

---

## The "spawn" mechanic

Each archive is a target: every bucket from pruning point to tip needs at least one rank-N holder.

```
Archive 1 status:  100,000 of 100,000 buckets at depth ≥ 1   →  COMPLETE ✓
Archive 2 status:  100,000 of 100,000 buckets at depth ≥ 2   →  COMPLETE ✓
Archive 3 status:   84,231 of 100,000 buckets at depth ≥ 3   →  84.2% filling
Archive 4 status:        0 of 100,000 buckets at depth ≥ 4   →  WAITING for #3
```

Once Archive 3 hits 100%, Archive 4 starts forming automatically. No protocol change — it's how depth-first priority already works (see `priority(bucket) = (target_depth - current_holders) × 1000 + age_rank` in the coverage plan). Archive 4 simply has zero progress until every bucket has ≥3 holders.

The spawn doesn't require a coordinator decision. **It emerges from the priority math.** As soon as the lowest-covered bucket in the swarm has 3 holders, the priority queue's next candidate is "any bucket at depth 2" (which now means "promote it to depth 3, contribute to Archive #3"). When Archive #3 is done, the next candidates are "any bucket at depth 3, promote to depth 4."

---

## The feasibility math at scale

Setup:
- Kaspa post-Crescendo: ~50 KB/block × 10 BPS = ~43 GB/day of new chain data
- One year of archival history ≈ 1.57 TB
- One "full archive" = N years of history depending on user goal

Scale 1 — Modest swarm (1,000 users, ~40 GB each):

```
Total committed: 1,000 × 40 GB = 40 TB
After hot-tail reserve (1 GB/user): 39 TB assignable
At 1 year of history (1.57 TB per archive):
  → ~25 complete virtual archive nodes
At 6 months of history (785 GB per archive):
  → ~50 complete virtual archive nodes
```

Scale 2 — Your target (10,000 users, ~40 GB each):

```
Total committed: 10,000 × 40 GB = 400 TB
After hot-tail reserve: ~390 TB assignable
At 1 year of history per archive:
  → ~250 complete virtual archive nodes
At 2.5 years of history per archive:
  → ~100 complete virtual archive nodes (your target)
At 5 years of history per archive:
  → ~50 complete virtual archive nodes
```

**100 archive nodes covering 2.5 years of Kaspa history is comfortably within 10,000 modest residential contributors.** No exotic infrastructure, no payment system, no heroic hardware — just opt-in volunteers at the same GB scale as a Dropbox account.

Scale 3 — Mature (50,000 users, average climbs to ~100 GB each):

```
Total: 5 PB committed
At 5 years of history per archive:
  → ~640 complete virtual archive nodes
```

At that point MyKAI quietly becomes one of the largest archival systems in existence, anywhere, for any blockchain. The math scales because the design has no global coordination bottleneck.

---

## The user-facing language

Drop "replication factor." Use **archive nodes**. Specifically:

| Backend term | User-facing |
|---|---|
| Replication factor | Number of archive nodes |
| RF=4 | "4 archive nodes" |
| Bucket coverage = 4 | "covered in 4 archives" |
| Pool floor DAA | "How far back the archives reach" |
| HRW rank for a bucket | "Which archive your slice belongs to" |
| Depth-first priority | "Building the next archive node" |

The dashboard headline changes from "you're holding 3,509 blocks" to:

```
You're contributing to Archive Node #1 (and partially #2)

The swarm has built 2 complete archive nodes
and is now forming Archive Node #3 (84.2% built)
```

That sentence is comprehensible. "RF=4" isn't.

---

## The visualization

Replace the multi-stripe coverage bar with a **stacked progress graphic** showing each virtual archive node as a separate progress well:

```
╭──────────────────────────────────────────────────────────────╮
│ NETWORK ARCHIVE STATUS                                       │
│                                                              │
│ Archive Node #1 [████████████████████████████████] 100%  ✓   │
│ Archive Node #2 [████████████████████████████████] 100%  ✓   │
│ Archive Node #3 [██████████████████████████░░░░░░]  84.2%    │
│ Archive Node #4 [░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░]    0%    │
│                                                              │
│ YOU are contributing 13 slices across:                       │
│  Archive #1: 8 slices (DAA range varies)                     │
│  Archive #3: 5 slices                                        │
│                                                              │
│ Coverage span: 2.4 years of Kaspa history                    │
│ Total contributors: 1,247                                    │
╰──────────────────────────────────────────────────────────────╯
```

Each archive's progress bar fills as the priority queue covers more buckets at that depth. When a bar hits 100% it gets a checkmark and stays visible (as a historical achievement). The "next" archive starts filling automatically.

Click into any archive to see:
- Which buckets are still missing
- Color-coded contributor stripes for the buckets that ARE filled (your stripe highlighted)
- Estimated time to completion at current swarm growth rate

---

## What this requires implementation-wise

**The math (already done in Day 1 of v0.5.3):** `swarm-assignment.js` already computes HRW ranks. The only addition needed: when an indexer or UI asks "what archive does bucket X at rank R belong to?", the answer is just `R`. No new code.

**The progress tracker (new in v0.5.4):** The foundation Worker computes per-archive coverage by counting:

```
for each bucket in scope:
  holders = count of distinct nodes claiming this bucket
  for r in 1..max_depth:
    if holders >= r: increment archives[r].buckets_filled

archives[r].progress_pct = archives[r].buckets_filled / total_buckets * 100
```

This is one extra aggregation step on top of the membership data the Worker already maintains. Returns a `archives` array on the same `/v1/swarm` response.

**The UI (new in v0.5.4):** Replace the multi-stripe SVG with the progress-bar stack. ~150 LOC of vanilla JS. The hover/click drill-down can come in v0.5.5.

**Renaming (cosmetic in v0.5.3):** Wherever the UI says "replication factor" or "depth," say "archive node." Wherever it shows a stripe count, frame it as archive-membership.

---

## How users perceive growth

**Day 1 (alone):** "Welcome. You're the first to build Archive Node #1. Right now it covers 12 hours of Kaspa history, growing as you stay online."

**Day 7 (small swarm):** "Archive Node #1 is 18% built (47 days covered). You're one of 23 contributors. Once it reaches 100% — when every block back to the pruning point has a home — Archive Node #2 will start automatically."

**Day 90 (medium swarm):** "Archive Nodes #1 and #2 are complete. Archive Node #3 is 84% built. Your storage is contributing to all three."

**Day 365 (mature swarm):** "47 complete archive nodes. Archive Node #48 is 22% built. You're contributing to 6 of them."

This is a **growth narrative**, not a number. Users see the swarm doing something. They see their own contribution placed in the bigger picture. The metaphor is real — these literally are complete archives, made of pieces.

---

## What's emergent vs. what's explicit

**Emergent (free from HRW + depth-first priority):**
- Archive ordering (rank → archive number)
- Spawn behavior (next archive starts when previous completes)
- Load balancing across archives (top-rank users naturally end up in the early archives)
- Resilience (losing a user only damages buckets where they were top-rank in the highest-depth archive)
- Backward-extension (frontier moves backward as capacity allows)

**Explicit (needs code):**
- Per-archive progress counting in the Worker (one new aggregation)
- The UI stack-of-wells visualization (replaces the current multi-stripe SVG)
- The user-facing language pass through every screen
- Optionally: a "you joined Archive #N at slice #M" welcome message when shardSizeGB is first set

That's it. The hard distributed-systems work was already done. What remains is **presenting it correctly.**

---

## Why this is the right design

1. **It uses the same proven math.** HRW + depth-first priority is already locked. We're not inventing anything new at the protocol level.

2. **It scales linearly with participation.** 10× users = ~10× archive nodes OR ~10× depth of history. No coordination bottleneck blocks this.

3. **It gives users a real reason to invite friends.** "We're at Archive Node #6, help us build #7." Concrete, social, gameable in a good way.

4. **It survives partial failure naturally.** If half the swarm vanishes, archives #1–#3 may degrade to depth 2, but they don't disappear — they just lose redundancy. The visualization can show this honestly: "Archive #4 dropped to 87% due to participant loss; healing in progress."

5. **It maps cleanly onto what users already understand.** "Archive nodes" exist in their mental model from kaspad. We're saying "we're building those, together, out of pieces."

6. **It doesn't lie.** Each completed archive really does contain every block — distributed across many users, but reconstructible. An indexer pointed at the swarm can rebuild Kaspa's full history from Archive #1 alone. Adding #2, #3, etc. is real redundancy, not optics.

---

## Honest limits

- **An archive is "complete" only as long as every bucket has at least one online holder.** Brief outages can drop a bucket below depth 1 temporarily. The Worker shows this honestly: "Archive #1 is 99.7% online right now (300 buckets temporarily uncovered as 12 users are offline)."
- **The frontier (how far back archives reach) is bounded by the swarm's total storage.** Once you've used all the storage, the only ways to extend backward are: more users, bigger budgets, or storage compaction. We don't lie about that — the UI shows the current "depth in years" and what it would take to extend it.
- **Bootstrapping needs seed sources.** Until the swarm has historical coverage, it has to pull old blocks from somewhere. Foundation-run archival kaspad + community archives serve as seeds; their dependency drops as swarm coverage grows.

---

## Build sequence

| Step | When | Effort |
|---|---|---|
| HRW math + member registry | **v0.5.3 Day 1 (done)** | — |
| Fill loop pulling assigned buckets | v0.5.3 Day 2 | 1 day |
| Foundation Worker with archive-progress aggregation | v0.5.3 Day 3 + slight extension | ~1 day, +0.25 for archive math |
| Bar UI showing real participants | v0.5.3 Day 4 | 1 day |
| Stack-of-wells visualization replacing multi-stripe | **v0.5.4** | 1.5 days |
| User-facing language pass ("Archive Node" everywhere) | v0.5.4 | 0.5 days |
| Click-into-archive drill-down | v0.5.5 | 1 day |

Total: ~6 days, same as before plus ~2 days for the reframing and visualization upgrade.

---

## The principle

**The pool isn't trying to be one archival node. It's trying to be many, in parallel.**

The number it's trying to be grows with the number of people who help. Each user's slice has a place in a specific archive — they can see it, name it, point at it. When they invite a friend, that friend's slice slots into a specific archive too. The growth is visible, the cooperation is concrete, the contribution is named.

That's a story worth telling. And the math already supports it.
