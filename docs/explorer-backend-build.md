# Explorer-Backend Build Plan

**Companion to:** `explorer-backend-plan.md` (the design)
**Status:** Build sequence for v0.5.1
**Estimate:** ~7 working days for one engineer, end-to-end from a clean tree to side-by-side validation against a real `simply-kaspa-indexer`

Five phases. Each one ships independently and is verifiable on its own. Stop after any phase and the codebase is still coherent.

---

## Phase A — Foundation (half day)

**Goal:** the pieces underneath the endpoints work and we know it.

**Touched files:**
- `src/dist/main/shard-storage.js`
- `src/dist/main/config-store.js`

**Work:**

1. Audit `shard_blocks` schema in `shard-storage.js`. The endpoints need:
   - Index on `blue_score` (for `/shard/blocks` low-hash walk)
   - Index on `daa_score` (for `/shard/block-range`)
   - Both indexes are cheap; add them in a migration if missing.

2. Add a `getPoolFloorDaa()` query: `SELECT MIN(daa_score) FROM shard_blocks`. Cached, refresh on capture.

3. Add config keys to `config-store.js`:
   - `explorer.enabled` (default `false`)
   - `explorer.bind` (default `"127.0.0.1"`)
   - `explorer.port` (default `17112`)
   - `explorer.tier` (default `"light"` — only used in v0.5.2, but reserve the key now)

**Verification:**
- Open the sql.js DB directly, confirm indexes exist
- Restart MyKAI, confirm config defaults appear in electron-store
- `getPoolFloorDaa()` returns a number when blocks exist, `null` otherwise

---

## Phase B — The four endpoints, naked (1 day)

**Goal:** all four endpoints return correct-shaped JSON. No mitigations yet. Validates that the data layer can answer the questions.

**Touched files:**
- `src/dist/main/agent-bridge.js`
- `src/dist/main/shard-storage.js` (add the query methods)
- Maybe `src/dist/main/rpc-monitor.js` (to expose existing kaspad wRPC handle for proxy endpoints)

**Work in order:**

1. **`GET /shard/dag-info`** (simplest — kaspad proxy + pool_floor_daa overlay).
   - Call kaspad's `getBlockDagInfo` via existing wRPC connection
   - Add `pool_floor_daa` and `capabilities.virtual_chain: true` fields
   - Plain `JSON.stringify`, no mitigations

2. **`GET /shard/blocks?low_hash=&include_txs=&limit=`** (the workhorse).
   - Query: `SELECT block_json FROM shard_blocks WHERE blue_score > (SELECT blue_score FROM shard_blocks WHERE hash = ?) ORDER BY blue_score LIMIT ?`
   - Cap `limit` at 500
   - Return `{block_hashes: [...], blocks: [...]}` shape

3. **`GET /shard/virtual-chain?start_hash=&tip_distance=`** (kaspad proxy).
   - Call `getVirtualChainFromBlockV2` via wRPC, pass through

4. **`GET /shard/block-range?from_daa=&to_daa=&include_txs=`** (DAA scan).
   - Query: `SELECT block_json FROM shard_blocks WHERE daa_score BETWEEN ? AND ? ORDER BY daa_score`
   - Cap range at 5000 blocks
   - Return `{blocks: [...]}`

**Field-shape rule:** every JSON field name must match kaspad wRPC byte-for-byte. When in doubt, capture the actual kaspad JSON response with a real call and diff.

**Verification:**
- `curl http://127.0.0.1:17112/shard/dag-info` returns valid JSON
- `curl …/shard/blocks?low_hash=<known hash>&limit=10` returns 10 blocks in blue_score order
- Diff the JSON shape against an equivalent kaspad wRPC call. Field names match.

---

## Phase C — Tier-1 mitigations (1 day)

**Goal:** the endpoints don't break the MyKAI renderer under load. Required before public-internet binding is ever allowed.

**Touched files:**
- `src/dist/main/agent-bridge.js`

**Work in order:**

1. **Rate limit** `/shard/blocks` and `/shard/block-range`:
   - ≤2 in-flight per connection
   - ≤4 in-flight globally
   - Excess requests get `503 Retry-After: 1`
   - One small counter map, no library needed

2. **`setImmediate()` yield** inside any loop that touches sql.js more than ~25 times:
   - Wrap the loop body in an async function that awaits `new Promise(r => setImmediate(r))` every 25-50 rows
   - The largest source of renderer jank — this single change matters most

3. **Streaming JSON writer** for `/shard/blocks` and `/shard/block-range`:
   - Replace `res.end(JSON.stringify(payload))` with:
     - `res.write('{"blocks":[')`
     - For each block: `res.write(prevWasFirst ? '' : ','); res.write(JSON.stringify(block))`
     - `res.write(']}')`
     - Each block becomes a young-generation allocation, scavenged before the next
   - Backpressure: if `res.write()` returns `false`, await the `'drain'` event before continuing

4. **zstd negotiation** with `Accept-Encoding`:
   - Honor `zstd`, `gzip` (fallback only), `identity`
   - **zstd preferred** because gzip on JSON of hashes/signatures is high CPU for ~1.4× ratio
   - Pipe the streaming JSON writer through `zlib.createBrotliCompress` (no, zstd) — use `node:zlib` `createZstdCompress` if available (Node 23+) or `@mongodb-js/zstd` if not
   - Set `Content-Encoding: zstd`
   - Stream-then-compress, never buffer-then-compress

