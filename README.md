# MyKAI Archival

A sovereign Kaspa archival node host, building toward a distributed peer-to-peer shard network that **supplements** existing archival infrastructure (kaspa.org/explorer, kaspadbase.com, Kasplex) with community-driven redundancy.

**Status:** Phase 0 (pre-flight). Forked from [MyKAI Node v0.3.8](https://github.com/KasMapApp/MyKAI-Node-Public) (MIT) with author permission.

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
