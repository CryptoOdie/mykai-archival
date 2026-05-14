"use strict";
/**
 * Diagnostic report builder.
 *
 * Produces a single markdown blob containing the node's current state, ready
 * to paste into an email, chat, or forum when asking for support.
 *
 * Identity & privacy policy:
 * - nodeId and accountKey are shown in FULL — they're the only handles the
 *   Insights/support backend has to find the user's data. Without them,
 *   diagnostics are useless for resolving issues like "my stats reset to 0
 *   after a reinstall." A user choosing to share this diagnostic is opting in.
 * - miningAddress is truncated (it's a wallet — leaking it isn't catastrophic
 *   but a partial display is enough to confirm "yes, that's mine" without
 *   broadcasting the full address publicly).
 * - File paths are normalized (Windows username stripped via <home>).
 * - Public IP is included only when the node is in public mode (otherwise
 *   it's private information for that user).
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDiagnosticReport = buildDiagnosticReport;
const os_1 = __importDefault(require("os"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const perfStalls = __importStar(require("./perf-stalls"));
const system_load_1 = require("./system-load");
const host_specs_1 = require("./host-specs");
const clock_offset_1 = require("./clock-offset");
const activity_buffer_1 = require("./activity-buffer");
const firewall_1 = require("./firewall");
const loop_lag_1 = require("./loop-lag");
const installations_info_1 = require("./installations-info");
/** Format a prefixed-hex identifier (`node_…`, `acc_…`) for diagnostic display.
 *  Now shows the FULL identifier — see file-header comment on the policy
 *  change. Function name kept for now to avoid touching every call site;
 *  rename to `formatId` (or similar) when convenient. */
function redactNodeId(id) {
    if (!id)
        return '(none)';
    return id;
}
function redactAddress(addr) {
    if (!addr)
        return '(not set)';
    if (addr.length < 16)
        return addr.substring(0, 4) + '...';
    return `${addr.substring(0, 10)}...${addr.substring(addr.length - 4)}`;
}
function redactPath(p) {
    if (!p)
        return '(default)';
    // Replace user-home-prefix path segments wherever they appear in the
    // string — not just at the start. The auto-update log embeds full
    // Windows paths inside JSON error messages (e.g. `"Path": "C:\\Users\\
    // dilan\\AppData\\..."`), and the prior anchored `^[A-Z]:\\Users\\X`
    // regex couldn't match those, leaking the Windows username verbatim
    // when users shared diagnostics. Now we strip both:
    //
    //   - single-backslash form (raw paths in plain text):
    //       C:\Users\dilan\AppData → <home>\AppData
    //   - double-backslash form (JSON-stringified paths, what shows up
    //     in electron-updater's error messages):
    //       C:\\Users\\dilan\\AppData → <home>\\AppData
    //
    // The Unix patterns are also unanchored — same reasoning. Any
    // `/home/<user>/...` or `/Users/<user>/...` becomes `<home>/...`
    // wherever it appears.
    return p
        .replace(/[A-Z]:\\\\Users\\\\[^\\]+/gi, '<home>')
        .replace(/[A-Z]:\\Users\\[^\\]+/gi, '<home>')
        .replace(/\/Users\/[^/]+/g, '<home>')
        .replace(/\/home\/[^/]+/g, '<home>');
}
function fmtBytes(bytes) {
    if (!bytes)
        return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}
