# Explorer-ready MyKAI Archive Pool

**Status:** Design spec, v1.0
**Date:** 2026-05-14
**Source:** Synthesis of 7 parallel deep-research agents covering pool→explorer feasibility, API surface, indexer reuse, latency models, failure modes, and the concrete `simply-kaspa-indexer` fork.

---

## TL;DR

**The indexer is the explorer.** Don't build a new one. `simply-kaspa-indexer` already does the work — it consumes `RpcBlock` from kaspad, writes to Postgres, and that Postgres feeds `kaspa-rest-server` which feeds every Kaspa explorer UI. The whole pipeline is source-agnostic except **80 lines of kaspad coupling**.

So the play is:

1. Add **4 new HTTP endpoints** to the MyKAI Pool (~150 LOC in `agent-bridge.js`)
2. Fork `simply-kaspa-indexer` to add a `BlockSource` trait with a `PoolSource` impl (~900 LOC)
3. Run the fork against the pool; it writes the same Postgres schema; `kaspa-rest-server` and the explorer UI are **unchanged**

Total: ~1100 LOC, 7-day cutover, one engineer.

---

## 1. Architecture

```
                          ┌──────────────────────────────┐
                          │  Explorer UI (kas.fyi, etc.) │
                          └─────────────┬────────────────┘
                                        │ (unchanged)
                          ┌─────────────▼────────────────┐
                          │     kaspa-rest-server        │
                          │     (pure Postgres reader)   │
                          └─────────────┬────────────────┘
                                        │ (unchanged schema)
                          ┌─────────────▼────────────────┐
                          │     Postgres (9 tables, v21) │
                          └─────────────┬────────────────┘
                                        │
                          ┌─────────────▼────────────────┐
                          │   simply-kaspa-indexer       │
                          │   FORK with --source pool    │  ← the only fork
                          └─────────────┬────────────────┘
                                        │ HTTP/JSON
                          ┌─────────────▼────────────────┐
                          │     MyKAI Pool Gateway       │  ← 4 new endpoints
                          │  (agent-bridge HTTP layer)   │
                          └─────────────┬────────────────┘
                                        │ wRPC
                          ┌─────────────▼────────────────┐
                          │   Pruned kaspad (local)      │
                          │   + shard-storage.db (SQLite)│
                          └──────────────────────────────┘
```

What changes:
- **Pool:** 4 new endpoints in `src/dist/main/agent-bridge.js`
- **Indexer:** new `source/` crate + `--source pool` CLI flag

What does NOT change:
- Postgres schema (v21, 9 tables)
- `simply-kaspa-mapping` crate (still consumes `RpcBlock`)
- `kaspa-rest-server` (pure Postgres reader)
- Explorer UI

---

## 2. Pool API additions

All endpoints live under `/shard/*` to match the existing namespace (`/shard/stats`, `/shard/block/:hash`). JSON responses are byte-compatible with kaspad wRPC's JSON encoding — **do not invent field names**, reuse rusty-kaspa's serde definitions.

### 2.1 `GET /shard/dag-info`

Proxies kaspad's `getBlockDagInfo`, plus pool-specific floor.

**Response:**
```json
{
  "network": "mainnet",
  "block_count": 12345678,
  "tip_hashes": ["hash..."],
  "virtual_parent_hashes": ["hash..."],
  "pruning_point_hash": "hash...",
  "virtual_daa_score": 98765432,
  "server_version": "MyKAI-0.5.1",
  "is_synced": true,
  "pool_floor_daa": 95000000,
  "capabilities": {
    "virtual_chain": true,
    "include_txs": true
  }
}
```

`pool_floor_daa` is the lowest DAA score this pool participant has stored. Below that, requests 404. `capabilities.virtual_chain` is `true` only if the participant runs a current-enough kaspad to serve `getVirtualChainFromBlockV2`.

### 2.2 `GET /shard/blocks?low_hash=&include_txs=&limit=`

The workhorse. Mirrors kaspad's `getBlocks(low_hash, include_blocks=true, include_txs)`.

**Query params:**
- `low_hash` (required) — start anchor; returned blocks have `blue_score > low_hash.blue_score`
- `include_txs` (default `false`) — include full transaction bodies
- `limit` (default `100`, max `500`) — number of blocks to return

**Response:**
```json
{
  "block_hashes": ["hash...", "..."],
  "blocks": [
    { "header": { ... }, "transactions": [ ... ], "verboseData": { ... } }
  ]
}
```

If `low_hash` is below `pool_floor_daa` → `404 {"error": "below_pool_floor", "pool_floor_daa": 95000000}`.

SQL implementation: `SELECT block FROM shard_blocks WHERE blue_score > (SELECT blue_score FROM shard_blocks WHERE hash=?) ORDER BY blue_score LIMIT ?`.

