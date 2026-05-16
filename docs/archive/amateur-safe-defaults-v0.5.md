# MyKAI Amateur-Safe Defaults v0.5 — Explorer-Backend Edition

**Status:** Design spec, v1.0
**Date:** 2026-05-14
**Supersedes:** v0.4 amateur-safe defaults (kept as baseline; this doc adds explorer-serving as a first-class concern)
**Source:** Synthesis of 6 parallel deep-research agents covering RAM/CPU, bandwidth/ISP, thermal/battery, fan-out/rate-limiting, tier design, and the updated-defaults synthesis. All grounded against the v0.4 invariant.

---

## TL;DR

The v0.4 "invisible to keep volunteers" invariant **survives, but only behind a strict envelope**. Three of v0.4's invariants are unchanged (disk thresholds, capture rate, telemetry default-off). The rest need extension.

**The single sharpest finding:** the failure mode isn't bandwidth, isn't thermal, isn't bandwidth caps. **It's Electron renderer jank.** A blocked main-process event loop drops compositor frames in the MyKAI UI itself, because Electron's main process owns the GPU IPC channel. A single `/shard/blocks?limit=500` call blocks the event loop for 100-200 ms — visible stutter in MyKAI's own live activity feed at as few as 5 requests/sec.

**Shipping plan:**
- **v0.5.1**: Opt-in "high-traffic mode" with Tier-1 technical mitigations (rate limits, `setImmediate` yielding, streaming JSON). Default off.
- **v0.5.2**: Three-tier system (Storage-only / Light-serve / Heavy-serve). Storage-only is default. Light/Heavy are opt-in with one-time speedtest + tier auto-suggestion.
- **v0.6+**: Dedicated explorer-tier participant on better-sqlite3 in a child process, separated from Electron main. This is the configuration that scales without breaking the invisible invariant.

The v0.4 covenant refines to: **"MyKAI must be invisible except when it isn't, and when it isn't we must have already told you, and the moment must be brief, and one click must end it."**

---

## 1. The hardest technical finding — renderer jank

This is the architectural constraint that drives everything else.

Electron docs are explicit: *"If you do CPU intensive work in the main process, it'll lock up all your renderer processes."* The mechanism is the GPU IPC channel — the main process routes compositor frames from renderer to GPU service. A blocked event loop = delayed IPC = dropped frames in the renderer, even though renderer JS is fine.

**The path that breaks:**
```
GET /shard/blocks?limit=500
  → 500 sequential sql.js queries (WASM↔JS copy per row, no yield)
  → one ~5 MB JSON.stringify on a nested object (40-120 ms wall-time)
  → one socket write
  = 100-200 ms event-loop blocking, no yield points
  = 6-12 dropped frames at 60 Hz in the MyKAI UI
```

5 such calls/sec = main process blocked half the time → MyKAI's own UI stutters.

**This is why default-on is rejected and `setImmediate` yielding is mandatory.**

---

## 2. Failure ladder

Pushed under increasing indexer load, the failure order:

| Load | What breaks | Threshold |
|---|---|---|
| 200-300 BPS | Renderer jank (first to manifest) | Visible to user |
| 500-800 BPS | Event-loop saturation | Archive pool silently falls behind tip |
| 1000+ BPS | sql.js synchronous stall | All HTTP routes time out |
| 1500-2500 BPS | GC death spiral | 500ms-2s stop-the-world pauses |
| 3000+ BPS | OS swap/OOM | 4 GB laptops collapse |

**Hard takeaway:** rate-limit `/shard/blocks` aggressively. The throughput ceiling on residential hardware is ~5-10 such calls/sec safely, ~20 with `setImmediate` yielding, and is fundamentally capped by sql.js until v0.6's better-sqlite3 swap.

---

## 3. v0.4 invariants — what holds, what extends, what breaks

