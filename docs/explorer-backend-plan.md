# MyKAI Pool as Explorer Backend — The Plan

**Status:** Final design, supersedes `explorer-ready-pool.md` and `amateur-safe-defaults-v0.5.md`
**Date:** 2026-05-14
**Source:** 7-agent architecture research + 6-agent resource-envelope research, synthesized into one design

---

## The question

How do we take the MyKAI Archive Pool — a fragmented mesh of recent Kaspa blocks scattered across residential laptops — and turn it into something a real block explorer can use? Without melting the volunteers, without rewriting the explorer ecosystem, without inventing protocols.

## The answer

**The indexer already does the work. We just give it a different data source.**

`simply-kaspa-indexer` is 6 Rust crates, ~80 lines of kaspad coupling, 7 distinct RPC calls. It maps `RpcBlock` → Postgres → `kaspa-rest-server` → UI. That whole pipeline is source-agnostic except those 80 lines. Every Kaspa explorer (explorer.kaspa.org, kas.fyi, kaspahub.org) reads the Postgres it writes.

So: add 4 HTTP endpoints to the pool, fork the indexer to swap kaspad for those endpoints, and the entire explorer stack keeps working. **~1100 lines of code total. Zero changes to the Postgres schema, the REST server, or any explorer UI.**

The hard part isn't the fork. The hard part is doing it without breaking the "MyKAI is invisible" invariant that keeps the volunteer base.

---

## What gets built

### Pool side (~150 LOC in `agent-bridge.js`)

Four new endpoints. JSON responses are byte-identical to kaspad wRPC — reuse rusty-kaspa's serde, don't invent field names.

```
GET /shard/dag-info
  → DAG topology + pool_floor_daa + capabilities.virtual_chain

GET /shard/blocks?low_hash=X&include_txs=true&limit=500
  → up to 500 RpcBlocks, the workhorse endpoint

GET /shard/virtual-chain?start_hash=X&tip_distance=50
  → chain-selection deltas (proxied from local kaspad)

GET /shard/block-range?from_daa=A&to_daa=B&include_txs=true
  → DAA-indexed range scan, up to 5000 blocks, bootstrap-friendly
```

### Indexer side (~900 LOC fork)

One new crate, `source/`, exposing a `BlockSource` trait. Three impls:

- **`KaspadSource`** — existing 80 LOC moved over, no behavior change
- **`PoolSource`** — new, `reqwest` + serde, with mandatory hash + Merkle verification
- **`HybridSource`** — wraps both; routes by DAA score during bootstrap

CLI flag: `--source {kaspad|pool|hybrid}` + `--pool-url` (repeatable) + `--bootstrap-rpc-url`.

### What does NOT change

Postgres schema. `simply-kaspa-mapping`. `kaspa-rest-server`. Explorer UI.

This is the load-bearing claim. It holds because the only thing the indexer's hot path needs from kaspad is an `RpcBlock`, and the pool can return one.

---

## The three hard constraints

Every design decision in this doc traces back to one of these. **Untrusted participants aren't on the list** — the indexer's bootstrap kaspad has the header chain, so every returned block either hashes to a known header or it doesn't. O(1) check, free, no defense bureaucracy needed.

### 1. The renderer is the binding constraint

Not bandwidth. Not thermal. Not battery. **Electron renderer jank.**

Electron's main process owns the GPU IPC channel. A blocked event loop drops compositor frames in MyKAI's own UI. One `/shard/blocks?limit=500` call is 500 sql.js queries + a 5 MB `JSON.stringify` = 100-200 ms of event-loop blocking = 6-12 dropped frames in the MyKAI live activity feed. Five such calls per second and MyKAI's own UI stutters visibly.

**Failure ladder under increasing indexer load:**

| Load (BPS) | What breaks |
|---|---|
| 200-300 | Renderer jank (first to manifest, lowest threshold) |
| 500-800 | Event-loop saturation → archive pool silently falls behind chain tip |
| 1000+ | sql.js synchronous stall |
| 1500-2500 | GC death spiral |
| 3000+ | OS swap on 4 GB laptops |

This is why default-on is rejected. This is why the v0.6 work is moving the shard storage to better-sqlite3 in a child process. This is why we yield the event loop every 25-50 rows with `setImmediate` even at the cost of doubling wall-time.

### 2. The fan is the uninstall trigger

Not heat, not battery wear, not ISP bills. The *audible spin-up* of a previously-silent laptop. Ultrabook fans concentrate noise in the 2-8 kHz band where human hearing peaks. Threshold for "uninstall within a week" is ~35-40 dBA, which most $700 ultrabooks hit at 25-35% sustained CPU.

