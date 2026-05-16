# MyKAI Archival

**A way for ordinary Kaspa users to collectively preserve the full history of the chain — without any of them having to trust each other.**

MyKAI Archival is a fork of [MyKAI Node v0.3.8](https://github.com/KasMapApp/MyKAI-Node-Public) (MIT, with author permission) that turns your normal pruned Kaspa node into an optional archival contributor. You pick a number of gigabytes you're willing to share. The app fills that slice with real, verified historical block data. Thousands of small contributors together stand up the equivalent of dozens of full archival nodes — with no coordinator, no token, no foundation in the critical path.

> **10,000 people × 40 GB ≈ 100 virtual archive nodes.**
> No single one of them has to be trusted. No single one of them can corrupt the archive.

**Status:** v0.5 pre-release, running locally, ready for early testers. Not yet on mainnet pool deployment.

---

## Why this exists

Kaspa's tip moves fast. Pruned nodes are the default, which is good for the network — but it means historical block data depends on a small number of dedicated archival operators. If they go away, history goes with them. MyKAI Archival is the **resilience layer**: spreading slices of history across many small participants so that the durability floor isn't a handful of servers, it's the community itself.

This is the opposite of "trust us, the data is right." Every byte that lands in a participant's slice is **cryptographically verified against the user's own PoW-validated kaspad** before it's stored, and **randomly re-audited** for as long as the user is online.

---

## The trust model (the whole point of this project)

The project lives or dies on one rule:

> **No participant ever has to trust any other participant — including the people they pull historical blocks from.**

Here's how that holds together, end to end:

### 1. Verification on ingest — every block, no exceptions

When a block arrives from any source (live capture, another participant, a friend's archival node, an HTTP seed), the fill loop runs it through this gauntlet **before it's written to disk**:

| Check | What it proves | Code |
|---|---|---|
| **Canonical re-serialization + BLAKE2b-256** (keyed `"BlockHash"`) | The header bytes the source sent actually hash to the block ID they're claiming. No swapping payloads. | `src/dist/main/kaspa-block-hash.js` (validated 5/5 against live mainnet blocks) |
| **Direct match against local kaspad** | If your local kaspad recognizes the hash, you're done — you've matched against a header your own PoW-validated node accepts. | `src/dist/main/shard-pull.js → verifyBlockHashAgainstKaspad` |
| **Parent-chain walking** | For deep-history blocks your local kaspad has pruned: walk the block's `parentsByLevel` recursively until you hit a hash kaspad *does* recognize. If you reach a canonical ancestor in ≤100k hops, the block is anchored to PoW. If you don't, it's rejected. | `src/dist/main/parent-chain-walker.js` |
| **DAA monotonicity + range contiguity** | The bucket the source is feeding you is contiguous and ordered. Cuts off pre-validation games. | `src/dist/main/shard-fill.js` |
| **`verboseData` stripping** | Peer-derived convenience fields are dropped before storage. Only consensus-critical, hashable bytes are kept. | `src/dist/main/main.js` |

If any check fails, the block is **dropped, not quarantined**, and the source takes a strike.

### 2. Maintenance over time — the audit loop

Verification on ingest is necessary but not sufficient. Disks corrupt. Participants get hacked. Bugs ship. So MyKAI runs a second pass continuously:

| Mechanism | What it does |
|---|---|
| **Random challenge audits** | Every ~36 seconds, the audit loop picks a random stored block, recomputes its hash from disk, and re-anchors it through the walker. Catches silent disk corruption, sneaky tampering, and walker regressions. |
| **Reputation-weighted sampling** | Sources that have failed audits before get challenged disproportionately often. Trusted sources get sampled less. Audit budget goes where suspicion is highest. |
| **Cross-peer corroboration** | A slice of audits (~20%) ask multiple sources for the same block and compare. Catches a source that's *internally consistent but lying* — they'd have to corrupt the same block across many peers, which content-addressing makes impossible. |
| **Range completeness audits** | ~5% of audits verify a participant claims contiguous coverage of a DAA range and can actually serve every block in it — no fake "I have 40 GB" gaps. |
| **Smart-ban** | 3 verification failures from the same source within 1 hour = 30-minute ban. Repeat offenders effectively get blacklisted. |
| **Churn-storm spike** | If many peers drop simultaneously, audit rate spikes to catch a coordinated bad-actor exit. |

### 3. Replication and assignment — no single point of failure

Buckets (100,000 DAA each) are assigned to participants via **weighted rendezvous hashing** (HRW) with a **replication factor of 4**: every bucket lives on at least 4 independent participants. Lose one, the bucket still has 3 copies. The assignment is deterministic and content-addressed — no registry server, no coordinator, no API to compromise.

```
bucket_id ─┐
           ├─ HRW(score = -budgetGB / ln(blake3(bucket_id || node_id)))
node_id ───┘                    │
                                ▼
                    top-4 participants store this bucket
```

If a participant's slice goes offline, the network re-scores and other participants quietly fill the gap — no governance event.

### 4. The full trust chain, one line

```
Kaspa PoW (your local kaspad)  →  walker anchors every untrusted block to PoW
                                   ↓
                          BLAKE2b-256 verifies bytes
                                   ↓
                  random audits re-verify forever
                                   ↓
                4× replication = no single point of loss
```

Everything you store is either:
- A block your local kaspad already accepted as canonical, **or**
- A block whose parent chain provably terminates in such a block.

Nothing else gets written. Nothing else stays written.

---

## Quick start

### Windows

```powershell
git clone https://github.com/CryptoOdie/mykai-archival.git
cd mykai-archival

# Fetch the pinned kaspad binary (SHA-256 verified)
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1

# Install JS deps (Node 20+ required, < 23)
cd src
npm install

# Launch
npm start
```

The app opens, your local kaspad starts in the background, and live capture starts filling the Archive bar at ~1 GB/hour. **For a much faster fill, link to an archival source — see below.**

### macOS / Linux

Setup script is currently Windows-only. PRs welcome. In the meantime, the manual steps:
1. Download `kaspad` v1.1.0 for your platform from [rusty-kaspa releases](https://github.com/kaspanet/rusty-kaspa/releases/tag/v1.1.0).
2. Verify its SHA-256 against the value pinned in `scripts/setup.ps1`.
3. Place it at `src/resources/kaspad` (no `.exe`).
4. `cd src && npm install && npm start`.

---

## Linking to an archival kaspad (recommended)

Without an archival source, your slice fills at the live-capture rate (~1 GB/hour). **With** an archival source, it fills as fast as your network — typically **40 GB in under an hour**.

**On the archival operator's side:**

```
kaspad --archival --rpc-listen=0.0.0.0:18110
```

Expose `18110` directly, via Tailscale, or via Cloudflare Tunnel.

**In MyKAI:** Settings → **Archive seed sources** → paste `wss://archival-host:18110` → **Test connection** → Save.

Within 60 seconds the fill loop starts pulling historical buckets in ~3 GB chunks. **Every block is hash-verified against your local kaspad's PoW chain before it's stored** — the archival source is a *speed* dependency, never a *trust* dependency. If it lies, the hash mismatches, the block is dropped, and the source takes a strike toward smart-ban.

---

## Reproducible build (for the security-critical)

Anyone should be able to verify the running build matches the published source. Run:

```bash
node scripts/verify-build.js
```

This checks five things:

1. **Pinned binary hashes** — `kaspad.exe` SHA-256 matches what's pinned in `setup.ps1`. Mismatch aborts with the actual hash so you can investigate.
2. **No native compilation** — confirms zero `.node` binary modules in `node_modules/`. Native compilation is the #1 source of non-reproducible builds; we avoid it entirely. `sql.js` (WASM), `@noble/hashes` (pure JS), no `node-gyp`.
3. **Exact dependency versions** — `package.json` uses no `^` or `~`; `package-lock.json` pins every transitive dep by SHA. The lockfile's `integrity:` fields are subresource-integrity hashes — npm verifies them on every install.
4. **Security-critical source files** — the trust-chain files (`kaspa-block-hash.js`, `parent-chain-walker.js`, `shard-fill.js`, `shard-audit.js`, `shard-pull.js`, `kaspad-wrpc-client.js`) exist and have their SHA-256 printed for cross-check against your git checkout.
5. **Node runtime version** — flags if you're running outside Node 20-22.

Expected output on a clean install:

```
MyKAI reproducibility check
============================

Pinned external binaries:
  ✓ src/resources/kaspad.exe = 02d40a0f6c8e19b9...

Native module audit:
  ✓ no .node binaries found — pure JS + WASM only, fully reproducible

Lockfile integrity:
  ✓ package-lock.json present (NNN packages pinned by SHA)
  ✓ all lockfile versions exact (no ranges)

Security-critical source files:
  ✓ src/dist/main/kaspa-block-hash.js sha256=...
  ✓ src/dist/main/parent-chain-walker.js sha256=...
  ✓ src/dist/main/shard-pull.js sha256=...
  ✓ src/dist/main/shard-fill.js sha256=...
  ✓ src/dist/main/shard-audit.js sha256=...
  ✓ src/dist/main/kaspad-wrpc-client.js sha256=...

Runtime environment:
  ✓ Node.js 20.x.x (within supported range)

============================
Result: 11 pass · 0 fail · 0 warnings
Build verified.
```

### The full verification chain

```
git clone @ commit X
  ↓ verify: git rev-parse HEAD == X
scripts/setup.ps1
  ↓ verify: kaspad.exe SHA-256 == 02d40a0f...
npm install
  ↓ verify: every package matches package-lock.json integrity hash
  ↓ verify: no compiled .node binaries
npm start
  ↓ the running JS is byte-for-byte the source you cloned
```

Every byte the app loads traces back to either: the git commit you checked out, a pinned SHA-256 in source (kaspad), or a pinned integrity hash in `package-lock.json` (npm packages + Electron binary).

**What's not bit-for-bit reproducible:** filesystem timestamps in `node_modules/` vary per install (content is identical; metadata isn't). If this project ever ships pre-built installers — currently it doesn't — Bitcoin-Core-grade binary reproducibility would require deterministic packaging. Out of scope for v0.5; we ship source.

For an Electron app distributed as source, this is the highest practical level of reproducibility.

---

## What this is

1. **One-click archival mode** for Kaspa, with the safety rails the upstream `--archival` flag is missing.
2. **MCP server** so every install becomes a sovereign AI backend — your agent queries Kaspa through your own node, no third-party API. (`src/dist/main/agent-bridge.js`)
3. **Distributed shard pool** — pick any amount of disk, anywhere; recency-first, gap-driven auto-pilot; no coordinator, no money, no multisig.

## What this is not

- **Not a replacement** for kaspa.org/explorer, kaspadbase.com, Kasplex, or any existing Kaspa archival operator. We're the resilience layer that makes the whole system stronger; they're the durability floor that always exists.
- **Not a token.** No payment, no stake, no slashing.
- **Not a multisig federation.** Challenges + content-addressing handle all integrity; no quorum is ever asked to vouch for data.
- **Not load-bearing** for any other Kaspa-stack project. If MyKAI Archival goes to zero, Kaspa is fine.

---

## Locked architectural rules

These are non-negotiable design constraints, not just preferences. Full design in [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md).

1. **No money, no token, no payment** — participation is gratis or it isn't sovereignty.
2. **No multisig, no federation, no authority** — no group of N can override consensus.
3. **No central coordinator, no registry server** — content-addressing is the only directory.
4. **Content-addressing handles correctness** — if the hash matches, the data is right; if it doesn't, it's wrong.
5. **Challenges handle governance** — random audits replace social trust.
6. **Pruned nodes are the verifiers** — every participant's own kaspad is the anchor, no oracle.
7. **Free pinning, no radius** — anyone pins any amount of any range; no quota, no jurisdiction.
8. **Supplement, don't replace** — existing archival operators are the durability floor; we add resilience on top.
9. **Maximum stacked redundancy** — RF≥4 by default, can climb arbitrarily.
10. **Forks are a feature** — if someone disagrees with the design, they fork the swarm and both swarms can coexist.
11. **Recency-first, climbing back into history** — fill the tip first, then walk backwards; never block tip availability on deep-history work.
12. **Active automated gap-filling, not passive heatmaps** — when coverage thins, participants automatically claim the thin bands.
13. **Layered archive nodes** — once one virtual archive node is full, start the next one with the same pattern; horizontal scale without coordination.

---

## Roadmap

- **v0.5** (current) — single-machine archival contribution + verification + audit. Works against a friend's archival kaspad.
- **v0.5.4** — body merkle root verification (currently just header anchoring). ~300 LOC.
- **v0.6** — peer discovery and bucket assignment go live on mainnet. The "100 virtual archive nodes" framing becomes real.
- **v0.7** — explorer-backend mode: the pool can serve `simply-kaspa-indexer` queries via `/shard/*` endpoints, so the archival data becomes useful to explorer apps, not just durable.

See [`docs/`](docs/) for full design notes per topic.

---

## License

MIT. See [`LICENSE`](LICENSE).

## Acknowledgments

Forked with permission from [MyKAI Node](https://github.com/KasMapApp/MyKAI-Node-Public). The MCP scaffolding (`agent-bridge.js`) is upstream; everything in the archival, shard, verification, and audit subsystems is new in this fork.