| v0.4 setting | v0.5 status | Reasoning |
|---|---|---|
| `power.pause_on_battery: true` | **EXTENDS** — also pauses explorer listener | Radio TX ~3× ingress energy; volunteer has zero visibility into who's hitting endpoint |
| `power.fight_sleep: false` | HOLDS | Let OS sleep. On wake, explorer rebinds after 15s grace |
| `thermal.cpu_temp_throttle_at_c: 80` | **EXTENDS** — explorer drops before capture | Capture is load-bearing; explorer is discretionary |
| `thermal.cpu_temp_pause_at_c: 90` | HOLDS | Hard-close listener at 90°C |
| `thermal.cpu_sustained_pct_cap: 15` | **CHANGED to 20** | JSON serialization spikes; can't hold 15% without breaking indexer 5-10s read timeouts. 5pp headroom is the explicit cost of explorer mode; still under fan-noise threshold on M-class and most modern x86. |
| (new) `cpu_burst_pct_cap: 35` | **NEW** | 10-second window; allows brief stringify spikes |
| `cpu_pause_when_user_active_pct: 10` | **EXTENDS** — also returns 503 Retry-After 30s | User noticing > uninterrupted indexer service |
| `storage.*` (all of it) | HOLDS UNCHANGED | Storage is physical reality, no load-pattern change |
| `network.bandwidth_cap_pct_of_probed_link: 25` | **SPLIT** | Mixed bucket lets indexers starve P2P. Now: 25% P2P + 60 KB/s steady explorer + 30 MB/min burst |
| `network.monthly_bandwidth_cap_gb: 200` | **SPLIT** | 200 GB P2P + 100 GB explorer (Light tier). Total ceiling 300 GB/month, well under 1.2 TB ISP caps |
| `scan_etiquette.pause_while_fullscreen_app: true` | **EXTENDS** — also returns 503 | Fan-during-Zoom was #1 killer in v0.4 |
| `scan_etiquette.pause_while_on_call: true` | **EXTENDS** — also returns 503 | Same |
| `ui.no_pestering_notifications: true` | HOLDS | Throttle events go to 24h ring buffer, not OS notifications |
| `ui.show_bytes_served_to_peers: true` | **EXTENDS** — adds explorer egress counter | "You helped" surface |

---

## 4. The three-tier model

Storage-only is the default. Light-serve and Heavy-serve are explicit opt-ins on the Pool page, behind a one-tap "Help indexers?" disclosure.

| | Storage-only | Light-serve | Heavy-serve |
|---|---|---|---|
| **Default for new installs?** | YES | No (opt-in) | No (opt-in) |
| **Target hardware** | Any | Laptop on residential cable | Desktop on unmetered fiber |
| **Block capture** | Yes | Yes | Yes |
| **Explorer endpoints** | No | Yes | Yes |
| **Monthly egress cap** | 0 GB | **50 GB** | **500 GB** |
| **Max concurrent indexers** | 0 | 2 | 8 |
| **Per-IP concurrent connections** | n/a | 2 | 5 |
| **Per-IP request rate** | n/a | 5 req/s sustained, 20 burst | 20 req/s sustained, 100 burst |
| **Per-connection bandwidth** | n/a | 1 Mbit/s | 4 Mbit/s |
| **`getBlocks` batch cap** | n/a | 100 | 500 |
| **`pool_floor_daa` retention** | per storage tier | 24h+ | 7d+ |
| **Quiet hours default** | n/a | 20:00-23:00 local | 20:00-23:00 local |
| **Backfill behavior in quiet hours** | n/a | Throttle requests >500 blocks until 23:00 | Throttle requests >500 blocks until 23:00 |

**Tier is the contract** indexers trust. Observed numbers (`current_load_percent`, `egress_used_gb_this_month`) are reality used only for tie-breaking and graceful rotation.

---

## 5. v0.5 ship config (drop-in successor to v0.4)

