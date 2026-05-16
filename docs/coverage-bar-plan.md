# Network Coverage Bar — Plan

**Companion to:** `explorer-backend-plan.md` and `explorer-backend-build.md`
**Goal:** a dynamic, multi-colored bar that shows every MyKAI participant's slice of the Kaspa archival history, with the user's own slice highlighted, so they can see exactly where they fit in the bigger picture.

---

## The picture in words

```
oldest stored                                                       chain tip
   |                                                                    |
   |▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░|  Node-A1f3
   |    ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░|  Node-7e22 (purple)
   |         ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░|  ← YOU (highlighted)
   |              ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓|  Node-b14c (cyan)
   |                              ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓|  Node-9aaf (amber)
   |                                          ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓|  Node-3d80 (rose)
   └────────────────────────────────────────────────────────────────────┘
        45 days ago        30 days ago        15 days ago        now
```

- Each stripe = one participant's DAA range (oldest → newest stored block)
- Color = deterministic hash of their `nodeId` (stable across sessions)
- The user's own stripe is **highlighted** (white border + "← YOU" label)
- The bar grows in width as the swarm collectively covers more history
- Stripes appear/disappear as participants come and go

---

## Why this needs three pieces to land

Today every MyKAI node is an island. It knows its own coverage from `shardStorage.getStats()` (`oldestDaa`, `newestDaa`), but nobody collects those numbers from everyone. The bar requires:

1. **A way for nodes to publish their coverage** (where do they post it?)
2. **A way for nodes to fetch the aggregated picture** (how do they read it back?)
3. **A renderer that draws the bar** (the SVG/canvas component)

(3) is the easy part. (1) and (2) are the same question — the **discovery service**. We've deferred that to v0.5.2 in the main plan. The coverage bar is the most user-facing reason to bring it forward.

---

## Five phases

### Phase 1 — Local "your slice" bar (1 day, works now)

Ship the bar as a **single-stripe widget showing the user's own coverage** against the local kaspad's chain tip. No discovery service yet — just `shardStorage.getStats()` + `monitor.rpcCall('getBlockDagInfo')`.

What the user sees on day 1:

```
your local kaspad's chain tip
                                                                       |
   ┌─────────────────────────────────────────────────────────▓▓▓▓▓▓▓▓▓│
   │                                                                  │  ← YOU
   └──────────────────────────────────────────────────────────────────┘
        not yet covered                          your slice (3.4 days)

  Aggregate network coverage will appear here as discovery rolls out.
```

This is **honest**: no fake data, no "72% of network covered" lies. The user sees their own contribution today, and the framing prepares them for more stripes appearing later.

### Phase 2 — Minimal discovery service (2 days)

Stand up the smallest possible aggregator. Three components:

**a. Foundation-hosted endpoint:** `https://discovery.mykai.io/v1/coverage`
- POST: `{ nodeId, oldest_daa, newest_daa, kaspad_chain_tip, opted_in_publish: true, timestamp }`
- GET: returns aggregated JSON of all participants seen in the last 24h

**b. Static fallback:** the same JSON is mirrored to `github.com/mykai-archival/coverage-snapshot` every 5 min (GitHub Actions). If the live endpoint is down, renderers fall back to the static mirror. **Indexer is never essential, foundation infra is never load-bearing** (per feedback memory).

**c. No publishing toggle.** Locked design rule: *no users can contribute without showing up in the bar.* If you're in the pool (`shardSizeGB > 0`), MyKAI publishes your coverage to the discovery service every 15 min, automatically. There is no separate opt-in. Storage and publication are the same act.

**d. Reachability gate at opt-in.** Locked design rule: *only people who can totally function for explorers partake as archival node participants.* Before MyKAI lets a user save a non-zero `shardSizeGB`, it probes whether the node can accept inbound HTTP from the public internet (foundation-side echo check). If the probe fails, the slider is disabled with an explanation: "Your network can't accept incoming connections. T-Mobile Home, Starlink residential, mobile-tethered, and some hotel/dorm setups have this problem. v0.6 will add a relay path." This excludes ~15-25% of would-be NA volunteers from v0.5.2 — by design.

### Phase 3 — Coverage fetch + cache (½ day)

Renderer pulls aggregated JSON from `discovery.mykai.io/v1/coverage` (or GitHub mirror on failure) every 60s when the Pool panel is open. Local cache so the bar doesn't go blank between fetches. Parsed shape:

```json
{
  "as_of": 1731579200,
  "kaspad_chain_tip_daa": 98765432,
  "participants": [
    { "node_id": "node_a1f3...", "oldest_daa": 95000000, "newest_daa": 98765400, "last_seen": 1731579100 },
    { "node_id": "node_7e22...", "oldest_daa": 96000000, "newest_daa": 98765420, "last_seen": 1731579080 },
    ...
  ]
}
```

`last_seen` filtering: drop entries older than 1 hour. A participant who was online 3 days ago doesn't get a stripe — they're stale.

### Phase 4 — The renderer (1½ days)

SVG-based bar component. ~150 LOC of vanilla JS.

**Color assignment.** Deterministic from `nodeId`:
```js
function nodeColor(nodeId) {
  // Hash the nodeId to a hue 0-360, fixed saturation + lightness
  // so all colors are vivid but distinguishable from each other and
  // from MyKAI's monochrome chrome.
  const hash = simpleHash(nodeId);
  const hue = hash % 360;
  return `hsl(${hue}, 70%, 55%)`;
}
```

Stable across sessions — your nodeId always maps to the same hue, so users mentally associate "I'm the teal one."