Apple Silicon is a non-event thermally. x86 ultrabooks are the at-risk cohort. The v0.5 at-risk composite weights "sustained CPU >25% for 5 min" at 25 — highest weight of any signal.

### 3. Residential ISPs make 15-25% of volunteers unreachable

Two real walls, neither of them bandwidth caps:

- **Asymmetric upload.** Modal US cable = 35 Mbps up. A 5 MB/s backfill = 91% utilization for 14-35 hours → bufferbloat → household Zoom/Netflix/gaming collapses → volunteer churns.
- **CGNAT.** T-Mobile Home, Starlink Residential, mobile-tethered — universally CGNAT. UPnP is unreliable. ~15-25% of would-be NA volunteers cannot accept inbound IPv4.

Comcast's AUP explicitly prohibits residential servers. UK/EU/Canada are friendlier.

---

## The shape

Every decision below is downstream of those four constraints.

### Default behavior — Storage-only

A fresh MyKAI install does not serve explorer traffic. Block capture runs, snapshots serve, that's it. This is the v0.4 invariant unchanged.

Explorer serving is an explicit opt-in on the Pool page, behind a one-tap disclosure:

> **Help indexers reach Kaspa? (optional)**
>
> Your archival storage already serves snapshots. You can also let explorer apps query your node directly — same idea, just answering live questions instead of handing over snapshots.
>
> This uses your internet connection. Choose the level that fits:
>
> ○ **Off** — recommended if your internet is metered or slow
> ○ **Light** — up to ~50 GB/month, fine for most home internet
> ○ **Heavy** — up to ~500 GB/month, for fast unmetered connections
>
> You can change this anytime. We'll show you how much you're actually using.

### Three tiers

| | Storage-only | Light-serve | Heavy-serve |
|---|---|---|---|
| Default for new installs | ✓ | — | — |
| Target | Anything that runs MyKAI | Laptop on residential | Desktop on fiber |
| Monthly egress cap (hard) | 0 GB | **50 GB** | **500 GB** |
| Max concurrent indexers | 0 | 2 | 8 |
| Per-IP concurrent | — | 2 | 5 |
| Per-IP req/s | — | 5 (burst 20) | 20 (burst 100) |
| Per-connection bandwidth | — | 1 Mbit/s | 4 Mbit/s |
| `getBlocks` batch cap | — | 100 | 500 |
| `pool_floor_daa` retention | per storage tier | 24h+ | 7d+ |
| Quiet hours (default 20:00-23:00) | — | throttle backfill | throttle backfill |

**Tier is the contract** indexers trust. Observed numbers (`current_load_percent`, `egress_used_gb`) are reality used only for tie-breaking. Volunteers never see raw numbers; the tier abstracts them.

### One operator control: Pause

Not a slider, not a config screen — a button. 24h hard stop. No confirmation dialog. The volunteer's instinct to stop is honored immediately. 60-second graceful drain on in-flight connections, then hard close.

### Auto-tune inside tier ceilings

Tier ceilings are hard caps the gateway enforces regardless of what's advertised. Within those ceilings, three signals auto-throttle without exposing knobs:

- Egress rate > 30% of measured upstream → drop concurrent slot count
- CPU sustained > 70% for 5 min → drop concurrent slot count
- Thermal throttle event from OS → drop to minimum slots for 1 hour

Auto-tier-down sequence when the at-risk composite trips 70: halve burst budget → halve concurrent → pause explorer listener → throttle shard serve → pause capture. **Explorer drops before capture, always.** Capture is load-bearing; serving is discretionary.

### How indexers find and use pool participants

Three structural rules, learned the hard way from BitTorrent, Bitcoin Core, Tor:

**Pin, don't fan out.** Each indexer pins to K=3-5 participants for its lifetime via weighted-random sampling at startup. Rotation only on health failure. The pinned pool keeps page caches and connection state warm.

**No "fastest responder" routing, ever.** That's the gradient that creates the "one volunteer gets melted" failure. Round-robin within the pinned pool only. The cost of occasionally hitting a slightly slower participant is 100 ms per request; the cost of hot-spotting one volunteer is "they uninstall."

**DNS round-robin to a single pool hostname is forbidden.** It converts a stateless indexer into a hot-spot generator. Single transient resolver bias dumps M connections onto one residential cable modem.