```yaml
# v0.5 = v0.4 + explorer block. Unchanged keys omitted for brevity.

power:
  pause_on_battery: true                # extends to explorer
  pause_explorer_on_battery: true       # NEW — explicit
  resume_grace_period_sec: 60

thermal:
  cpu_temp_throttle_at_c: 80
  cpu_temp_pause_at_c: 90
  cpu_sustained_pct_cap: 20             # CHANGED from 15
  cpu_burst_pct_cap: 35                 # NEW
  cpu_burst_window_sec: 10              # NEW
  cpu_pause_when_user_active_pct: 10
  thermal_pause_explorer_first: true    # NEW

network:
  # P2P side unchanged
  p2p_bandwidth_cap_pct_of_probed_link: 25
  monthly_p2p_cap_gb: 200
  monthly_p2p_cap_soft_alert_pct: 70
  monthly_p2p_cap_hard_pause_pct: 90

  # NEW explorer block (Light tier defaults shown)
  explorer_listener_enabled: false      # opt-in default
  explorer_bind: "127.0.0.1"            # default loopback; 0.0.0.0 requires explicit opt-in + NAT check
  explorer_port: 17112
  explorer_tier: "light"                # storage-only | light | heavy
  explorer_bandwidth_steady_kbps: 60    # ~5.2 GB/day raw, ~1.3 GB/day with zstd
  explorer_burst_budget_mb_per_min: 30  # token bucket
  explorer_max_concurrent_connections: 2  # Light; Heavy: 8
  explorer_max_per_ip_concurrent: 2     # Light; Heavy: 5
  explorer_max_per_ip_req_per_sec: 5    # Light; Heavy: 20
  explorer_max_per_ip_burst: 20         # Light; Heavy: 100
  explorer_max_block_range: 100         # Light; Heavy: 500
  explorer_monthly_egress_cap_gb: 50    # Light; Heavy: 500
  explorer_monthly_egress_soft_alert_pct: 70
  explorer_monthly_egress_hard_stop_pct: 90
  explorer_response_timeout_sec: 30
  explorer_zstd_required: true          # mandatory; gzip fallback for old clients
  explorer_zstd_level: 3                # 400-600 MB/s on JSON; <5% CPU at 5 MB/s

scan_etiquette:
  pause_while_fullscreen_app: true
  pause_while_on_call: true
  return_503_on_etiquette_pause: true   # NEW — explorer-side

scheduling:                              # NEW SECTION
  quiet_hours_enabled: true
  quiet_hours_local_start: "20:00"
  quiet_hours_local_end: "23:00"
  quiet_hours_behavior: "throttle_backfill"
  quiet_hours_backfill_threshold_blocks: 500

auto_tier_down:                          # NEW SECTION
  enabled: true
  trigger_at_risk_score: 70              # 0-100 composite
  action_order:                          # explorer drops before capture
    - explorer_burst_budget_halve
    - explorer_max_concurrent_halve
    - explorer_listener_pause
    - shard_serve_throttle
    - capture_pause
  recovery_dwell_min: 15                 # don't oscillate

soft_commitment:                         # NEW SECTION
  explorer_min_enable_days: 7            # advisory only, never enforced
  drain_timeout_sec: 60                  # graceful disable; Pause is honored immediately

ui:
  show_bytes_served_to_peers: true
  show_bytes_served_via_explorer: true   # NEW
  show_explorer_clients_24h: true        # NEW — count only, never IPs
  one_click_pause: true
  one_click_pause_explorer_only: true    # NEW — granular kill switch
```

---

## 6. The at-risk composite (extended)

v0.4's composite combined CPU temp, manual-pause frequency, bandwidth burn rate, time-since-peer-round. v0.5 adds five explorer-aware signals. Any single signal in the red can trip auto-tier-down at composite ≥70.

