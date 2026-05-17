# MyKAI Archival

### Kaspa's history, preserved by everyone, trusted from no one.

A normal Kaspa node, with a quiet superpower: pick a number of gigabytes you're willing to share, and your node becomes part of a swarm preserving the full history of the chain. No coordinator. No token. No federation. Just math and a lot of small disks.

```
   10,000 people × 40 GB        =        100 virtual archive nodes
   ─────────────────────────────────────────────────────────────
        none of them            ─→         all of history stays
        have to be trusted                 cryptographically alive
```

**Status:** v0.5.4 pre-release · trust model fully closed (header + body) · ready for early testers.

---

## The 30-second version

You run MyKAI. It runs a normal pruned Kaspa node *plus* a small archival contributor on the side. Every block that lands in your slice goes through this gauntlet before it's stored:

```
   block arrives  ─→  body merkle root  ─→  header hash  ─→  PoW anchor
                          ✗ ban 24h        ✗ ban 24h        ✗ reject
                                  │
                          ✓ all three pass
                                  ▼
                            stored on disk
                                  │
                          ~36s later, audit re-verifies
                                  │
                         random challenge again, forever
```

If a peer sends bad data once, they're gone for 24 hours. If they keep sending bad data, they're effectively gone. Honest peers don't even notice. **The data is right because the math says so, not because anyone is voting.**

---

## Why this exists

Kaspa moves fast. Pruned nodes are the default — good for the network, but it means *historical* block data lives on a handful of dedicated archival operators. If they go away, history goes with them.

MyKAI Archival is the resilience layer underneath. Spread slices of history across thousands of small participants, replicate everything 4×, audit it forever, and the durability floor stops being "a few servers" and starts being "the community itself."

It's the opposite of "trust us, the data is right." Every byte is **cryptographically verified against your own PoW-validated kaspad** before it's stored, and **randomly re-audited** for as long as the program is running.

---

## How it stays honest

The whole project rests on one rule:

> **No participant ever has to trust any other participant — including the people they pull historical blocks from.**

Here's how that holds together.

### Verification on the way in

Every block you receive goes through this — no exceptions, no shortcuts:

| Check | Proves | Code |
|---|---|---|
| **Body merkle root** (keyed `"TransactionHash"` + `"MerkleBranchHash"`) | The transaction list inside the block actually hashes to the `hashMerkleRoot` committed in the header. **No swapping txs, editing amounts, or inserting outputs.** Validated against rusty-kaspa's 8 canonical test vectors AND against 5 live mainnet blocks (12-56 txs each) — bit-perfect. | `kaspa-tx-hash.js` + `kaspa-merkle.js` |
| **Canonical header re-serialization + BLAKE2b-256** (keyed `"BlockHash"`) | The header bytes the source sent actually hash to the block ID they're claiming. Validated 5/5 against live mainnet blocks. | `kaspa-block-hash.js` |
| **Direct match against local kaspad** | If your local PoW-validated kaspad already recognizes this hash, you're done. | `shard-pull.js → verifyBlockHashAgainstKaspad` |
| **Parent-chain walking** | For deep-history blocks kaspad has pruned: walk parents recursively until you hit a hash kaspad *does* recognize. Anchor or reject. ≤100k hops, cycle-detected, LRU-cached. | `parent-chain-walker.js` |
| **DAA monotonicity + range contiguity** | The bucket the source is feeding you is contiguous and ordered. No re-ordering games. | `shard-fill.js` |
| **`verboseData` stripping** | Peer-derived convenience fields are dropped before storage. Only consensus-critical, hashable bytes stay. | `main.js` |

Any check fails → block is **dropped, not quarantined** → the source takes a strike.

### What "strike" means (new in v0.5.4: tiered)

We treat tampering and network flakes very differently:

