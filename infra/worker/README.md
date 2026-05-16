# MyKAI Discovery Worker

Cloudflare Worker that serves as the foundation phone book + coverage aggregator for the MyKAI swarm.

## Deploy

```bash
# 1. Install wrangler if you don't have it
npm install -g wrangler

# 2. Log in
wrangler login

# 3. Create the KV namespace
wrangler kv namespace create SWARM
# Copy the returned id, paste into wrangler.toml at REPLACE_WITH_KV_NAMESPACE_ID

# 4. Deploy
wrangler deploy
```

You'll get a URL like `https://mykai-discovery.<your-subdomain>.workers.dev`. Optionally add a custom domain in the Cloudflare dashboard to make it `https://discovery.mykai.io`.

## Configure MyKAI nodes to point at it

In each MyKAI install's `mykai-archival-config.json` (in the userData directory):

```json
{
  "swarmDiscoveryUrl": "https://discovery.mykai.io/v1/swarm"
}
```

Or hardcode the production URL in `src/dist/main/main.js`'s `SWARM_DEFAULT_URL` constant.

## What it does

- Accepts heartbeat POSTs every 5 min from each node
- Stores them in KV with a 20-min TTL (so a node that misses 2 heartbeats is auto-removed)
- Returns the aggregated member list + per-archive progress + churn-storm flag

## What it does NOT do

- It is **not a coordinator.** Every value it returns is verifiable by the swarm.
- It is **not load-bearing.** If the Worker is down, nodes fall back to local kaspad + seed sources.
- It does **not store block data.** Only membership metadata.

## Cost

- Free tier (100k reads / 1k writes per day): supports ~3-10 active nodes.
- $5/month Workers Paid plan (10M reads / 1M writes per day): supports ~1000+ nodes comfortably.
- For 10,000+ nodes, KV write spend becomes meaningful (~$50/month). At that point, switch storage to Cloudflare D1 (relational, much cheaper at scale).