| Signal | Source | Yellow | Red | Weight |
|---|---|---|---|---|
| Sustained outbound >40 KB/s for 10 min | app counter | 40 KB/s | 80 KB/s | 15 |
| **CPU sustained >25% for 5 min (fan-noise proxy)** | PDH / `top` / `/proc/stat` | 25% | 40% | **25** |
| **Node.js GC pause frequency >100ms** | `perf_hooks.PerformanceObserver` for `gc` | >5/min | >20/min | **15** |
| Concurrent explorer connections | app counter | 3 | 4+ for >5min | 10 |
| 5xx rate last 5 min | app counter | >2% | >10% | 10 |
| (v0.4) monthly bandwidth burn | | 70% | 90% | 15 |
| (v0.4) CPU package temp | WMI/SMC/sysfs | 75°C | 85°C | 10 |

**Highest weight is fan-noise-proxy (sustained CPU >25%).** The fan is the single highest-probability uninstall trigger — a previously silent laptop that fans up because of MyKAI is uninstalled within a week. Ultrabook fans concentrate noise in the 2-8 kHz band where human hearing is most sensitive.

**GC pause frequency** is the cheap canary for Node-process-near-saturation. Free to instrument via `perf_hooks`, canonical signature.

---

## 7. Technical mitigations (mandatory for v0.5.1)

These ship before the opt-in toggle is even enabled. Without them, even opted-in mode breaks the renderer.

**Tier-1 (ship before opt-in is unlocked):**

1. **Hard rate-limit `/shard/blocks` and `/shard/block-range` to ≤2 in-flight per connection, ≤4 globally.** One line of code, biggest single win against renderer jank.

2. **`setImmediate()` yielding every 25-50 rows inside sql.js read loops.** Doubles wall-time of large requests but eliminates 100-200 ms event-loop monopoly. **The single largest renderer-jank mitigation available.**

3. **Stream the JSON response.** Write `[`, then per-block `JSON.stringify(block)` separated by `,`, then `]`. Each block becomes a young-generation allocation that gets scavenged before the next; large-object-space pressure drops from 5 MB transient peaks to ~10 KB peaks.

4. **zstd mandatory** with `Accept-Encoding: zstd, gzip` negotiation. Level 3, single-threaded compression at 400-600 MB/s on JSON. CPU cost <5% of one core at 5 MB/s pre-compression. **4-5× wire reduction** (100 GB/month → 25 GB/month).

   **Caveat:** stream-then-compress, not buffer-then-compress. Compress chunks as they emit from the streaming JSON writer. Future v0.6 should move compression to a worker thread.

5. **Hash-verify every block before responding** — kaspad-native block hashes included in response so the indexer can re-verify. The pool participant is untrusted from the indexer's perspective.

**Tier-2 (v0.5.2):**

6. **fast-json-stringify with RpcBlock schema.** 2-5× stringify speedup for shapes like RpcBlock. Consumable standalone without migrating to Fastify.

7. **Response caching by `(low_hash, limit, include_txs)` tuple.** 64-entry LRU. ~200 MB peak. Worthless for single indexer; high-leverage when ≥2 indexers pinned to same participant.

8. **HTTP/1.1 keep-alive default**. Already in Node 19+; confirm in MyKAI's bundled Electron Node.

**Anti-patterns (do NOT ship):**

- **gzip on the JSON path is actively harmful.** Block JSON has high entropy (hashes, signatures); compression ratio 1.3-1.6×. `zlib.gzip` on 5 MB strings is 30-80 ms on residential hardware, competing for the **exact same event-loop ticks already at the bottleneck.** Use zstd instead, or skip compression entirely on tight residential hosts.
- **Worker threads for sql.js (v0.5).** Significant refactor; sql.js + in-memory DB + wRPC integration on main thread make this expensive. Reserve for v0.6's better-sqlite3 move.
- **Fastify migration (v0.5).** The schema-serialization win is real but consumable via fast-json-stringify standalone. Defer.
- **DNS round-robin to `pool.mykai.network`.** Forbidden. Forces stateless indexer behavior, hot-spots single participants on resolver bias.

**v0.6 — the structurally correct shape:**

A separate **explorer-tier participant** running **better-sqlite3** (native, ~5× sql.js throughput, zero WASM marshalling) in a **child process supervised by the Electron main**. This dedicates the high-traffic regime to opted-in hardware and keeps the mainline MyKAI app on sql.js + invisible. The architectural shift is small because the archive-pool ingestion path is already separable from the agent-bridge HTTP path.

