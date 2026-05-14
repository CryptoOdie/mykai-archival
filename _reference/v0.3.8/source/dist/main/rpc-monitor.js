"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RpcMonitor = void 0;
const events_1 = require("events");
const ws_1 = __importDefault(require("ws"));
const perf_hot_1 = require("./perf-hot");
const perf_stalls_1 = require("./perf-stalls");
/** Drop the prefix of `arr` whose values are < cutoff. Single splice instead
 *  of repeated shift() — shift() is O(N) (memmove of all remaining elements),
 *  so K shifts on an N-array is O(N×K). splice(0, K) is one O(N) pass. */
function pruneExpired(arr, cutoff) {
    let i = 0;
    while (i < arr.length && arr[i] < cutoff)
        i++;
    if (i > 0)
        arr.splice(0, i);
}
/**
 * RPC monitor for kaspad — simple polling with connection guard.
 * Polls getInfo, getBlockDagInfo, getConnectedPeerInfo every 2 seconds.
 * Uses notifyVirtualChainChanged subscription for live TPS only.
 */
class RpcMonitor extends events_1.EventEmitter {
    // Two WebSockets, same kaspad wRPC JSON endpoint.
    //
    // wsRpc  — sends all poll requests (getInfo, getBlockDagInfo,
    //          getConnectedPeerInfo) and red-block enrichment (getBlock).
    //          Receives ID-matched responses. Request/response only.
    //
    // wsNotify — carries the `subscribe` request and receives ALL subsequent
    //            push notifications (BlockAdded, VirtualChainChanged, etc.).
    //            kaspad's wRPC registers notification delivery on the socket
    //            that issued `subscribe`, so subscribe MUST be sent here.
    //
    // Why: originally these shared a single socket, which meant ~10 BPS
    // notification delivery competed on the same TCP pipe as the 1s poll
    // cycle + fire-and-forget getBlock calls from VirtualChainChanged
    // (one per added chain block). Under chain-active periods that created
    // genuine WebSocket backpressure — notifications arrived in bursts.
    // Splitting the channels isolates the two traffic patterns: a poll
    // timeout or a slow getBlock can no longer stall notification delivery.
    //
    // The sockets heal independently — a failed notify socket won't tear
    // down RPC and vice versa. Protocol is legal: rusty-kaspa wRPC supports
    // multiple concurrent connections per client.
    wsRpc = null;
    wsNotify = null;
    _connectingRpc = false;
    _connectingNotify = false;
    pollTimer = null;
    pending = new Map();
    _nextId = 1;
    _status;
    jsonUrl;
    borshUrl;
    lastKnownPeerCount = 0;
    _managerPeerCount = 0;
    subscribed = false;
    _loggedFirstPoll = false;
    _lastSinkHash = '';
    _lastFetchedSinkHash = '';
    _lastPruningPointHash = '';
    _uptimeGetter = null;
    // Rolling TPS from subscription-based accepted transaction IDs
    _txSamples = [];
    _currentTps = 0;
    // Subscription-driven counters — silently increment on notifications,
    // read + reset by the heartbeat drain. No UI path, no event emissions.
    _daaScoreAdvances = 0;
    _sinkBlueScoreAdvances = 0;
    // Sink block's blue score, captured during the existing per-poll
    // getBlock(sink) call (already done for propagation samples). Sent in
    // every heartbeat so the server can compute `block_finality_passed`
    // per block as `(sinkBlueScore - block.blueScore) > 432_000` (the
    // 12-hour Kaspa mainnet finality threshold).
    _sinkBlueScore = 0;
    // Pruning point block's blue score. Updated only when pruningPointHash
    // changes (rare — advances roughly every finality window). Sent in every
    // heartbeat so the server can compute `block_pruning_passed` per block as
    // `pruningPointBlueScore > block.blueScore` — using kaspad's empirical
    // pruning advancement instead of a theoretical block-count threshold.
    _pruningPointBlueScore = 0;
    _lastFetchedPruningPointHash = '';
    // Rolling DAA score samples for activity-feed BPS. DAA increments by
    // exactly 1 per network block, so deltas over a window are the true
    // block rate — independent of notification merge-set inflation and
    // immune to event-loop stalls compressing callback timestamps.
    // Populated by the getBlockDagInfo poll (1s cadence on subscribed nodes,
    // see scheduleNextPoll). At 1 Hz with a 10s window we hold ~10 samples.
    _daaSamples = [];
    // Parallel high-density DAA score samples populated from the
    // VirtualDaaScoreChanged notification (~10-14 Hz on synced mainnet —
    // kaspad's virtual processor flushes its batch queue at that rate).
    // Used by getDaaEventBps() for an alternate activity-feed BPS source
    // we're A/B-testing against the poll-based getDaaBps(). Same window
    // (10s) holds 100-140 samples — far denser than the poll source —
    // which should eliminate the 5-second plateau and burst-quantization
    // artifacts visible during catch-up.
    _daaEventSamples = [];
    // Diagnostic flags — fire a one-time log when first notification arrives
    // per subscription type, so we can tell if a subscribe went through.
    _blockAddedSeen = false;
    _loggedMissingHash = false;
    _loggedEmptyParents = false;
    // Timestamps exposed for the diagnostic report
    _lastBlockAddedTs = 0;
    _peersInbound = 0;
    _peersOutbound = 0;
    // Red-block enrichment queue — chain block hashes waiting for a `getBlock`
    // call. Previously each VirtualChainChanged addedChainBlockHashes entry
    // fired a parallel getBlock, so a batched VCC with N entries meant N
    // simultaneous RPC requests on wsRpc. With the split-socket world from
    // PR 2 that no longer stalls BlockAdded delivery, but it still bursts
    // the RPC socket and makes poll timeouts more likely. Serialize through
    // a single-concurrency worker with 50 ms pacing between calls — 20 calls/s
    // is plenty for post-Crescendo chain rate (which is < 10 BPS).
    _redBlockQueue = [];
    _redBlockWorkerRunning = false;
    static RED_BLOCK_PACE_MS = 50;
    // Wall-clock time of the last successful getInfo that populated mempoolSize.
    // Consumed by the diagnostic report to render a staleness flag — the
    // getInfo.catch(() => null) swallowing means the displayed value can persist
    // indefinitely across poll timeouts without this indicator. Threshold is
    // applied at render time (see diagnostic.ts).
    _lastMempoolUpdateMs = 0;
    // Separate backpressure flag so we log the rpc socket being swamped only
    // once per run — purely diagnostic, not a control signal.
    _wsRpcBackpressureLogged = false;
    // Last 5 notification method names received, for perf-stalls context.
    // Cheap ring; keeps just enough to attribute "what was kaspad sending
    // when the loop stalled?" without bloating memory. Updated in
    // handleMessage right after method extraction.
    _recentMethods = [];
    // Yield-aware message queue. When kaspad floods us with backfill from
    // a peer-flood or post-reconnect catch-up, the WebSocket library can
    // emit dozens of `'message'` events synchronously while parsing one
    // TCP recv buffer — all on the same event-loop tick. Without yielding,
    // the loop is held for the duration of all the JSON.parse + dispatch
    // work, which on real machines we've measured at >1 s. Symptom: 5-sec
    // gaps in the activity feed, BPS spikes from sample-timestamp
    // clustering, missed setInterval ticks downstream.
    //
    // Pattern: enqueue every 'message' here, schedule one setImmediate
    // drain. The drain processes up to YIELD_BATCH_SIZE messages, then
    // schedules another setImmediate if more remain — letting the loop
    // run other I/O between batches. Adds ~1µs per message in low-load
    // (one queue push + one setImmediate); under load, prevents the
    // unbounded synchronous fan-out.
    _messageQueue = [];
    _drainScheduled = false;
    // 0.3.6 experiment iteration: reduced from 50 to 10. With 50, a batch
    // of heavy notifications during catch-up (BlockAdded fan-out + VCC
    // txIds iteration + monitoring buffer pushes) could exceed 1 second
    // wall-clock per batch — starving the activity-feed setInterval and
    // producing the user-visible "freeze" (UI silence). 10 messages per
    // batch keeps each batch under ~200 ms even in worst-case catch-up,
    // letting the 1Hz activity feed continue ticking through the storm.
    static YIELD_BATCH_SIZE = 10;
    // Rolling-window counters used to attribute underfeeding. When the activity
    // feed shows 3 BPS on a 10-BPS network, we need to know: is kaspad sending
    // us only 3 notifications/s (server-side), or sending 10 and we're emitting
    // 3 (client-side parse failure)? These count at the earliest and latest
    // points of the notification pipeline. Both use a timestamped-sample ring
    // buffer so the rate is correct even when the event loop stalls.
    _notifyRawSamples = []; // ts of every wsNotify message
    _rpcRawSamples = []; // ts of every wsRpc message
    _blockAddedSamples = []; // ts of every emitted block-added
    // Per-method notification counter + per-drop-reason counter for the
    // BlockAdded branch. Answers "which of the five subscriptions is actually
    // firing, and where are BlockAdded notifications dying?" in one diagnostic.
    // Cumulative-since-start — the diagnostic renders raw totals.
    _methodCounts = new Map();
    _blockAddedDrops = {
        noCandidateBlock: 0, // method matched but no candidate had header/verboseData
        noHash: 0, // block found but hash extraction failed
    };
    _blockAddedAccepts = 0;
    /** Whether our wRPC subscriptions are currently active. */
    get isSubscribed() { return this.subscribed; }
    /** Unix-ms of the most recent blockAdded notification (0 if never). */
    get lastBlockAddedTs() { return this._lastBlockAddedTs; }
    /** Inbound peer count from the latest peer-details sample. */
    get peersInbound() { return this._peersInbound; }
    /** Outbound peer count from the latest peer-details sample. */
    get peersOutbound() { return this._peersOutbound; }
    /** Unix-ms when mempoolSize last came from a live getInfo response.
     *  0 if never. Consumed by the diagnostic for staleness warnings. */
    get lastMempoolUpdateMs() { return this._lastMempoolUpdateMs; }
    /** Last 5 notification method names received. For perf-stalls attribution. */
    get recentMethods() { return [...this._recentMethods]; }
    /** Buffer sizes for perf-stalls context — what state was the monitor in when something stalled. */
    get bufferSizes() {
        return {
            _daaSamples: this._daaSamples.length,
            _daaEventSamples: this._daaEventSamples.length,
            _blockAddedSamples: this._blockAddedSamples.length,
            _notifyRawSamples: this._notifyRawSamples.length,
            _rpcRawSamples: this._rpcRawSamples.length,
            _redBlockQueue: this._redBlockQueue.length,
            _messageQueue: this._messageQueue.length,
            _txSamples: this._txSamples.length,
        };
    }
    /** Current outbound-queued bytes on each socket — direct read of TCP backpressure. */
    get socketBuffered() {
        return {
            rpc: this.wsRpc?.bufferedAmount ?? 0,
            notify: this.wsNotify?.bufferedAmount ?? 0,
        };
    }
    /** Current outbound-queued bytes on the RPC socket. 0 when idle / no socket.
     *  A non-trivial number means the OS TCP buffer couldn't be flushed as fast
     *  as we queued writes — a direct measurement of RPC-side backpressure. */
    get wsRpcBufferedBytes() {
        return this.wsRpc?.bufferedAmount ?? 0;
    }
    /** Rate snapshots for underfeeding attribution. `notifyRawBps` is the raw
     *  wsNotify message arrival rate; `blockAddedBps` is the rate at which we
     *  successfully parse + emit block-added events. If these disagree, the
     *  gap is on the client side (parse failure, shape mismatch). If they
     *  agree but are below network BPS, the gap is on the kaspad / network side. */
    getNotifyRates(windowMs = 10_000) {
        const cutoff = Date.now() - windowMs;
        // Index-find + single splice instead of repeated shift(). Each shift() is
        // an O(N) memmove of the remaining elements, so K shifts on an N-entry
        // array is O(N×K) — quadratic. One splice(0, K) does the same work in
        // a single O(N) memmove. The push-site cap means N stays ≤ 1000, but the
        // splice form is also more honest about what we're doing: drop the
        // expired prefix in one shot.
        pruneExpired(this._notifyRawSamples, cutoff);
        pruneExpired(this._rpcRawSamples, cutoff);
        pruneExpired(this._blockAddedSamples, cutoff);
        const sec = windowMs / 1000;
        return {
            notifyRawBps: this._notifyRawSamples.length / sec,
            rpcRawBps: this._rpcRawSamples.length / sec,
            blockAddedBps: this._blockAddedSamples.length / sec,
        };
    }
    /** Activity-feed BPS derived from DAA score deltas. DAA increments by
     *  exactly 1 per network block, so this is immune to:
     *   - notification merge-set inflation (blockAddedNotification can fire
     *     more than once per block when the virtual chain reorganizes),
     *   - event-loop stalls compressing callback timestamps into bursts.
     *  Returns 0 when there aren't enough samples yet (cold start) so the
     *  caller can fall back to the legacy callback-based rate. */
    getDaaBps(windowMs = 10_000) {
        const cutoff = Date.now() - windowMs;
        while (this._daaSamples.length > 0 && this._daaSamples[0].ts < cutoff)
            this._daaSamples.shift();
        if (this._daaSamples.length < 2)
            return 0;
        const first = this._daaSamples[0];
        const last = this._daaSamples[this._daaSamples.length - 1];
        const elapsedSec = (last.ts - first.ts) / 1000;
        if (elapsedSec <= 0)
            return 0;
        return Math.max(0, (last.daaScore - first.daaScore) / elapsedSec);
    }
    /** Parallel BPS from the high-density VirtualDaaScoreChanged notification
     *  stream (~14 Hz natural). Same delta math as getDaaBps but ~10× more
     *  samples in the same window, so per-batch quantization drops out and
     *  catch-up bursts present as smooth excursions instead of plateaus.
     *
     *  `minSpanMs` is a cold-start guard: if the samples in the window only
     *  span a short time (e.g. ~0.5s right after launch with 5 samples),
     *  the BPS calculation overestimates wildly because the denominator is
     *  tiny while the network rate over that 0.5s could be any value.
     *  Returning 0 keeps the activity feed silent until we have enough
     *  observation span to compute a meaningful rate. Default 5s. */
    getDaaEventBps(windowMs = 10_000, minSpanMs = 5_000) {
        const cutoff = Date.now() - windowMs;
        while (this._daaEventSamples.length > 0 && this._daaEventSamples[0].ts < cutoff)
            this._daaEventSamples.shift();
        if (this._daaEventSamples.length < 2)
            return 0;
        const first = this._daaEventSamples[0];
        const last = this._daaEventSamples[this._daaEventSamples.length - 1];
        const spanMs = last.ts - first.ts;
        if (spanMs < minSpanMs)
            return 0;
        const raw = Math.max(0, (last.daaScore - first.daaScore) / (spanMs / 1000));
        // Sanity ceiling at 1,000 BPS — that's beyond hardware-realistic
        // kaspad throughput. The previous clamp at 50 BPS was added during
        // the bug era when raw values >50 almost certainly indicated a
        // local-ingest artifact (event-loop stalls + sample-timestamp
        // clustering). Those root causes are now fixed:
        //   - Worker-thread JSON.stringify (no event-loop stalls)
        //   - Yield-aware message queue (no synchronous notification floods)
        //   - Split RPC sockets (no notify-side backpressure)
        //   - Per-depth histogram (no merge-set re-fire double-count)
        //
        // What used to look "impossible" — 98 BPS during catchup after a
        // brief restart — is genuine kaspad backlog-processing throughput.
        // Showing it informs the user; clamping it actively misleads. The
        // catching-up-vs-steady-state classifier in main.ts then frames the
        // value with appropriate copy ("Catching up 😅 Processing 98 BPS"
        // vs "Settling 10.5 BPS").
        //
        // 1,000 BPS still fires recordClampFire so any genuinely impossible
        // value (true bug producing 10,000 BPS) is logged and suppressed.
        if (raw > 1000) {
            (0, perf_stalls_1.recordClampFire)(raw, 1000);
            return 1000;
        }
        return raw;
    }
    /** Like getDaaEventBps but returns the raw, unclamped value. Used by
     *  the diagnostic dump's three-rate truth table — we want to see
     *  divergence in the report even if the activity feed reads clamped. */
    getDaaEventBpsRaw(windowMs = 10_000, minSpanMs = 5_000) {
        const cutoff = Date.now() - windowMs;
        // Don't mutate the buffer here — the clamped variant above already
        // prunes old entries on its own ticks; this read-only sibling
        // shouldn't double-prune.
        const buf = this._daaEventSamples.filter(s => s.ts >= cutoff);
        if (buf.length < 2)
            return 0;
        const first = buf[0];
        const last = buf[buf.length - 1];
        const spanMs = last.ts - first.ts;
        if (spanMs < minSpanMs)
            return 0;
        return Math.max(0, (last.daaScore - first.daaScore) / (spanMs / 1000));
    }
    /** Per-method notification histogram + BlockAdded drop-reason counters.
     *  Cumulative since start. If `blockadded*` count is high but
     *  `blockAddedAccepts` is low, the drop-reason counters will localize
     *  the failure — typically noCandidateBlock (shape mismatch, kaspad
     *  shipped the notification in an envelope our parser doesn't know). */
    getNotifyStats() {
        return {
            byMethod: [...this._methodCounts.entries()].sort((a, b) => b[1] - a[1]),
            blockAddedAccepts: this._blockAddedAccepts,
            blockAddedDrops: { ...this._blockAddedDrops },
        };
    }
    _seenMethods;
    // Inter-arrival + score-delta tracking for the perf-hot DAA forensics.
    // Both 0 means "no prior notification yet"; first notification just
    // initializes them.
    _lastDaaNotifTs = 0;
    _lastDaaScore = 0;
    // BlockAdded inter-arrival tracking — Theseus cross-check. If BlockAdded
    // fires uniformly while DAA fires uniformly but daaScore freezes, the
    // virtual processor is stalled while both notification streams continue.
    _lastBlockAddedNotifTs = 0;
    constructor(jsonPort = 18110, borshPort = 17110, host = '127.0.0.1') {
        super();
        this.jsonUrl = `ws://${host}:${jsonPort}`;
        this.borshUrl = `ws://localhost:${borshPort}`;
        this._status = this.defaultStatus();
    }
    get status() {
        return { ...this._status };
    }
    defaultStatus() {
        return {
            state: 'stopped',
            syncProgress: 0,
            syncDetail: '',
            peerCount: 0,
            daaScore: 0,
            blockCount: 0,
            headerCount: 0,
            mempoolSize: 0,
            networkName: '',
            serverVersion: '',
            isUtxoIndexed: false,
            uptimeSeconds: 0,
            wrpcEndpoint: this.borshUrl,
            rpcConnected: false,
            sinkHash: '',
            pruningPointHash: '',
        };
    }
    start(uptimeGetter) {
        const preservedState = this._status.state;
        this.stop();
        this._uptimeGetter = uptimeGetter;
        if (preservedState !== 'stopped') {
            this._status.state = preservedState;
        }
        this.scheduleNextPoll(0);
    }
    stop() {
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        this.disconnect();
        this._status = this.defaultStatus();
        this.lastKnownPeerCount = 0;
        this._uptimeGetter = null;
        this._connectingRpc = false;
        this._connectingNotify = false;
        this.subscribed = false;
        // Drop queued red-block fetches — the sockets are gone, they'd just
        // fail anyway. The worker loop exits on next tick when it finds the
        // queue empty.
        this._redBlockQueue = [];
    }
    setState(state) { this._status.state = state; }
    setSyncDetail(detail) { this._status.syncDetail = detail; }
    setSyncProgress(progress) { this._status.syncProgress = progress; }
    /** Accept peer count from log parsing as fallback */
    setManagerPeerCount(count) {
        this._managerPeerCount = count;
        if (this._status.peerCount === 0 && count > 0) {
            this._status.peerCount = count;
        }
    }
    /** Full disconnect — both sockets, all pending rejected. Used by stop(). */
    disconnect() {
        for (const [, req] of this.pending) {
            clearTimeout(req.timer);
            req.reject(new Error('Disconnected'));
        }
        this.pending.clear();
        this.subscribed = false;
        this.closeSocket('rpc');
        this.closeSocket('notify');
    }
    /** Close one socket; reject only that socket's pending entries.
     *  The OTHER socket keeps its pending entries alive — they're unrelated. */
    disconnectOne(kind) {
        for (const [id, req] of [...this.pending]) {
            if (req.kind === kind) {
                clearTimeout(req.timer);
                req.reject(new Error(`Disconnected (${kind})`));
                this.pending.delete(id);
            }
        }
        if (kind === 'notify')
            this.subscribed = false;
        this.closeSocket(kind);
    }
    /** Tear down a socket's handlers + close it. Safe to call when null. */
    closeSocket(kind) {
        const ws = kind === 'rpc' ? this.wsRpc : this.wsNotify;
        if (!ws)
            return;
        // Remove all listeners before closing — otherwise each reconnect
        // accumulates callbacks on old socket objects that prevent GC and
        // keep libuv handles alive. Over hours this exhausts handle pools.
        try {
            ws.removeAllListeners();
        }
        catch { /* ignore */ }
        try {
            ws.close();
        }
        catch { /* ignore */ }
        if (kind === 'rpc')
            this.wsRpc = null;
        else
            this.wsNotify = null;
    }
    /** Connect one socket with guard — prevents concurrent attempts per kind. */
    async ensureConnected(kind) {
        const cur = kind === 'rpc' ? this.wsRpc : this.wsNotify;
        if (cur && cur.readyState === ws_1.default.OPEN)
            return true;
        const isConnecting = () => kind === 'rpc' ? this._connectingRpc : this._connectingNotify;
        const setConnecting = (v) => {
            if (kind === 'rpc')
                this._connectingRpc = v;
            else
                this._connectingNotify = v;
        };
        if (isConnecting())
            return false;
        setConnecting(true);
        this.disconnectOne(kind);
        try {
            return await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    setConnecting(false);
                    resolve(false);
                }, 3000);
                try {
                    // 0.3.6 freeze investigation: disable perMessageDeflate.
                    // Default ws config enables permessage-deflate compression,
                    // which runs zlib decompression on libuv worker threads for
                    // every frame. process.cpuUsage() includes worker-thread CPU.
                    // The mystery 7.6s of CPU work invisible to our handler-level
                    // instrumentation could be deflate processing kaspad's
                    // notification stream. Localhost wRPC = no bandwidth concern,
                    // so disabling compression is free.
                    const ws = new ws_1.default(this.jsonUrl, { perMessageDeflate: false });
                    if (kind === 'rpc')
                        this.wsRpc = ws;
                    else
                        this.wsNotify = ws;
                    ws.on('open', () => {
                        clearTimeout(timeout);
                        setConnecting(false);
                        this.emit('activity', `RPC ${kind} connected to ${this.jsonUrl}`);
                        resolve(true);
                    });
                    ws.on('message', (data) => {
                        // Time the toString() conversion separately. This runs SYNC
                        // on the main thread BEFORE our queue + drain logic. With
                        // big buffers (compressed kaspad notifications can be MB
                        // when a peer-flood backfill arrives), this conversion is
                        // not negligible and was outside our handleMessage timing.
                        const __toStringStart = Date.now();
                        const raw = data.toString();
                        const __toStringDur = Date.now() - __toStringStart;
                        this._messageQueue.push({ raw, kind });
                        this._scheduleQueueDrain();
                        try {
                            if (__toStringDur > 0) {
                                require('./perf-stalls').recordHandlerTiming(`bufferToString(${data.length}B)`, __toStringDur);
                            }
                        }
                        catch { /* perf-stalls not init — skip */ }
                    });
                    ws.on('error', (err) => {
                        clearTimeout(timeout);
                        setConnecting(false);
                        if (kind === 'rpc')
                            this.wsRpc = null;
                        else
                            this.wsNotify = null;
                        // Only log non-ECONNREFUSED errors (ECONNREFUSED is expected during startup)
                        const msg = err?.message || String(err);
                        if (!msg.includes('ECONNREFUSED')) {
                            this.emit('activity', `RPC ${kind} error: ${msg}`);
                        }
                        resolve(false);
                    });
                    ws.on('close', () => {
                        if (kind === 'rpc')
                            this.wsRpc = null;
                        else {
                            this.wsNotify = null;
                            this.subscribed = false;
                        }
                    });
                }
                catch (e) {
                    clearTimeout(timeout);
                    setConnecting(false);
                    resolve(false);
                }
            });
        }
        catch {
            setConnecting(false);
            return false;
        }
    }
    /** Schedule (or piggyback onto a scheduled) drain of the message
     *  queue. Each drain processes up to YIELD_BATCH_SIZE messages then
     *  reschedules itself if more remain. The setImmediate boundary
     *  between batches lets activity-feed setInterval ticks, renderer
     *  IPC drain, and incremental GC run during a flood. */
    _scheduleQueueDrain() {
        if (this._drainScheduled)
            return;
        this._drainScheduled = true;
        setImmediate(() => {
            this._drainScheduled = false;
            let processed = 0;
            while (this._messageQueue.length > 0 && processed < RpcMonitor.YIELD_BATCH_SIZE) {
                const msg = this._messageQueue.shift();
                try {
                    this.handleMessage(msg.raw, msg.kind);
                }
                catch (err) {
                    // Don't let one malformed message kill the drain. Errors here
                    // are very rare in practice — handleMessage already wraps
                    // JSON.parse in try/catch — but a defensive guard keeps the
                    // queue draining if anything throws.
                    this.emit('activity', `RPC drain error: ${err?.message ?? err}`);
                }
                processed++;
            }
            // More work? Yield and continue. The loop runs other I/O between.
            if (this._messageQueue.length > 0)
                this._scheduleQueueDrain();
        });
    }
    /** Current queue depth — exposed for the perf-stalls context provider
     *  so a stall entry can show whether the queue was backed up. */
    get messageQueueDepth() {
        return this._messageQueue.length;
    }
    handleMessage(raw, source) {
        // Always-on timing wrapper (0.3.6 iteration, hunting the freeze
        // root cause). Records to perf-stalls.log if any single handler
        // call takes > 50 ms. During the catch-up freeze, this should
        // expose exactly which method was the slow one. Implemented as
        // a try/finally so even if the handler throws, the timing record
        // still fires. The method name is captured AFTER JSON.parse, so
        // a parse failure logs as 'parse-error'.
        const __callStart = Date.now();
        let __slowMethodName = 'unknown';
        try {
            return this._handleMessageInner(raw, source, (m) => { __slowMethodName = m; });
        }
        finally {
            const __callDur = Date.now() - __callStart;
            try {
                const ps = require('./perf-stalls');
                // Always record (cheap accumulator) so the periodic per-method
                // dump shows the cumulative time even when no single call is
                // slow. The single-call >50ms warning still fires alongside.
                ps.recordHandlerTiming(__slowMethodName, __callDur);
                if (__callDur > 50)
                    ps.recordSlowHandler(__slowMethodName, __callDur);
            }
            catch { /* perf-stalls not init — skip */ }
        }
    }
    /** Inner body of handleMessage, separated so the outer wrapper can
     *  unconditionally time the call without indenting the entire body. */
    _handleMessageInner(raw, source, setMethodName) {
        const __mark = (0, perf_hot_1.startMark)(); // perf-hot: full-message-handling time
        // Attribution counter (PR 5 follow-up). Count every raw message per
        // socket BEFORE we parse, so even malformed JSON doesn't escape the
        // tally. If BlockAdded notifications are ending up on wsRpc instead
        // of wsNotify (kaspad v1.1.0 may route by a different rule than we
        // assumed), the rpc-side counter climbs while notify-side stays flat.
        const __now = Date.now();
        // Hard cap on the rolling-sample arrays. Without this, the arrays grow
        // unbounded between getNotifyRates() calls — and getNotifyRates is only
        // called by the diagnostic builder (user click) or on a Tier-2 trigger,
        // both of which can stay quiet for hours on a healthy node. After ~9h
        // of synced operation that's ~1.7 M entries, and a click would then
        // execute O(N×K) shift() pruning for hours — the renderer/main freeze
        // we kept hitting. Drop-oldest in batches of 500 keeps the array bounded
        // at 1000 (≈20 s of headroom over the 10 s window). splice(0, 500) does
        // one O(N) memmove instead of N×O(N) for repeated shift().
        if (source === 'notify') {
            this._notifyRawSamples.push(__now);
            if (this._notifyRawSamples.length > 1000)
                this._notifyRawSamples.splice(0, 500);
        }
        else {
            this._rpcRawSamples.push(__now);
            if (this._rpcRawSamples.length > 1000)
                this._rpcRawSamples.splice(0, 500);
        }
        try {
            const __parseMark = (0, perf_hot_1.startMark)();
            const msg = JSON.parse(raw);
            (0, perf_hot_1.endMark)(`rpc.JSON.parse.${source}`, __parseMark);
            const id = msg.id;
            const method = msg.method;
            const params = msg.params || {};
            // Capture method name for the slow-handler timing wrapper above.
            setMethodName(method || (id != null ? `response.id=${id}` : 'unknown'));
            // Recent-methods ring (size 5) for perf-stalls attribution.
            if (method) {
                this._recentMethods.push(method);
                if (this._recentMethods.length > 5)
                    this._recentMethods.shift();
            }
            // Response to a pending request. ID namespace is shared across both
            // sockets (single _nextId counter), so a straight lookup is safe —
            // whichever socket the response arrived on, the id uniquely matches
            // one pending entry. Typical traffic: subscribe-responses arrive on
            // wsNotify, everything else on wsRpc, but the lookup doesn't care.
            if (id != null && this.pending.has(id)) {
                const req = this.pending.get(id);
                clearTimeout(req.timer);
                this.pending.delete(id);
                req.resolve(msg);
                (0, perf_hot_1.endMark)(`rpc.handleMessage.response.${source}`, __mark);
                return;
            }
            // Subscription notification (no matching pending id). These should
            // only arrive on wsNotify in steady state; if one shows up on wsRpc
            // it's harmless — we route through the same handler.
            if (method) {
                // perf-hot: classify method once and time the dispatch with that
                // bucket name. Lets us see "blockAdded handler costs Xms/sec" vs
                // "virtualChainChanged costs Yms/sec" separately.
                if ((0, perf_hot_1.isPerfHotEnabled)()) {
                    const __notifMark = (0, perf_hot_1.startMark)();
                    const ml = method.toLowerCase();
                    // Inter-arrival histogram for VirtualDaaScoreChanged specifically.
                    // Theseus-the-bug-hunter flagged the 0.1 BPS readings as worth
                    // verifying upstream-vs-downstream. If notifications arrive in
                    // tight bursts with multi-second gaps, we'd see the histogram
                    // skew bimodal. If they arrive uniformly while daaScore stays
                    // frozen, kaspad's virtual processor is stalled. Different
                    // signals, different fixes.
                    // BlockAdded inter-arrival cross-check (Theseus's suggestion).
                    // Comparison with VirtualDaaScoreChanged inter-arrival lets us
                    // attribute precisely:
                    //   - BlockAdded smooth + DAA bursty → virtual processor batches
                    //   - Both bursty                    → network/P2P-layer burstiness
                    //   - Both smooth + DAA frozen       → virtual processor stalls
                    //     while the notification stream continues (Q1 hypothesis B)
                    if (ml.includes('blockadded')) {
                        const now = Date.now();
                        if (this._lastBlockAddedNotifTs > 0) {
                            const dt = now - this._lastBlockAddedNotifTs;
                            let bucket = '5000+';
                            if (dt < 50)
                                bucket = '0_50';
                            else if (dt < 100)
                                bucket = '50_100';
                            else if (dt < 200)
                                bucket = '100_200';
                            else if (dt < 500)
                                bucket = '200_500';
                            else if (dt < 1000)
                                bucket = '500_1k';
                            else if (dt < 2000)
                                bucket = '1k_2k';
                            else if (dt < 5000)
                                bucket = '2k_5k';
                            const m = (0, perf_hot_1.startMark)();
                            (0, perf_hot_1.endMark)(`blockAdded.interarrival.${bucket}`, m);
                        }
                        this._lastBlockAddedNotifTs = now;
                    }
                    if (ml.includes('virtualdaascorechanged')) {
                        const now = Date.now();
                        if (this._lastDaaNotifTs > 0) {
                            const dt = now - this._lastDaaNotifTs;
                            // Bucket boundaries: 0-50, 50-100, 100-200, 200-500, 500-1000,
                            //                    1000-2000, 2000-5000, 5000+
                            let bucket = '5000+';
                            if (dt < 50)
                                bucket = '0_50';
                            else if (dt < 100)
                                bucket = '50_100';
                            else if (dt < 200)
                                bucket = '100_200';
                            else if (dt < 500)
                                bucket = '200_500';
                            else if (dt < 1000)
                                bucket = '500_1k';
                            else if (dt < 2000)
                                bucket = '1k_2k';
                            else if (dt < 5000)
                                bucket = '2k_5k';
                            // Record a ~0ms event under the bucket name. We only care
                            // about COUNT in this bucket (how many inter-arrivals fell
                            // here), not duration. start+end immediately = ~0ns recorded
                            // + count incremented.
                            const m = (0, perf_hot_1.startMark)();
                            (0, perf_hot_1.endMark)(`daa.interarrival.${bucket}`, m);
                        }
                        this._lastDaaNotifTs = now;
                        // Also track whether daaScore changed since last notification.
                        // Q1 hypothesis: virtual processor stalls keep notifications
                        // arriving but score frozen.
                        const inner = params?.VirtualDaaScoreChanged
                            || params?.virtualDaaScoreChangedNotification
                            || params;
                        const score = Number(inner?.virtual_daa_score ?? inner?.virtualDaaScore ?? 0);
                        if (score > 0 && this._lastDaaScore > 0) {
                            const delta = score - this._lastDaaScore;
                            const dKey = delta === 0 ? 'frozen' : delta < 0 ? 'rewind' : delta < 5 ? 'tiny' : delta < 50 ? 'small' : 'big';
                            const m2 = (0, perf_hot_1.startMark)();
                            (0, perf_hot_1.endMark)(`daa.scoreDelta.${dKey}`, m2);
                        }
                        if (score > 0)
                            this._lastDaaScore = score;
                    }
                    this.handleNotification(method, params);
                    let cls = 'other';
                    if (ml.includes('blockadded'))
                        cls = 'blockAdded';
                    else if (ml.includes('virtualdaascorechanged'))
                        cls = 'virtualDaaScoreChanged';
                    else if (ml.includes('sinkbluescorechanged'))
                        cls = 'sinkBlueScoreChanged';
                    else if (ml.includes('virtualchainchanged'))
                        cls = 'virtualChainChanged';
                    else if (ml.includes('finality'))
                        cls = 'finalityConflict';
                    (0, perf_hot_1.endMark)(`rpc.handleNotification.${cls}`, __notifMark);
                }
                else {
                    this.handleNotification(method, params);
                }
            }
        }
        catch { /* ignore */ }
        (0, perf_hot_1.endMark)(`rpc.handleMessage.${source}`, __mark);
    }
    handleNotification(method, data) {
        // Kaspad wRPC JSON sends notifications with varying method name casing
        // (e.g. notifyVirtualChainChangedResponse, VirtualChainChangedNotification, etc.)
        const methodLower = method.toLowerCase();
        // Per-method histogram (diagnostic). Lets us see at a glance whether
        // e.g. BlockAdded is firing at 10/s or 0.2/s — kaspad-side vs client-side
        // question resolved in one reading.
        this._methodCounts.set(methodLower, (this._methodCounts.get(methodLower) || 0) + 1);
        // Diagnostic — log each unique notification method we see, once.
        // Hard cap at 20 entries: the Set is bounded by protocol (~10 methods in
        // practice) but cap it anyway so a buggy kaspad can't grow it forever.
        if (!this._seenMethods)
            this._seenMethods = new Set();
        if (this._seenMethods.size < 20 && !this._seenMethods.has(methodLower)) {
            this._seenMethods.add(methodLower);
            this.emit('activity', `RPC notification method seen: ${method}`);
        }
        // ─── blockAdded notification — every block the node accepts ───
        if (methodLower.includes('blockadded')) {
            // First-notification diagnostics so we know the subscription is actually firing
            if (!this._blockAddedSeen) {
                this._blockAddedSeen = true;
                const topKeys = Object.keys(data || {}).slice(0, 5).join(',');
                this.emit('activity', `RPC: first blockAdded received (keys: ${topKeys})`);
            }
            // Kaspa v1.0 wRPC JSON wraps notification payloads externally-tagged,
            // matching the Scope variant we subscribed with:
            //   { "BlockAdded": { "block": { ... } } }
            // Older versions used different shapes; check all known paths.
            const candidates = [
                data?.BlockAdded?.block,
                data?.blockAddedNotification?.block,
                data?.block_added_notification?.block,
                data?.block,
                data,
            ].filter(b => b && typeof b === 'object');
            const block = candidates.find(b => b.header || b.verboseData || b.verbose_data) || null;
            if (!block) {
                this._blockAddedDrops.noCandidateBlock++;
                // One-shot dump of what the notification actually looked like when
                // nothing matched — we've been flying blind on this branch.
                if (this._blockAddedDrops.noCandidateBlock === 1) {
                    const topKeys = Object.keys(data || {}).slice(0, 8).join(',');
                    const innerKeys = data?.BlockAdded ? Object.keys(data.BlockAdded).slice(0, 8).join(',') : '(none)';
                    this.emit('activity', `RPC: blockAdded no candidate — top keys: [${topKeys}]; BlockAdded.* keys: [${innerKeys}]`);
                }
                return;
            }
            // Hash: try verboseData first (populated when kaspad computed it), then header
            const hash = block.verboseData?.hash || block.verbose_data?.hash
                || block.header?.hash || block.hash;
            if (!hash) {
                this._blockAddedDrops.noHash++;
                if (!this._loggedMissingHash) {
                    this._loggedMissingHash = true;
                    this.emit('activity', `RPC: blockAdded missing hash — block keys: ${Object.keys(block).join(',')}; header keys: ${Object.keys(block.header || {}).join(',')}`);
                }
                return;
            }
            this._blockAddedAccepts++;
            // Parents: kaspad uses `parents` in older versions, `parentsByLevel` /
            // `parents_by_level` in v1.0+. Each level entry has `parentHashes` / `parent_hashes`.
            let parents = [];
            const header = block.header || {};
            if (Array.isArray(header.parents)) {
                parents = header.parents;
            }
            else {
                const levels = header.parentsByLevel || header.parents_by_level;
                if (Array.isArray(levels) && levels.length > 0) {
                    const level0 = levels[0];
                    parents = level0?.parentHashes || level0?.parent_hashes
                        || (Array.isArray(level0) ? level0 : []);
                }
            }
            const parentCount = parents.length;
            const selectedParent = header.selectedParentHash || header.selected_parent_hash || parents[0] || '';
            // Diagnostic: one-shot warn if we detect an empty parents array on a
            // blockAdded notification. Kaspa blocks always have at least one parent
            // (except genesis, which we won't see via blockAdded). If this fires,
            // it means kaspad shipped a block shape our parser doesn't understand,
            // and the BlockEvent sent to KasMap would have empty parents — which
            // breaks DAG rendering on kasmap.org.
            if (parentCount === 0 && !this._loggedEmptyParents) {
                this._loggedEmptyParents = true;
                const headerKeys = Object.keys(header).join(',');
                const blockKeys = Object.keys(block).join(',');
                this.emit('activity', `RPC: blockAdded missing parents — block keys: ${blockKeys}; header keys: ${headerKeys}`);
            }
            const blueScore = Number(header.blueScore ?? header.blue_score ?? 0);
            const blockTimestamp = Number(header.timestamp || 0);
            const ts = Date.now();
            // Track last notification time for the diagnostic report
            this._lastBlockAddedTs = ts;
            // _blockAddedSamples counts RAW notifications, NOT unique blocks. A
            // single network block can fire blockAddedNotification more than once
            // when the virtual chain reorganizes (merge-set re-notifications), so
            // this array overcounts true block rate by ~1.0–1.7×. It is for the
            // diagnostic's "block-added emit rate" line ONLY — never use it to
            // drive user-facing BPS. The activity-feed rate is computed from
            // DAA-score deltas via getDaaBps(), which is immune to this inflation.
            // Same drop-oldest cap pattern as the raw-message arrays above.
            this._blockAddedSamples.push(ts);
            if (this._blockAddedSamples.length > 1000)
                this._blockAddedSamples.splice(0, 500);
            // Track the highest blueScore seen across block-added notifications
            // as our running sinkBlueScore estimate. Overshoot is bounded by the
            // GHOSTDAG K parameter (≤124 on mainnet) since red blocks can appear
            // briefly above the chain tip's blueScore. At 432K-block finality
            // threshold that's ≤0.03% noise — well below useful resolution.
            if (typeof blueScore === 'number' && blueScore > this._sinkBlueScore) {
                this._sinkBlueScore = blueScore;
            }
            // First-seen timestamp for propagation analysis
            this.emit('block-added', {
                hash,
                selectedParentHash: selectedParent,
                blueScore,
                parentCount,
                timestamp: blockTimestamp,
                txCount: block.transactions?.length || 0,
                parents,
                ts,
            });
            // Red-block detection moved to VirtualChainChanged + explicit getBlock.
            // Kaspad's BlockAdded notification path falls back to a verbose-less
            // conversion when its internal get_block fails under load — this
            // produced fleet-wide red_blocks=0 despite ~50 chain reorgs per hour.
            // See fetchRedBlocksForChainBlock below.
            // Propagation sample: time between the block's consensus timestamp and now.
            // Strict medallion: emit every observation — including negative values
            // (source clock skew, still a real datum) and large positive values
            // (slow propagation vs. skew — server decides). No client-side filtering.
            if (blockTimestamp) {
                const delayMs = ts - blockTimestamp;
                this.emit('propagation-sample', delayMs);
            }
            // Miner data from coinbase (first tx)
            const coinbase = block.transactions?.[0];
            const firstOutput = coinbase?.outputs?.[0];
            const minerAddress = firstOutput?.verboseData?.scriptPublicKeyAddress
                || firstOutput?.verbose_data?.script_public_key_address;
            if (minerAddress) {
                this.emit('mined-block', {
                    hash,
                    minerAddress,
                    timestamp: blockTimestamp,
                    blueScore,
                    txCount: block.transactions?.length || 0,
                    parents,
                    selectedParentHash: selectedParent,
                    parentCount,
                });
            }
            return;
        }
        // ─── Chain-velocity counters (silent — no emit, no UI path) ───
        if (methodLower.includes('virtualdaascorechanged')) {
            this._daaScoreAdvances++;
            // Push a high-frequency DAA sample for the event-based BPS source.
            // The notification carries `virtual_daa_score` in its payload; multi-
            // shape fallbacks mirror the rest of this file (kaspad version compat).
            // No-op if the payload is unexpectedly missing the field — we still
            // bumped the counter above so the diagnostic stays accurate.
            const inner = data?.VirtualDaaScoreChanged
                || data?.virtualDaaScoreChangedNotification
                || data?.virtual_daa_score_changed_notification
                || data;
            const score = Number(inner?.virtual_daa_score ?? inner?.virtualDaaScore ?? 0);
            if (score > 0) {
                this._daaEventSamples.push({ ts: Date.now(), daaScore: score });
                // Cap at 600 entries — at the observed ~10 Hz steady-state rate
                // that's ~60s of history, comfortable headroom over the 30s
                // activity-feed window. The original 200-entry cap held only
                // ~14-20s of samples, which made the 30s windowMs in
                // getDaaEventBps effectively a 14-20s window — and triggered
                // a half-the-time "no result" pattern where minSpanMs >= the
                // shorter side of the buffer-fill cycle. splice in batches of
                // 300 to avoid the same shift-prune quadratic the rolling rate
                // arrays had (Volume 2 §23 of the lessons doc).
                if (this._daaEventSamples.length > 600)
                    this._daaEventSamples.splice(0, 300);
            }
            return;
        }
        if (methodLower.includes('sinkbluescorechanged')) {
            this._sinkBlueScoreAdvances++;
            return;
        }
        // ─── Finality conflict notifications ───
        // kaspad fires these on finality-violating blocks. Rare but critical for
        // chain-health monitoring; Insights tracks them in a dedicated bronze table.
        if (methodLower.includes('finalityconflictresolved')) {
            const inner = data.FinalityConflictResolved
                || data.finalityConflictResolvedNotification
                || data.finality_conflict_resolved_notification
                || data;
            this.emit('finality-event', {
                kind: 'resolved',
                finalityBlockHash: inner.finalityBlockHash || inner.finality_block_hash || '',
                ts: Date.now(),
            });
            return;
        }
        if (methodLower.includes('finalityconflict')) {
            const inner = data.FinalityConflict
                || data.finalityConflictNotification
                || data.finality_conflict_notification
                || data;
            this.emit('finality-event', {
                kind: 'conflict',
                violatingBlockHash: inner.violatingBlockHash || inner.violating_block_hash || '',
                ts: Date.now(),
            });
            return;
        }
        if (methodLower.includes('virtualchainchanged')) {
            const inner = data.VirtualChainChanged
                || data.virtualChainChangedNotification
                || data.virtual_chain_changed_notification
                || data;
            const removed = inner.removedChainBlockHashes || inner.removed_chain_block_hashes || [];
            const added = inner.addedChainBlockHashes || inner.added_chain_block_hashes || [];
            // Bronze-on-wire per medallion-strict policy (0.3.8): emit raw
            // hashes only. Server derives the depth distribution from
            // `chain_events.removed_hashes` array length, and the
            // settlement-latency JOIN against the blocks table comes from the
            // (hash, minedAt) pairs that recentBlocks ships independently
            // via the block-added handler. No client-side derivation here.
            this.emit('chain-event', {
                removed,
                added,
                ts: Date.now(),
            });
            // Red-block detection from GHOSTDAG merge-set reds.
            //
            // We USED to read this from BlockAdded.verboseData.mergeSetRedsHashes,
            // but kaspad v1.x's BlockAdded notification path falls back to a
            // conversion that lacks verbose_data when its internal `get_block`
            // fails (which happens under load, or for just-added blocks whose
            // ghostdag data isn't computed yet). Result: ~0% of notifications
            // carry verboseData in practice, so we saw red_blocks=0 fleet-wide.
            //
            // VirtualChainChanged's addedChainBlockHashes are chain blocks whose
            // merge-sets we want. Explicit getBlock with include_verbose_data=true
            // is infallible server-side and always returns the merge-set.
            //
            // Enqueue instead of fire-and-forget (PR 4). A single batched VCC can
            // carry many addedChainBlockHashes; firing them in parallel bursts
            // the RPC socket. The worker drains the queue at RED_BLOCK_PACE_MS
            // per call — 20 calls/s sustained, enough for post-Crescendo chain
            // rate (< 10 BPS) with ample headroom for catch-up bursts.
            if (Array.isArray(added) && added.length > 0) {
                for (const chainBlockHash of added) {
                    this._redBlockQueue.push(chainBlockHash);
                }
                this.kickRedBlockWorker();
            }
            // Live TPS from accepted transaction IDs (rolling 10-second window).
            // The divisor is FIXED at 10s (the window size), not `(now - oldest_sample)`.
            // Old behavior: when a single fat chainEvent arrived (e.g. 9k tx at once)
            // and was the only sample in the window, we'd divide by ~1s instead of 10s,
            // reporting 9000 TPS. This produced the wild 24 → 9171 → 35 swings Insights
            // observed. With a fixed 10s divisor, TPS is always "tx accepted over the
            // last 10 seconds / 10", a stable rolling average.
            const txIds = inner.acceptedTransactionIds || inner.accepted_transaction_ids;
            if (Array.isArray(txIds) && txIds.length > 0) {
                let txCount = 0;
                for (const entry of txIds) {
                    const ids = entry.acceptedTransactionIds || entry.accepted_transaction_ids;
                    if (Array.isArray(ids)) {
                        txCount += ids.length;
                    }
                }
                if (txCount > 0) {
                    const now = Date.now();
                    this._txSamples.push({ ts: now, count: txCount });
                    const cutoff = now - 10000;
                    this._txSamples = this._txSamples.filter(s => s.ts > cutoff);
                    const totalTx = this._txSamples.reduce((sum, s) => sum + s.count, 0);
                    this._currentTps = Math.round(totalTx / 10);
                    this.emit('tps-update', this._currentTps);
                }
            }
        }
    }
    /**
     * Send a wRPC JSON request on the RPC socket (default).
     * Format: { id, method, params } → response: { id, method, params: { ...data } }.
     * Used for all polling (getInfo/getBlockDagInfo/getConnectedPeerInfo) and
     * red-block enrichment (getBlock). Subscribe calls must go on wsNotify —
     * see rpcCallOn().
     */
    rpcCall(method, params = {}, timeoutMs = 5000) {
        return this.rpcCallOn('rpc', method, params, timeoutMs);
    }
    /** Send a wRPC request on a specific socket kind. Only `subscribe` needs
     *  the 'notify' path — kaspad registers notification delivery on the
     *  socket that issued the subscribe. */
    rpcCallOn(kind, method, params = {}, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const ws = kind === 'rpc' ? this.wsRpc : this.wsNotify;
            if (!ws || ws.readyState !== ws_1.default.OPEN) {
                return reject(new Error(`Not connected (${kind})`));
            }
            const id = this._nextId++;
            const request = { jsonrpc: '2.0', id, method, params };
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('timeout'));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer, id, kind });
            try {
                ws.send(JSON.stringify(request));
                // Confirmatory backpressure diagnostic (PR 5). If the kernel TCP
                // buffer on the RPC socket hasn't drained past 1 MB, we're queuing
                // writes faster than kaspad is reading them. One-shot log so the
                // activity feed doesn't spam during a sustained burst.
                if (kind === 'rpc' &&
                    !this._wsRpcBackpressureLogged &&
                    ws.bufferedAmount > 1_000_000) {
                    this._wsRpcBackpressureLogged = true;
                    this.emit('activity', `RPC socket backpressure: ${Math.round(ws.bufferedAmount / 1024)} KB queued`);
                }
            }
            catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(err);
            }
        });
    }
    /** One-shot fetch of the pruning point's blueScore via getBlock. Called
     *  when pruningPointHash changes (rare — once per ~30 hours per node).
     *  Updates _pruningPointBlueScore on success; on failure leaves prior
     *  value untouched and lets the next pruning advance retry. */
    async fetchPruningPointBlueScore(hash) {
        try {
            const resp = await this.rpcCall('getBlock', { hash, includeTransactions: false });
            const inner = resp?.params?.block || resp?.block || resp?.params?.Block || resp?.Block;
            const blueScoreRaw = inner?.header?.blueScore ?? inner?.header?.blue_score;
            const blueScore = typeof blueScoreRaw === 'string'
                ? parseInt(blueScoreRaw, 10)
                : typeof blueScoreRaw === 'number' ? blueScoreRaw : NaN;
            if (Number.isFinite(blueScore) && blueScore > 0) {
                this._pruningPointBlueScore = blueScore;
            }
        }
        catch {
            // Silent — caller's .catch() handles. Logging here would noise up
            // the activity feed for a routinely-rare event.
        }
    }
    /** Start the red-block enrichment worker if idle. Idempotent — safe to
     *  call on every enqueue. The worker exits as soon as the queue drains,
     *  so there's no idle timer to stop. */
    kickRedBlockWorker() {
        if (this._redBlockWorkerRunning)
            return;
        this._redBlockWorkerRunning = true;
        this.drainRedBlockQueue().catch(() => {
            // Should never happen — fetchRedBlocksForChainBlock catches its own
            // errors — but if it does, reset the flag so future enqueues can
            // restart the worker rather than deadlocking.
            this._redBlockWorkerRunning = false;
        });
    }
    async drainRedBlockQueue() {
        try {
            while (this._redBlockQueue.length > 0) {
                const chainBlockHash = this._redBlockQueue.shift();
                if (!chainBlockHash)
                    continue;
                await this.fetchRedBlocksForChainBlock(chainBlockHash);
                // Pace the next call so parallel VCC bursts don't saturate wsRpc.
                if (this._redBlockQueue.length > 0) {
                    await new Promise(r => setTimeout(r, RpcMonitor.RED_BLOCK_PACE_MS));
                }
            }
        }
        finally {
            this._redBlockWorkerRunning = false;
        }
    }
    /**
     * Fetch a chain block's verboseData explicitly (via `getBlock` with
     * include_verbose_data=true) and emit one `red-block` event per hash
     * in its mergeSetRedsHashes. Used from the VirtualChainChanged handler
     * because kaspad's BlockAdded notification path unreliably omits
     * verboseData under load. Errors are swallowed — we just miss that one
     * chain block's red set.
     */
    async fetchRedBlocksForChainBlock(chainBlockHash) {
        let resp;
        try {
            // include_transactions=false keeps the response small; we only need header+verboseData
            resp = await this.rpcCall('getBlock', {
                hash: chainBlockHash,
                includeTransactions: false,
            }, 5000);
        }
        catch {
            return;
        }
        const block = resp?.params?.block || resp?.params;
        if (!block)
            return;
        const vd = block.verboseData || block.verbose_data;
        if (!vd)
            return;
        const isChainBlock = vd.isChainBlock ?? vd.is_chain_block ?? false;
        if (!isChainBlock)
            return;
        const reds = vd.mergeSetRedsHashes || vd.merge_set_reds_hashes || [];
        if (!Array.isArray(reds) || reds.length === 0)
            return;
        const ts = Date.now();
        for (const redHash of reds) {
            this.emit('red-block', { hash: redHash, acceptingBlockHash: chainBlockHash, ts });
        }
    }
    // ─── Non-overlapping poll loop ───
    //
    // Cadence depends on subscription state (PR 4):
    //   subscribed=false  → 1000 ms (startup/IBD — UI needs responsive
    //                       uptime + connect-status feedback).
    //   subscribed=true   → 5000 ms (steady state — the polled fields
    //                       mempoolSize, sinkHash, peer count don't need
    //                       second-resolution; sink/pruning changes propagate
    //                       via subscription notifications anyway).
    // Dropping from 1 s to 5 s cuts ~3 RPC calls × 4 saved seconds per cycle
    // = 12 calls/minute removed from wsRpc in steady state. Combined with
    // the red-block queue pacing above, this keeps the RPC socket quiet
    // enough that getBlock calls almost never time out.
    scheduleNextPoll(delayMs) {
        if (this.pollTimer)
            clearTimeout(this.pollTimer);
        this.pollTimer = setTimeout(async () => {
            await this.poll();
            if (this._uptimeGetter) {
                // Always 1 s — same cadence as v0.2.25, before 0.2.29's
                // post-sync slowdown to 5 s. The 5 s value was an opportunistic
                // efficiency change inside the wRPC-socket-split PR, not a fix for
                // a specific 1 s-induced problem; in the field it produced 0.2 Hz
                // DAA sampling against a 14 Hz batch process, aliasing the BPS
                // display into 5-second plateaus jumping 0.2 ↔ 42. With 1 s polling
                // the activity-feed window holds ~10 samples, smoothing the value
                // back to ~10 BPS ± 1 in steady state.
                this.scheduleNextPoll(1000);
            }
        }, delayMs);
    }
    async poll() {
        if (this._uptimeGetter) {
            this._status.uptimeSeconds = this._uptimeGetter();
        }
        this._status.wrpcEndpoint = this.borshUrl;
        // Ensure the RPC socket is up — polling needs it. The notify socket is
        // connected lazily below only when we're ready to subscribe (post-sync).
        const connected = await this.ensureConnected('rpc');
        this._status.rpcConnected = connected;
        if (!connected) {
            if (this.lastKnownPeerCount > 0) {
                this._status.peerCount = this.lastKnownPeerCount;
            }
            this.emitStatus();
            return;
        }
        try {
            const [info, dag, peers] = await Promise.all([
                this.rpcCall('getInfo').catch(() => null),
                this.rpcCall('getBlockDagInfo').catch(() => null),
                this.rpcCall('getConnectedPeerInfo').catch(() => null),
            ]);
            // Parse getInfo — data is in resp.params
            const infoData = info?.params;
            if (infoData) {
                this._status.serverVersion = infoData.serverVersion || '';
                this._status.isUtxoIndexed = infoData.isUtxoIndexed ?? false;
                this._status.mempoolSize = infoData.mempoolSize ?? 0;
                // Track when mempoolSize last came from a live getInfo response so
                // the diagnostic can flag "stale for 4m 20s" instead of silently
                // displaying a 5-minute-old number. The previous .catch(() => null)
                // on getInfo means the value otherwise persists indefinitely on
                // repeated poll timeouts — exactly the symptom observed in the
                // 1,455-TPS / same-mempool-twice snapshot.
                this._lastMempoolUpdateMs = Date.now();
                if (infoData.isSynced) {
                    if (this._status.state === 'syncing') {
                        this._status.state = 'synced';
                        // Emit so main.ts can propagate to kaspad-manager.state — its
                        // log-based 'via relay' state machine can miss the transition
                        // on startup if the exact log phrase doesn't fire.
                        this.emit('rpc-sync-confirmed');
                    }
                    // Clear any stale sync detail (e.g. "Downloading UTXO set...")
                    // once kaspad reports fully synced — log-based sync messages
                    // don't always come with a matching "done" line.
                    if (this._status.syncDetail) {
                        this._status.syncDetail = '';
                    }
                }
                // Subscribe to chain notifications after RPC is confirmed working and node is synced.
                // Each subscribe is independent — a partial failure must not break the others.
                //
                // CRITICAL: subscribe MUST be sent on wsNotify. kaspad's wRPC
                // registers notification delivery on the socket that issued the
                // subscribe call — sending it on wsRpc would route notifications
                // back there and undo the channel split.
                if (infoData.isSynced && !this.subscribed) {
                    const notifyOk = await this.ensureConnected('notify');
                    if (!notifyOk) {
                        // Can't subscribe without the notify socket up — leave
                        // subscribed=false so the next poll retries. Polling data still
                        // flows on wsRpc, so status updates continue meanwhile.
                        this.emit('activity', 'RPC notify socket unavailable — subscribe deferred');
                    }
                    else {
                        // Kaspa v1.0 (Crescendo) wRPC JSON uses a single `subscribe` method
                        // with an externally-tagged Scope enum. Individual notify* methods
                        // were removed. Fields inside scope use snake_case.
                        // Verified against rusty-kaspa v1.0.0 source (notify/src/scope.rs).
                        const scopes = [
                            ['VirtualChainChanged', { VirtualChainChanged: { include_accepted_transaction_ids: true } }],
                            ['BlockAdded', { BlockAdded: {} }],
                            ['FinalityConflict', { FinalityConflict: {} }],
                            ['VirtualDaaScoreChanged', { VirtualDaaScoreChanged: {} }],
                            ['SinkBlueScoreChanged', { SinkBlueScoreChanged: {} }],
                        ];
                        const subResults = [];
                        for (const [label, scope] of scopes) {
                            try {
                                const resp = await this.rpcCallOn('notify', 'subscribe', scope);
                                if (resp?.params?.error || resp?.error) {
                                    const err = resp?.params?.error || resp?.error;
                                    subResults.push(`${label}:FAIL(${err?.message?.substring(0, 40) || 'err'})`);
                                }
                                else {
                                    subResults.push(`${label}:ok`);
                                }
                            }
                            catch (err) {
                                subResults.push(`${label}:FAIL(${err?.message?.substring(0, 40) || 'unknown'})`);
                            }
                        }
                        this.subscribed = true;
                        this.emit('activity', `RPC subscribe: ${subResults.join(' | ')}`);
                    }
                }
            }
            // Parse getBlockDagInfo
            const dagData = dag?.params;
            if (dagData) {
                this._status.headerCount = Number(dagData.headerCount ?? 0);
                this._status.blockCount = Number(dagData.blockCount ?? 0);
                this._status.daaScore = Number(dagData.virtualDaaScore ?? 0);
                // Push a DAA sample; getDaaBps reads these for activity-feed BPS.
                if (this._status.daaScore > 0) {
                    this._daaSamples.push({ ts: Date.now(), daaScore: this._status.daaScore });
                    // Cap to the last 30 entries — at 2s poll cadence that's a 60s history,
                    // way more than the 10s default window getDaaBps actually reads.
                    if (this._daaSamples.length > 30)
                        this._daaSamples.shift();
                }
                this._status.networkName = dagData.network || '';
                if (this._status.headerCount > 0) {
                    this._status.syncProgress = Math.min(100, Math.round((this._status.blockCount / this._status.headerCount) * 100));
                }
                if (dagData.sink) {
                    if (this._lastSinkHash && dagData.sink !== this._lastSinkHash) {
                        this.emit('sink-change', {
                            hash: dagData.sink,
                            previousHash: this._lastSinkHash,
                            daaScore: Number(dagData.virtualDaaScore || 0),
                            ts: Date.now(),
                        });
                    }
                    this._lastSinkHash = dagData.sink;
                    this._status.sinkHash = dagData.sink;
                }
                if (dagData.pruningPointHash) {
                    if (this._lastPruningPointHash && dagData.pruningPointHash !== this._lastPruningPointHash) {
                        this.emit('pruning-change', {
                            hash: dagData.pruningPointHash,
                            previousHash: this._lastPruningPointHash,
                            daaScore: Number(dagData.virtualDaaScore || 0),
                            ts: Date.now(),
                        });
                    }
                    this._lastPruningPointHash = dagData.pruningPointHash;
                    this._status.pruningPointHash = dagData.pruningPointHash;
                    // Fetch pruningPointBlueScore on hash change OR if we don't have
                    // it yet (first-poll case). Pruning advances rarely — roughly
                    // every finality window — so this is a low-cost refresh. Try the
                    // local block-timestamp/metadata path first (free), fall back to
                    // a single getBlock RPC if the hash isn't in our window (likely,
                    // since pruning point is from ~30 hours ago).
                    if (this._lastFetchedPruningPointHash !== dagData.pruningPointHash) {
                        this._lastFetchedPruningPointHash = dagData.pruningPointHash;
                        this.fetchPruningPointBlueScore(dagData.pruningPointHash).catch(() => {
                            // On failure, leave the previous value in place — better than
                            // zeroing. Server treats stale value as conservative; the next
                            // pruning advance will retry.
                        });
                    }
                }
                if (dagData.tipHashes) {
                    this.emit('tip-count', dagData.tipHashes.length);
                }
            }
            // Parse connected peers
            const peersData = peers?.params;
            if (peersData?.peerInfo) {
                this._status.peerCount = peersData.peerInfo.length;
                this.lastKnownPeerCount = peersData.peerInfo.length;
                if (peersData.peerInfo.length > 0) {
                    const peerDetails = peersData.peerInfo.map((p) => ({
                        ip: p.address?.ip || '',
                        port: p.address?.port || 0,
                        latencyMs: p.last_ping_duration || 0,
                        isOutbound: p.is_outbound ?? true,
                        connectedSecs: Math.round((p.time_connected || 0) / 1000),
                        userAgent: p.user_agent || '',
                        protocolVersion: p.advertised_protocol_version || 0,
                    }));
                    // Cache direction split for the diagnostic report
                    this._peersOutbound = peerDetails.filter((p) => p.isOutbound).length;
                    this._peersInbound = peerDetails.length - this._peersOutbound;
                    this.emit('peer-details', peerDetails);
                    const latencies = peerDetails
                        .map((p) => ({ pingMs: p.latencyMs }))
                        .filter((p) => p.pingMs > 0);
                    if (latencies.length > 0) {
                        this.emit('peer-latencies', latencies);
                    }
                }
            }
            else if (this.lastKnownPeerCount > 0) {
                this._status.peerCount = this.lastKnownPeerCount;
            }
            // Block data (propagation, miners, recentBlocks) is now driven by the
            // notifyBlockAdded subscription — every block captured, zero polling.
            // We keep the sink tracker for sink-change detection only.
            if (dagData?.sink && this._status.state === 'synced') {
                this._lastFetchedSinkHash = dagData.sink;
            }
            // Log first successful RPC connection (once only)
            if (!this._loggedFirstPoll && (infoData || dagData)) {
                this._loggedFirstPoll = true;
                const parts = [];
                if (dagData)
                    parts.push(`daa=${dagData.virtualDaaScore} blocks=${dagData.blockCount} net=${dagData.network}`);
                if (peersData?.peerInfo)
                    parts.push(`peers=${peersData.peerInfo.length}`);
                if (infoData)
                    parts.push(`v${infoData.serverVersion} mempool=${infoData.mempoolSize ?? 0}`);
                this.emit('activity', `RPC live: ${parts.join(' ')}`);
            }
            this._status.errorMessage = undefined;
        }
        catch {
            if (this.lastKnownPeerCount > 0) {
                this._status.peerCount = this.lastKnownPeerCount;
            }
        }
        this.emitStatus();
        // mempoolSize comes from getInfo — no need for getMempoolEntries
    }
    /** Emit current status snapshot */
    emitStatus() {
        if (this._uptimeGetter) {
            this._status.uptimeSeconds = this._uptimeGetter();
        }
        // Fallback to log-parsed peer count
        if (this._status.peerCount === 0 && this._managerPeerCount > 0) {
            this._status.peerCount = this._managerPeerCount;
        }
        this.emit('status', this.status);
    }
}
exports.RpcMonitor = RpcMonitor;
//# sourceMappingURL=rpc-monitor.js.map