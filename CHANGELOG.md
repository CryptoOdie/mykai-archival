# Changelog

## v0.5.0 — Archival Contribution Feature (unreleased)

The big one. MyKAI Node now optionally helps preserve Kaspa's history.

### New: archival contribution as an optional feature

A new Settings → Storage section: **"Help preserve Kaspa history (optional)"** with a single number input — `Contribute X GB`. Default is 0 (feature off, identical behavior to v0.4). When set to any positive value:

- A background **shard storage module** subscribes to the local pruned kaspad's chain events
- For each new accepted block, captures the body into a local SQLite database (`<userData>/shard-storage.db`)
- Holds blocks until they fall outside the user-configured disk budget
- Rolls oldest blocks out as new blocks arrive at the chain tip
- Captures happen via the kaspad wRPC notification stream — **no extra internet traffic** (kaspad already downloaded the block; we just write it to our own store)

### Why this matters

Kaspa's pruning point is at ~30 hours post-Crescendo. Every block older than that gets discarded by default pruned nodes. The archival contribution feature lets your normal MyKAI Node *catch* those blocks before they disappear and *hold* them for as long as your disk budget allows. Your node now contributes to a network-wide preservation of Kaspa history.

In v0.6+, the same shard module will expose the captured blocks to other MyKAI peers via libp2p, forming a distributed archival mesh. v0.5 is the local-only foundation.

### Architecture

- **One pruned kaspad** (as in v0.4) — your normal Kaspa node, ~4 GB RAM, ~30 GB disk
- **MyKAI shard storage module** (new) — `src/dist/main/shard-storage.js`, in-process, ~0.5-2 GB extra RAM depending on pinset size, additional disk = your configured GB

This is NOT a separate archival kaspad. It's a lightweight Node module sitting next to pruned kaspad in the same Electron process.

### Storage backend

- `sql.js` (pure JS / WASM SQLite) — no native build toolchain required
- ~3× slower than native SQLite, but fully adequate at Kaspa's 10 BPS write rate
- Migration to native `better-sqlite3` planned for v0.6 alongside the libp2p sidecar

### Dashboard widget

When the feature is enabled, the main dashboard shows a new card:
- Blocks held
- Disk used (formatted: e.g., "1.2 GB")
- Budget (e.g., "50 GB")
- Captures per minute
- DAA range covered

The card is hidden entirely when the feature is off — no visual clutter for users who don't opt in.

### New IPC + HTTP endpoints

- IPC: `shard:stats` returns the current contribution state
- HTTP (agent-bridge): `GET /shard/stats` and `GET /shard/block/:hash`
- Both return 503 with a helpful message when the feature is off

### Internal changes

- `src/dist/main/shard-storage.js` — NEW (~330 lines): the storage class
- `src/dist/main/rpc-monitor.js` — block-added event extended with `daaScore` and `rawBlock` (non-breaking — existing consumers ignore new fields)
- `src/dist/main/main.js` — module init in `initialize()`, capture subscriber, periodic prune timer, cleanup on quit
- `src/dist/main/config-store.js` — `shardSizeGB` field (default 0)
- `src/dist/main/agent-bridge.js` — `/shard/*` endpoints
- `src/dist/main/ipc-handlers.js` — `shard:stats` channel
- `src/dist/preload/preload.js` — `window.mykai.shard.stats()`
- `src/src/renderer/index.html` — `#shard-card` widget, contribution slider in Settings
- `src/src/renderer/app.js` — `refreshShardCard()`, `updateShardSizeHint()`, save handler

### Known caveats

- **Restart required** after changing `shardSizeGB` from 0 to positive or vice versa. The module starts/stops at app launch based on the config value at that moment.
- **JSON storage overhead**: blocks are stored as JSON strings (sql.js convention). ~30% larger than Borsh-encoded binary. Migrate to native SQLite + Borsh in v0.6.
- **Local-only in v0.5**: no P2P sharing yet. Your captured blocks help YOUR node's MCP server and any local consumers. Sharing across MyKAI peers ships in v0.6 with the libp2p sidecar.

---

## v0.4.0 — Archival Mode + Sovereign Fork (unreleased)

Forked from MyKAI Node v0.3.8 (MIT, KasMapApp). Author permission granted 2026-05-14.

### New features

