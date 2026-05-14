"use strict";
/**
 * MyKAI Insights Contributor
 *
 * Sends raw network telemetry to MyKAI Insights for the global monitoring network.
 * No account needed. No IP sent (unless public). Just a random nodeId for tracking.
 * ON by default — users can opt out in settings.
 *
 * The node is a dumb relay: it buffers raw measurements from kaspad and sends them
 * as-is. All intelligence (health scores, analysis, percentiles) lives in Insights.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MonitoringContributor = void 0;
const https_1 = __importDefault(require("https"));
const http_1 = __importDefault(require("http"));
const zlib_1 = __importDefault(require("zlib"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const util_1 = require("util");
const worker_threads_1 = require("worker_threads");
const http_body_1 = require("./util/http-body");
const http_agent_1 = require("./util/http-agent");
// Electron is only present in the desktop build. The headless Docker image
// runs pure Node.js with no electron module — require() it lazily inside a
// try/catch so this file loads in either context.
let electronApp = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    electronApp = require('electron').app;
}
catch {
    electronApp = null;
}
// Async gzip — avoids blocking the event loop on multi-MB payloads.
// Kept at module level so it's a single shared binding (no per-call allocation).
const gzipAsync = (0, util_1.promisify)(zlib_1.default.gzip);
const MONITORING_URL = 'https://mykai.dev/api/network/contribute';
// Payload schema version. Bump when payload shape changes in a non-additive
// way so the server can route old/new versions to different ingest paths.
const SCHEMA_VERSION = 1;
// --- Delivery semantics (strict medallion) --------------------------------
// Raw per-event arrays only; no client-side aggregation. Durable, no data
// loss on transient failures.
const FLUSH_INTERVAL_MS = 60_000; // base cadence: every 60s (was 5 min)
const SIZE_CHECK_INTERVAL_MS = 5_000; // re-check buffer size every 5s
const SIZE_FLUSH_THRESHOLD = 8_000_000; // flush early if buffer ≳ 8 MB
const CHUNK_TARGET_BYTES = 8_000_000; // target for each HTTP request body
const DISK_SPILL_THRESHOLD = 500_000_000; // 500 MB pending → start spilling to disk
const DISK_CAP_BYTES = 5_000_000_000; // 5 GB cap; only then do we drop oldest
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const HTTP_TIMEOUT_MS = 90_000; // per insights dev — server p99 ≈ 60s
// Soft cap on raw-event arrays that otherwise grow without bound if flushes
// keep failing (Insights 500 → retry → events accumulate). 10 k entries is
// ~10× steady-state per flush cycle on a chain-active node; anything above
// this means something is wrong upstream and we're better off shedding
// oldest-first than letting the process OOM. Dropped counts ship in the
// next envelope under `droppedEventsByType` so Insights can adjust
// percentile math instead of silently under-counting.
const BUFFER_ENTRY_CAP = 10_000;
// Monitor code version — read from package.json so there's a single source of
// truth. Bump package.json "version" and every build automatically reports the
// new string in the heartbeat. Used by Insights Fleet Overview to distinguish
// nodes running old vs new code.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MONITOR_VERSION = require('../../package.json').version;
// Geo-IP is handled server-side by Insights from the request header IP.
// The node sends isPublic so Insights knows whether to store/expose the full IP.
class MonitoringContributor {
    config;
    flushTimer = null;
    sizeCheckTimer = null;
    intervalMs = FLUSH_INTERVAL_MS;
    getData = null;
    _lastSendTime = 0;
    _lastSendOk = false;
    _lastSendError = '';
    _lastSuccessTime = 0;
    _payloadBytes = 0; // raw JSON size of last flush (summed across chunks)
    _payloadBytesCompressed = 0; // gzipped size of last flush (summed across chunks)
    // Outgoing chunk queue (FIFO) — each entry is a pre-gzipped Buffer ready to POST.
    // On send failure we keep the chunk and retry with backoff; on success remove
    // from head. Chunk order within a heartbeat is preserved.
    pendingChunks = [];
    pendingBytes = 0;
    senderRunning = false;
    backoffMs = BACKOFF_INITIAL_MS;
    // Disk WAL — append-only file of gzip-encoded JSON payloads, one per line
    // (base64). Used when in-memory pending queue exceeds DISK_SPILL_THRESHOLD.
    diskQueuePath = null;
    diskQueueBytes = 0;
    // Heartbeat attempt/miss tracking — exposed in next payload so Insights
    // can see "node attempted 6 but we received 3" for missing-heartbeat
    // diagnosis (the zombie-NL pattern).
    _heartbeatAttempts = 0;
    _heartbeatMisses = 0;
    // Tier 2 diagnostic: caller stages a diagnostic object via setNextDiagnostic();
    // it's drained on the next send and attached to the heartbeat payload.
    _pendingDiagnostic = null;
    /**
     * True when the previous heartbeat response had `request_diagnostic: true`.
     * Main.ts reads it, builds a Tier-3 payload, and stages it for next send.
     */
    _diagnosticRequested = false;
    // Quality hints — set by caller before send (main.ts runs health checks,
    // stuffs the hints here, they go out with the next heartbeat).
    _nextQualityHints = null;
    // Long-lived worker_threads Worker for off-main-thread JSON.stringify + gzip.
    // See insights-worker.ts for protocol. One worker reused across flushes so
    // we don't pay spawn cost every 60 s. If the worker dies or fails to spawn,
    // flushNow falls back to the inline sync path (gzipAsync) — losing the
    // latency win for that flush but keeping telemetry flowing.
    worker = null;
    _workerNextId = 1;
    _workerPending = new Map();
    // Drop-counters (PR 5). Cumulative across a flush cycle; attached to the
    // envelope under `droppedEventsByType` on flush and reset. Counts are
    // non-zero only when the soft buffer cap (BUFFER_ENTRY_CAP) kicked in —
    // i.e. flushes were failing and the buffers grew enough that we shed
    // oldest-first instead of risking OOM. Insights uses these to adjust
    // percentile math so it knows the sample set isn't complete.
    _droppedEventsByType = {};
    /** Public buffer — main.ts pushes events directly into these arrays. */
    buffer = {
        propagationSamples: [],
        tipCountSamples: [],
        blockArrivalTimestamps: [],
        redBlockEvents: [],
        propagationOrphans: [],
        // blockBatchStats removed — Insights derives from per-block parentCount + txCount
        minedBlocks: [],
        disconnectTimestamps: [],
        peerSnapshots: [],
        chainEvents: [],
        blockFirstSeen: [],
        sinkChanges: [],
        pruningEvents: [],
        recentBlocks: [],
        finalityEvents: [],
    };
    constructor(config) {
        this.config = config;
        try {
            // Desktop: %APPDATA%/MyKAI Node/. Headless: $MYKAI_QUEUE_DIR or cwd.
            let dir = null;
            if (electronApp && typeof electronApp.getPath === 'function') {
                dir = electronApp.getPath('userData');
            }
            else {
                dir = process.env.MYKAI_QUEUE_DIR || process.cwd();
            }
            if (dir) {
                if (!fs_1.default.existsSync(dir))
                    fs_1.default.mkdirSync(dir, { recursive: true });
                this.diskQueuePath = path_1.default.join(dir, 'insights-queue.jsonl');
                if (fs_1.default.existsSync(this.diskQueuePath)) {
                    this.diskQueueBytes = fs_1.default.statSync(this.diskQueuePath).size;
                }
            }
        }
        catch {
            // As a last resort: disable disk WAL rather than crash. Events still
            // flow through memory; catastrophic outages cap at DISK_SPILL_THRESHOLD
            // worth of memory pending, after which enqueue returns without writing.
            this.diskQueuePath = null;
        }
    }
    updateConfig(config) {
        this.config = config;
        if (!config.enabled)
            this.stop();
    }
    start(getData) {
        this.getData = getData;
        this.stop();
        if (!this.config.enabled)
            return;
        // Spin up the serializer worker now so the first flush doesn't pay the
        // spawn cost on the main thread. Failure to spawn is logged and handled
        // at flush time — we'll use the sync fallback.
        this.ensureWorker();
        // Kick sender first — if there's a leftover disk queue from a prior
        // session, oldest chunks leave before any fresh data.
        this.kickSender();
        // First flush shortly after startup so UI sees activity quickly.
        // Tested 30s deferral (0.3.6 experiment); freeze still happened
        // at T+9-25 with heartbeat firing AFTER the freeze recovered.
        // Confirmed: heartbeat is NOT the structural cause of the freeze.
        // Reverted to 5s — no point delaying first telemetry when the fix
        // is elsewhere. Real cause is in the wRPC notification flood.
        setTimeout(() => this.flushNow(), 5_000);
        this.flushTimer = setInterval(() => this.flushNow(), this.intervalMs);
        this.sizeCheckTimer = setInterval(() => this.flushIfOversize(), SIZE_CHECK_INTERVAL_MS);
    }
    stop() {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.sizeCheckTimer) {
            clearInterval(this.sizeCheckTimer);
            this.sizeCheckTimer = null;
        }
        this.teardownWorker();
    }
    /** Spawn the serializer worker if we don't already have a healthy one.
     *  Called lazily from flushNow so a one-off spawn failure doesn't stop
     *  telemetry — we just use the inline path for that flush and retry next
     *  time. */
    ensureWorker() {
        if (this.worker)
            return;
        try {
            // When compiled, this file lives at dist/main/monitoring-contributor.js
            // and the worker at dist/main/insights-worker.js — sibling resolution
            // works for both asar-packaged (Electron desktop) and dist-headless.
            const workerPath = path_1.default.join(__dirname, 'insights-worker.js');
            const w = new worker_threads_1.Worker(workerPath);
            w.on('message', (msg) => {
                const pending = this._workerPending.get(msg.id);
                if (!pending)
                    return;
                this._workerPending.delete(msg.id);
                if (msg.ok && msg.gz) {
                    // postMessage delivers a Uint8Array for Buffer — rewrap so downstream
                    // Buffer APIs (length, toString, etc.) work as expected.
                    const gz = Buffer.isBuffer(msg.gz) ? msg.gz : Buffer.from(msg.gz);
                    pending.resolve({ rawBytes: msg.rawBytes ?? gz.length, gz });
                }
                else {
                    pending.reject(new Error(msg.error || 'worker returned !ok'));
                }
            });
            w.on('error', (err) => {
                // Worker crashed mid-flight. Reject all in-flight requests so
                // flushNow can fall back to the inline path for that batch.
                for (const [id, p] of this._workerPending) {
                    p.reject(err);
                    this._workerPending.delete(id);
                }
                this._lastSendError = `insights-worker error: ${err?.message || err}`;
                this.worker = null;
            });
            w.on('exit', (code) => {
                if (code !== 0) {
                    for (const [id, p] of this._workerPending) {
                        p.reject(new Error(`worker exited with code ${code}`));
                        this._workerPending.delete(id);
                    }
                }
                this.worker = null;
            });
            this.worker = w;
        }
        catch (err) {
            this._lastSendError = `insights-worker spawn failed: ${err?.message || err}`;
            this.worker = null;
        }
    }
    teardownWorker() {
        if (!this.worker)
            return;
        try {
            this.worker.terminate();
        }
        catch { /* ignore */ }
        this.worker = null;
        for (const [, p] of this._workerPending) {
            p.reject(new Error('worker torn down'));
        }
        this._workerPending.clear();
    }
    /** Serialize + gzip a payload off the main thread. Rejects if the worker
     *  is unavailable; caller falls back to the inline sync path. */
    serializeInWorker(payload) {
        return new Promise((resolve, reject) => {
            if (!this.worker)
                return reject(new Error('no worker'));
            const id = this._workerNextId++;
            this._workerPending.set(id, { resolve, reject });
            try {
                this.worker.postMessage({ id, payload });
            }
            catch (err) {
                this._workerPending.delete(id);
                reject(err);
            }
        });
    }
    get status() {
        return {
            active: this.flushTimer !== null,
            intervalMs: this.intervalMs,
            lastSendTime: this._lastSendTime,
            lastSendOk: this._lastSendOk,
            lastSendError: this._lastSendError,
            lastSuccessTime: this._lastSuccessTime,
            payloadBytes: this._payloadBytes,
            payloadBytesCompressed: this._payloadBytesCompressed,
            heartbeatAttempts: this._heartbeatAttempts,
            heartbeatMisses: this._heartbeatMisses,
            pendingChunks: this.pendingChunks.length,
            pendingBytes: this.pendingBytes,
            diskQueueBytes: this.diskQueueBytes,
        };
    }
    /** Whether the server has asked us (via previous response) to attach a Tier-3 diagnostic. */
    get isDiagnosticRequested() {
        return this._diagnosticRequested;
    }
    /** Called by main.ts after satisfying the request, to clear the flag. */
    clearDiagnosticRequest() {
        this._diagnosticRequested = false;
    }
    /** Stage a diagnostic to be attached on the next send. */
    setNextDiagnostic(tier, payload) {
        this._pendingDiagnostic = { tier, payload };
    }
    /** Stage quality hints to be attached on the next send (small compared to diagnostic). */
    setNextQualityHints(hints) {
        this._nextQualityHints = hints;
    }
    drainBuffer() {
        // Snapshot current buffer and clear. Soft per-array caps (PR 5) are
        // enforced in enforceBufferCaps() on the 5 s tick — by the time we
        // drain here, arrays are already bounded. Drop counters for the flush
        // cycle ride the envelope under `droppedEventsByType` so Insights can
        // adjust percentile math; they're reset after the envelope is built.
        // Previous behavior was "no caps by design", but the real failure mode
        // that produced is OOM, which loses more data than drop-oldest does.
        const raw = {
            propagationSamples: this.buffer.propagationSamples.splice(0),
            tipCountSamples: this.buffer.tipCountSamples.splice(0),
            blockArrivalTimestamps: this.buffer.blockArrivalTimestamps.splice(0),
            redBlockEvents: this.buffer.redBlockEvents.splice(0),
            propagationOrphans: this.buffer.propagationOrphans.splice(0),
            minedBlocks: this.buffer.minedBlocks.splice(0),
            disconnectTimestamps: this.buffer.disconnectTimestamps.splice(0),
            peerSnapshots: [...this.buffer.peerSnapshots], // latest snapshot, don't clear
            chainEvents: this.buffer.chainEvents.splice(0),
            blockFirstSeen: this.buffer.blockFirstSeen.splice(0),
            sinkChanges: this.buffer.sinkChanges.splice(0),
            pruningEvents: this.buffer.pruningEvents.splice(0),
            recentBlocks: this.buffer.recentBlocks.splice(0),
            finalityEvents: this.buffer.finalityEvents.splice(0),
        };
        return raw;
    }
    /** Build the top-level payload envelope. Caller provides the raw events
     *  subset (chunk 0 gets the full snapshot metadata; chunks 1..N-1 also
     *  carry metadata but the server is expected to ignore snapshot fields
     *  for chunkIndex > 0 per the medallion contract). */
    buildEnvelope(data, raw, chunkIndex, chunkTotal) {
        const payload = {
            schemaVersion: SCHEMA_VERSION,
            nodeId: this.config.nodeId,
            accountKey: this.config.accountKey || undefined,
            nodeName: this.config.nodeName || 'Local Node',
            heartbeatMode: this.config.heartbeatMode || 'normal',
            dataSource: this.config.heartbeatMode === 'headless' ? 'rpc' : 'log',
            monitorVersion: MONITOR_VERSION,
            isPublic: this.config.isPublic,
            network: data.network,
            status: data.status,
            daaScore: data.daaScore,
            headerCount: data.headerCount || 0,
            blockCount: data.blockCount || 0,
            startTimestamp: data.startTimestamp || 0,
            nodeVersion: data.nodeVersion,
            peerCount: data.peerCount,
            currentTps: Math.round(data.currentTps || 0),
            mempoolSize: data.mempoolSize || 0,
            sinkHash: data.sinkHash,
            pruningPointHash: data.pruningPointHash,
            sinkBlueScore: data.sinkBlueScore || 0,
            pruningPointBlueScore: data.pruningPointBlueScore || 0,
            clockOffsetMs: data.clockOffsetMs || 0,
            storageBytes: data.storageBytes || 0,
            ramBytes: data.ramBytes || 0,
            ramFreeBytes: data.ramFreeBytes || 0,
            cpuCount: data.cpuCount || 0,
            cpuVendor: data.cpuVendor || '',
            cpuFamily: data.cpuFamily || '',
            cpuClockGhz: data.cpuClockGhz || 0,
            cpuLoad1m: data.cpuLoad1m || 0,
            cpuPercentPerCore: data.cpuPercentPerCore || [],
            platform: data.platform || '',
            daaScoreAdvances: data.daaScoreAdvances || 0,
            sinkBlueScoreAdvances: data.sinkBlueScoreAdvances || 0,
            networkType: data.networkType || 'unknown',
            networkLinkSpeedMbps: data.networkLinkSpeedMbps ?? null,
            networkHasIpv6: data.networkHasIpv6 || false,
            miningActive: data.miningActive || false,
            minerCount: data.minerCount || 0,
            totalHashrateGhs: data.totalHashrateGhs || 0,
            blocksFound: data.blocksFound || 0,
            rewardKas: data.rewardKas || 0,
            // Lifetime gamification stats — see InsightsNodeData interface comment.
            // Required for cloud-side recovery (Theme 5 of the 0.3.3 plan).
            blocksValidated: data.blocksValidated ?? 0,
            transactionsSeen: data.transactionsSeen ?? 0,
            totalUptimeSeconds: data.totalUptimeSeconds ?? 0,
            longestStreakSeconds: data.longestStreakSeconds ?? 0,
            peakTps: data.peakTps ?? 0,
            firstSyncCompleted: data.firstSyncCompleted ?? false,
            sharesAccepted: data.sharesAccepted ?? 0,
            heartbeatAttempts: this._heartbeatAttempts,
            heartbeatMisses: this._heartbeatMisses,
            chunkIndex,
            chunkTotal,
            raw,
        };
        // Quality hints + staged diagnostic ride with chunk 0 only.
        if (chunkIndex === 0) {
            if (this._nextQualityHints) {
                payload.qualityHints = this._nextQualityHints;
                this._nextQualityHints = null;
            }
            if (this._pendingDiagnostic) {
                payload.raw.diagnostic = {
                    tier: this._pendingDiagnostic.tier,
                    ...this._pendingDiagnostic.payload,
                };
                this._pendingDiagnostic = null;
            }
            // Drop counts from cap enforcement. Only emit the key if we actually
            // dropped something — a zero-entry object is just noise in the logs.
            if (Object.keys(this._droppedEventsByType).length > 0) {
                payload.droppedEventsByType = { ...this._droppedEventsByType };
                this._droppedEventsByType = {};
            }
        }
        return payload;
    }
    /** Split raw event arrays roughly proportionally into N chunks. peerSnapshots
     *  (latest-state snapshot, not an event stream) rides only on chunk 0. */
    splitRaw(raw, n) {
        const eventKeys = [
            'propagationSamples', 'tipCountSamples', 'blockArrivalTimestamps',
            'redBlockEvents', 'propagationOrphans', 'minedBlocks', 'disconnectTimestamps',
            'chainEvents', 'blockFirstSeen', 'sinkChanges', 'pruningEvents',
            'recentBlocks', 'finalityEvents',
        ];
        const chunks = [];
        for (let i = 0; i < n; i++) {
            const chunk = {
                peerSnapshots: i === 0 ? raw.peerSnapshots : [],
            };
            for (const k of eventKeys) {
                const arr = raw[k];
                if (!Array.isArray(arr)) {
                    chunk[k] = [];
                    continue;
                }
                const start = Math.floor((arr.length * i) / n);
                const end = Math.floor((arr.length * (i + 1)) / n);
                chunk[k] = arr.slice(start, end);
            }
            chunks.push(chunk);
        }
        return chunks;
    }
    /** Rough per-entry byte estimates — cheap proxy for serialized size,
     *  used to decide whether to flush early. */
    estimateBufferBytes() {
        const b = this.buffer;
        // Per-entry constants are deliberately conservative (upper-bound) —
        // this estimate drives chunk-count selection in flushNow() without
        // a main-thread JSON.stringify probe. Better to over-split a single
        // flush than to ship a 12 MB chunk that the server rejects.
        // chainEvents in particular carry variable-length added/removed hash
        // arrays; the 600-byte figure accounts for the typical ~8-hash batch
        // after Crescendo.
        return 2000 /* top-level overhead */
            + b.propagationSamples.length * 8
            + b.tipCountSamples.length * 4
            + b.blockArrivalTimestamps.length * 15
            + b.disconnectTimestamps.length * 15
            + b.redBlockEvents.length * 220
            + b.propagationOrphans.length * 120
            + b.minedBlocks.length * 160
            + b.peerSnapshots.length * 220
            + b.chainEvents.length * 600
            + b.blockFirstSeen.length * 90
            + b.sinkChanges.length * 80
            + b.pruningEvents.length * 80
            + b.recentBlocks.length * 220
            + b.finalityEvents.length * 120;
    }
    bufferIsEmpty() {
        const b = this.buffer;
        return (b.propagationSamples.length === 0 &&
            b.tipCountSamples.length === 0 &&
            b.blockArrivalTimestamps.length === 0 &&
            b.disconnectTimestamps.length === 0 &&
            b.redBlockEvents.length === 0 &&
            b.propagationOrphans.length === 0 &&
            b.minedBlocks.length === 0 &&
            b.peerSnapshots.length === 0 &&
            b.chainEvents.length === 0 &&
            b.blockFirstSeen.length === 0 &&
            b.sinkChanges.length === 0 &&
            b.pruningEvents.length === 0 &&
            b.recentBlocks.length === 0 &&
            b.finalityEvents.length === 0);
    }
    flushIfOversize() {
        // Enforce per-array caps first (PR 5). If a flush is stuck (server 500s,
        // network partition), buffers otherwise grow without bound — the SIZE
        // threshold is 8 MB of _total_ which one fat array can eat through. A
        // per-array cap means no single event type can monopolize memory.
        this.enforceBufferCaps();
        if (this.estimateBufferBytes() >= SIZE_FLUSH_THRESHOLD) {
            this.flushNow();
        }
    }
    /** Drop-oldest enforcement on the volume-heavy arrays. Called every 5 s
     *  from the SIZE_CHECK timer. Only the arrays that can realistically
     *  accumulate are capped — peerSnapshots is a latest-state slot and
     *  tipCount/disconnect/sinkChange/pruningEvents/finalityEvents are
     *  naturally bounded by network cadence. */
    enforceBufferCaps() {
        const cap = BUFFER_ENTRY_CAP;
        const capped = [
            ['recentBlocks', this.buffer.recentBlocks],
            ['blockFirstSeen', this.buffer.blockFirstSeen],
            ['propagationSamples', this.buffer.propagationSamples],
            ['blockArrivalTimestamps', this.buffer.blockArrivalTimestamps],
            ['minedBlocks', this.buffer.minedBlocks],
            ['redBlockEvents', this.buffer.redBlockEvents],
            ['chainEvents', this.buffer.chainEvents],
            ['propagationOrphans', this.buffer.propagationOrphans],
        ];
        for (const [name, arr] of capped) {
            if (arr.length > cap) {
                const drop = arr.length - cap;
                arr.splice(0, drop); // drop-oldest; splice in place so the public ref stays stable
                this._droppedEventsByType[name] =
                    (this._droppedEventsByType[name] || 0) + drop;
            }
        }
    }
    /** Drain the buffer, build + serialize + gzip one or more chunk bodies,
     *  enqueue them, and kick the sender. Never awaits on the network.
     *
     *  Serialization + gzip runs in a worker thread (see insights-worker.ts)
     *  to keep the main event loop responsive during flushes. With the raw
     *  JSON routinely reaching 10 MB on chain-active nodes, a single
     *  main-thread JSON.stringify blocked the loop for ~500 ms — that
     *  window is exactly when blockAdded notifications queue in the TCP
     *  receive buffer and then drain as a spike (285 BPS observed on a
     *  ~10 BPS network). So we never stringify on the main thread: split
     *  preemptively from the cheap estimateBufferBytes() and push every
     *  chunk to the worker. Falls back to inline sync gzip only if the
     *  worker is unavailable. */
    async flushNow() {
        if (!this.getData || !this.config.enabled)
            return;
        if (this.bufferIsEmpty())
            return;
        // Keep the worker warm across flushes; respawn if it died since last flush.
        this.ensureWorker();
        const data = this.getData();
        const estimatedBytes = this.estimateBufferBytes();
        const raw = this.drainBuffer();
        this._heartbeatAttempts++;
        // Decide chunking from the pre-drain size estimate — no main-thread
        // stringify. estimateBufferBytes is intentionally conservative (lower
        // bound), so rounding up to the next chunk boundary keeps us safely
        // under CHUNK_TARGET_BYTES per chunk. Worst case: we send one extra
        // (smaller) chunk, which is benign.
        let parts;
        if (estimatedBytes <= CHUNK_TARGET_BYTES) {
            parts = [this.buildEnvelope(data, raw, 0, 1)];
        }
        else {
            const n = Math.max(2, Math.ceil(estimatedBytes / CHUNK_TARGET_BYTES));
            const rawSplit = this.splitRaw(raw, n);
            parts = rawSplit.map((r, i) => this.buildEnvelope(data, r, i, n));
        }
        let totalRawBytes = 0;
        let totalGzipBytes = 0;
        for (const part of parts) {
            try {
                let rawBytes;
                let gz;
                if (this.worker) {
                    // Off-main-thread path. Worker does JSON.stringify + gzip and
                    // transfers the result buffer back (zero-copy on the ArrayBuffer).
                    const out = await this.serializeInWorker(part);
                    rawBytes = out.rawBytes;
                    gz = out.gz;
                }
                else {
                    // Fallback: inline sync stringify + async gzip. Still blocks the
                    // loop on the stringify, but we only land here if the worker died
                    // — the flush is already degraded; the shipping-it matters more.
                    const json = JSON.stringify(part);
                    rawBytes = Buffer.byteLength(json);
                    gz = await gzipAsync(json);
                }
                totalRawBytes += rawBytes;
                totalGzipBytes += gz.length;
                this.enqueueChunk(gz);
            }
            catch (err) {
                // Worker error or gzip OOM — log and abandon this chunk; the
                // other chunks still ship. Losing is better than hanging.
                this._lastSendError = `serialize failed: ${err?.message || err}`;
            }
        }
        this._payloadBytes = totalRawBytes;
        this._payloadBytesCompressed = totalGzipBytes;
        this.kickSender();
    }
    enqueueChunk(gz) {
        this.pendingChunks.push(gz);
        this.pendingBytes += gz.length;
        // If in-memory pending exceeds the threshold, spill oldest chunks to
        // disk until back under. Keep at least one in memory so the sender can
        // make forward progress without a disk round-trip per send.
        while (this.pendingBytes > DISK_SPILL_THRESHOLD && this.pendingChunks.length > 1) {
            if (!this.spillOldestToDisk())
                break;
        }
    }
    spillOldestToDisk() {
        if (!this.diskQueuePath)
            return false;
        const oldest = this.pendingChunks.shift();
        if (!oldest)
            return false;
        try {
            // Write as base64 + newline so the file is line-separated text. One
            // line per chunk. On read we split by '\n' and decode base64.
            const line = oldest.toString('base64') + '\n';
            fs_1.default.appendFileSync(this.diskQueuePath, line);
            this.diskQueueBytes += line.length;
            this.pendingBytes -= oldest.length;
            if (this.diskQueueBytes > DISK_CAP_BYTES) {
                console.warn('[monitoring] disk queue exceeded 5GB cap; truncating');
                fs_1.default.truncateSync(this.diskQueuePath, 0);
                this.diskQueueBytes = 0;
            }
            return true;
        }
        catch (err) {
            console.warn('[monitoring] disk spill failed:', err?.message);
            this.pendingChunks.unshift(oldest);
            return false;
        }
    }
    /** Read the disk queue in one pass, decode each base64 line back to a
     *  chunk buffer, prepend into pending (oldest-first), and truncate the
     *  file. Intended to be called once when the sender starts up. */
    drainDiskQueueIntoPending() {
        if (!this.diskQueuePath || this.diskQueueBytes === 0)
            return;
        if (!fs_1.default.existsSync(this.diskQueuePath)) {
            this.diskQueueBytes = 0;
            return;
        }
        try {
            const content = fs_1.default.readFileSync(this.diskQueuePath, 'utf8');
            fs_1.default.truncateSync(this.diskQueuePath, 0);
            this.diskQueueBytes = 0;
            const lines = content.split('\n').filter((l) => l.length > 0);
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const buf = Buffer.from(lines[i], 'base64');
                    this.pendingChunks.unshift(buf);
                    this.pendingBytes += buf.length;
                }
                catch {
                    // malformed line — skip, don't crash the drain
                }
            }
        }
        catch (err) {
            console.warn('[monitoring] disk drain failed:', err?.message);
        }
    }
    /** Single background sender loop. Reentrancy-guarded — only one at a time.
     *  Processes pendingChunks FIFO. On transient failure, exponential backoff
     *  and retry the same chunk (never drop). */
    async kickSender() {
        if (this.senderRunning)
            return;
        this.senderRunning = true;
        try {
            // Oldest data leaves first: drain disk WAL before accepting any fresh
            // chunks in front of it.
            this.drainDiskQueueIntoPending();
            while (this.pendingChunks.length > 0) {
                const chunk = this.pendingChunks[0];
                try {
                    const response = await this.httpPost(MONITORING_URL, chunk);
                    // Success: dequeue, reset backoff, refresh diagnostics.
                    this.pendingChunks.shift();
                    this.pendingBytes -= chunk.length;
                    this.backoffMs = BACKOFF_INITIAL_MS;
                    this._lastSendOk = true;
                    this._lastSendTime = Date.now();
                    this._lastSuccessTime = Date.now();
                    this._lastSendError = '';
                    // Honor server directives (only meaningful on chunk 0 responses
                    // but applying on any success is harmless).
                    if (response?.next_ping_seconds && typeof response.next_ping_seconds === 'number') {
                        const newInterval = Math.max(10_000, response.next_ping_seconds * 1000);
                        if (newInterval !== this.intervalMs) {
                            this.intervalMs = newInterval;
                            if (this.flushTimer) {
                                clearInterval(this.flushTimer);
                                this.flushTimer = setInterval(() => this.flushNow(), this.intervalMs);
                            }
                        }
                    }
                    if (Array.isArray(response?.alerts) && this.config.onAlerts) {
                        this.config.onAlerts(response.alerts);
                    }
                    if (response?.request_diagnostic === true) {
                        this._diagnosticRequested = true;
                    }
                }
                catch (err) {
                    // Failure: DO NOT drop. Exponential backoff, then retry head.
                    this._lastSendOk = false;
                    this._lastSendTime = Date.now();
                    this._lastSendError = (err?.code ? `${err.code}: ` : '') + (err?.message || String(err)).substring(0, 200);
                    this._heartbeatMisses++;
                    console.warn(`[monitoring] send failed: ${this._lastSendError} — retry in ${this.backoffMs}ms ` +
                        `(pending: ${this.pendingChunks.length} chunks / ${this.pendingBytes} bytes / ` +
                        `disk: ${this.diskQueueBytes} bytes)`);
                    const delay = this.backoffMs;
                    this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
                    await new Promise((r) => setTimeout(r, delay));
                    // loop continues; head chunk retried
                }
            }
        }
        finally {
            this.senderRunning = false;
        }
    }
    httpPost(url, body) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const isHttps = parsed.protocol === 'https:';
            const mod = isHttps ? https_1.default : http_1.default;
            const agent = isHttps ? http_agent_1.sharedHttpsAgent : http_agent_1.sharedHttpAgent;
            const req = mod.request({
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname,
                agent,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Encoding': 'gzip',
                    'Content-Length': body.length,
                },
                timeout: HTTP_TIMEOUT_MS,
            }, async (res) => {
                try {
                    const responseBody = await (0, http_body_1.readBody)(res);
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(responseBody));
                        }
                        catch {
                            resolve({ ok: true });
                        }
                    }
                    else {
                        reject(new Error(`HTTP ${res.statusCode}: ${responseBody.substring(0, 200)}`));
                    }
                }
                catch (err) {
                    reject(err);
                }
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.write(body);
            req.end();
        });
    }
}
exports.MonitoringContributor = MonitoringContributor;
//# sourceMappingURL=monitoring-contributor.js.map