**Layout strategy.**
- Up to **20 participants:** stacked rows, ordered by `oldest_daa` ascending (deepest history at top)
- **20-100:** stacked rows + scroll, user's stripe pinned to top
- **100+:** density-overlay mode — single row, semi-transparent stripes blend. Heat-map effect: darker = more participants cover that range

User's stripe always:
- 2 px white border
- "← YOU" label aligned to the stripe's right edge
- Slight color brightness boost
- Pinned visible regardless of scroll

**X-axis labels.** Convert DAA to human time:
- `chain_tip` → "now"
- `chain_tip - 86400` (one day of blocks at 10 BPS) → "1 day ago"
- `chain_tip - 86400 * 7` → "1 week ago"
- Floor of leftmost participant → "(oldest stored: X days ago)"

Don't show raw DAA numbers. Users don't think in DAA scores.

**Hover/tap detail.** On hover (desktop) or tap (mobile), tooltip:
```
Node 7e22 · 3.1 days of history · joined 2h ago
```
Never include IP, never include accountKey. nodeId prefix is enough to disambiguate visually without doxxing.

### Phase 5 — Refresh, empty states, edge cases (½ day)

**Refresh cadence:**
- Bar opens → fetch immediately
- While Pool panel visible → refetch every 60s
- Pool panel closed → stop fetching (save bandwidth)

**Empty states:**
- Discovery service unreachable + no cached data: show "Couldn't reach the coverage feed. Showing your local slice only." with the Phase 1 single-stripe bar
- No participants beyond you yet: "You're contributing X days. The network coverage bar will fill in as more people join."
- You haven't opted in to publish: "Publishing off. You're still helping the pool — your stripe just isn't shown on the network bar." with a quick toggle

**Edge cases:**
- A participant publishes `oldest_daa > newest_daa` (broken): drop the entry
- Participant claims more history than `kaspad_chain_tip_daa`: clamp to tip
- Same `nodeId` posts twice in 15 min: take latest, ignore earlier
- Aggregator returns participants with stale `last_seen` (>1h): drop

---

## What ships when

| Phase | Cost | Ships in | Visible value |
|---|---|---|---|
| 1. Local slice bar | 1 day | **v0.5.1** | User sees their contribution today |
| 2. Discovery service | 2 days | v0.5.1.5 (concurrent with indexer fork) | Foundation infra, no user-visible change yet |
| 3. Fetch + cache | ½ day | v0.5.1.5 | Renderer can pull aggregate (still shows local-only if no others online) |
| 4. Multi-stripe renderer | 1½ days | v0.5.2 | The full picture lands |
| 5. Polish + edges | ½ day | v0.5.2 | Empty states, tooltips, opt-in toggle |

**Total: ~5.5 days** spread across the next two releases. Phase 1 is the only thing the user *needs* to see immediately to validate the concept; the rest is honest infrastructure.

---

## The locked design rules

Three rules, all from the design owner. Every other decision in this doc cascades from them.

1. **Pool participation is bundled.** One decision: are you in the pool or not? (`shardSizeGB > 0`). If yes, you store blocks AND serve explorer queries AND appear on the coverage bar. No sub-toggles, no "advanced" opt-ins, no temporary Pause. Want out? Set `shardSizeGB` to 0.

2. **No invisible contributors.** Every pool participant shows up on the bar. Storage and publication are the same act. There is no way to contribute storage without your nodeId appearing.

3. **Only reachable nodes can join.** If your network can't accept inbound connections (CGNAT, T-Mobile Home, Starlink residential, mobile-tethered, some dorm/hotel setups), you can't be in the pool. v0.5.2 includes a reachability probe at opt-in time that hard-disables the slider for non-reachable nodes. v0.6's libp2p Circuit Relay v2 will unlock those users later.

4. **The bar is not a leaderboard.** No ranking, no "top contributors," no scores. Just a visualization of where each participant's slice sits. The framing is "where do I fit?" not "am I winning?" The moment the bar implies competition, you get gamification pressure — people running multiple nodes to look bigger, or feeling bad when their stripe shrinks. Visualization, not scoreboard.

**On privacy.** `nodeId` is a pseudonymous random hex (`node_<random>`). It doesn't reveal IP, location, or any other identifier. Publishing the (nodeId, DAA range) tuple is privacy-safe by the same standard kaspad's own peer list is. Users who don't want their pseudonym on a chart have one option: don't join the pool. The bundling is non-negotiable.

---

## What this does NOT solve

- **Participant discovery for indexers.** The coverage bar is purely a UI surface. The indexer-routing discovery list is a separate JSON (different fields, different concerns, different mirror cadence). They share the underlying "MyKAI Foundation hosts a phone book" infrastructure, but the bar's data is human-facing and the indexer list is machine-facing.

- **Lying about coverage.** A participant could post a fake range to look generous. Detection: when an indexer (or another node) asks them for a block they claim to have and gets a 404, that's a tell. Logged but not enforced — the bar is honest signaling, not a contract. Indexers verify their own data via hash check; the bar is just a picture.

- **Counting anonymous contributors.** Participants who haven't opted in to publish are invisible. The bar says "Visible: 47 contributors" honestly rather than estimating a hidden total.

---

## The principle

The bar exists to make **invisible work visible** — the volunteer running MyKAI at 3 AM should be able to see their stripe on a picture of the network and feel "I'm part of this." It's the antidote to the "is my donation even doing anything?" fatigue that kills Folding@home-style projects.

But the bar should never lie. A picture that shows fake coverage to make the network look busier than it is would betray exactly the volunteer trust we're trying to build. **Honest, dynamic, multi-colored, opt-in. No fiction.**
