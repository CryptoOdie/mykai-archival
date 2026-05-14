# MyKAI Node + Archival Contribution

A fork of [MyKAI Node v0.3.8](https://github.com/KasMapApp/MyKAI-Node-Public) (MIT, with author permission) that adds an **optional archival contribution feature**: your normal Kaspa node can also help preserve Kaspa's history.

**Status:** v0.5 pre-release.

See [`CHANGELOG.md`](CHANGELOG.md) for the full v0.4 + v0.5 release notes.

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
