"use strict";
/**
 * Stratum Manager
 *
 * Manages kaspa-stratum-bridge as a child process, following the same pattern
 * as KaspadManager. Connects to kaspad's gRPC and exposes Stratum V1 for ASIC miners.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StratumManager = void 0;
const events_1 = require("events");
const child_process_1 = require("child_process");
const http_1 = __importDefault(require("http"));
const http_body_1 = require("./util/http-body");
const SOMPI_PER_KAS = 100_000_000;
// Block reward in sompi. 15.2 KAS is a rough current-DAA estimate; Kaspa's
// emission schedule reduces this over time per Crescendo, so a follow-up
// should derive this from an RPC call instead of a hardcoded constant.
const BLOCK_REWARD_SOMPI = Math.round(15.2 * SOMPI_PER_KAS);
const DEFAULT_CONFIG = {
    bridgePath: '',
    miningAddress: '',
    stratumPort: 5555,
    stratumBind: 'localhost',
    grpcAddress: 'localhost:16110',
    prometheusPort: 2114,
};
const MAX_RESTARTS = 5;
const STABLE_AFTER_MS = 5 * 60 * 1000; // Reset restart counter after 5 min stable
const POLL_INTERVAL = 5000; // Poll Prometheus every 5s
class StratumManager extends events_1.EventEmitter {
    process = null;
    _state = 'stopped';
    config;
    restartCount = 0;
    restartTimer = null;
    stableTimer = null;
    pollTimer = null;
    logBuffer = [];
    startTime = 0;
    _stats = {
        workers: [], totalHashrate: 0, totalShares: 0, totalBlocks: 0,
        networkDifficulty: 0, networkHashrate: 0,
    };
    _previousBlocks = 0; // Track new blocks between heartbeats
    _blocksThisCycle = 0;
    // Accumulate per-heartbeat reward in integer sompi to match gamification's
    // accumulator. The 5-minute cycle resets the value, so float drift here is
    // tiny in practice — but using sompi everywhere keeps the units consistent
    // and avoids the awkwardness of one path producing 15.200000000000001 KAS
    // while the lifetime accumulator is exact.
    _rewardThisCycleSompi = 0;
    constructor(config) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    get state() { return this._state; }
    get stats() { return this._stats; }
    get logs() { return this.logBuffer; }
    get uptime() { return this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0; }
    get blocksThisCycle() { return this._blocksThisCycle; }
    /** Display value in KAS, derived from the integer sompi accumulator. */
    get rewardThisCycle() { return this._rewardThisCycleSompi / SOMPI_PER_KAS; }
    /** Reset per-heartbeat counters (called by monitoring contributor after each send) */
    resetCycleCounters() {
        this._blocksThisCycle = 0;
        this._rewardThisCycleSompi = 0;
    }
    setState(state) {
        if (this._state !== state) {
            this._state = state;
            this.emit('state-change', state);
        }
    }
    addLog(line) {
        this.logBuffer.push(line);
        if (this.logBuffer.length > 200)
            this.logBuffer.shift();
        this.emit('log', line);
    }
    updateConfig(config) {
        this.config = { ...this.config, ...config };
    }
    async start() {
        if (this._state === 'running' || this._state === 'starting')
            return;
        if (!this.config.miningAddress) {
            throw new Error('Mining address is required');
        }
        // Check for orphan processes
        await this.checkForOrphans();
        // Verify binary exists
        const fs = require('fs');
        if (!fs.existsSync(this.config.bridgePath)) {
            throw new Error(`Stratum bridge not found at ${this.config.bridgePath}`);
        }
        this.setState('starting');
        this.startTime = Date.now();
        // Determine bind address
        const bindAddr = this.config.stratumBind === 'localhost'
            ? `127.0.0.1:${this.config.stratumPort}`
            : `0.0.0.0:${this.config.stratumPort}`;
        const args = [
            `--mining-addr=${this.config.miningAddress}`,
            `--stratum=${bindAddr}`,
            `--kaspad=${this.config.grpcAddress}`,
            `--prom=127.0.0.1:${this.config.prometheusPort}`,
        ];
        this.addLog(`Starting stratum bridge: ${this.config.bridgePath}`);
        this.addLog(`Args: ${args.join(' ')}`);
        try {
            this.process = (0, child_process_1.spawn)(this.config.bridgePath, args, {
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            this.process.stdout?.on('data', (data) => {
                const lines = data.toString().split('\n').filter(l => l.trim());
                for (const line of lines) {
                    this.addLog(line);
                    this.parseLogLine(line);
                }
            });
            this.process.stderr?.on('data', (data) => {
                const lines = data.toString().split('\n').filter(l => l.trim());
                for (const line of lines) {
                    this.addLog(`[ERR] ${line}`);
                    this.parseLogLine(line);
                }
            });
            this.process.on('exit', (code) => {
                this.addLog(`Stratum bridge exited with code ${code}`);
                this.process = null;
                this.stopPolling();
                if (this._state !== 'stopped') {
                    this.setState('error');
                    this.scheduleRestart();
                }
            });
            this.process.on('error', (err) => {
                this.addLog(`Stratum bridge error: ${err.message}`);
                this.setState('error');
            });
            // Start polling Prometheus for stats
            this.startPolling();
            // Mark as stable after 5 minutes
            this.stableTimer = setTimeout(() => {
                this.restartCount = 0;
            }, STABLE_AFTER_MS);
        }
        catch (err) {
            this.addLog(`Failed to start stratum bridge: ${err.message}`);
            this.setState('error');
            throw err;
        }
    }
    async stop() {
        if (this._state === 'stopped')
            return;
        this.setState('stopped');
        this.stopPolling();
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.stableTimer) {
            clearTimeout(this.stableTimer);
            this.stableTimer = null;
        }
        if (this.process) {
            const pid = this.process.pid;
            this.addLog('Stopping stratum bridge...');
            try {
                this.process.kill('SIGTERM');
            }
            catch { }
            // Force kill after 5 seconds on Windows
            await new Promise((resolve) => {
                const forceKillTimer = setTimeout(() => {
                    if (pid) {
                        try {
                            (0, child_process_1.execSync)(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore' });
                        }
                        catch { }
                    }
                    resolve();
                }, 5000);
                this.process?.on('exit', () => {
                    clearTimeout(forceKillTimer);
                    resolve();
                });
            });
            this.process = null;
            this.addLog('Stratum bridge stopped');
        }
    }
    parseLogLine(line) {
        const lower = line.toLowerCase();
        // Detect running state
        if (lower.includes('stratum') && (lower.includes('listening') || lower.includes('started'))) {
            this.setState('running');
            this.addLog('Stratum bridge is ready for miners');
        }
        // Detect errors
        if (lower.includes('address already in use') || lower.includes('bind:')) {
            this.addLog(`Port ${this.config.stratumPort} is already in use`);
            this.emit('error', `Port ${this.config.stratumPort} is already in use by another program`);
        }
        if (lower.includes('invalid mining address') || lower.includes('invalid address')) {
            this.emit('error', 'Invalid mining address');
        }
        // Detect block found
        if (lower.includes('block') && lower.includes('found')) {
            this.emit('block-found');
        }
    }
    scheduleRestart() {
        if (this.restartCount >= MAX_RESTARTS) {
            this.addLog(`Max restart attempts (${MAX_RESTARTS}) reached. Giving up.`);
            return;
        }
        const delay = Math.min(1000 * Math.pow(2, this.restartCount), 16000);
        this.restartCount++;
        this.addLog(`Restarting in ${delay / 1000}s (attempt ${this.restartCount}/${MAX_RESTARTS})...`);
        this.restartTimer = setTimeout(() => {
            this.start().catch((err) => {
                this.addLog(`Restart failed: ${err.message}`);
            });
        }, delay);
    }
    async checkForOrphans() {
        try {
            const result = (0, child_process_1.execSync)('tasklist /FI "IMAGENAME eq ks_bridge.exe" /FO CSV /NH', {
                encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'],
            });
            if (result.includes('ks_bridge.exe')) {
                this.addLog('Found orphan stratum bridge process, killing...');
                try {
                    (0, child_process_1.execSync)('taskkill /IM ks_bridge.exe /F', { stdio: 'ignore' });
                }
                catch { }
                await new Promise(r => setTimeout(r, 1000));
            }
        }
        catch { }
    }
    // --- Prometheus Polling ---
    startPolling() {
        this.stopPolling();
        this.pollTimer = setInterval(() => this.pollMetrics(), POLL_INTERVAL);
    }
    stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }
    _pollInFlight = false;
    pollMetrics() {
        // In-flight guard. Without this, a slow/hung Prometheus endpoint would
        // let every 5-s tick stack up a fresh request, piling sockets in
        // CLOSE_WAIT. Single-instance only.
        if (this._pollInFlight)
            return;
        this._pollInFlight = true;
        const url = `http://127.0.0.1:${this.config.prometheusPort}/metrics`;
        const req = http_1.default.get(url, { timeout: 3000 }, async (res) => {
            try {
                // Cap at 1 MB — prometheus metrics bodies are tiny (a few KB).
                // Anything larger is a runaway endpoint we shouldn't trust.
                const body = await (0, http_body_1.readBody)(res, 1_000_000);
                try {
                    this.parsePrometheus(body);
                    this.emit('stats-update', this._stats);
                }
                catch { }
            }
            catch { /* body too large or read error — ignore */ }
            finally {
                this._pollInFlight = false;
            }
        });
        req.on('error', () => { this._pollInFlight = false; });
        req.on('timeout', () => { req.destroy(); this._pollInFlight = false; });
    }
    parsePrometheus(body) {
        const lines = body.split('\n');
        const workerMap = new Map();
        let networkDiff = 0;
        let networkHashrate = 0;
        for (const line of lines) {
            if (line.startsWith('#') || !line.trim())
                continue;
            // Parse: metric_name{labels} value
            const match = line.match(/^(\w+)(?:\{(.*?)\})?\s+([\d.e+-]+)$/);
            if (!match)
                continue;
            const [, metric, labelsStr, valueStr] = match;
            const value = parseFloat(valueStr);
            const labels = this.parseLabels(labelsStr || '');
            const workerName = labels.worker || labels.worker_name || '';
            if (workerName) {
                if (!workerMap.has(workerName)) {
                    workerMap.set(workerName, { name: workerName, connected: true });
                }
                const w = workerMap.get(workerName);
                if (metric.includes('valid_share'))
                    w.sharesFound = (w.sharesFound || 0) + value;
                if (metric.includes('stale_share'))
                    w.staleShares = value;
                if (metric.includes('invalid_share'))
                    w.invalidShares = value;
                if (metric.includes('block') && metric.includes('found'))
                    w.blocksFound = value;
                if (metric.includes('hashrate') || metric.includes('hash_rate'))
                    w.hashrate = value;
            }
            if (metric.includes('network_difficulty'))
                networkDiff = value;
            if (metric.includes('network_hashrate') || metric.includes('estimated_network_hashrate'))
                networkHashrate = value;
        }
        // Build worker list
        const workers = [];
        let totalHashrate = 0;
        let totalShares = 0;
        let totalBlocks = 0;
        for (const [, w] of workerMap) {
            const worker = {
                name: w.name || 'unknown',
                hashrate: w.hashrate || 0,
                sharesFound: w.sharesFound || 0,
                staleShares: w.staleShares || 0,
                invalidShares: w.invalidShares || 0,
                blocksFound: w.blocksFound || 0,
                connected: w.connected !== false,
                lastShare: Date.now(),
            };
            workers.push(worker);
            totalHashrate += worker.hashrate;
            totalShares += worker.sharesFound;
            totalBlocks += worker.blocksFound;
        }
        // Detect new blocks since last poll
        if (totalBlocks > this._previousBlocks) {
            const newBlocks = totalBlocks - this._previousBlocks;
            this._blocksThisCycle += newBlocks;
            // Reward in integer sompi; the public getter divides by SOMPI_PER_KAS
            // to expose the KAS value. See header comment on BLOCK_REWARD_SOMPI.
            this._rewardThisCycleSompi += newBlocks * BLOCK_REWARD_SOMPI;
            for (let i = 0; i < newBlocks; i++) {
                this.emit('block-found');
            }
        }
        this._previousBlocks = totalBlocks;
        this._stats = {
            workers,
            totalHashrate,
            totalShares,
            totalBlocks,
            networkDifficulty: networkDiff,
            networkHashrate,
        };
    }
    parseLabels(labelsStr) {
        const labels = {};
        if (!labelsStr)
            return labels;
        const pairs = labelsStr.split(',');
        for (const pair of pairs) {
            const [key, val] = pair.split('=');
            if (key && val) {
                labels[key.trim()] = val.trim().replace(/"/g, '');
            }
        }
        return labels;
    }
}
exports.StratumManager = StratumManager;
//# sourceMappingURL=stratum-manager.js.map