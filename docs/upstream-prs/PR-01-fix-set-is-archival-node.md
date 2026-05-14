# Upstream PR #1: Fix uncommitted `WriteBatch` in `set_is_archival_node`

**Target:** `kaspanet/rusty-kaspa`
**File:** `consensus/src/consensus/factory.rs`
**Severity:** data-loss bug (silent reversion under crash)
**Complexity:** S (small surgical fix)
**Risk:** low (non-consensus, single-function persistence)

## Problem

`MultiConsensusManagementStore::set_is_archival_node` builds a `WriteBatch` but never commits it:

```rust
// consensus/src/consensus/factory.rs:214-220 (current)
pub fn set_is_archival_node(&mut self, is_archival_node: bool) {
    let mut metadata = self.metadata.read().unwrap();
    if metadata.is_archival_node != is_archival_node {
        metadata.is_archival_node = is_archival_node;
        let mut batch = WriteBatch::default();
        self.metadata.write(BatchDbWriter::new(&mut batch), &metadata).unwrap();
        // BUG: missing self.db.write(batch).unwrap();
    }
}
```

The flag is persisted to disk only when a *subsequent* operation (called from `Factory::new` → `delete_inactive_consensus_entries` at line 301, or any downstream consensus write) flushes RocksDB and incidentally includes the cached metadata.

`Factory::new` calls `set_is_archival_node(config.is_archival)` on **every** kaspad startup (line 286). If kaspad crashes within ~30 seconds of a fresh archival install — before any subsequent batch write flushes — the on-disk `is_archival_node` flag remains `false`.

## Consequence

On the next startup, the operator passes `--archival` again, but their previous-boot crash left the persisted flag as `false`. `daemon.rs:536-540` reads `is_archival_node = false`, sees `--archival` is set in args, and skips the consistency check that would otherwise alert the operator.

Worse: in the *opposite* direction — archival → pruned mid-crash — `Factory::new` calls `set_is_archival_node(false)`, the in-memory cached metadata says false, but the on-disk flag may still be true. If a downstream write doesn't fire before the operator boots back into `--archival`, the consistency check at `daemon.rs:536` will trigger the "previously archival" confirmation prompt **despite the user never having intentionally been archival**.

This is consistent with the report from `bobpinella` on Issue #578 (October 2025), who described losing archival data accumulated since October 2024 after upgrading to v1.0.0. While the root cause of #578 is the `retention_root_database_upgrade()` adjacent to the schema bump, the `set_is_archival_node` non-commit bug is a contributing factor that makes the failure mode harder to diagnose: the operator may have intended to remain archival, the in-memory state may have agreed, but the persisted flag could have transiently disagreed.

## Solution

Refactor `set_is_archival_node` to match `set_version`'s pattern at line 232 (`DirectDbWriter` — commits immediately, no explicit batch needed):

```rust
// consensus/src/consensus/factory.rs:214-220 (proposed)
pub fn set_is_archival_node(&mut self, is_archival_node: bool) -> StoreResult<()> {
    self.metadata.update(DirectDbWriter::new(&self.db), |mut data| {
        data.is_archival_node = is_archival_node;
        data
    })?;
    Ok(())
}
```

Behavioral difference from existing: returns `StoreResult<()>` instead of `()`. Callers must handle the result.

Caller at line 286 in `Factory::new`:

```rust
// before
management_store.write().set_is_archival_node(config.is_archival);

// after
management_store.write().set_is_archival_node(config.is_archival).unwrap();
```