### 2.3 `GET /shard/virtual-chain?start_hash=&tip_distance=`

Proxies kaspad's `getVirtualChainFromBlockV2`. Pool participant must run a live kaspad for this.

**Query params:**
- `start_hash` (required)
- `tip_distance` (default `50`)

**Response:**
```json
{
  "added_chain_block_hashes": ["hash..."],
  "removed_chain_block_hashes": ["hash..."],
  "chain_block_accepted_transactions": [
    {
      "accepted_block_hash": "hash...",
      "accepted_transaction_ids": ["txid...", "..."]
    }
  ]
}
```

If participant cannot serve VC → `503 {"error": "vc_capability_unavailable"}`. Indexer skips this participant for VC requests and falls back to another.

### 2.4 `GET /shard/block-range?from_daa=&to_daa=&include_txs=`

Bootstrap-friendly range scan. Lets a fresh indexer pull a DAA window in parallel rather than serial low-hash chasing.

**Query params:**
- `from_daa` (required)
- `to_daa` (required, `to_daa - from_daa ≤ 5000`)
- `include_txs` (default `false`)

**Response:**
```json
{
  "blocks": [ ... ]
}
```

Blocks returned in ascending DAA order. Hard cap: 5000 blocks per call to bound memory.

### 2.5 Extended `GET /shard/stats`

Add fields:
- `network_id` (e.g. `"mainnet"`)
- `is_synced` (bool, mirrors kaspad)
- `virtual_daa_score` (u64)
- `pool_floor_daa` (u64)
- `vc_capability` (bool)

Existing fields (block count, DAA span, uptime) unchanged.

---

## 3. Indexer fork

### 3.1 New crate: `source/`

```rust
// source/src/lib.rs
#[async_trait::async_trait]
pub trait BlockSource: Send + Sync {
    async fn get_dag_info(&self) -> Result<DagInfo, SourceError>;
    async fn get_block(&self, hash: KaspaHash) -> Result<RpcBlock, SourceError>;
    async fn get_blocks(
        &self,
        low_hash: KaspaHash,
        include_txs: bool,
        limit: usize,
    ) -> Result<GetBlocksResponse, SourceError>;
    async fn get_virtual_chain(
        &self,
        start_hash: KaspaHash,
        tip_distance: u64,
    ) -> Result<GetVirtualChainFromBlockV2Response, SourceError>;
    async fn get_server_info(&self) -> Result<ServerInfo, SourceError>;
}
```

Three impls:
- `KaspadSource` — existing 80 LOC moved over, no behavior change
- `PoolSource` — new, `reqwest` + serde, ~400 LOC including verification
- `HybridSource` — wraps both; routes by DAA score (see §3.3)

### 3.2 Verification (non-negotiable for pool source)

Pool participants are untrusted. Every block returned by `PoolSource` is checked:

```rust
fn verify_block(block: &RpcBlock, expected_hash: KaspaHash) -> Result<(), SourceError> {
    let computed = kaspa_hashes::block_hash(&block.header);
    if computed != expected_hash {
        return Err(SourceError::HashMismatch { expected: expected_hash, got: computed });
    }
    let computed_root = kaspa_hashes::merkle_root(&block.transactions);
    if computed_root != block.header.hash_merkle_root {
        return Err(SourceError::MerkleMismatch);
    }
    Ok(())
}
```

~50 LOC. Any failure → quarantine that pool participant for `BAN_DURATION` (default 5 min).

### 3.3 Hybrid bootstrap state machine

```
state: BootstrapPhase
  ↓ start
  KaspadOnly { rpc_url }      ← used when checkpoint_daa < pool_floor_daa
  ↓ checkpoint_daa crosses pool_floor_daa
  Crossover { pool_url }      ← validate first 100 blocks against both sources
  ↓ crossover validated
  PoolOnly { pool_urls }      ← steady state
```

- If `--bootstrap-rpc-url` is set and pool's `pool_floor_daa` > current checkpoint DAA, use `KaspadSource` for the gap.
- Once indexer's checkpoint DAA ≥ `pool_floor_daa`, switch to `PoolSource`. Validate the first 100 post-crossover blocks against both sources before declaring crossover successful.
- If no `--bootstrap-rpc-url` provided and checkpoint < `pool_floor_daa`, indexer errors out with a clear message: *"Pool floor is at DAA X; checkpoint is at DAA Y. Provide --bootstrap-rpc-url=&lt;archival kaspad&gt; for the gap, or use --ignore-checkpoint to restart from pool floor."*

### 3.4 Multi-pool failover

`--pool-url` is repeatable:
```
--pool-url=https://pool-a.example/shard \
--pool-url=https://pool-b.example/shard
```

Round-robin with quarantine. A pool gets quarantined when:
- Returns 404 for a hash inside its advertised `pool_floor_daa`
- Returns a block that fails `verify_block`
- Times out (default 30s)
- Returns `503 vc_capability_unavailable` for VC requests (VC-only quarantine; still used for block requests)

