/**
 * MyKAI Discovery Worker — Cloudflare Worker (deploy with `wrangler deploy`)
 *
 * The foundation phone book + coverage aggregator. NOT a coordinator.
 * Every value this Worker holds is verifiable by participants once
 * they're in the swarm — it just speeds up bootstrap and gives the
 * coverage-bar UI a network view.
 *
 * Two endpoints, one route each:
 *
 *   POST /v1/swarm
 *     body: { nodeId, budgetGB, oldest_daa, newest_daa, kaspad_chain_tip,
 *             block_count, last_seen, endpoint? }
 *     response: { members: [...], archives: [...], generated_at, churn_storm }
 *     side-effect: upserts the heartbeat into KV with a TTL
 *
 *   GET /v1/swarm
 *     response: same as POST response (read-only view)
 *
 * Storage: Cloudflare KV. One key per nodeId. 20-min TTL — if a node
 * doesn't heartbeat within that window, it ages out automatically.
 * KV's eventual-consistency model is fine here; staleness is bounded
 * and the bar can tolerate ~minutes-old data.
 *
 * Free tier limits:
 *   - 100k KV reads/day (~120 nodes heartbeating every 5min = ~35k reads/day)
 *   - 1k KV writes/day (~12 nodes heartbeating every 5min = ~35k writes/day)
 *   ... wait, that's already over. So in practice the free tier handles
 *   ~3-10 active nodes. For real deployment, the $5/month Workers plan
 *   gives 10M reads + 1M writes — handles 1000+ active nodes easily.
 *
 * Archive-progress aggregation: counts buckets at each depth across
 * the live member list. Powers the "Archive Node #1: 100% / #2: 84%"
 * UI. Cheap — runs on every request, O(members × candidate_buckets).
 *
 * For the v0.5.3 ship: this Worker is OPTIONAL. Nodes fall back to a
 * hardcoded peer list + their own local kaspad if the Worker is down.
 * The Worker just makes the experience better — it isn't load-bearing.
 */

export interface Env {
    SWARM: KVNamespace;
}

interface HeartbeatPayload {
    nodeId: string;
    budgetGB: number;
    oldest_daa: number | null;
    newest_daa: number | null;
    kaspad_chain_tip: number | null;
    block_count: number;
    last_seen: number;
    endpoint?: string;  // public URL if reachable, else omitted
    vetted?: boolean;   // server sets this; ignored from client
}

interface Member extends HeartbeatPayload {
    first_seen: number;
    vetted: boolean;
}

const MEMBER_TTL_SEC = 20 * 60;    // 20 min — older than 2 missed heartbeats
const VETTING_WINDOW_SEC = 15 * 60; // 15 min probation before counting in HRW
const BUCKET_DAA_SIZE = 100_000;
const MAX_DEPTH_TO_REPORT = 10;
const CHURN_STORM_THRESHOLD_PCT = 20;
const CHURN_STORM_WINDOW_MS = 60 * 60 * 1000;

export default {
    async fetch(req: Request, env: Env): Promise<Response> {
        const url = new URL(req.url);

        if (url.pathname === '/health') {
            return json({ ok: true, service: 'mykai-discovery', version: '0.5.3' });
        }

        if (url.pathname !== '/v1/swarm') {
            return json({ error: 'Not found' }, 404);
        }

        // Heartbeat ingest
        if (req.method === 'POST') {
            let payload: HeartbeatPayload;
            try { payload = await req.json(); }
            catch { return json({ error: 'Invalid JSON' }, 400); }
            if (!validateHeartbeat(payload)) {
                return json({ error: 'Invalid heartbeat shape' }, 400);
            }
            await upsertMember(env, payload);
            // fall through to GET semantics — return swarm view to caller
        }
        else if (req.method !== 'GET') {
            return json({ error: 'Method not allowed' }, 405);
        }

        // Compute and return the swarm view
        const view = await buildSwarmView(env);
        return json(view);
    },
};