```
  HARD STRIKE          1 strike   →    24-hour ban    (cryptographic violation)
  ─────────────────────────────────────────────────────────────────────────
  hash mismatch                       there is no honest reason
  body merkle mismatch                for the bytes to not hash to
  all-blocks-rejected                 what the source claims.
                                      we don't extend second chances.


  SOFT STRIKE          3 in 1h  →    30-minute ban    (probably just life)
  ─────────────────────────────────────────────────────────────────────────
  TCP timeout                         residential ISPs blip. cell
  connection refused                  networks drop. servers restart.
  malformed response                  honest peers should not get
                                      blacklisted for that.
```

### Maintenance over time — the audit loop

Verification on ingest is necessary but not sufficient. Disks corrupt, participants get hacked, bugs ship. So MyKAI runs a second pass continuously:

| Mechanism | What it does |
|---|---|
| **Random challenge audits** | Every ~36s, pick a random stored block, recompute its hash from disk, re-anchor through the walker. Catches silent disk corruption, sneaky tampering, walker regressions. |
| **Reputation-weighted sampling** | Sources that failed audits before get challenged more often. Trusted sources get sampled less. Audit budget goes where suspicion is highest. |
| **Cross-peer corroboration** | ~20% of audits ask multiple sources for the same block and compare. Catches a source that's *internally consistent but lying* — they'd have to corrupt the same block across many peers, which content-addressing makes mathematically impossible. |
| **Range completeness audits** | ~5% of audits verify a participant claims contiguous coverage *and* can actually serve every block in the range. No faking "I have 40 GB" with gaps. |
| **Churn-storm spike** | If many peers drop simultaneously, audit rate spikes to catch a coordinated bad-actor exit. |

### Replication — no single point of loss

Buckets (100,000 DAA each) are assigned to participants via **weighted rendezvous hashing** with a **replication factor of 4**. Every bucket lives on at least 4 independent participants.

```
   bucket_id ─┐
              ├─ HRW(score = -budgetGB / ln(blake3(bucket_id || node_id)))
   node_id  ──┘                       │
                                      ▼
                          top-4 participants store this bucket
```

The assignment is deterministic and content-addressed. **No registry server, no coordinator, no API to compromise.** If a participant goes offline, the network re-scores and other participants quietly fill the gap. No governance event, no vote, no email thread.

### The whole trust chain, one line

```
   Kaspa PoW (your local kaspad)
            │
            └─→ walker anchors every untrusted block to PoW
                       │
                       └─→ BLAKE2b-256 verifies header bytes
                                  │
                                  └─→ MerkleBranch verifies tx body
                                             │
                                             └─→ stored
                                                    │
                                                    └─→ random audits, forever
                                                              │
                                                              └─→ 4× replicated
```

Everything you store is either a block your local kaspad already accepted as canonical, or a block whose parent chain provably terminates in one. **Nothing else gets written. Nothing else stays written.**

---

## What an attacker can actually try

I'll be specific because security claims that aren't specific are worthless.

| Attack | Defense | Secure? |
|---|---|---|
| Fork the code, strip the checks, serve garbage | Every *receiving* honest client re-verifies. Bad bytes → drop → 24h ban. | ✅ |
| Fake "I'm storing 40 GB" — claim coverage, store junk | Random range-completeness audits ask for specific blocks. Can't pass without actually having them. | ✅ |
| Sybil — run 1,000 modified clients | Each Sybil must serve verifiable data or get banned. RF=4 means even 3/4 Sybils per bucket can't kill it. Audits progressively eject them. | ✅ |
| Eclipse — surround a new participant with malicious peers | The participant's own local kaspad is the PoW anchor. Even 100% evil peers can't poison ingest. | ✅ |
| Tamper with the binary on disk | `verify-build.js` checks pinned SHA-256 on kaspad + integrity hashes on every npm dep. | ✅ |
| Compromise an upstream npm package | Lockfile pins every transitive dep by subresource-integrity hash. npm verifies on every install. | ✅ |
| Replay a real-but-old block as new | DAA score is in the header. Contiguity check rejects it. | ✅ |
| **Tamper with transaction body** (valid header, fake txs inside) | **v0.5.4** ships body merkle verification. Every tx hashed under canonical Kaspa rules; root must match `header.hashMerkleRoot`. | ✅ |

