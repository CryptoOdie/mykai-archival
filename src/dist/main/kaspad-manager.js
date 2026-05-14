"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KaspadManager = void 0;
const child_process_1 = require("child_process");
const events_1 = require("events");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const DEFAULT_CONFIG = {
    network: 'mainnet',
    borshPort: 17110,
    jsonPort: 18110,
    outpeers: 64,
    ramScale: 0.5,
    utxoIndex: true,
    nodeVisibility: 'public',
};
class KaspadManager extends events_1.EventEmitter {
    process = null;
    _state = 'stopped';
    config;
    restartCount = 0;
    /** Tracks user-initiated restarts (Restart Node button + manual Stop+Start
     *  cycles). Distinct from `restartCount` which only counts auto-restart-
     *  after-crash. Both are surfaced separately in the diagnostic dump so
     *  support can see the FULL restart picture; only `restartCount` feeds
     *  the `kaspad_crash_loop` Tier-2 trigger (we don't want a user
     *  debugging via Stop+Start to look like a crash loop).
     *  Theme D of the 0.3.4 plan — added after Morris's diagnostic showed
     *  "Restarts this session: 0" despite multiple user-initiated restarts. */
    userInitiatedRestartCount = 0;
    /** Wall-clock ms of the last stop() call. If start() runs within
     *  USER_RESTART_WINDOW_MS afterwards, we count that as a user-initiated
     *  restart cycle. Set to 0 when not in a stop+start window. */
    lastUserStopAt = 0;
    static USER_RESTART_WINDOW_MS = 60_000; // 60s — generous; covers user pausing to read a dialog
    /** Peer connect/disconnect coalescing buffers. kaspad's stdout produces
     *  one log line per peer event, and we used to emit one activity-feed
     *  line per event — which on startup creates an 80-line storm in the
     *  first 13 s, and on periodic peer rotation creates a 14-line burst
     *  in a single second (observed 2026-04-29 14:46:01). The coalescer
     *  buffers events for ~1.5 s after the first, then emits a single
     *  summary line. Single events still surface (with 1.5 s delay, which
     *  is acceptable for a friendly UI signal that isn't urgent). */
    _peerConnectBuffer = [];
    _peerDisconnectBuffer = [];
    _peerCoalesceTimer = null;
    static PEER_COALESCE_MS = 1500;
    restartTimer = null;
    stableTimer = null;
    lastLogLines = []; // small ring for diagnostics only
    startTime = 0;
    /**
     * Classified startup error reason — set when kaspad exits unexpectedly
     * or logs a known-bad pattern. Read by diagnostic-payload builder so
     * Insights sees WHY a node with status=error is broken (BE Antwerpen
     * case). Reset on each start().
     */
    _startupErrorReason = null;
    // Batched "Validated" counters — flushed externally by main.ts tick
    _pendingBlocks = 0;
    _pendingTx = 0;
    // Rolling-window sampler feeding the activity-feed rate display. Each
    // entry is (wall-clock ms, tx count in that block). Timestamps are
    // captured at enqueue time, so a missed emitter tick still produces
    // the correct rate when the loop recovers — replaces the naive "blocks
    // per wall-clock second" display that turned event-loop stalls into
    // alarming "142 new blocks" lines. Pruned by the emitter tick in main.ts.
    _blockRate = [];
    /**
     * Emit a sync-detail message, guarded against log-line noise on a synced
     * node. Kaspad periodically logs phrases like "Downloading UTXO set..."
     * and "Initial block download started..." even during normal steady-state
     * operation (brief catch-up bursts, pruning cycles). Without this guard,
     * those log lines stamp a stale sync-detail onto the UI of a fully synced
     * node, so the user sees "Running · synced" in the header and
     * "Downloading UTXO set..." in the detail field simultaneously.
     *
     * Intentional clears (empty-string emits at state transitions like
     * "sync complete") bypass this helper and emit directly — we always want
     * the detail field wiped after a real sync finishes.
     */
    emitSyncDetail(detail) {
        if (this._state === 'synced')
            return;
        this.emit('sync-detail', detail);
    }
    constructor(config) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    get state() {
        return this._state;
    }
    get pid() {
        return this.process?.pid ?? null;
    }
    get uptime() {
        if (this.startTime === 0)
            return 0;
        return Math.floor((Date.now() - this.startTime) / 1000);
    }
    /** Unix-ms when kaspad was started, or 0 if not running. Raw value for Insights. */
    get startTimestamp() {
        return this.startTime;
    }
    /** How many times kaspad has restarted since the app launched — diagnostic
     *  signal for crash loops. ONLY counts auto-restart-after-crash; does NOT
     *  count user-initiated restarts (those have their own counter via
     *  `userInitiatedRestarts` so the crash-loop trigger doesn't spuriously
     *  fire when a user is debugging by Stop+Start). */
    get restartsInSession() {
        return this.restartCount;
    }
    /** How many user-initiated restarts (Restart Node button + manual Stop+Start
     *  cycles within ~60s) since the app launched. Surfaced in the diagnostic
     *  dump alongside `restartsInSession` so support can see the full picture
     *  when investigating sync issues. Doesn't feed any Tier-2 trigger directly
     *  — the user's restart action triggers via the user-restart event /
     *  consumeUserRestartFlag() path (Theme E of 0.3.4 plan). */
    get userInitiatedRestarts() {
        return this.userInitiatedRestartCount;
    }
    /** True if a user-initiated restart fired since the last consume call.
     *  One-shot — reading clears the flag. Used by the diagnostic-payload
     *  Tier-2 trigger so the next heartbeat after a user-driven restart
     *  attaches a full diagnostic for support. (Theme E of 0.3.4 plan.) */
    consumeUserRestartFlag() {
        if (!this._userRestartPending)
            return false;
        this._userRestartPending = false;
        return true;
    }
    _userRestartPending = false;
    /** Recent log lines (ring buffer, max 20). Used by diagnostic payload builder. */
    get recentLogLines() {
        return this.lastLogLines;
    }
    /**
     * Elapsed seconds since the most recent UTXO-index rebuild started, or
     * 0 if no rebuild is currently in progress. Read by health checks and
     * the Tier-2 trigger so we can flag rebuilds that have been running
     * unusually long (common after unclean shutdowns).
     */
    get utxoRebuildElapsedSec() {
        if (this.utxoResyncStart === 0)
            return 0;
        return Math.floor((Date.now() - this.utxoResyncStart) / 1000);
    }
    /**
     * Force-clear the UTXO-rebuild-in-progress state and emit utxo-resync-done.
     * Used as a FALLBACK when main.ts observes via RPC signals that kaspad is
     * clearly past the rebuild phase (first blockAdded received, state=synced,
     * peers connected) but our log-parser didn't catch the transition line.
     *
     * This bug bit real users: their UI showed "Rebuilding UTXO index — 479m
     * elapsed" for 8 hours while kaspad was actually running fine with 64
     * peers. The log line we matched ("wrpc server starting") doesn't appear
     * in all kaspad v1.x builds — so without this RPC-based fallback the
     * toast could persist indefinitely.
     */
    markUtxoRebuildComplete() {
        if (this.utxoResyncStart === 0)
            return;
        const duration = Math.round((Date.now() - this.utxoResyncStart) / 1000);
        this.utxoResyncStart = 0;
        this.emit('utxo-resync-done', duration);
    }
    /**
     * Short classification of why kaspad failed to start, if we observed a
     * known pattern. One of: 'port_conflict' | 'binary_missing' |
     * 'permission_denied' | 'disk_full' | 'db_migration' | 'kaspad_panic'
     * | null. Resets on each start().
     */
    get startupErrorReason() {
        return this._startupErrorReason;
    }
    /**
     * Inspect a single log line (stdout or stderr) for known-bad startup
     * patterns. Side-effect: sets _startupErrorReason if matched. Called
     * from the stdout/stderr handlers so classification happens as lines
     * arrive, not only on exit.
     */
    classifyStartupErrorLine(line) {
        if (this._startupErrorReason)
            return; // first match wins
        const lower = line.toLowerCase();
        if (lower.includes('address already in use') || lower.includes('eaddrinuse')) {
            this._startupErrorReason = 'port_conflict';
        }
        else if (lower.includes('access is denied') || lower.includes('permission denied') || lower.includes('eacces')) {
            this._startupErrorReason = 'permission_denied';
        }
        else if (lower.includes('no space left on device') || lower.includes('disk full') || lower.includes('enospc')) {
            this._startupErrorReason = 'disk_full';
        }
        else if (lower.includes('operation was rejected')) {
            this._startupErrorReason = 'db_migration';
        }
        else if (lower.includes('thread') && lower.includes('panicked')) {
            this._startupErrorReason = 'kaspad_panic';
        }
    }
    setState(state) {
        if (this._state !== state) {
            this._state = state;
            this.emit('state-change', state);
        }
    }
    /**
     * External confirmation that kaspad is synced. Called by main.ts when
     * rpc-monitor's getInfo poll reports `isSynced: true` — authoritative
     * signal that the log-line 'via relay' heuristic may have missed
     * (observed on a user's node: state stuck at 'syncing' for 1+ min after
     * kaspad was fully operational because the 'Accepted N blocks via relay'
     * log phrase didn't fire on startup). Only promotes from syncing → synced;
     * never regresses or overrides other states.
     */
    confirmSyncedFromRpc() {
        if (this._state === 'syncing') {
            this.setState('synced');
        }
    }
    addLog(line) {
        this.lastLogLines.push(line);
        if (this.lastLogLines.length > 20)
            this.lastLogLines.shift();
    }
    /** Coalesces peer connect/disconnect events so the activity feed
     *  doesn't spam 14 lines for a single second's peer rotation. First
     *  event of a batch starts a fixed 1.5 s timer; the timer fires once
     *  with whatever accumulated. Single events still surface (with a
     *  1.5 s delay, fine for a non-urgent UX signal). */
    _bufferPeerEvent(kind, ip) {
        if (kind === 'connect')
            this._peerConnectBuffer.push(ip);
        else
            this._peerDisconnectBuffer.push(ip);
        if (this._peerCoalesceTimer)
            return; // batch already scheduled
        this._peerCoalesceTimer = setTimeout(() => {
            this._peerCoalesceTimer = null;
            this._flushPeerEvents();
        }, KaspadManager.PEER_COALESCE_MS);
    }
    /** Emit the coalesced summary line. Single event → "New peer
     *  connected" / "Peer disconnected" (no IP). Multiple events →
     *  count only ("57 new peers connected"). Both connect and
     *  disconnect can fire in the same flush, kept as separate lines.
     *
     *  Privacy: peer IPs are publicly observable on the Kaspa P2P
     *  network, but YOUR specific peer set IS a fingerprint of YOUR
     *  node, so we don't render them in the activity feed (which gets
     *  embedded in copied diagnostics that users may share). The IPs
     *  ARE still shipped to MyKAI Insights via the separate
     *  `peerSnapshots[]` heartbeat field — that data path is unchanged
     *  and the insights dev still gets the full peer list for fleet
     *  topology / propagation-map analytics. The local `_peerConnect/
     *  DisconnectBuffer` arrays continue to hold IPs in memory in case
     *  a future debug feature wants to render them on demand. */
    _flushPeerEvents() {
        const conns = this._peerConnectBuffer.splice(0);
        const discs = this._peerDisconnectBuffer.splice(0);
        if (conns.length === 1) {
            this.emit('activity', `New peer connected`);
        }
        else if (conns.length >= 2) {
            this.emit('activity', `${conns.length} new peers connected`);
        }
        if (discs.length === 1) {
            this.emit('activity', `Peer disconnected`);
        }
        else if (discs.length >= 2) {
            this.emit('activity', `${discs.length} peers disconnected`);
        }
    }
    async start() {
        // Detect user-initiated restart cycle: a stop() within the last
        // USER_RESTART_WINDOW_MS followed by this start() means the user
        // (or restart() helper) deliberately cycled the process. Bump the
        // user-initiated counter and arm the Tier-2 trigger so the next
        // heartbeat carries a full diagnostic. Theme D + E of 0.3.4 plan.
        if (this.lastUserStopAt > 0 &&
            Date.now() - this.lastUserStopAt < KaspadManager.USER_RESTART_WINDOW_MS) {
            this.userInitiatedRestartCount++;
            this._userRestartPending = true;
        }
        this.lastUserStopAt = 0;
        if (this.process) {
            this.addLog('kaspad is already running');
            return;
        }
        // Check if kaspad is already running (orphaned from previous session)
        const orphanRunning = await this.checkForOrphans();
        if (orphanRunning) {
            this.addLog('Warning: kaspad.exe is already running from a previous session.');
            this.addLog('Attempting to stop it before starting a fresh instance...');
            try {
                (0, child_process_1.execSync)('cmd.exe /c "taskkill /IM kaspad.exe /F"', { stdio: 'ignore' });
                await new Promise(r => setTimeout(r, 3000));
            }
            catch {
                // May not have permission
            }
        }
        // Clean up RocksDB LOG.old files before starting (saves disk space)
        this.cleanupOldLogs();
        // Reset the classified startup error from any prior failed run.
        this._startupErrorReason = null;
        // Verify kaspad binary exists
        if (!fs_1.default.existsSync(this.config.kaspadPath)) {
            this._startupErrorReason = 'binary_missing';
            this.setState('error');
            throw new Error(`kaspad not found at: ${this.config.kaspadPath}`);
        }
        // Ensure data directory exists
        fs_1.default.mkdirSync(this.config.appDir, { recursive: true });
        this.setState('starting');
        this.startTime = Date.now();
        this.lastLogLines = [];
        this._pendingBlocks = 0;
        this._pendingTx = 0;
        this._blockRate = [];
        const args = this.buildArgs();
        this.addLog(`Starting kaspad: ${this.config.kaspadPath}`);
        this.addLog(`Args: ${args.join(' ')}`);
        this.process = (0, child_process_1.spawn)(this.config.kaspadPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        // Run kaspad below NORMAL priority so the Electron UI (window drag, paint,
        // IPC) always gets a scheduling slot even when kaspad is CPU-saturated.
        // Under Crescendo (v1.1.0) consensus uses a lot more CPU, and at steady
        // state on smaller boxes it was pinning cores — blocks came in bursts
        // because kaspad's own relay threads were starved, and the window felt
        // laggy because our main process couldn't preempt it. BELOW_NORMAL keeps
        // kaspad running at full tilt when the OS has spare cycles (the common
        // case) and simply yields first when anything else needs CPU.
        if (this.process.pid) {
            try {
                os_1.default.setPriority(this.process.pid, os_1.default.constants.priority.PRIORITY_BELOW_NORMAL);
            }
            catch (err) {
                // Non-fatal — on Windows this occasionally fails with EPERM if the
                // process is wrapped by the OS. Kaspad still runs, just at default
                // priority.
                this.addLog(`Note: could not lower kaspad priority (${err.message || err})`);
            }
        }
        this.process.stdout?.on('data', (data) => {
            const __start = Date.now();
            const lines = data.toString().split('\n').filter(l => l.trim());
            for (const line of lines) {
                this.addLog(line);
                this.classifyStartupErrorLine(line);
                this.parseLogLine(line);
            }
            // Per-chunk timing for the freeze hunt. If kaspad sends a 100KB
            // stdout burst during peer-flood, this captures it. Logged via
            // recordHandlerTiming so the 5s aggregator dumps it alongside
            // wRPC handler totals.
            const __dur = Date.now() - __start;
            try {
                require('./perf-stalls').recordHandlerTiming(`stdout(${lines.length}L)`, __dur);
            }
            catch { /* perf-stalls not init — skip */ }
        });
        this.process.stderr?.on('data', (data) => {
            const __start = Date.now();
            const lines = data.toString().split('\n').filter(l => l.trim());
            for (const line of lines) {
                this.addLog(`[stderr] ${line}`);
                this.classifyStartupErrorLine(line);
                this.parseLogLine(line);
            }
            const __dur = Date.now() - __start;
            try {
                require('./perf-stalls').recordHandlerTiming(`stderr(${lines.length}L)`, __dur);
            }
            catch { /* perf-stalls not init — skip */ }
        });
        this.process.on('error', (err) => {
            this.addLog(`Process error: ${err.message}`);
            // Spawn-level errors — cover cases where `spawn()` itself failed
            // (missing binary, access denied) that would otherwise not leave
            // any log trace to classify.
            const msg = err.message.toLowerCase();
            if (!this._startupErrorReason) {
                if (msg.includes('enoent'))
                    this._startupErrorReason = 'binary_missing';
                else if (msg.includes('eacces') || msg.includes('access'))
                    this._startupErrorReason = 'permission_denied';
                else
                    this._startupErrorReason = 'spawn_failed';
            }
            this.setState('error');
            this.process = null;
            this.emit('error', err);
        });
        this.process.on('exit', (code, signal) => {
            this.addLog(`kaspad exited (code=${code}, signal=${signal})`);
            const uptimeSec = this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
            const wasSyncing = this._state === 'syncing' || this._state === 'starting';
            this.process = null;
            this.startTime = 0;
            if (this._state !== 'stopped') {
                // Unexpected exit. Classify if we haven't already (log patterns
                // would have set this earlier if they matched a specific case).
                // On Windows, OOM kills usually produce signal=null, code=non-zero,
                // short uptime, and prior memory pressure. We heuristically tag as
                // crashed_during_sync for first responders to look at RAM first.
                if (!this._startupErrorReason) {
                    if (wasSyncing && uptimeSec < 600) {
                        // Short uptime + sync state = probable OOM / crash during IBD.
                        this._startupErrorReason = 'crashed_during_sync';
                    }
                    else if (code !== 0 && code !== null) {
                        this._startupErrorReason = 'crashed';
                    }
                    else {
                        this._startupErrorReason = 'unexpected_exit';
                    }
                }
                this.setState('error');
                this.scheduleRestart();
            }
        });
        // Reset restart counter after 5 minutes of stable running
        this.stableTimer = setTimeout(() => {
            this.restartCount = 0;
        }, 5 * 60 * 1000);
    }
    async stop() {
        if (this.stableTimer) {
            clearTimeout(this.stableTimer);
            this.stableTimer = null;
        }
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        // Flush any pending peer-event batch so activity-feed lines about
        // the previous session don't get lost when the user stops the node.
        if (this._peerCoalesceTimer) {
            clearTimeout(this._peerCoalesceTimer);
            this._peerCoalesceTimer = null;
            this._flushPeerEvents();
        }
        // Mark the time of this stop. If start() runs within
        // USER_RESTART_WINDOW_MS, we treat the pair as a user-initiated
        // restart cycle (manual Stop+Start in Settings, or restart() helper).
        // Theme D of the 0.3.4 plan.
        this.lastUserStopAt = Date.now();
        this.setState('stopped');
        if (!this.process)
            return;
        const pid = this.process.pid;
        this.addLog('Stopping kaspad...');
        // Try graceful kill first
        try {
            this.process.kill('SIGTERM');
        }
        catch {
            // ignore
        }
        // Wait up to 15 seconds for graceful shutdown
        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                // Force kill on Windows
                if (pid) {
                    this.addLog('Force killing kaspad...');
                    try {
                        (0, child_process_1.execSync)(`cmd.exe /c "taskkill /PID ${pid} /F /T"`, { stdio: 'ignore' });
                    }
                    catch {
                        // Process may already be gone
                    }
                }
                resolve();
            }, 15000);
            if (this.process) {
                this.process.on('exit', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            }
            else {
                clearTimeout(timeout);
                resolve();
            }
        });
        this.process = null;
        this.startTime = 0;
        this.restartCount = 0;
        this.addLog('kaspad stopped');
    }
    async restart() {
        await this.stop();
        await this.start();
    }
    buildArgs() {
        const args = [];
        if (this.config.network === 'testnet') {
            args.push('--testnet');
        }
        // RPC ALWAYS on localhost — never exposed to the internet, regardless of visibility
        args.push(`--rpclisten-borsh=127.0.0.1:${this.config.borshPort}`);
        args.push(`--rpclisten-json=127.0.0.1:${this.config.jsonPort}`);
        if (this.config.utxoIndex) {
            args.push('--utxoindex');
        }
        // Storage mode — pruned is kaspad's default (no flag).
        // Archival keeps all blocks since flip (~1.5 TB and growing).
        // Retention keeps last N days (N >= 2; kaspad panics below).
        // Mutually exclusive at the kaspad layer: archival wins if both set.
        // Hard rule: archival on testnet is rejected here (TN12 --yes bypass
        // can nuke data on testnet reset). UI also blocks this but we
        // double-guard for hand-edited configs.
        if (this.config.nodeStorageMode === 'archival') {
            if (this.config.network === 'testnet') {
                this.addLog('refusing to enable archival on testnet (data risk on testnet reset); falling back to pruned mode');
            } else {
                args.push('--archival');
            }
        } else if (this.config.nodeStorageMode === 'retention') {
            const days = Math.max(2, parseInt(this.config.retentionDays, 10) || 0);
            if (days >= 2) {
                args.push(`--retention-period-days=${days}`);
            }
            // If days resolved to <2, fall through to kaspad's default (pruned).
            // The UI clamps to >=2 so this branch is defensive only.
        }
        args.push(`--outpeers=${this.config.outpeers}`);
        args.push(`--ram-scale=${this.config.ramScale}`);
        args.push('--loglevel=info');
        args.push(`--appdir=${this.config.appDir}`);
        // `--unsaferpc` was set here historically for getMempoolEntries, but
        // we switched to reading mempoolSize from getInfo (no unsafe method
        // needed). Flag removed — keeps kaspad on the safe method surface,
        // which matters on decentralized hosting (Flux) where other containers
        // may be coresident on the same host and bound to 127.0.0.1 is the
        // only isolation boundary.
        // Identify MyKAI Node nodes on the network. Shows up as
        // `kaspad:1.1.0(MyKAI)` in network stats and peer user agents — same
        // pattern FluxCloud uses to identify theirs. Helps us (and the ecosystem)
        // gauge how widely MyKAI is being used.
        args.push('--uacomment=MyKAI');
        // Auto-confirm interactive prompts. Kaspad v1.1.0 asks for y/n to upgrade
        // the database schema from older versions; without --yes it reads EOF
        // and exits with "Operation was rejected". DB upgrades are documented as
        // instant and safe (one-way — downgrading would require deleting the DB).
        args.push('--yes');
        // Private mode: disable UPnP (don't advertise to the network)
        // Public mode: allow UPnP (make P2P port discoverable)
        if (this.config.nodeVisibility === 'private') {
            args.push('--disable-upnp');
        }
        return args;
    }
    parseLogLine(line) {
        const lower = line.toLowerCase();
        // --- Any kaspad log output means it's alive ---
        if (this._state === 'starting' && lower.includes('[info')) {
            this.setState('syncing');
        }
        // --- Detect state transitions ---
        // Resyncing utxoindex — start timing it
        if (lower.includes('resyncing') && lower.includes('utxoindex')) {
            this.utxoResyncStart = Date.now();
            this.setState('syncing');
            this.emit('utxo-resync-start');
        }
        // Server starting = resync is done, node is ready for P2P
        if (lower.includes('wrpc server starting') || lower.includes('grpc server starting') || lower.includes('p2p server starting')) {
            if (this.utxoResyncStart > 0) {
                const duration = Math.round((Date.now() - this.utxoResyncStart) / 1000);
                this.emit('utxo-resync-done', duration);
                this.utxoResyncStart = 0;
            }
            if (this._state !== 'synced') {
                this.setState('syncing');
                this.emitSyncDetail('Connecting to peers...');
            }
        }
        // Peer connections — track count separately
        const peerMatch = line.match(/P2P Connected.*\(outbound: (\d+)\)/i);
        if (peerMatch) {
            if (this._state === 'starting')
                this.setState('syncing');
            this.peerCount = parseInt(peerMatch[1], 10);
            this.emit('peer-count', this.peerCount);
        }
        // IBD started — but ONLY regress state if we're not already synced.
        // kaspad emits "IBD started" log lines during minor DAG catch-up bursts
        // even on a healthy synced node, which previously caused the state to
        // flap syncing ↔ synced every few seconds. rpc-monitor's getInfo poll
        // is the authoritative source for real synced↔syncing transitions.
        if (lower.includes('ibd started')) {
            if (this._state !== 'synced') {
                this.setState('syncing');
            }
            this.emitSyncDetail('Initial block download started...');
        }
        // Pruning point proof validation (the long phase)
        // "Validating level 42 from the pruning point proof (2067 headers)"
        const pruningMatch = line.match(/Validating level (\d+) from the pruning point proof/i);
        if (pruningMatch) {
            const level = parseInt(pruningMatch[1], 10);
            // Levels count DOWN from ~184 to 0
            if (!this.maxPruningLevel)
                this.maxPruningLevel = Math.max(level, 184);
            const done = this.maxPruningLevel - level;
            const progress = Math.round((done / this.maxPruningLevel) * 50); // 0-50% for pruning phase
            // Same guard — don't regress a synced node on a transient pruning
            // validation log line.
            if (this._state !== 'synced') {
                this.setState('syncing');
            }
            this.emit('sync-progress', progress);
            this.emitSyncDetail(`Validating headers — level ${level} of ${this.maxPruningLevel}`);
        }
        // Built headers proof = pruning validation done, start header download phase
        if (lower.includes('built headers proof')) {
            this.emitSyncDetail('Headers validated, downloading blocks...');
        }
        // Setting pruning point
        if (lower.includes('setting') && lower.includes('pruning point')) {
            this.emitSyncDetail('Setting pruning point...');
        }
        // Building proof (sanity test)
        if (lower.includes('building the proof')) {
            this.emitSyncDetail('Verifying proof integrity...');
        }
        // IBD: Processed 18377 block headers (62%) last block timestamp: ...
        const ibdHeaderMatch = line.match(/IBD:?\s*Processed\s+(\d+)\s+block\s+headers?\s+\((\d+)%\)/i);
        if (ibdHeaderMatch) {
            const pct = parseInt(ibdHeaderMatch[2], 10);
            this.headerProgress = Math.max(this.headerProgress, pct);
            this.emit('sync-phase', { headers: this.headerProgress, blocks: this.blockProgress });
            this.emitSyncDetail(`Downloading headers — ${ibdHeaderMatch[1]} processed`);
        }
        // Processed 0 blocks and 950 headers in the last 10.00s (0 transactions; 0 UTXO-validated blocks...)
        // This is block-level processing after headers are done
        const blockProcessMatch = line.match(/Processed\s+(\d+)\s+blocks?\s+and\s+(\d+)\s+headers?.*?(\d+)\s+transactions/i);
        if (blockProcessMatch) {
            const blocks = parseInt(blockProcessMatch[1], 10);
            if (blocks > 0) {
                this.emitSyncDetail(`Processing blocks — ${blocks} in last batch`);
            }
        }
        // IBD: Processed N blocks (X%)  — matches "blocks" but NOT "block headers"
        const ibdBodyMatch = line.match(/IBD:?\s*Processed\s+(\d+)\s+blocks?\s+\((\d+)%\)/i);
        if (ibdBodyMatch) {
            const pct = parseInt(ibdBodyMatch[2], 10);
            this.blockProgress = Math.max(this.blockProgress, pct);
            this.emit('sync-phase', { headers: this.headerProgress, blocks: this.blockProgress });
            this.emitSyncDetail(`Downloading blocks — ${ibdBodyMatch[1]} processed`);
        }
        // Syncing UTXO set
        if (lower.includes('utxo') && (lower.includes('download') || lower.includes('process') || lower.includes('import'))) {
            this.emitSyncDetail('Downloading UTXO set...');
        }
        // Resolving virtual = almost done
        if (lower.includes('resolving virtual') || lower.includes('virtual resolving')) {
            this.blockProgress = Math.max(this.blockProgress, 95);
            this.emit('sync-phase', { headers: 100, blocks: this.blockProgress });
            this.emitSyncDetail('Resolving virtual state...');
        }
        // Importing UTXO index
        if (lower.includes('importing') && lower.includes('utxo')) {
            this.emitSyncDetail('Importing UTXO index...');
        }
        // "Accepted N blocks ... via relay"
        const acceptedMatch = line.match(/Accepted (\d+) blocks?/i);
        if (acceptedMatch) {
            const count = parseInt(acceptedMatch[1], 10);
            this.emit('blocks-accepted', count);
            // Activity-feed counters (_pendingBlocks/_pendingTx) are fed from the
            // wRPC block-added subscription in main.ts, not from here. This log
            // phrase does not reliably fire on kaspad v1.1.0 (a prior attempt to
            // route the activity counter through here produced an empty feed —
            // the regex never matched for ~1 min after startup). Kept for the
            // 'via relay' state-transition below and the 'blocks-accepted' emit
            // that drives the lifetime stat.
            // If accepting blocks via relay, node is likely synced
            if (lower.includes('via relay') && this._state === 'syncing') {
                this.acceptedViaRelayCount++;
                // After 5 consecutive "via relay" accepts, we're synced
                if (this.acceptedViaRelayCount >= 5) {
                    this.setState('synced');
                    this.emit('sync-progress', 100);
                    this.emit('sync-detail', '');
                    this.emit('activity', 'Blockchain sync complete — your node is live!');
                }
            }
        }
        // "Processed 105 blocks and 105 headers in the last 10.00s (18481 transactions; 31 UTXO-validated blocks; 7.60 parents; 7.80 mergeset; 176.01 TPB; 295846.3 mass)"
        // Note: the last number is TPB (transactions per block), NOT TPS. Real TPS comes from "Tx throughput stats" line.
        const processedMatch = line.match(/Processed (\d+) blocks.*?(\d+) transactions.*?([\d.]+)\s+parents.*?([\d.]+)\s+mergeset.*?([\d.]+) TP[BS]/i);
        if (processedMatch) {
            const blocks = parseInt(processedMatch[1], 10);
            const txCount = parseInt(processedMatch[2], 10);
            const parents = parseFloat(processedMatch[3]);
            const mergeSet = parseFloat(processedMatch[4]);
            // processedMatch[5] is TPB (tx per block), not TPS — don't emit as tps-update
            // NOTE: do NOT emit 'blocks-accepted' here. This log line is a 10-second
            // SUMMARY of the same blocks already counted by the 'Accepted N blocks'
            // line above. Emitting here double-counted every block in the lifetime
            // "Blocks validated" stat, producing ~2x inflated rates.
            if (blocks > 0) {
                this.lastTxPerBlock = blocks > 0 ? Math.round(txCount / blocks) : 0;
            }
            if (txCount > 0)
                this.emit('transactions-processed', txCount);
            this.emit('merge-set', { blocks, txCount, parents, mergeSet });
            if (this._state === 'syncing') {
                const syncTps = blocks > 0 ? Math.round(txCount / 10) : 0; // txCount over 10-second window
                this.emitSyncDetail(`Downloading blocks — ${syncTps} tx/sec`);
            }
        }
        else {
            // Fallback: simpler format match
            const simpleProcessed = line.match(/Processed (\d+) blocks.*?(\d+) transactions.*?([\d.]+) TP[BS]/i);
            if (simpleProcessed) {
                // No 'blocks-accepted' emit — same reason as above (would double-count
                // with the Accepted line). Only transactions-processed remains.
                const txCount = parseInt(simpleProcessed[2], 10);
                if (txCount > 0)
                    this.emit('transactions-processed', txCount);
            }
        }
        // "Tx throughput stats: 367.78 u-tps, 100.00% e-tps (in: 0 via RPC, 1046 via P2P, out: 3679 via accepted blocks)"
        const throughputMatch = line.match(/Tx throughput.*?([\d.]+) u-tps.*?in:\s*(\d+)\s*via RPC.*?out:\s*(\d+)/i);
        if (throughputMatch) {
            const tps = parseFloat(throughputMatch[1]);
            const rpcIn = parseInt(throughputMatch[2], 10);
            const txOut = parseInt(throughputMatch[3], 10);
            this.emit('tps-update', tps);
            if (txOut > 0)
                this.emit('transactions-processed', txOut);
            this.emit('rpc-activity', rpcIn);
        }
        // "Orphaned N block(s) ...hash... and queued M missing roots"
        // We track these purely to measure propagation-orphan resolve time
        // (latency between seeing a child and receiving its parents). An orphan
        // that never resolves is NOT a red block — red/blue is a GHOSTDAG DAG
        // coloring decision, not a routing timeout. Red blocks come from
        // rpc-monitor's blockAdded verboseData.mergeSetRedsHashes instead.
        // Cleanup timeout is for memory hygiene only (parents rarely arrive
        // more than a minute late in practice).
        const orphanMatch = line.match(/Orphaned (\d+) block\(s\)\s+\.\.\.([a-f0-9]+).*?queued (\d+) missing/i);
        if (orphanMatch) {
            const count = parseInt(orphanMatch[1], 10);
            const hash = orphanMatch[2];
            const missingRoots = parseInt(orphanMatch[3], 10);
            this.pendingOrphans.set(hash, { count, missingRoots, timestamp: Date.now() });
            setTimeout(() => { this.pendingOrphans.delete(hash); }, 60000);
        }
        else {
            const orphanSimple = line.match(/Orphaned (\d+) block\(s\)\s+\.\.\.([a-f0-9]+)/i);
            if (orphanSimple) {
                const count = parseInt(orphanSimple[1], 10);
                const hash = orphanSimple[2];
                this.pendingOrphans.set(hash, { count, missingRoots: 0, timestamp: Date.now() });
                setTimeout(() => { this.pendingOrphans.delete(hash); }, 60000);
            }
        }
        // "Unorphaned block hash..." — this block's parents arrived, it's a propagation orphan
        const unorphanMatch = line.match(/Unorphaned block ([a-f0-9]+)/i);
        if (unorphanMatch) {
            const hash = unorphanMatch[1];
            const pending = this.pendingOrphans.get(hash);
            if (pending) {
                const resolveTimeMs = Date.now() - pending.timestamp;
                this.pendingOrphans.delete(hash);
                this.emit('propagation-orphan', {
                    hash,
                    missingRoots: pending.missingRoots,
                    resolveTimeMs,
                    timestamp: pending.timestamp,
                });
            }
        }
        // New peer connected — friendly activity (coalesced)
        const newPeerMatch = line.match(/P2P Connected to outgoing peer ([\d.]+)/i);
        if (newPeerMatch) {
            this._bufferPeerEvent('connect', newPeerMatch[1]);
        }
        // Peer disconnected (coalesced for activity feed; the structural
        // 'peer-disconnect' event still fires per-peer because Insights /
        // health-checks consume it for individual reconnect tracking).
        if (lower.includes('network error') || lower.includes('connection reset')) {
            const dcPeerMatch = line.match(/peer ([\d.]+)/i);
            if (dcPeerMatch) {
                this._bufferPeerEvent('disconnect', dcPeerMatch[1]);
                this.emit('peer-disconnect');
            }
        }
        // IBD finished / sync complete
        if (lower.includes('ibd finished') || lower.includes('ibd complete') || lower.includes('virtual resolving completed')) {
            this.setState('synced');
            this.emit('sync-progress', 100);
            this.emit('sync-detail', '');
            this.emit('activity', 'Blockchain sync complete — your node is live!');
        }
        // Errors
        if (lower.includes('address already in use') || lower.includes('eaddrinuse')) {
            this.addLog('ERROR: Port already in use. Is another kaspad running?');
            this.setState('error');
            this.emitSyncDetail('Port already in use');
        }
    }
    maxPruningLevel = 0;
    acceptedViaRelayCount = 0;
    utxoResyncStart = 0;
    lastTxPerBlock = 0;
    pendingOrphans = new Map(); // from "Processed" log, for activity messages
    peerCount = 0;
    headerProgress = 0;
    blockProgress = 0;
    scheduleRestart() {
        const MAX_RESTARTS = 5;
        if (this.restartCount >= MAX_RESTARTS) {
            this.addLog(`Max restart attempts (${MAX_RESTARTS}) reached. Giving up.`);
            this.emit('error', new Error('Max restart attempts reached'));
            return;
        }
        const delay = Math.pow(2, this.restartCount) * 1000; // 1s, 2s, 4s, 8s, 16s
        this.restartCount++;
        this.addLog(`Restarting in ${delay / 1000}s (attempt ${this.restartCount}/${MAX_RESTARTS})...`);
        this.restartTimer = setTimeout(async () => {
            try {
                await this.start();
            }
            catch (err) {
                this.addLog(`Restart failed: ${err}`);
            }
        }, delay);
    }
    cleanupOldLogs() {
        try {
            const dataDir = this.config.appDir;
            let totalCleaned = 0;
            const walk = (dir) => {
                try {
                    const entries = fs_1.default.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path_1.default.join(dir, entry.name);
                        if (entry.isFile() && entry.name.startsWith('LOG.old')) {
                            const size = fs_1.default.statSync(fullPath).size;
                            fs_1.default.unlinkSync(fullPath);
                            totalCleaned += size;
                        }
                        else if (entry.isDirectory()) {
                            walk(fullPath);
                        }
                    }
                }
                catch { /* skip inaccessible */ }
            };
            walk(dataDir);
            if (totalCleaned > 0) {
                const mb = (totalCleaned / (1024 * 1024)).toFixed(1);
                this.addLog(`Cleaned up ${mb} MB of old RocksDB logs`);
                this.emit('activity', `Cleaned up ${mb} MB of old log files`);
            }
        }
        catch { /* ignore cleanup errors */ }
    }
    async checkForOrphans() {
        try {
            const result = (0, child_process_1.execSync)('cmd.exe /c "tasklist /FI \\"IMAGENAME eq kaspad.exe\\" /FO CSV /NH"', {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'ignore'],
            });
            return result.includes('kaspad.exe');
        }
        catch {
            return false;
        }
    }
    // --- Update system helpers ---
    /**
     * Detect kaspad version by running `kaspad --version` (fast, <100ms, no node start).
     * Falls back to null if the binary doesn't support --version or doesn't exist.
     */
    async detectVersion() {
        try {
            if (!fs_1.default.existsSync(this.config.kaspadPath))
                return null;
            const result = (0, child_process_1.execSync)(`"${this.config.kaspadPath}" --version`, {
                encoding: 'utf-8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'ignore'],
            });
            const match = result.match(/(\d+\.\d+\.\d+)/);
            return match ? match[1] : null;
        }
        catch {
            return null;
        }
    }
    /**
     * Replace the kaspad binary with a new one. Keeps old as .bak for rollback.
     * MUST be called when kaspad is stopped.
     */
    async replaceBinary(newBinaryPath) {
        if (this.process) {
            return { success: false, error: 'kaspad is still running — stop it first' };
        }
        const currentPath = this.config.kaspadPath;
        const backupPath = currentPath + '.bak';
        // Retry logic for Windows file lock delays
        const tryReplace = async (attempt) => {
            try {
                // Remove old backup if exists
                if (fs_1.default.existsSync(backupPath))
                    fs_1.default.unlinkSync(backupPath);
                // Backup current binary
                if (fs_1.default.existsSync(currentPath))
                    fs_1.default.renameSync(currentPath, backupPath);
                // Install new binary
                fs_1.default.copyFileSync(newBinaryPath, currentPath);
                return { success: true };
            }
            catch (err) {
                if (err.code === 'EBUSY' && attempt < 3) {
                    await new Promise(r => setTimeout(r, 2000));
                    return tryReplace(attempt + 1);
                }
                // Attempt rollback on failure
                try {
                    if (fs_1.default.existsSync(backupPath) && !fs_1.default.existsSync(currentPath)) {
                        fs_1.default.renameSync(backupPath, currentPath);
                    }
                }
                catch { /* rollback also failed */ }
                return { success: false, error: `File operation failed: ${err.message}` };
            }
        };
        return tryReplace(0);
    }
    /**
     * Rollback to the previous kaspad binary from .bak file.
     */
    async rollbackBinary() {
        if (this.process)
            return false;
        const currentPath = this.config.kaspadPath;
        const backupPath = currentPath + '.bak';
        if (!fs_1.default.existsSync(backupPath))
            return false;
        try {
            if (fs_1.default.existsSync(currentPath))
                fs_1.default.unlinkSync(currentPath);
            fs_1.default.renameSync(backupPath, currentPath);
            this.addLog('Rolled back to previous kaspad binary');
            this.emit('activity', 'Rolled back to previous kaspad version');
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Startup crash recovery: if kaspad.exe is missing but .bak exists, restore it.
     */
    recoverBinaryIfNeeded() {
        const currentPath = this.config.kaspadPath;
        const backupPath = currentPath + '.bak';
        if (!fs_1.default.existsSync(currentPath) && fs_1.default.existsSync(backupPath)) {
            try {
                fs_1.default.renameSync(backupPath, currentPath);
                this.addLog('Recovered kaspad binary from backup');
                this.emit('activity', 'Recovered kaspad from backup after interrupted update');
                return true;
            }
            catch {
                return false;
            }
        }
        return false;
    }
}
exports.KaspadManager = KaspadManager;
//# sourceMappingURL=kaspad-manager.js.map