- **Archival mode** with three storage tiers selectable in Settings:
  - `Pruned` (default, ~30 GB disk, ~30 hours of history) — unchanged from v0.3.x
  - `Retention` — keep last N days of blocks (N ≥ 2, default 30)
  - `Archival` — keep all blocks since enabling (~1.5 TB and growing)
- **Storage-mode change dialogs** with typed confirmation:
  - Pruned/Retention → Archival: type `KEEP ARCHIVE` to confirm
  - Archival → Pruned/Retention: type `DELETE HISTORY` to confirm
  - Cancel reverts the config silently and reloads the UI
- **Mode-aware disk thresholds** — disk-monitor pauses kaspad at appropriate floors:
  - Pruned: pause at 5 GB free, resume at 10 GB
  - Retention: pause at 20 GB free, resume at 40 GB
  - Archival: pause at 50 GB free, resume at 100 GB
- **Marker file** (`mykai-storage-mode.json` in userData) on every mode flip — defends against the upstream rusty-kaspa `set_is_archival_node` WriteBatch non-commit bug (see `docs/upstream-prs/PR-01`)
- **Pause-on-battery** default behavior — when a laptop unplugs, kaspad stops cleanly; when plugged back in, it resumes. Eliminates the #1 amateur quit-trigger.
- **Hard guard against archival on testnet** — archival data risks being nuked on testnet reset; the option is disabled in the UI when network = testnet.

### Privacy / sovereign-fork changes

- **Telemetry now strictly opt-in (default OFF).** Previous v0.3.x silently set `contributeMonitoring: true` in the save-settings handler — that hardcoded `true` is removed. Existing v0.3.x users upgrading will keep their previous setting; new installs default to OFF.
- **Remote recovery lookup disabled.** `recovery-client.js` previously called `https://mykai.dev/api/recover-by-key` (a Supabase-backed identity registry) when a user pasted an accountKey and no local match was found. Now returns a `remote-disabled` error. Local recovery via `Documents\MyKAI\identity_acc_<key>.json` is unchanged and remains the primary mechanism.
- **Cloud node management disabled.** The FluxCloud-specific `mykai-monitor.sh` script generator is no longer shipped. `cloud:generate-script` and `cloud:status` IPC channels return disabled responses (rather than being removed entirely) for backward compatibility with the renderer.
- **`cloud-monitor/` directory removed from the install bundle.**
- **`cloud-node-manager.js` deleted.**

### Hardware recommendations

Empirically derived from 3 parallel deep-research runs (kaspad resources, shard module overhead, residential laptop reality):

| Storage tier | RAM minimum | RAM recommended | Disk | CPU |
|---|---|---|---|---|
| Pruned | 8 GB | 16 GB | 100 GB NVMe | 2 cores |
| Retention (30 days) | 8 GB | 16 GB | 250 GB NVMe | 2 cores |
| Archival | 8 GB (with `--rocksdb-preset=hdd` `--ram-scale=0.5`) | 16-32 GB | 2 TB NVMe | 4 cores |

HDDs are NOT recommended for archival in the current rusty-kaspa codebase — IBD fails on mechanical disks. Use NVMe SSD for archival.

### Upstream contributions

- `docs/upstream-prs/PR-01-fix-set-is-archival-node.md` — proposed fix for a data-loss bug in `consensus/src/consensus/factory.rs`. Carried as a patch in our fork; pending upstream merge.

### Compatibility

- Requires kaspad 1.1.0+ (bundled). Verified to include PR #780 (Dec 2025 underflow fix) and PR #827 (Jan 2026 utxoindex stale fix) — both critical for archival operators.

### Internal changes (not user-visible)

- `config-store.js` — new `nodeStorageMode` + `retentionDays` schema fields with migration from v0.3.x
- `kaspad-manager.js::buildArgs()` — wires `--archival` and `--retention-period-days=N`
- `disk-monitor.js` — `THRESHOLDS_BY_MODE` table + `setStorageMode()` setter
- `ipc-handlers.js::config:set` — detects storage-mode changes, writes marker file, emits `config:storage-mode-changed` IPC event
- `preload.js` — exposes `window.mykai.config.onStorageModeChanged(callback)`
- `recovery-client.js` — gutted, returns disabled error
- `main.js` — pause-on-battery + AC resume via `powerMonitor` events