(Or propagate the error if `Factory::new`'s signature allows. Defer the broader error-handling cleanup to a follow-up PR.)

## Audit of sibling functions

Checked every function in `factory.rs` that touches the metadata store. None have the same omission:

| Function | Line | Pattern | Correct? |
|---|---|---|---|
| (factory construction) | 99-100 | `BatchDbWriter` + explicit `self.db.write(batch)` | ✓ |
| `new_staging_consensus_entry` | 142-147 | `BatchDbWriter` + explicit `self.db.write(batch)` | ✓ |
| `save_new_active_consensus` | 160-162 | `BatchDbWriter` + explicit `self.db.write(batch)` | ✓ |
| `delete_entry` | 202-204 | `DirectDbWriter` | ✓ (commits immediately) |
| `set_is_archival_node` | **214-220** | `BatchDbWriter` + **NO** commit | ✗ — this PR |
| `set_version` | 232-237 | `update()` with `DirectDbWriter` | ✓ (commits immediately) |
| `should_upgrade` | 240-247 | read-only | ✓ |

## Test plan

Add unit test in `consensus/src/consensus/factory.rs` `mod tests`:

```rust
#[test]
fn test_set_is_archival_node_persists_across_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let db = create_temp_db_with_path(dir.path());

    // First session: open store, set archival, drop
    {
        let mut store = MultiConsensusManagementStore::new(db.clone());
        store.set_is_archival_node(true).unwrap();
    }

    // Re-open the same DB
    let store = MultiConsensusManagementStore::new(db);
    assert_eq!(store.is_archival_node().unwrap(), true);
}

#[test]
fn test_set_is_archival_node_noop_when_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let db = create_temp_db_with_path(dir.path());

    let mut store = MultiConsensusManagementStore::new(db);
    store.set_is_archival_node(true).unwrap();
    // Second call to same value should not error and should not double-write
    store.set_is_archival_node(true).unwrap();
    assert_eq!(store.is_archival_node().unwrap(), true);
}
```

Plus the standard `./check.ps1` + `cargo nextest run --release` to confirm no regression elsewhere.

## Mainnet verification

The bug surfaces only under crash-during-30s-window-after-first-archival-flip. Reproducing this requires fault injection. Acceptable to land the fix without mainnet rehearsal, since:

1. The fix is non-consensus
2. The before-state already produces undefined behavior under the crash window
3. The after-state is straightforwardly correct (matches `set_version`'s proven pattern)

If desired by reviewers, a follow-up integration test in `testing/integration/` can simulate the crash-and-reopen cycle.

## Risk assessment

- **Consensus impact:** none. The function is called only from `Factory::new` (startup) and any future runtime archival-flip path. It does not feed into block validation.
- **API surface:** changes return type from `()` → `StoreResult<()>`. Only one caller exists in upstream (`factory.rs:286`); update accompanies this PR.
- **Performance:** identical. Both `BatchDbWriter` and `DirectDbWriter` ultimately translate to a RocksDB write; the difference is when the commit fires.
- **Backward compat:** safe. Any operator running pre-fix code who upgrades will, on first startup post-upgrade, immediately commit the correct flag via the new code path.

## Suggested PR title

`fix(consensus): commit metadata write in set_is_archival_node so the flag survives crash`

## Reviewers to tag

- `@coderofstuff` — authored retention-period support (PR #592), close to this area
- `@someone235` (Ori Newman) — archival ownership, authored PR #651 (Archival manager)
- `@michaelsutton` — consensus lead

## Related issues

- Issue #578 "Archival node" — bobpinella's October 2025 data-loss report. Not the same root cause but related blast radius.
- This PR should not close #578 directly; the upgrade-path retention root pinning bug remains and warrants a separate PR.

## Suggested issue text (open this first per maintainer culture)

> ## Bug: set_is_archival_node does not commit its WriteBatch
>
> `MultiConsensusManagementStore::set_is_archival_node` at `consensus/src/consensus/factory.rs:214-220` creates a `WriteBatch`, writes the cached metadata into it via `BatchDbWriter`, but never calls `self.db.write(batch)`. The flag persists incidentally via subsequent operations that flush the DB.
>
> `Factory::new` calls this function on every kaspad startup (line 286). A crash within the window between the cached write and the next downstream batch flush would leave the persisted flag stale, while the in-memory state believes it succeeded.
>
> This is a low-frequency bug but a real one — for an operator first enabling `--archival` and then crashing before the second pruning advance, the persisted state can silently revert.
>
> Suggested fix: refactor to use `DirectDbWriter` matching `set_version` at line 232. Happy to send a PR if this analysis lands.