Discovery is a **bootstrap list** — a plain JSON phone book of participant endpoints. Not for trust (consensus handles that), just for findability. Anyone can add themselves; the indexer picks K=3-5 weighted by advertised tier. Mirror it on GitHub + IPFS so no single host gates participation. Not DNS, not DHT — both have worse failure modes than a static file with a checksum.

### Bootstrap is hybrid

Pools have data from `T_join` forward, not from genesis. A fresh indexer asking for the pruning-point block gets a 404 if pruning-point < `pool_floor_daa`.

Three modes the indexer fork supports:

- **`--source pool`** — start from pool floor, no pre-floor history. For new networks or test deployments.
- **`--source hybrid`** (recommended for production) — use `--bootstrap-rpc-url=<archival kaspad>` for the gap, cross over to pool at `pool_floor_daa`. Validate first 100 post-crossover blocks against both sources.
- **`--source kaspad`** — unchanged, default behavior.

### Soft signals over hard cuts

When a participant hits 90% of its monthly egress, it doesn't hard-503 everything. It falls back to **head-only mode** (Bitcoin Core pattern) — serve recent blocks, 503 historical. The indexer sees `X-MyKAI-Load: 0.9` in response headers and schedules rotation at the next batch boundary, not instant cut. This prevents the cascade where the next-most-loaded participant melts.

### zstd is mandatory, gzip is forbidden on the JSON path

zstd at level 3 on JSON: 400-600 MB/s single-threaded, 4-5× wire reduction. CPU cost <5% of one core at 5 MB/s pre-compression. Light-tier 100 GB/month raw becomes 25 GB/month on the wire.

gzip is actively harmful here. Block JSON has high entropy (hashes, signatures), compression ratio only 1.3-1.6×. `zlib.gzip` on 5 MB strings is 30-80 ms on residential hardware, competing for the exact event-loop ticks that are already the bottleneck.

Stream-then-compress, not buffer-then-compress.

---

## The technical mitigations

These four ship before the opt-in toggle is even unlocked. Without them, even opt-in serving breaks the MyKAI UI.

1. **Hard rate-limit `/shard/blocks` to ≤2 in-flight per connection, ≤4 globally.** One line of code, biggest single win against renderer jank.

2. **`setImmediate()` yield every 25-50 sql.js rows.** Doubles wall-time of large requests, eliminates 100-200 ms event-loop monopoly. The single largest renderer-jank mitigation available.

3. **Stream the JSON response.** Write `[`, per-block stringify, `,` between, `]` at end. Each block becomes a young-generation allocation that gets scavenged before the next. Large-object-space pressure drops from 5 MB transient peaks to ~10 KB peaks.

4. **Hash-check every block** on the indexer side. This is the same check the indexer would do against kaspad — it costs nothing extra. Mismatched block = drop the response, try a different pinned participant. No reputation system, no three-strike, no reporting. The header chain is the truth.

---

## The operator surface

A telemetry panel appears below the toggle when serving is enabled:

```
Explorer Serving — Light
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Currently serving:  1 indexer
This month:         11.2 / 50 GB egress  [▓▓▓░░░░░░░] 22%
Right now:          3.4 Mbps up

7-day uptime:       99.1%
Auto-adjustments:   none in last 7d

[ Pause for 24h ]   [ Change tier ]   [ Why these numbers? ]
```

Rules the panel obeys:

- **Mbps not MB/s.** Mbps is what their ISP plan is in.
- **Progress bar fills relative to tier ceiling**, not user's data cap. We don't know their plan.
- **"Auto-adjustments: none"** is the trust-builder. After a thermal event: `Auto-adjustments: 1 (thermal, 3d ago) →` opens log.
- **No currency framing.** Never "estimated cost in $". Currency implies we know their plan and turns donation into transaction.
- **One real-time number only.** Volunteer can spot-check during a Zoom call.

---

## The shipping ladder

Three releases. Each one must succeed before the next is meaningful.

### v0.5.1 — endpoints + mitigations, opt-in dark launch

**Pool side:**
- Add the 4 `/shard/*` endpoints to `agent-bridge.js`
- Tier-1 mitigations: rate limits, `setImmediate` yielding, streaming JSON, mandatory zstd
- Toggle exists but **default off**
- Listener binds to `127.0.0.1` only — public-internet binding requires a second explicit opt-in + NAT check
- No tier selection yet (single-mode for early-adopter testing)

**Indexer side:**
- Branch `simply-kaspa-indexer` to `mykai/pool-source`
- New `source/` crate, `BlockSource` trait, three impls
- Hash + Merkle verification on `PoolSource`
- CLI flags wired