function validateHeartbeat(p: any): p is HeartbeatPayload {
    if (!p || typeof p !== 'object') return false;
    if (typeof p.nodeId !== 'string' || !/^node_[0-9a-f]{16,}$/.test(p.nodeId)) return false;
    if (typeof p.budgetGB !== 'number' || p.budgetGB < 0 || p.budgetGB > 1_000_000) return false;
    if (p.endpoint != null && (typeof p.endpoint !== 'string' || !/^https?:\/\//.test(p.endpoint))) return false;
    return true;
}

async function upsertMember(env: Env, p: HeartbeatPayload) {
    const key = `m:${p.nodeId}`;
    const existing = await env.SWARM.get(key, { type: 'json' }) as Member | null;
    const now = Math.floor(Date.now() / 1000);
    const first_seen = existing?.first_seen || now;
    // Vetting: a new node is unvetted until it has 15 min of continuous
    // presence. Vetted nodes count in HRW; unvetted are visible but
    // ignored for assignment purposes (the client respects this flag).
    const vetted = (now - first_seen) >= VETTING_WINDOW_SEC;
    const member: Member = {
        ...p,
        last_seen: now,
        first_seen,
        vetted,
    };
    // 20-min TTL — auto-expire if 2+ heartbeats miss in a row.
    await env.SWARM.put(key, JSON.stringify(member), { expirationTtl: MEMBER_TTL_SEC });
}

async function buildSwarmView(env: Env) {
    const now = Math.floor(Date.now() / 1000);
    const listing = await env.SWARM.list({ prefix: 'm:' });
    const members: Member[] = [];
    for (const k of listing.keys) {
        const raw = await env.SWARM.get(k.name, { type: 'json' }) as Member | null;
        if (raw) members.push(raw);
    }
    // Sort by nodeId for stable ordering (clients can re-sort).
    members.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    // Archive-progress aggregation: for each depth d in 1..MAX_DEPTH,
    // count buckets covered by at least d distinct members.
    const archives = computeArchiveProgress(members);
    // Churn-storm detection: if too many members aged out recently,
    // flag it so clients freeze drops and double their jitter.
    const churn_storm = await detectChurnStorm(env, members);
    return {
        members,
        archives,
        generated_at: now,
        churn_storm,
    };
}

function computeArchiveProgress(members: Member[]) {
    // Bucketize each member's advertised range.
    const bucketHolderCount = new Map<number, number>();
    let globalMinBucket = Number.POSITIVE_INFINITY;
    let globalMaxBucket = -1;
    for (const m of members) {
        if (!m.vetted) continue;
        if (m.oldest_daa == null || m.newest_daa == null) continue;
        if (m.oldest_daa >= m.newest_daa) continue;
        const fromBucket = Math.floor(m.oldest_daa / BUCKET_DAA_SIZE);
        const toBucket = Math.floor(m.newest_daa / BUCKET_DAA_SIZE);
        for (let b = fromBucket; b <= toBucket; b++) {
            bucketHolderCount.set(b, (bucketHolderCount.get(b) || 0) + 1);
            if (b < globalMinBucket) globalMinBucket = b;
            if (b > globalMaxBucket) globalMaxBucket = b;
        }
    }
    const totalBuckets = (globalMaxBucket - globalMinBucket + 1) | 0;
    if (totalBuckets <= 0 || !Number.isFinite(globalMinBucket)) {
        return [];
    }
    const archives = [];
    for (let depth = 1; depth <= MAX_DEPTH_TO_REPORT; depth++) {
        let filled = 0;
        for (const cnt of bucketHolderCount.values()) {
            if (cnt >= depth) filled++;
        }
        const progress_pct = totalBuckets > 0 ? (filled / totalBuckets) * 100 : 0;
        archives.push({
            depth,
            buckets_filled: filled,
            total_buckets: totalBuckets,
            progress_pct,
            complete: filled >= totalBuckets,
        });
        // Stop reporting past the first not-yet-started archive — keeps
        // the response compact and the UI's "next archive to fill" obvious.
        if (filled === 0) break;
    }
    return archives;
}

async function detectChurnStorm(env: Env, members: Member[]): Promise<boolean> {
    // Track a sliding-window count of "active members 1h ago" in KV.
    const now = Math.floor(Date.now() / 1000);
    const key = 'churn:active_count';
    const histRaw = await env.SWARM.get(key, { type: 'json' }) as { ts: number; count: number } | null;
    const currentCount = members.length;
    if (!histRaw) {
        await env.SWARM.put(key, JSON.stringify({ ts: now, count: currentCount }), { expirationTtl: 7200 });
        return false;
    }
    // Update the snapshot every 5 min to keep the comparison window honest.
    if ((now - histRaw.ts) * 1000 > 5 * 60 * 1000) {
        await env.SWARM.put(key, JSON.stringify({ ts: now, count: currentCount }), { expirationTtl: 7200 });
    }
    // If we've lost more than threshold% of the snapshot's count, flag.
    if (histRaw.count === 0) return false;
    const lossPct = ((histRaw.count - currentCount) / histRaw.count) * 100;
    return lossPct > CHURN_STORM_THRESHOLD_PCT;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
        },
    });
}