---

## 8. Bandwidth + ISP reality

**Two real walls** (not bandwidth caps):

1. **Asymmetric upload.** Modal US cable = 35 Mbps upload. A 5 MB/s backfill = 91% utilization for 14-35 hours → bufferbloat collapses Zoom, Netflix, gaming. Volunteer churns in a week.
2. **CGNAT prevalence.** T-Mobile Home, Starlink Residential, mobile-tethered are universally CGNAT. ~15-25% of would-be NA volunteers cannot accept inbound IPv4.

**ISP AUP risk:** Comcast explicitly prohibits residential servers. Enforcement is bandwidth-anomaly-driven, not protocol DPI. UK/EU/Canada residential ISPs are friendlier. Surface AUP disclosure for Comcast/Cox/Spectrum via reverse-DNS detection at opt-in time.

**zstd is non-negotiable.** 4-5× wire reduction on JSON. CPU cost <5% of one core. There is no version of amateur-safe defaults where this isn't on.

**NAT traversal stack** (priority order):
1. UPnP attempt with TTL refresh
2. IPv6-only serving if dual-stack
3. **libp2p Circuit Relay v2 via the MyKAI swarm** (preferred CGNAT escape; pure-P2P, no third-party trust)
4. ~~Cloudflare Tunnel~~ — ToS section 2.8 prohibits CDN-as-primary-delivery, ambiguous for indexer JSON
5. ~~ngrok~~ — 1 GB/month free-tier cap, useless
6. ~~Tailscale Funnel~~ — undocumented bandwidth limits

---

## 9. Thermal + battery reality

**The fan is the uninstall trigger.** Not heat, not battery wear — the *audible spin-up* on previously-silent laptops. Threshold for "uninstall within a week" is ~35-40 dBA, which most $700 ultrabooks hit at 25-35% sustained CPU.

**Architecture gap:**
- **Apple Silicon (M1/M2/M3 Air, M-series Pro):** workload is a non-event. Air will throttle 22-32% during 30 min bursts but stay silent. Fanned models inaudible.
- **x86 ultrabooks (Ryzen 5500U, i5-1135G7):** real problem. Backfill workload hits 75-85°C package temp, 70-90% fan duty. Some i5-1135G7 firmware sets PROCHOT at 70°C → throttles 60% of sustained time.

**Battery wear:** sustained 38-45°C cell temp = 3-6× calendar aging vs 25°C baseline. ~10-18% capacity loss in year one of MyKAI explorer duty vs ~3% idle baseline. Surface "enable manufacturer charge-limit (Dell Power Manager / Lenovo Vantage / macOS Optimized Charging)" reminder at opt-in.

**Wake-on-LAN is dead** on modern laptops. Modern Standby (S0ix) keeps NIC powered-down. HTTP SYN cannot wake the device. Explorer mode requires `powerSaveBlocker.start('prevent-display-sleep')` while on AC — must respect AC state or it breaks battery-pause.

**Behavior matrix:**

| Power state | Block capture | Steady-state serve | Backfill serve |
|---|---|---|---|
| AC, cool | Active | Active | Active |
| AC, thermal warn (≥80°C) | Active | Active (cap 10%) | **Pause** |
| AC, thermal hot (≥90°C) | **Pause** | **Pause** | **Pause** |
| Battery | **Pause** | Active (cap 5%) | **Pause** |
| Battery <30% | **Pause** | **Pause** | **Pause** |

Failure mode of pausing serve is benign: indexer gets 503, retries another pinned participant. **That's the whole point of having multiple pinned participants.**

---

## 10. Fan-out and rate limiting

**The indexer pins, doesn't fan out.** Each indexer process pins to **K=3-5 participants** for its lifetime via weighted-random sampling at startup. **No "fastest responder" routing, ever** — that's the gradient that creates the "one volunteer gets melted" failure.