function fmtDuration(ms) {
    if (!ms || ms < 0)
        return '—';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (d > 0)
        return `${d}d ${h}h ${m}m`;
    if (h > 0)
        return `${h}h ${m}m`;
    if (m > 0)
        return `${m}m ${sec}s`;
    return `${sec}s`;
}
function fmtTimeAgo(ts) {
    if (!ts)
        return '(never)';
    const diff = Date.now() - ts;
    if (diff < 0)
        return '(future?)';
    return fmtDuration(diff) + ' ago';
}
async function buildDiagnosticReport(sources) {
    const { manager, monitor, config, gamification, stratum, monitoring } = sources;
    const appConfig = config.getAll();
    const status = monitor.status;
    const gameStats = gamification.current;
    const mon = monitoring.status;
    const specs = (0, host_specs_1.getHostSpecs)();
    const nowIso = new Date().toISOString().replace('T', ' ').substring(0, 19);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const monitorVersion = require('../../package.json').version;
    const uptimeMs = manager.startTimestamp > 0 ? Date.now() - manager.startTimestamp : 0;
    const ramUsedPct = specs.ramBytes > 0
        ? Math.round(((specs.ramBytes - specs.ramFreeBytes) / specs.ramBytes) * 100)
        : 0;
    const peersTotal = status.peerCount || 0;
    const peersInbound = monitor.peersInbound;
    const peersOutbound = monitor.peersOutbound;
    // Firewall rule status — query in parallel (read-only, no elevation needed)
    const [fwMainnet, fwTestnet, fwMining] = await Promise.all([
        (0, firewall_1.isRuleActive)(firewall_1.FW_MAINNET.ruleName),
        (0, firewall_1.isRuleActive)(firewall_1.FW_TESTNET.ruleName),
        (0, firewall_1.isRuleActive)(firewall_1.FW_MINING.ruleName),
    ]);
    // Fetch system load BEFORE building sections. PowerShell call is
    // ~250 ms cold but cached for 5 s. The result drives both the
    // overload-advisory header (very visible) and the `## System load`
    // section (forensic detail). Best-effort — getSystemLoad never
    // throws, returns empty topProcesses on platforms where it can't
    // enumerate.
    let systemLoad;
    try {
        systemLoad = await (0, system_load_1.getSystemLoad)();
    }
    catch {
        systemLoad = null;
    }
    const sections = [];
    // YAML front-matter — for AI-assistant fast parsing without reading
    // the prose. Bracketed by `---` so any malformed value doesn't
    // corrupt the human-readable tail. Schema versioned via
    // diagnostic_version; bump when fields change shape.
    // Computed once up front so it's deterministic and the same numbers
    // appear in both the front-matter and the structured prose below.
    const fmEventLoopMaxMs = (() => {
        try {
            return Math.round((process.getActiveResourcesInfo ? 0 : 0));
        }
        catch {
            return 0;
        }
    })();
    // Best-effort rate snapshot for front-matter; full table appears below.
    const fmRatePoll = (() => { try {
        return monitor.getDaaBps(30_000);
    }
    catch {
        return 0;
    } })();
    const fmRateEvent = (() => { try {
        return monitor.getDaaEventBpsRaw(30_000);
    }
    catch {
        return 0;
    } })();
    sections.push('---');
    sections.push(`diagnostic_version: 1`);
    sections.push(`app_version: ${monitorVersion}`);
    sections.push(`kaspad_version: ${status.serverVersion || 'unknown'}`);
    sections.push(`timestamp_utc: ${nowIso}Z`);
    sections.push(`state: ${manager.state}`);
    sections.push(`peers_total: ${(monitor.peersInbound + monitor.peersOutbound)}`);
    sections.push(`sync_progress: ${status.syncProgress ?? 0}`);
    sections.push(`bps_poll: ${fmRatePoll.toFixed(1)}`);
    sections.push(`bps_event: ${fmRateEvent.toFixed(1)}`);
    sections.push(`bps_diverged: ${Math.abs(fmRatePoll - fmRateEvent) > 2.0 ? 'yes' : 'no'}`);
    sections.push(`node_id: ${appConfig.nodeId || 'unknown'}`);
    sections.push(`account_key: ${appConfig.accountKey || 'unknown'}`);
    sections.push('---');
    sections.push('');
    sections.push(`# MyKAI Node diagnostic — ${nowIso} UTC`);
    sections.push('');
    // Heavy-load advisory — appears at the very top so any reader sees
    // it before scrolling. When the user's machine is being saturated by
    // other apps (browsers, Docker, etc.), most "MyKAI freeze" reports
    // are environmental, not bugs in our code. The advisory short-circuits
    // hours of speculative debugging that we lived through on 2026-04-28.
    if (systemLoad?.overloaded) {
        const advisory = (0, system_load_1.renderOverloadAdvisory)(systemLoad);
        if (advisory) {
            sections.push(advisory);
            sections.push('');
        }
    }
    // --- App ---
    sections.push('## App');
    sections.push(`- Monitor version: \`${monitorVersion}\``);
    sections.push(`- Kaspad version: \`${status.serverVersion || '(unknown)'}\``);
    sections.push(`- Platform: ${specs.platform}`);
    sections.push(`- OS version: ${os_1.default.version?.() || os_1.default.release()}`);
    sections.push(`- OS release: ${os_1.default.release()}`);
    sections.push(`- Kaspad uptime: ${fmtDuration(uptimeMs)}`);
    sections.push('');
    // --- Node ---
    sections.push('## Node');
    sections.push(`- State: \`${manager.state}\``);
    sections.push(`- Network: ${appConfig.network}`);
    sections.push(`- Visibility: ${appConfig.nodeVisibility}`);
    sections.push(`- Node mode: ${appConfig.nodeMode}`);
    sections.push(`- Data directory: ${redactPath(appConfig.dataDir)}`);
    sections.push(`- DAA score: ${status.daaScore ? status.daaScore.toLocaleString() : '—'}`);
    // Mempool staleness: if the last live update is > 10s old, the displayed
    // value is frozen — almost always because getInfo has been silently
    // timing out (.catch(() => null)). Call it out so operators don't read
    // the stale number as current state. 10s threshold: the subscribed-state
    // poll cadence is 5s (PR 4), so two consecutive misses == suspicious.
    {
        const lastMempool = monitor.lastMempoolUpdateMs;
        const ageMs = lastMempool ? Date.now() - lastMempool : 0;
        const mempoolVal = status.mempoolSize ?? '—';
        if (lastMempool && ageMs > 10_000) {
            sections.push(`- Mempool: ${mempoolVal} (stale for ${fmtDuration(ageMs)})`);
        }
        else {
            sections.push(`- Mempool: ${mempoolVal}`);
        }
    }
    sections.push(`- Sync progress: ${status.syncProgress ?? '—'}%`);
    if (status.syncDetail)
        sections.push(`- Sync detail: ${status.syncDetail}`);
    // Sync getter — `walkDirSize` returns the cached value instantly and kicks
    // a background refresh if stale. Awaiting `walkDirSizeFresh` here was a
    // UX regression: on a stale cache the user saw "Gathering diagnostic info…"
    // for 15-30 s while the walker traversed the 30+ GB data dir, indistinguishable
    // from a hang. The cached-or-zero value the sync getter returns is a much
    // better tradeoff — once the heartbeat path has refreshed the cache, future
    // diagnostic builds get the real value.
    sections.push(`- Storage used: ${fmtBytes(config.getDataSizeBytes())}`);
    sections.push(`- Clock offset: ${(0, clock_offset_1.getClockOffset)()} ms`);
    sections.push(`- Node ID: \`${redactNodeId(appConfig.nodeId)}\``);
    sections.push(`- Account key: \`${redactNodeId(appConfig.accountKey)}\``);
    sections.push('');
    // --- Network / peers / ports ---
    const kaspaP2pPort = appConfig.network === 'testnet' ? 16211 : 16111;
    sections.push('## Network');
    sections.push(`- Kaspa P2P port: ${kaspaP2pPort} (${appConfig.network})`);
    sections.push(`- Borsh RPC: 127.0.0.1:${appConfig.borshPort} (localhost only)`);
    sections.push(`- JSON RPC: 127.0.0.1:${appConfig.jsonPort} (localhost only)`);
    sections.push(`- Stratum mining port: ${appConfig.stratumPort} (bind: ${appConfig.stratumBind})`);
    sections.push(`- Peers total: ${peersTotal}`);
    if (peersInbound + peersOutbound > 0) {
        sections.push(`- Peers inbound: ${peersInbound}`);
        sections.push(`- Peers outbound: ${peersOutbound}`);
    }
    sections.push(`- Outpeers config: ${appConfig.outpeers}`);
    sections.push('');
    // --- Windows Firewall rules ---
    const fwStatus = (active) => active ? '✓ allowed' : '— not active';
    sections.push('## Windows Firewall rules');
    sections.push(`- Kaspa P2P mainnet (16111): ${fwStatus(fwMainnet)}`);
    sections.push(`- Kaspa P2P testnet (16211): ${fwStatus(fwTestnet)}`);
    sections.push(`- Stratum mining (5555): ${fwStatus(fwMining)}`);
    sections.push('');
    // --- Kaspad process ---
    sections.push('## Kaspad process');
    sections.push(`- Running: ${manager.pid !== null ? 'yes' : 'no'}`);
    if (manager.pid !== null) {
        sections.push(`- PID: ${manager.pid}`);
    }
    // Two distinct counters for support clarity:
    //   - Auto-restarts: only after-crash restarts via scheduleRestart().
    //     Feeds the kaspad_crash_loop Tier-2 trigger (>= 3 = crash loop).
    //     Resets to 0 after 5 min of stable running.
    //   - User-initiated: Restart Node button + manual Stop+Start cycles
    //     within ~60s. Doesn't trigger crash-loop alerts; persists for the
    //     whole session. Added in 0.3.4 (Theme D) after Morris's diagnostic
    //     showed "Restarts this session: 0" while he had pressed Restart
    //     multiple times.
    sections.push(`- Auto-restarts this session: ${manager.restartsInSession}`);
    sections.push(`- User-initiated restarts: ${manager.userInitiatedRestarts}`);
    sections.push('');
    // --- Installations & process inventory ---
    // Surfaces the "are there zombie kaspad.exe processes from a previous
    // unclean shutdown holding the chain DB lock?" failure mode, plus any
    // duplicate MyKAI Node installs from incomplete uninstalls. Added in
    // 0.3.4 after a 0.3.3 user (Morris) hit a "Sync hasn't moved in 52
    // minutes" alert that survived both the Restart-node button AND a
    // manual Stop+Start — strongly suggesting a zombie process MyKAI's
    // foreground manager couldn't see.
    sections.push('## Installations & processes');
    // Run the three Windows shell-outs (2 tasklists + 3-hive reg query) in
    // parallel. Pre-0.3.5-hotfix-#5 these were sequential synchronous
    // execSync calls that blocked the event loop for 1–3 s on every
    // diagnostic build — the structural cause of the multi-second
    // freeze users saw on every fresh install since 0.3.4. Now async +
    // parallel, and they don't block the loop while running.
    const [kaspadProcs, mykaiProcs, installs] = await Promise.all([
        (0, installations_info_1.countRunningProcesses)('kaspad.exe'),
        (0, installations_info_1.countRunningProcesses)('MyKAI Node.exe'),
        (0, installations_info_1.getInstalledMyKAIVersions)(),
    ]);
    sections.push(`- kaspad.exe processes running: ${kaspadProcs.count}` +
        (kaspadProcs.count > 0 ? ` (PIDs: ${kaspadProcs.pids.join(', ')})` : '') +
        (kaspadProcs.count > 1 ? '  ⚠️ multiple instances — likely zombies from previous unclean shutdowns; expected: 1' : ''));
    // Note: 3-5 MyKAI Node.exe processes is NORMAL for Electron apps —
    // Electron spawns separate processes for the main process, renderer
    // (Chromium UI), GPU process, and 1-2 utility processes (network
    // service, audio, etc.). All share the same .exe name. We don't
    // warn unless the count is wildly off (>8 suggests something is
    // really wrong — runaway spawn loop or two full app instances).
    sections.push(`- MyKAI Node.exe processes running: ${mykaiProcs.count}` +
        (mykaiProcs.count > 0 ? ` (PIDs: ${mykaiProcs.pids.join(', ')})` : '') +
        (mykaiProcs.count >= 3 && mykaiProcs.count <= 6 ? '  (normal — Electron multi-process: main + renderer + GPU + utilities)' : '') +
        (mykaiProcs.count > 8 ? '  ⚠️ unusually high — possibly two app instances or a runaway spawn loop' : ''));
    if (installs.length === 0) {
        sections.push('- Installed MyKAI versions (Add/Remove Programs): none detected');
    }
    else {
        sections.push(`- Installed MyKAI versions (Add/Remove Programs): ${installs.length}`);
        for (const inst of installs) {
            const loc = inst.installLocation && inst.installLocation !== '?'
                ? ` — ${redactPath(inst.installLocation)}`
                : '';
            sections.push(`  - ${inst.name} ${inst.version}${loc}`);
        }
        if (installs.length > 1) {
            sections.push('  ⚠️ multiple installs detected — expected: 1. Uninstall extras via Settings → Apps.');
        }
    }
    const dataDirs = (0, installations_info_1.getKaspaDataDirs)();
    if (dataDirs.length === 0) {
        sections.push('- Kaspa data dirs found: none in default locations');
    }
    else {
        sections.push(`- Kaspa data dirs found: ${dataDirs.length}`);
        for (const d of dataDirs) {
            sections.push(`  - ${redactPath(d.path)}`);
        }
        if (dataDirs.length > 1) {
            sections.push('  ⚠️ multiple kaspa data dirs found — kaspad may be using a different one than expected');
        }
    }
    sections.push('');
    // --- Auto-update log tail ---
    // Pre-0.3.6 we ran with `autoUpdater.logger = null`, blinding us to
    // every silent failure. Now electron-updater writes to
    // userData/updater.log; we tail the last ~120 lines into the
    // diagnostic so when a non-tech user reports "no banner / never
    // upgrades" we can read the real reason (signature mismatch, blockmap
    // delta failure, network error, ...) without asking them to find a
    // log file by hand. Silent on first run / fresh install (no log yet).
    sections.push('## Auto-update log (last 120 lines)');
    try {
        const updaterLogPath = path_1.default.join(electron_1.app.getPath('userData'), 'updater.log');
        if (fs_1.default.existsSync(updaterLogPath)) {
            const raw = fs_1.default.readFileSync(updaterLogPath, 'utf8');
            const lines = raw.split(/\r?\n/).filter(Boolean);
            const tail = lines.slice(-120);
            if (tail.length === 0) {
                sections.push('_(log empty)_');
            }
            else {
                sections.push('```');
                for (const ln of tail)
                    sections.push(redactPath(ln));
                sections.push('```');
            }
        }
        else {
            sections.push('_(no log yet — auto-update has not run on this install)_');
        }
    }
    catch (err) {
        sections.push(`_(log read failed: ${err?.message || String(err)})_`);
    }
    sections.push('');
    // --- System load ---
    // Aggregated CPU% (real, not the always-0 os.loadavg() Windows
    // returns), memory pressure, and top-5 processes by recent CPU time.
    // The single biggest piece of context that was missing on
    // 2026-04-28 — without it we couldn't tell "your machine is saturated
    // by 143 Edge processes" from "MyKAI has a real bug." With it, the
    // answer is one glance.
    sections.push('## System load');
    if (systemLoad) {
        const cpuFlag = systemLoad.cpuPctAvg > 50 ? ' ⚠️' : '';
        const memFlag = systemLoad.memPct > 85 ? ' ⚠️' : '';
        sections.push(`- CPU averaged across ${systemLoad.cpuCores} cores: ${systemLoad.cpuPctAvg.toFixed(1)}%${cpuFlag}`);
        sections.push(`- Memory: ${systemLoad.memUsedGB.toFixed(1)} GB / ${systemLoad.memTotalGB.toFixed(1)} GB (${systemLoad.memPct.toFixed(0)}% used)${memFlag}`);
        if (systemLoad.topProcesses.length > 0) {
            sections.push('- Top processes (recent-CPU weight, descending):');
            // Process names are a software fingerprint — listing them in a
            // diagnostic that gets pasted into Discord / email outs the user's
            // gaming, streaming, dev, mail, password-manager, etc. apps. Drop
            // everything except our own processes (kaspad, MyKAI Node, mykai-
            // monitor) to "other" — the diagnostic value is "is something else
            // starving us?" which the cpuPct + memMB still answer cleanly.
            for (const p of systemLoad.topProcesses) {
                const lower = p.name.toLowerCase();
                const isOurs = lower.includes('mykai') || lower.includes('kaspad');
                const displayName = isOurs ? p.name : 'other';
                const tag = isOurs ? ' (ours)' : '';
                sections.push(`    - ${displayName}: ${p.cpuPct}% recent-CPU, ${p.memMB} MB RSS${tag}`);
            }
            // Always show MyKAI / kaspad processes with their rank in the
            // system-wide CPU sort — even when they're below the top-5 cutoff.
            // Helps the user (and support) answer "is MyKAI the cause of
            // slowness or the victim of it" without that signal being silently
            // missing whenever ours happen not to make top-5.
            if (systemLoad.ownProcesses && systemLoad.ownProcesses.length > 0) {
                sections.push('- MyKAI / kaspad processes (always shown):');
                for (const p of systemLoad.ownProcesses) {
                    const rankStr = p.rank ? `rank #${p.rank}` : 'rank ?';
                    sections.push(`    - ${p.name}: ${rankStr}, ${p.cpuPct}% recent-CPU, ${p.memMB} MB RSS`);
                }
            }
        }
        else {
            sections.push('- Top processes: _(enumeration unavailable on this platform)_');
        }
        if (systemLoad.overloaded) {
            sections.push(`- Overload flags: ${systemLoad.reasons.join('; ')}`);
        }
        else {
            sections.push('- Overload flags: none ✓');
        }
    }
    else {
        sections.push('_(system-load module unavailable)_');
    }
    sections.push('');
    // --- Block rate truth table ---
    // Three-rate comparison: poll-based (kaspad's getBlockDagInfo at 1 Hz),
    // event-based raw (VirtualDaaScoreChanged at ~14 Hz, before clamp),
    // and event-based displayed (post-clamp at 50 BPS — what the
    // activity feed actually shows the user). When all three agree
    // within ~2 BPS, calc is consistent with what kaspad reports. When
    // they diverge, the comparison itself attributes the bug:
    //   - poll > event by >2 BPS  → notification stream throttled / wsNotify backpressured
    //   - event > poll by >2 BPS  → poll lagging (kaspad busy on poll RPC)
    //   - raw > display           → clamp fired (sample timestamp clustering)
    // Window timestamps shown so each rate can be correlated with
    // entries in perf-stalls.log below.
    sections.push('## Block rate');
    const _bpsWindowMs = 30_000;
    const _bpsNow = Date.now();
    const _bpsWindowEnd = new Date(_bpsNow).toISOString();
    const _bpsWindowStart = new Date(_bpsNow - _bpsWindowMs).toISOString();
    sections.push(`- Window: ${_bpsWindowStart} → ${_bpsWindowEnd} (30 s)`);
    sections.push(`- Kaspa network target (post-Crescendo): ~10 BPS`);
    let _ratePoll = 0, _rateEvent = 0, _rateDisplay = 0;
    try {
        _ratePoll = monitor.getDaaBps(_bpsWindowMs);
    }
    catch { }
    try {
        _rateEvent = monitor.getDaaEventBpsRaw(_bpsWindowMs);
    }
    catch { }
    try {
        _rateDisplay = monitor.getDaaEventBps(_bpsWindowMs);
    }
    catch { }
    sections.push(`- Kaspad reports (1 Hz poll): **${_ratePoll.toFixed(1)} BPS**`);
    sections.push(`- Kaspad reports (notification stream, raw): **${_rateEvent.toFixed(1)} BPS**`);
    sections.push(`- MyKAI displays (activity feed, post-clamp): **${_rateDisplay.toFixed(1)} BPS**`);
    const _dPollEvent = _ratePoll - _rateEvent;
    const _dEventDisplay = _rateEvent - _rateDisplay;
    const _flag = (delta) => Math.abs(delta) > 2.0 ? '⚠️ DIVERGED' : '✓';
    sections.push(`- Δ poll − event: ${_dPollEvent >= 0 ? '+' : ''}${_dPollEvent.toFixed(1)} BPS  ${_flag(_dPollEvent)}`);
    sections.push(`- Δ event − display: ${_dEventDisplay >= 0 ? '+' : ''}${_dEventDisplay.toFixed(1)} BPS  ${_dEventDisplay > 0.5 ? '⚠️ CLAMP-ACTIVE' : '✓'}`);
    // Buffer-size divergence check — _blockRate (kaspad-manager, 30s
    // window) and monitoring.buffer.recentBlocks (60s heartbeat) should
    // grow at the same rate but stay within 2× of each other in steady
    // state. A large divergence = one buffer drains and the other
    // doesn't, signaling a heartbeat or activity-feed pipeline issue.
    const _blockRateLen = manager._blockRate?.length ?? 0;
    const _recentBlocksLen = monitor._monitoringRef?.buffer?.recentBlocks?.length ?? 0;
    sections.push(`- Buffer sizes: _blockRate=${_blockRateLen}, recentBlocks=(passed via heartbeat — see Performance stalls section)`);
    sections.push('');
    // --- Performance stalls ---
    // perf-stalls.log captures every tick > 100 ms, GC > 50 ms, rate
    // divergence > 2 BPS, slow electron-store .set() > 50 ms, and BPS
    // clamp fires. Surface the in-memory ring (last 50 summary lines)
    // here so a single diagnostic copy-paste tells us everything. The
    // file on disk holds more (last ~2 MB) for deeper forensics.
    sections.push('## Performance stalls (last 50 events)');
    try {
        const stallText = perfStalls.getRecentEntriesText();
        sections.push('```');
        sections.push(stallText);
        sections.push('```');
    }
    catch (err) {
        sections.push(`_(read failed: ${err?.message || String(err)})_`);
    }
    sections.push('');
    // --- RPC subscriptions ---
    sections.push('## RPC subscriptions');
    sections.push(`- Subscribed: ${monitor.isSubscribed ? 'yes' : 'no'}`);
    sections.push(`- Last blockAdded received: ${monitor.lastBlockAddedTs ? fmtTimeAgo(monitor.lastBlockAddedTs) : '(never)'}`);
    // Underfeeding attribution (PR 5 follow-up). If `notify raw` tracks
    // network BPS (~10) but `block-added emitted` is lower, parse is
    // dropping events (client-side bug). If `notify raw` itself is low,
    // kaspad isn't sending them (server / topology side).
    const rates = monitor.getNotifyRates();
    sections.push(`- Notify-socket raw message rate (10s): ${rates.notifyRawBps.toFixed(1)}/s`);
    sections.push(`- RPC-socket raw message rate (10s): ${rates.rpcRawBps.toFixed(1)}/s`);
    sections.push(`- block-added emit rate (10s): ${rates.blockAddedBps.toFixed(1)}/s`);
    // Method histogram + BlockAdded drop reasons (cumulative since start).
    // If blockadded count is high but accepts is low, the drop-reason
    // tally localizes the parse failure. If blockadded count itself is
    // low, the gap is kaspad-side.
    const stats = monitor.getNotifyStats();
    if (stats.byMethod.length > 0) {
        sections.push(`- Notifications seen (cumulative):`);
        for (const [method, count] of stats.byMethod) {
            sections.push(`    - ${method}: ${count.toLocaleString()}`);
        }
        sections.push(`- BlockAdded accepted: ${stats.blockAddedAccepts.toLocaleString()}`);
        sections.push(`- BlockAdded dropped (no candidate block shape): ${stats.blockAddedDrops.noCandidateBlock.toLocaleString()}`);
        sections.push(`- BlockAdded dropped (no hash): ${stats.blockAddedDrops.noHash.toLocaleString()}`);
    }
    sections.push('');
    // --- Main process (MyKAI itself) ---
    // Shows at a glance whether the main process is accumulating state.
    // Healthy baseline: RSS ~350 MB, heap used ~100 MB, listener counts
    // exactly 1 on the events we care about, kasmap.connecting=false.
    sections.push('## Process (MyKAI main)');
    const mem = process.memoryUsage();
    sections.push(`- RSS: ${fmtBytes(mem.rss)}`);
    sections.push(`- Heap used / total: ${fmtBytes(mem.heapUsed)} / ${fmtBytes(mem.heapTotal)}`);
    sections.push(`- External: ${fmtBytes(mem.external)}`);
    sections.push(`- Process uptime: ${fmtDuration(process.uptime() * 1000)}`);
    sections.push(`- Listener count (manager:state-change): ${manager.listenerCount('state-change')}`);
    sections.push(`- Listener count (monitor:block-added): ${monitor.listenerCount('block-added')}`);
    sections.push(`- Listener count (monitor:status): ${monitor.listenerCount('status')}`);
    // Event-loop delay (PR 5). Healthy baseline: p50 < 10 ms, p99 < 100 ms.
    // Sustained p99 > 500 ms is diagnostic of the main thread being
    // periodically blocked — typically JSON.stringify + gzip of a multi-MB
    // Insights payload (fixed by PR 3's worker-thread offload). A run that
    // reproduces the "142 new blocks" symptom will show p99 > 500 ms.
    const lag = (0, loop_lag_1.getLoopLagPercentiles)();
    sections.push(`- Event-loop delay: p50 ${lag.p50Ms} ms, p99 ${lag.p99Ms} ms, max ${lag.maxMs} ms (lifetime)`);
    // Top stalls (this session). Loop-lag's max gives the WORST value but
    // says nothing about WHEN it happened or WHY. perf-stalls captures
    // each stall over the 100 ms threshold with full forensic context;
    // the top-N tracker keeps the worst three in memory across the whole
    // process lifetime, so they stay visible even after rolling out of
    // the perf-stalls.log ring (which only keeps ~2 MB on disk).
    //
    // Reading the rows: BLOCKED = main thread was waiting on something
    // external (sync I/O, OS scheduling, antivirus). BUSY = our own JS
    // code was burning CPU (gzip, big JSON.stringify, etc.). GC time +
    // biggest_buffer give attribution hints.
    const topStalls = perfStalls.getTopStalls();
    if (topStalls.length === 0) {
        sections.push(`- Top stalls (this session): none — clean run`);
    }
    else {
        sections.push(`- Top stalls (this session, worst ${topStalls.length}):`);
        for (let i = 0; i < topStalls.length; i++) {
            const s = topStalls[i];
            const isoTs = new Date(s.ts).toISOString();
            const cpuPart = `${s.cpuVerdict} (cpu ${s.cpuPct}%)`;
            const gcPart = s.gcType ? ` GC=${s.gcType} ${(s.gcDurationMs ?? 0).toFixed(1)}ms` : '';
            const bufPart = s.biggestBuffer ? ` biggest_buffer: ${s.biggestBuffer.name}=${s.biggestBuffer.size}` : '';
            sections.push(`    ${i + 1}. ${s.durationMs.toFixed(0)} ms at ${isoTs} | ${cpuPart}${gcPart}${bufPart}`);
        }
    }
    // RPC-socket backpressure (PR 5). 0 is the healthy number. A non-zero
    // steady-state value means we're writing to wsRpc faster than kaspad
    // reads — the symptom PR 2/4 targeted.
    sections.push(`- RPC socket buffered: ${fmtBytes(monitor.wsRpcBufferedBytes)}`);
    if (sources.agentBridge) {
        sections.push(`- Listener count (agentBridge:watch-tx): ${sources.agentBridge.listenerCount('watch-tx')}`);
    }
    if (sources.kasmapRealtime) {
        sections.push(`- KasMap connected / connecting: ${sources.kasmapRealtime.isConnected} / ${sources.kasmapRealtime.isConnecting}`);
    }
    sections.push('');
    // --- Hardware ---
    sections.push('## Hardware');
    sections.push(`- RAM total: ${fmtBytes(specs.ramBytes)}`);
    sections.push(`- RAM free: ${fmtBytes(specs.ramFreeBytes)} (${ramUsedPct}% used)`);
    sections.push(`- CPU: ${specs.cpuVendor || '(unknown)'} ${specs.cpuFamily || ''}${specs.cpuClockGhz ? ' @ ' + specs.cpuClockGhz + ' GHz' : ''}`);
    sections.push(`- CPU cores: ${specs.cpuCount}`);
    // Aggregated CPU% from system-load module — replaces the
    // always-0 os.loadavg() reading on Windows. Falls back to the old
    // value if system-load wasn't initialized (defensive — should not
    // happen in a normal session).
    const cpuLoadDisplay = systemLoad
        ? `${systemLoad.cpuPctAvg.toFixed(1)}%`
        : `${specs.cpuLoad1m} (loadavg fallback — Windows always reports 0)`;
    sections.push(`- CPU usage (avg across cores): ${cpuLoadDisplay}`);
    if (specs.cpuPercentPerCore.length > 0) {
        sections.push(`- CPU per-core %: [${specs.cpuPercentPerCore.join(', ')}]`);
    }
    sections.push('');
    // --- Insights heartbeat ---
    sections.push('## Insights heartbeat');
    sections.push(`- Enabled: ${appConfig.contributeMonitoring}`);
    sections.push(`- Active: ${mon.active}`);
    sections.push(`- Interval: ${Math.round(mon.intervalMs / 1000)}s`);
    sections.push(`- Last attempt: ${fmtTimeAgo(mon.lastSendTime)}`);
    sections.push(`- Last attempt OK: ${mon.lastSendOk}`);
    if (mon.lastSuccessTime) {
        sections.push(`- Last success: ${fmtTimeAgo(mon.lastSuccessTime)}`);
    }
    else {
        sections.push(`- Last success: never`);
    }
    if (mon.payloadBytes) {
        if (mon.payloadBytesCompressed) {
            const ratio = mon.payloadBytes / mon.payloadBytesCompressed;
            sections.push(`- Last payload: ${(mon.payloadBytesCompressed / 1024).toFixed(1)} KB on the wire (${(mon.payloadBytes / 1024).toFixed(1)} KB raw, ${ratio.toFixed(1)}× gzip)`);
        }
        else {
            sections.push(`- Last payload: ${(mon.payloadBytes / 1024).toFixed(1)} KB`);
        }
    }
    if (!mon.lastSendOk && mon.lastSendError) {
        sections.push(`- Last error: \`${mon.lastSendError}\``);
    }
    sections.push('');
    // --- KasMap ---
    sections.push('## KasMap');
    sections.push(`- Enabled: ${appConfig.kasmap?.enabled ?? false}`);
    sections.push(`- Token set: ${!!(appConfig.kasmap?.token)}`);
    if (sources.kasmapRealtime) {
        const rt = sources.kasmapRealtime;
        sections.push(`- Realtime connected: ${rt.isConnected}`);
        sections.push(`- Realtime connecting: ${rt.isConnecting}`);
        sections.push(`- Circuit breaker open: ${rt.circuitOpen}`);
        sections.push(`- Consecutive failures: ${rt.consecutiveFailures}`);
        sections.push(`- Last error reason: ${rt.lastErrorReason || '(none)'}`);
        const status = rt.getStatus();
        if (status.nextRetryInMs > 0) {
            const secs = Math.round(status.nextRetryInMs / 1000);
            sections.push(`- Next retry in: ${secs}s`);
        }
    }
    sections.push('');
    // --- Mining — always shown, with explicit "not linked" when inactive ---
    sections.push('## Mining');
    const miningEnabled = appConfig.miningEnabled;
    const stratumRunning = stratum.state === 'running';
    const workerCount = stratum.stats.workers.length;
    const hasLinkedMiner = stratumRunning && workerCount > 0;
    if (!miningEnabled && !stratumRunning) {
        sections.push('- Mining is disabled in settings — no miner linked.');
    }
    else if (miningEnabled && !stratumRunning) {
        sections.push('- Mining enabled in settings but stratum bridge is not running.');
        sections.push(`- Address: ${redactAddress(appConfig.miningAddress)}`);
        sections.push(`- Stratum bind: ${appConfig.stratumBind}`);
        sections.push(`- Stratum port: ${appConfig.stratumPort}`);
    }
    else if (stratumRunning && workerCount === 0) {
        sections.push('- Stratum bridge is running, but no miner has connected yet.');
        sections.push(`- Address: ${redactAddress(appConfig.miningAddress)}`);
        sections.push(`- Stratum bind: ${appConfig.stratumBind}`);
        sections.push(`- Stratum port: ${appConfig.stratumPort}`);
        sections.push(`- State: \`${stratum.state}\``);
    }
    else if (hasLinkedMiner) {
        sections.push(`- State: \`${stratum.state}\``);
        sections.push(`- Address: ${redactAddress(appConfig.miningAddress)}`);
        sections.push(`- Stratum bind: ${appConfig.stratumBind}`);
        sections.push(`- Stratum port: ${appConfig.stratumPort}`);
        sections.push(`- Workers: ${workerCount}`);
        sections.push(`- Total hashrate: ${stratum.stats.totalHashrate} GH/s`);
        sections.push(`- Blocks found (this cycle): ${stratum.blocksThisCycle}`);
    }
    sections.push('');
    // --- Gamification stats ---
    sections.push('## Stats (lifetime)');
    sections.push(`- Blocks validated: ${gameStats.blocksValidated?.toLocaleString() ?? 0}`);
    sections.push(`- Transactions seen: ${gameStats.transactionsSeen?.toLocaleString() ?? 0}`);
    sections.push(`- Current TPS: ${gameStats.currentTps ?? 0}`);
    sections.push(`- Total uptime: ${fmtDuration((gameStats.totalUptimeSeconds ?? 0) * 1000)}`);
    sections.push(`- Uptime record: ${fmtDuration((gameStats.longestStreakSeconds ?? 0) * 1000)}`);
    sections.push('');
    // --- Recent activity ---
    // 100 lines (was 60). Cold-start bursts produce 30-50 "New peer connected"
    // lines in the first 30 seconds, which used to fill most of a 60-line dump
    // and crowd out the actually-interesting events that came after. 100 gives
    // ~4 minutes of history at typical event rates.
    const activity = (0, activity_buffer_1.getRecentActivity)(100);
    sections.push('## Recent activity (last ' + activity.length + ' lines)');
    sections.push('```');
    if (activity.length === 0) {
        sections.push('(no activity yet)');
    }
    else {
        for (const line of activity)
            sections.push(line);
    }
    sections.push('```');
    sections.push('');
    sections.push('---');
    sections.push('*Generated by MyKAI Node. Safe to share with the MyKAI team for diagnostics.*');
    return sections.join('\n');
}
//# sourceMappingURL=diagnostic.js.map