**Smoke testing:** local indexer pointed at local MyKAI, validate `cargo test` + row counts vs reference archival kaspad.

**~30 day measurement window** where only deliberate opt-ins serve. This calibrates the auto-tuner before broader recruitment.

### v0.5.2 — three-tier system, real public deployment

**Pool side:**
- Tier selection UI (Storage-only / Light / Heavy)
- Capability advertisement in `/shard/dag-info`
- Operator telemetry panel
- Quiet hours scheduling
- Auto-tier-down logic wired to the at-risk composite

**Discovery service:**
- MyKAI Foundation publishes signed bootstrap JSON
- GitHub + IPFS mirrors
- On-chain hash anchor for tamper-evidence

**Indexer side:**
- Multi-`--pool-url` failover with `Retry-After`-respecting quarantine
- Discovery-list integration (read the phone book at startup, pin K=3-5)

### v0.6 — the structurally correct shape

**The technical refactor that unlocks Heavy-tier:**
- Move shard storage from sql.js to **better-sqlite3** (native, ~5× throughput, zero WASM marshalling)
- Move the explorer HTTP server to a **child process** supervised by the Electron main
- This separates explorer load from Electron's renderer event loop entirely
- libp2p Circuit Relay v2 for CGNAT participants

This is the configuration that scales to multiple indexer consumers without compromising the invisible invariant.

**Do not skip v0.5.1.** The measurement window is what makes v0.5.2's tier numbers honest instead of guesses.

---

## What it costs in code

| Component | Added | Changed | Removed |
|---|---|---|---|
| Pool: 4 new endpoints + extended `/shard/stats` | ~170 | ~10 | – |
| Indexer: `source/` crate (trait + 3 impls + verification) | ~700 | – | – |
| Indexer: hybrid bootstrap state machine | ~80 | – | – |
| Indexer: multi-pool failover + quarantine | ~80 | – | – |
| Indexer: move kaspad coupling into source crate | – | – | ~80 |
| Indexer: CLI + main.rs wiring | ~45 | ~80 | ~25 |
| Indexer: fetch_blocks + fetch_virtual_chain + health | ~15 | ~60 | ~10 |
| **Total** | **~1090** | **~150** | **~115** |

A reviewable PR, one engineer, ~7 days from clean checkout to side-by-side validation against a production indexer.

---

## The honest "still invisible?" verdict

By load class:

- **Idle and typical polling** (small `/shard/dag-info` polls, a few `/shard/blocks` recent-range hits per minute): still invisible.
- **Single indexer backfill**: lightly visible. A multi-thousand-block range serialization spikes a core for several seconds. Mitigations bring it to "user almost never hears it, and when they do it's brief and apologetic."
- **Multi-indexer concurrent backfill**: visible. The 2-concurrent cap on Light tier and the auto-tier-down composite keep this rare. We promise containment, not invisibility.

On first opt-in, the volunteer sees one honest sheet:

> You're hosting Kaspa history for other apps. Almost all the time you won't notice. Once in a while, when one of those apps catches up on history, your fan may spin briefly. MyKAI will pause itself if your laptop gets hot, if you're on battery, if you're in a video call, or during quiet hours (8-11 PM). You can pause explorer hosting anytime from the dashboard. You can keep contributing to the Archive Pool with explorer hosting off.

The v0.4 covenant — "MyKAI must be invisible to keep volunteers" — refines to:

**MyKAI must be invisible except when it isn't, and when it isn't we must have already told you, and the moment must be brief, and one click must end it.**

---

## The principle

Every recommendation in this doc traces back to one line:

> **Indexers can scale up by adding more nodes. Volunteers can only scale down by uninstalling.**

When in doubt, optimize for the volunteer who's about to wonder why their internet is slow.

---

## References

- v0.4 baseline: `memory/reference_mykai_amateur_defaults.md`
- Architecture pivot context: `memory/project_mykai_archival_pivot.md`
- `simply-kaspa-indexer` repo: `supertypo/simply-kaspa-indexer` (MIT, Rust 2024)
- Bitcoin Core `maxuploadtarget` (5 GB/day residential floor)
- Tor `BandwidthRate` minimum (75 KB/s, ~6 GB/day)
- BitTorrent BEP-3 (4+1 unchoke slots)
- IPFS gateway nginx defaults (1 req/s/IP)
- Filecoin Saturn L1 orchestrator pattern (no DNS round-robin)
