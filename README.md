# MyKAI Node + Archival Contribution

A fork of [MyKAI Node v0.3.8](https://github.com/KasMapApp/MyKAI-Node-Public) (MIT, with author permission) that adds an **optional archival contribution feature**: your normal Kaspa node can also help preserve Kaspa's history.

**Status:** v0.5 pre-release — running locally, ready for early testers.

See [`CHANGELOG.md`](CHANGELOG.md) for the full v0.4 + v0.5 release notes and [`docs/security-model.md`](docs/security-model.md) for the trust chain.

---

## Quick start (Windows)

```powershell
# 1. Clone
git clone https://github.com/<your-org>/mykai-archival.git
cd mykai-archival

# 2. Fetch kaspad binary (pinned + SHA-256 verified)
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1

# 3. Install JS deps (Node 20+ required)
cd src
npm install

# 4. Run
npm start
```

That's it — the app opens, kaspad starts in the background, and the Archive bar begins filling at ~1 GB/hour from live capture.

## Connecting to an archival kaspad source

If you have access to an archival kaspad (your own, a friend's, or a community-run one), pull deep-history blocks from it instead of waiting on live capture.

1. **On the archival operator's side**, run:
   ```
   kaspad --archival --rpc-listen=0.0.0.0:18110
   ```
   Open port 18110, or expose via Tailscale / Cloudflare Tunnel for private sharing.

2. **In MyKAI** → Settings → **Archive seed sources** → paste the URL (`wss://archival-host:18110`) → click **Test connection** → if green, Save.

3. Within 60 seconds the fill loop pulls deep-history buckets. **Every block is hash-verified against your local kaspad's PoW chain** — no trust in the source required. See [`docs/security-model.md`](docs/security-model.md).

## Reproducibility & security verification

MyKAI is designed so anyone can independently verify the running build matches the published source. Run:

```bash
node scripts/verify-build.js
```

This checks:

1. **Pinned binary hashes** — `kaspad.exe` SHA-256 matches what's pinned in `setup.ps1`. Mismatch = aborts with the actual hash so you can investigate.
2. **No native compilation** — confirms zero `.node` binary modules in `node_modules/`. Native compilation is the #1 source of non-reproducible builds; we avoid it entirely. `sql.js` (WASM), `@noble/hashes` (pure JS), no `node-gyp`.
3. **Exact dependency versions** — `package.json` uses no `^` or `~`; `package-lock.json` pins every transitive dep by SHA. The lockfile's `integrity:` fields are subresource-integrity hashes — npm verifies them on every install.
4. **Security-critical source files present** — confirms the trust-chain files (`kaspa-block-hash.js`, `parent-chain-walker.js`, `shard-fill.js`, etc.) exist with their current hashes printed for cross-check against your git checkout.
5. **Node runtime version** — flags if you're running outside the tested range (Node 20-22).

### The verification chain

```
git clone @ SHA X
  ↓ verify: git rev-parse HEAD == X
scripts/setup.ps1
  ↓ verify: kaspad.exe SHA-256 = 02d40a0f...
npm install
  ↓ verify: every package matches package-lock.json integrity hash
  ↓ verify: no compiled .node binaries
npm start  →  the running JS is byte-for-byte the source you cloned
```

Every byte the app loads can be traced back to either:
- The git commit you checked out (JS source), OR
- A pinned SHA-256 in source (kaspad), OR
- A pinned integrity hash in `package-lock.json` (npm packages + Electron binary).

**Caveats — what is NOT bit-for-bit reproducible:**
- Electron is downloaded from electronjs.org during `npm install` and its hash IS in package-lock.json, but the resulting `node_modules` directory has filesystem timestamps that vary per install. The *content* is identical; the *file metadata* isn't.
- If/when this project ever ships pre-built `.exe` installers (currently it doesn't), achieving Bitcoin-Core-grade bit-for-bit binary reproducibility would require deterministic packaging (`SOURCE_DATE_EPOCH`, electron-builder reproducible flags). Out of scope for v0.5 because we ship source.

For an Electron app distributed as source, this is the highest practical level of reproducibility.

## What's new

### v0.5 — Archive Pool participation (optional)

A new section in Settings → Storage: **"Archive Pool"**. Set a number of GB to contribute; your node joins the pool — catching each new block from kaspad just before it would be pruned and holding it in a local store. Set 0 to stay out — MyKAI Node still works exactly as before.

- Default: 0 GB (not joined, behavior unchanged from v0.4)
- 50 GB: small pool contributor
- 200 GB: meaningful pool contributor
- 1000+ GB: dedicated archive operator

The pool uses pruned kaspad + a lightweight in-process module — much lighter than running kaspad's `--archival` mode directly. Same node, just a small storage helper on the side.

### v0.4 — Sovereign-fork foundation

Telemetry strictly opt-in. Remote identity-recovery disabled. FluxCloud cloud-monitor removed. Pause-on-battery for laptop users. Archival/retention mode flags exposed via Settings (advanced).

## What this is

Three things, in three phases:

1. **One-click archival mode** for Kaspa, with all the safety rails the upstream `--archival` flag is missing.
2. **MCP server** so every install becomes a sovereign AI backend — your agent queries Kaspa through your own node, no third-party API.
3. **Distributed shard network** — anyone pins what they want, any amount, anywhere. Recency-first, gap-driven auto-pilot. Heatmap shows which "archive node" the network is currently building. No coordinator, no money, no multisig, no foundation in the critical path.

## What this is not

- Not a replacement for kaspa.org/explorer, kaspadbase.com, Kasplex, or any existing Kaspa archival operator. We're the resilience layer that makes the whole system stronger; they're the durability floor that always exists.
- Not a token. No payment, no stake, no slashing.
- Not a multisig federation. Challenges + content-addressing handle all governance.
- Not load-bearing infrastructure for any other Kaspa-stack project. If MyKAI Archival goes to zero, Kaspa is fine.

## Locked architectural rules

See [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md) for the full design. Headline rules:

1. No money, no token, no payment
2. No multisig, no federation, no authority
3. No central coordinator, no registry server
4. Content-addressing handles correctness
5. Challenges handle governance
6. Pruned nodes are the verifiers
7. Free pinning, no radius
8. Supplement existing archival, don't replace
9. Maximum stacked redundancy
10. Forks are a feature
11. Recency-first, climbing back into history
12. Active automated gap-filling, not passive heatmaps
13. Layered archive nodes — fill the next one in the same pattern

## License

MIT. See [`LICENSE`](LICENSE).

## Status

Pre-alpha. Not yet released. Not yet running on any network.