**DNS round-robin to a single pool hostname is forbidden.** Forces stateless behavior; transient resolver bias hot-spots one participant.

**`503 + Retry-After` is sacred.** Mandatory quarantine for at least `Retry-After`. No early retry. Three strikes in 24h = eviction from indexer's pinned pool + foundation report.

**`X-MyKAI-Load: 0.7` advisory header** → indexer schedules rotation at next batch boundary (not instant cut). Prevents the "next-most-loaded participant melts" cascade.

**At 90% monthly egress cap, fall back to head-only mode** (Bitcoin Core pattern) — serve recent blocks, 503 historical. Don't return 503 on everything.

**Probe at 0.1% rate** for liveness; three-strike eviction with foundation report.

**Discovery is a curated bootstrap list maintained by MyKAI Foundation.** Signed JSON, GitHub + IPFS mirrors, on-chain hash anchor. Not DNS, not DHT. Same shape as Tor directory authorities + Bitcoin Core seed-node list. Off-chain admit/remove governance (matches Stag Hunt frozen-per-hunt pattern).

---

## 11. UX — the operator surface

**Where the toggle lives:** sub-toggle on the Pool page, behind a one-tap "Help indexers?" disclosure. Not its own page, not buried in advanced. Storage-and-serving is one conceptual donation, not two products.

**Copy that threads the needle:**

> **Help indexers reach Kaspa? (optional)**
>
> Your archival storage already serves snapshots. You can also let explorer apps query your node directly — same idea, just answering live questions instead of handing over snapshots.
>
> This uses your internet connection. Choose the level that fits:
>
> ☐ **Off** — recommended if your internet is metered or slow
> ☐ **Light** — up to ~50 GB/month, fine for most home internet
> ☐ **Heavy** — up to ~500 GB/month, for fast unmetered connections
>
> You can change this anytime. We'll show you how much you're actually using.

**Operator telemetry panel** (appears below toggle when enabled):

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

Design rules:
- Use **Mbps not MB/s** — Mbps is what their ISP plan is in
- Bar fills relative to **tier ceiling**, not user's data cap (we don't know their plan)
- "Auto-adjustments: none" is the trust-builder. After thermal event: "Auto-adjustments: 1 (thermal, 3d ago) →" opens log
- **No currency framing.** No "estimated cost in $". Currency implies we know their plan and turns donation into transaction
- **Pause is a button, not a slider.** 24h hard stop, no confirm dialog. Operator's instinct to stop must be honored immediately

**The "I want OUT" flow:**
1. T+0: stop accepting new connections, mark `explorer.enabled: false`, re-advertise to discovery within 5s
2. T+0 to T+60s: existing connections receive `serving_ending` notice on next response
3. T+60s: hard-close remaining connections

60-second drain is short enough that a panicking operator doesn't feel trapped, long enough that indexers don't see every Pause as hard failure.

---

## 12. Validation plan (regression-test ladder)

v0.4 was validated by parallel research against postmortem/operator data. v0.5 needs that plus synthetic load + real-indexer endurance because no field data exists for "Electron-app-with-HTTP-endpoint on residential laptop."

**Tier 1 — Synthetic load harness (1 week).** `mykai-explorer-hammer.js` simulating 1-8 concurrent indexer clients hitting all 4 endpoints with realistic mix (70% `/shard/dag-info`, 20% `/shard/blocks` recent-range, 8% `/shard/virtual-chain`, 2% `/shard/block-range` deep). Target: Tiger Lake i5, 16 GB, NVMe. Pass: composite at-risk <70 for >95% of window; no audible fan; no thermal throttle; no Defender flags.

**Tier 2 — Real indexer pull (3 days).** Actual `simply-kaspa-indexer` backfilling 30 days of history from cold against MyKAI. Pass: backfill completes in 48h; fan stays <3500 RPM on test laptop; battery test variant correctly returns 503s and indexer recovers when laptop returns to AC.