Quarantine duration: 5 min initial, exponential backoff to 1 hour.

### 3.5 CLI changes (`cli/src/cli_args.rs`)

```rust
#[arg(long, value_enum, default_value = "kaspad")]
pub source: SourceKind,  // Kaspad | Pool | Hybrid

#[arg(long)]
pub pool_url: Vec<String>,  // repeatable

#[arg(long)]
pub bootstrap_rpc_url: Option<String>,  // for hybrid mode
```

---

## 4. LOC budget

| Component | Added | Changed | Removed |
|---|---:|---:|---:|
| Pool: `/shard/dag-info` | 30 | – | – |
| Pool: `/shard/blocks` | 50 | – | – |
| Pool: `/shard/virtual-chain` | 30 | – | – |
| Pool: `/shard/block-range` | 30 | – | – |
| Pool: extend `/shard/stats` | – | 10 | – |
| Indexer: `source/` crate | 600 | – | – |
| Indexer: verification | 50 | – | – |
| Indexer: hybrid bootstrap | 80 | – | – |
| Indexer: multi-pool failover | 80 | – | – |
| Indexer: move kaspad coupling | – | – | 80 |
| Indexer: `cli_args.rs` | 15 | – | – |
| Indexer: `main.rs` wiring | 30 | 40 | 20 |
| Indexer: `fetch_blocks.rs` | 10 | 30 | 5 |
| Indexer: `fetch_virtual_chain.rs` | 5 | 20 | 5 |
| Indexer: health endpoint | – | 10 | – |
| **Total** | **~1010** | **~110** | **~110** |

---

## 5. Performance characteristics

Steady-state at 10 BPS (Kaspa chain growth post-Crescendo):
- ~40 KB/s of JSON over HTTP
- ~10-15% CPU on indexer host (JSON parse)
- A phone could serve this load

Backfill:
- **LAN, single pool:** 200-500 BPS → pool's full window (~25M blocks) in 14-35 hours
- **LAN, `/shard/block-range` parallel:** 500+ BPS
- **WAN, single pool:** 50-200 BPS — operationally undesirable; run pool participant locally

Wire-cost vs kaspad wRPC: ~3× bytes (JSON vs Borsh). `Accept-Encoding: gzip` shave is ~70% wire reduction, recommended but not required.

**Keeping up with chain tip is trivial.** The only performance concern is genesis-to-floor backfill, which is handled by the hybrid bootstrap (archival kaspad for the gap).

---

## 6. What does NOT change

- **Postgres schema** (v21, 9 tables: `vars`, `blocks`, `block_parent`, `transactions`, `transactions_acceptances`, `blocks_transactions`, `addresses_transactions`, `scripts_transactions`)
- **`simply-kaspa-mapping`** — still consumes `RpcBlock`/`RpcTransaction`, emits row tuples
- **`kaspa-rest-server`** — opens the same Postgres DB, runs the same `sqlx` queries
- **Explorer UI** — reads `kaspa-rest-server`, knows nothing about the source

This is the load-bearing claim. It holds because the only thing the indexer's hot path needs from kaspad is an `RpcBlock` — and the pool can return one.

---

## 7. Production-grade gaps (not in base fork)

1. **TLS in front of pool** — caddy/nginx termination + HSTS preload. Operator concern, not pool code.
2. **Rate-limiting** — public explorers backfilling against one volunteer pool participant will DoS them. Mitigation: explorer operators run their own pool participant locally; multi-pool failover spreads load for incidental queries.
3. **Pool capability advertising** — `/shard/dag-info.capabilities` lets the indexer skip VC-incapable participants.
4. **Pool floor accountability** — a lying participant could advertise a falsely-high `pool_floor_daa` to mask 404s. Indexer cross-checks: any 404 inside another pool's floor is suspicious; sample-check across N pools at startup.

Budget another 200-400 LOC for items 3-4 if shipping at kaspa.org scale.

---

## 8. The virtual-chain problem

This is the single hardest design question.

**The issue:** "Which block is on the selected chain" is computed by chain-selection logic in a *live* kaspad. The pool stores blocks; it doesn't run chain selection. So `GET /shard/virtual-chain` must proxy a live kaspad.

**Implication:** pool participants whose local kaspad lags or is offline can't serve VC. Without VC data, the indexer can index block bodies but `transactions_acceptances` is empty — explorer shows transactions but can't say which ones "really happened."

**Resolution:**
- Pool participants advertise `capabilities.virtual_chain` in `/shard/dag-info`
- Indexer routes VC requests only to capable participants
- If no capable participant exists, indexer logs a clear warning and skips VC processing (legal per `CliDisable::VirtualChainProcessing`)
- For kaspa.org-grade explorers: at least one operator-controlled pool participant must run a current kaspad