**Verification:**
- Load test: 10 concurrent curls hitting `/shard/blocks?limit=500`. MyKAI's UI scroll/animation stays smooth. Without these mitigations it stutters visibly within seconds.
- `curl --compressed -H "Accept-Encoding: zstd" …` returns a smaller payload than uncompressed
- Manual: open Pool tab in MyKAI, run the load test, watch for jank. Should be clean.

---

## Phase D — Opt-in toggle + UI (half day)

**Goal:** user can turn explorer serving on and off. Default off. Loopback-bind only at this stage; public-internet binding is gated until v0.5.2 tier work.

**Touched files:**
- `src/dist/main/agent-bridge.js` (bind logic)
- `src/dist/main/ipc-handlers.js`
- `src/dist/preload/preload.js`
- `src/src/renderer/index.html`
- `src/src/renderer/app.js`

**Work:**

1. **Agent-bridge bind logic.** On startup, read `config.explorer.enabled`. If false, don't bind the 4 new routes (still bind `/shard/stats` etc. — those are pre-existing). If true, bind to `config.explorer.bind` (always `127.0.0.1` in v0.5.1).

2. **IPC handler** for `explorer:set-enabled`. Persist to config, restart the listener.

3. **Preload bridge** — add `window.mykai.explorer.{enabled, setEnabled, stats}` to `preload.js`.

4. **Pool-page toggle**. Below the existing storage tier picker, add:
   ```
   ┌─────────────────────────────────────────────────┐
   │ Help indexers reach Kaspa? (experimental)       │
   │                                                  │
   │ Let local Kaspa explorers query your node       │
   │ directly. Local-only in this version — your     │
   │ data stays on your machine.                     │
   │                                                  │
   │ [○ Off]   [● On]                                │
   └─────────────────────────────────────────────────┘
   ```

   Use the existing pure-black/grey monochrome aesthetic. No accent colour.

5. **Pause button.** A small `[ Pause for 24h ]` that hits IPC and sets `config.explorer.pausedUntil`. The bind logic respects it.

**Verification:**
- Toggle off → curl returns connection-refused on port 17112
- Toggle on → curl works
- Pause → 503 for 24h, then auto-resume
- Restart MyKAI with toggle on → still on (config persisted)

---

## Phase E — Smoke test against real indexer (half day)

**Goal:** prove the loop closes. A real `simply-kaspa-indexer` reads from the pool and writes Postgres rows.

**Work:**

1. Spin up `simply-kaspa-indexer` upstream binary (no fork yet) against your local kaspad. Let it write to a Postgres `kaspa_indexer_control` DB. This is the **control**.

2. Manual comparison: curl `/shard/blocks?low_hash=X&limit=100` and compare returned blocks (by hash) against what the control indexer stored at the same blue_score range. Hashes match → data is correct.

3. Document the JSON shape with one sample response per endpoint in `docs/api-samples/`. These become the contract the indexer fork will deserialize.

**This phase does NOT need the indexer fork.** It validates the pool side is sound before we start the Rust work.

---

## What comes after v0.5.1

**v0.5.1.5 — The indexer fork (~5 days):**
- Branch `simply-kaspa-indexer` to `mykai/pool-source`
- New `source/` crate with `BlockSource` trait + `KaspadSource` (move existing 80 LOC) + `PoolSource` (new ~400 LOC reqwest + serde + hash check)
- Hybrid bootstrap state machine
- CLI flags: `--source`, `--pool-url` (repeatable), `--bootstrap-rpc-url`
- `cargo test` + side-by-side run against MyKAI v0.5.1

**v0.5.2 — Three-tier + discovery (~3 days):**
- Tier picker UI (Storage-only / Light / Heavy)
- Capability advertisement in `/shard/dag-info`
- Operator telemetry panel
- Quiet hours scheduling
- Public-internet bind unlocked, with NAT check
- Bootstrap JSON phone book + GitHub/IPFS mirror

**v0.6 — better-sqlite3 + child process (~5 days):**
- Swap sql.js for better-sqlite3 (native, ~5× throughput)
- Move HTTP server to child process supervised by Electron main
- libp2p Circuit Relay v2 for CGNAT participants

---

## Total v0.5.1 estimate

| Phase | Time |
|---|---|
| A — Foundation | ½ day |
| B — Endpoints | 1 day |
| C — Mitigations | 1 day |
| D — Toggle + UI | ½ day |
| E — Smoke test | ½ day |
| **v0.5.1 total** | **~3.5 days** |

Plus ~5 days for v0.5.1.5 indexer fork. Plus ~3 days for v0.5.2. **~12 days from start to public-internet-capable explorer backend.**

---

## What we are not building in v0.5.1

To keep the ship list honest:

- ❌ Three-tier system (deferred to v0.5.2)
- ❌ Capability advertisement (v0.5.2)
- ❌ Discovery phone book (v0.5.2)
- ❌ Operator telemetry panel (v0.5.2)
- ❌ Public-internet bind (v0.5.2 + NAT check)
- ❌ Quiet hours scheduling (v0.5.2)
- ❌ Auto-tier-down composite (v0.5.2)
- ❌ The indexer fork itself (v0.5.1.5)
- ❌ better-sqlite3 swap (v0.6)
- ❌ Child-process explorer server (v0.6)
- ❌ libp2p Circuit Relay v2 (v0.6)

v0.5.1 is the dark launch. Loopback only, opt-in off, just the four endpoints + the technical mitigations + a manual smoke test. Everything else is the next ship.