**Tier 3 — Endurance run (30 days).** Three volunteer laptops (Windows Tiger Lake i5, M2 MacBook Air, Linux ThinkPad), real internet, real households, v0.5 defaults. Daily telemetry pull. Pass: zero "fan during call" complaints; monthly egress <50 GB; zero Defender quarantines; zero manual-pause-during-explorer-load events.

**Tier 4 — Adversarial single-IP (1 day).** Local attacker tries to DoS the explorer listener. Pass: per-IP rate limit fires; concurrent-connection cap fires; at-risk auto-tier-down halves capacity, then pauses listener; nothing else on the laptop degrades.

---

## 13. The honest "still invisible?" verdict

By load class:

- **Idle / typical polling** (small `/shard/dag-info`, a few `/shard/blocks` recent-range/min): **still invisible**. ✓
- **Single indexer backfill**: **lightly visible.** Multi-thousand-block range serialization spikes a core for several seconds. On 2020-era ultrabooks (XPS 13, MacBook Air M1) this is audible in a quiet meeting if you're listening. Mitigations bring it to "user almost never hears it, and when they do it's brief and apologetic."
- **Multi-indexer concurrent backfill**: **visible.** Can only promise containment, not invisibility. 2-concurrent cap (Light) and at-risk auto-tier-down keep this rare. Honest answer.

**One-time onboarding sheet on first explorer-enable:**

> You're hosting Kaspa history for other apps. Almost all the time you won't notice. Once in a while, when one of those apps catches up on history, your fan may spin briefly. MyKAI will pause itself if your laptop gets hot, if you're on battery, if you're in a video call, or during quiet hours (8-11 PM). You can pause explorer hosting anytime from the dashboard. You can keep contributing to the Archive Pool with explorer hosting off.

**The Apple-style rule still holds:** Users NEVER pick which indexers to serve, which endpoints to enable, which time windows to allow. Defaults handle it. We tell them honestly something exists they may occasionally perceive, because pretending otherwise is how Folding@home lost a generation when fans came on during Zoom.

---

## 14. Shipping sequence

**v0.5.1 (next release):**
- Pool API: 4 new `/shard/*` endpoints in `agent-bridge.js` (~150 LOC)
- Technical mitigations: rate limits, `setImmediate` yielding, streaming JSON, zstd
- Toggle exists but **default off**
- Listener binds to `127.0.0.1` only — public-internet binding requires explicit second opt-in + NAT check
- No tier selection (single mode for early-adopter testing)

**v0.5.2:**
- Three-tier system (Storage-only / Light / Heavy)
- Capability advertisement schema
- Curated bootstrap list (foundation discovery service)
- Operator telemetry panel
- 7-day soft commitment
- Quiet hours scheduling

**v0.6:**
- Move shard storage to **better-sqlite3** (native, ~5× sql.js)
- Move explorer HTTP server to **child process** supervised by Electron main
- This unlocks Heavy-tier without breaking renderer invariant on sql.js
- libp2p Circuit Relay v2 for CGNAT participants

**Do not skip v0.5.1.** A 30-day measurement window where only deliberate opt-ins serve is what calibrates the auto-tuner before broader recruitment.

---

## 15. The principle

Every recommendation traces back to:

> **Indexers can scale up by adding more nodes. Volunteers can only scale down by uninstalling.**

When in doubt, optimize for the volunteer who's about to wonder why their internet is slow.

---

## References

- `docs/explorer-ready-pool.md` — companion spec, the architecture this defaults sheet protects
- `memory/reference_mykai_amateur_defaults.md` — v0.4 baseline
- `memory/project_mykai_archival_pivot.md` — architecture + Apple-UX hard rules
- Bitcoin Core `maxuploadtarget` (5 GB/day residential floor)
- Tor `BandwidthRate` minimum (75 KB/s, ~6 GB/day)
- BitTorrent BEP-3 (4+1 unchoke slots)
- IPFS gateway nginx defaults (1 req/s/IP)
- Filecoin Saturn L1 orchestrator pattern (no DNS round-robin)