**Alternative considered and rejected:** have the pool itself run chain selection. This makes the pool a partial archival kaspad, which doubles the resource cost and defeats the whole "lightweight contributor" model.

---

## 9. The bootstrap problem

Pools have data from `T_join` forward, not from genesis. A fresh indexer asking for the pruning-point block gets a 404 if pruning-point < `pool_floor_daa`.

Three modes:

**Mode A — `--source pool` only.** Indexer starts at `pool_floor_daa`. Explorer has no pre-floor data. Acceptable for new networks; useless for retrofitting an existing explorer.

**Mode B — `--source hybrid`.** Use `--bootstrap-rpc-url=<archival kaspad>` for the gap, cross over to pool at `pool_floor_daa`. Validates first 100 post-crossover blocks against both. **This is the recommended mode for production explorers.**

**Mode C — `--source pool` with `--ignore-checkpoint=floor`.** Resume from the pool's floor, accepting data loss. Valid for fresh explorer deployments or test environments.

---

## 10. Migration plan: existing explorer → pool-backed in 7 days

Assumes one engineer, existing Postgres + indexer + REST + UI deployed, at least one operator-controlled MyKAI v0.5.1 pool participant.

### Day 1 — Pool API extension
- Add 4 endpoints to `src/dist/main/agent-bridge.js`
- Extend `/shard/stats` and `shard:stats` IPC payload
- Update memory + ship MyKAI v0.5.1

### Day 2-3 — Indexer fork
- Branch to `mykai/pool-source`
- Create `source/` crate with `BlockSource` trait
- Move `kaspad/src/manager.rs` → `source/src/kaspad.rs` (no behavior change)
- Implement `source/src/pool.rs` with reqwest + verification
- Wire CLI flags
- `cargo test` + local smoke against MyKAI v0.5.1

### Day 4 — Hybrid bootstrap
- Implement crossover state machine
- Test against real pruning-point bootstrap (kaspadbase.com or operator archival kaspad)
- Validate row counts vs reference indexer

### Day 5 — Multi-pool + verification hardening
- Multi-`--pool-url` round-robin + quarantine
- Block hash + Merkle verification
- Re-validate

### Day 6 — Parallel production run
- Provision operator-controlled MyKAI v0.5.1 with large pool budget (1+ TB)
- Run pool-backed indexer side-by-side, writing to `kaspa_pool_test` DB
- Hourly row-count diff vs production DB for 24 hours

### Day 7 — Cutover
- Stop legacy indexer writes
- Swap `kaspa-rest-server`'s `DATABASE_URL`
- Keep archival kaspad as hot rollback for 7 more days
- File `BlockSource` trait refactor as upstream PR to `supertypo/simply-kaspa-indexer`
- Carry pool impl as downstream patch if upstream declines

---

## 11. Honest SLA

- **Tip-following:** trivial, near-zero risk
- **Backfill within pool window:** 14-35 hours LAN, fine for any operator
- **Pre-floor history:** requires hybrid bootstrap against an archival source — not the pool's job
- **VC data:** depends on at least one VC-capable pool participant being reachable; gracefully degrades if not
- **Trust model:** indexer-side verification (hash + Merkle) is mandatory; pool participants are untrusted

---

## 12. Open questions

1. **Wire format:** strict kaspad-JSON compatibility, or pool's own JSON shape? Recommendation: strict kaspad compatibility. Reuses rusty-kaspa serde, no field-name drift.
2. **Compression:** `Accept-Encoding: gzip` default, or `zstd` when both sides support? Recommendation: gzip default, zstd opportunistic.
3. **Upstream PR strategy:** land `BlockSource` trait refactor first (high merge probability), then pool impl as feature-flagged second PR. If pool impl is declined, carry downstream — 900 LOC is rebaseable indefinitely.
4. **Pool participant tiering:** does a "VC-capable" participant get any special status / lower contribution requirements? Open.

---

## 13. Source references

- `simply-kaspa-indexer` repo: `supertypo/simply-kaspa-indexer`, MIT, Rust 2024
  - `kaspad/src/manager.rs:1-77` — entire kaspad coupling (the 80 lines)
  - `indexer/src/main.rs:55-235` — bootstrap + task wiring
  - `indexer/src/blocks/fetch_blocks.rs:91, 102` — hot-path RPC calls
  - `indexer/src/virtual_chain/fetch_virtual_chain.rs:52` — VCP RPC call
  - `database/migrations/schema/up.sql` — 9-table schema
- MyKAI Pool current surface:
  - `src/dist/main/agent-bridge.js` — HTTP endpoints
  - `src/dist/main/shard-storage.js` — SQLite shard store
  - `CHANGELOG.md` v0.5 section — `/shard/stats`, `/shard/block/:hash`