The architecture's strongest property: **the source of data is never load-bearing for the validity of data.** Every byte is independently anchored to PoW. A maximally malicious participant has exactly one useful move available to them: get banned.

---

## Quick start

### Windows

```powershell
git clone https://github.com/CryptoOdie/mykai-archival.git
cd mykai-archival

# Fetch the pinned kaspad binary (SHA-256 verified)
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1

# Install JS deps (Node 20-22)
cd src
npm install

# Run
npm start
```

The app opens, your local kaspad starts in the background, and the Archive bar begins filling at ~1 GB/hour from live capture. **For a much faster fill, link to an archival source — see below.**

### macOS / Linux

The setup script is Windows-only right now. PRs welcome. Manual steps:
1. Download `kaspad` v1.1.0 for your platform from [rusty-kaspa releases](https://github.com/kaspanet/rusty-kaspa/releases/tag/v1.1.0).
2. Verify SHA-256 against the value pinned in `scripts/setup.ps1`.
3. Drop it at `src/resources/kaspad` (no `.exe`).
4. `cd src && npm install && npm start`.

---

## Linking to an archival kaspad

Without an archival source, your slice fills at the live-capture rate (~1 GB/hour). With one, it fills as fast as your network:

```
   live capture only:  ~1 GB/hour       →  40 GB takes ~40 days
   linked to archival: ~15 MB/sec       →  40 GB takes ~45 minutes
                                            (then idles into live-capture)
```

**On the archival operator's side:**

```
kaspad --archival --rpc-listen=0.0.0.0:18110
```

Expose `18110` directly, via Tailscale, or via Cloudflare Tunnel.

**In MyKAI:** Settings → **Archive seed sources** → paste `wss://archival-host:18110` → **Test connection** → Save.

Within 60 seconds, the fill loop pulls historical buckets in ~3 GB chunks. **Every block is hash-verified against your local kaspad's PoW chain before storage** — the archival source is a *speed* dependency, never a *trust* dependency. If it lies, the block is dropped and the source earns a 24h ban.

---

## Reproducible build

Anyone should be able to verify the running build matches the published source. One command:

```bash
node scripts/verify-build.js
```

It checks:

1. **Pinned binary hashes** — `kaspad.exe` SHA-256 matches `setup.ps1`. Mismatch aborts with the actual hash so you can investigate.
2. **No native compilation** — zero `.node` binary modules. Native compilation is the #1 source of non-reproducible builds; we avoid it entirely. `sql.js` (WASM), `@noble/hashes` (pure JS), no `node-gyp`.
3. **Exact dependency versions** — no `^` or `~` in `package.json`; every transitive dep in `package-lock.json` pinned by SHA-256 integrity hash.
4. **Security-critical source files** — the trust-chain files (`kaspa-block-hash.js`, `kaspa-tx-hash.js`, `kaspa-merkle.js`, `parent-chain-walker.js`, `shard-fill.js`, `shard-audit.js`, `shard-pull.js`, `kaspad-wrpc-client.js`) exist with their SHA-256 printed for cross-check.
5. **Node runtime** — flags if you're outside 20-22.

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
  ✓ src/dist/main/kaspa-tx-hash.js sha256=...
  ✓ src/dist/main/kaspa-merkle.js sha256=...
  ✓ src/dist/main/parent-chain-walker.js sha256=...
  ✓ src/dist/main/shard-pull.js sha256=...
  ✓ src/dist/main/shard-fill.js sha256=...
  ✓ src/dist/main/shard-audit.js sha256=...
  ✓ src/dist/main/kaspad-wrpc-client.js sha256=...

Runtime environment:
  ✓ Node.js 20.x.x (within supported range)

Result: 13 pass · 0 fail · 0 warnings
Build verified.
```

You can also run the canonical hashing test vectors at any time:

```bash
node scripts/test-tx-hash.js
```

That validates `kaspa-tx-hash.js` + `kaspa-merkle.js` against **all 8 in-tree test vectors from rusty-kaspa's own CI**, byte-for-byte. If those pass, the hasher is mathematically equivalent to the reference implementation.

### The full chain, one line

```
   git clone @ commit X
         │
         └─→ verify: git rev-parse HEAD == X
                   │
                   └─→ scripts/setup.ps1
                              │
                              └─→ verify: kaspad.exe SHA-256 == 02d40a0f…
                                         │
                                         └─→ npm install
                                                    │
                                                    └─→ every dep matches lockfile integrity
                                                              │
                                                              └─→ zero compiled .node files
                                                                         │
                                                                         └─→ npm start
                                                                                    │
                                                                                    └─→ what you run = what you cloned
```

Every byte the app loads traces back to: the git commit you checked out, a pinned SHA-256 in source (kaspad), or a pinned integrity hash in `package-lock.json`. For an Electron app distributed as source, this is the highest practical level of reproducibility.

---

## What this is

1. **One-click archival mode** for Kaspa, with the safety rails the upstream `--archival` flag is missing.
2. **MCP server** so every install becomes a sovereign AI backend — your agent queries Kaspa through your own node, no third-party API. (`src/dist/main/agent-bridge.js`)
3. **Distributed shard pool** — pick any amount of disk, anywhere; recency-first, gap-driven auto-pilot; no coordinator, no money, no multisig.

## What this is not

- **Not a replacement** for kaspa.org/explorer, kaspadbase.com, Kasplex, or any existing Kaspa archival operator. We're the resilience layer that makes the system stronger; they're the durability floor.
- **Not a token.** No payment, no stake, no slashing.
- **Not a multisig federation.** Content-addressing + challenges handle all integrity; no quorum is ever asked to vouch for data.
- **Not load-bearing** for any other Kaspa-stack project. If MyKAI Archival goes to zero, Kaspa is fine.

---

## Locked architectural rules

These are non-negotiable design constraints, not just preferences:

1. **No money, no token, no payment** — participation is gratis or it isn't sovereignty.
2. **No multisig, no federation, no authority** — no group of N can override consensus.
3. **No central coordinator, no registry server** — content-addressing is the only directory.
4. **Content-addressing handles correctness** — if the hash matches, the data is right.
5. **Challenges handle governance** — random audits replace social trust.
6. **Pruned nodes are the verifiers** — every participant's own kaspad is the anchor.
7. **Free pinning, no radius** — anyone pins any amount of any range; no quota, no jurisdiction.
8. **Supplement, don't replace** — existing archival operators are the durability floor; we add resilience on top.
9. **Maximum stacked redundancy** — RF ≥ 4 by default, can climb arbitrarily.
10. **Forks are a feature** — if someone disagrees with the design, they fork the swarm and both can coexist.
11. **Recency-first, climbing back into history** — fill the tip first, then walk backwards; never block tip availability on deep-history work.
12. **Active automated gap-filling** — when coverage thins, participants automatically claim the thin bands.
13. **Layered archive nodes** — once one virtual archive node is full, start the next one with the same pattern; horizontal scale without coordination.

---

## Roadmap

- ✅ **v0.5** — single-machine archival contribution + verification + audit. Works against a friend's archival kaspad.
- ✅ **v0.5.4** — body merkle verification. Every block now verified at both header AND transaction level. Validated against all 8 of rusty-kaspa's canonical test vectors.
- 🔜 **v0.6** — peer discovery and bucket assignment go live on mainnet. The "100 virtual archive nodes" framing becomes real.
- 🔜 **v0.7** — explorer-backend mode: the pool serves `simply-kaspa-indexer` queries via `/shard/*` endpoints. Archival data becomes useful to explorer apps, not just durable.

See [`docs/`](docs/) for full design notes per topic.

---

## License

MIT. See [`LICENSE`](LICENSE).

## Acknowledgments

Forked with permission from [MyKAI Node](https://github.com/KasMapApp/MyKAI-Node-Public). The MCP scaffolding is upstream; everything in the archival, shard, verification, and audit subsystems is new in this fork.
