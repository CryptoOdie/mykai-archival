// MyKAI Node — Renderer

const $ = (sel) => document.querySelector(sel);

/** Escape HTML-special characters in a string before inserting into innerHTML.
 *  Activity-feed messages and alert content can include text from kaspad logs,
 *  peer user-agents, or remote addresses; without escaping, a peer-influenced
 *  string could land an HTML/script fragment in the DOM. Sandboxing limits the
 *  blast radius but doesn't make it benign. */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
let currentState = 'stopped';
let isLoading = false;
let lastLogTime = 0;
let activityInterval = null;
let activePanel = 'activity'; // 'activity' | 'mining' | 'settings'
let utxoResyncTimer = null;
let utxoResyncStartTime = 0;
let utxoResyncEstimate = 0;

// All milestone definitions (must match backend)
const ALL_MILESTONES = [
  { id: 'first-sync', label: 'First Sync' },
  { id: 'blocks-1k', label: '1K Blocks' },
  { id: 'blocks-10k', label: '10K Blocks' },
  { id: 'blocks-100k', label: '100K Blocks' },
  { id: 'blocks-1m', label: '1M Blocks' },
  { id: 'uptime-1h', label: '1 Hour' },
  { id: 'uptime-24h', label: '24 Hours' },
  { id: 'uptime-7d', label: '7 Days' },
  { id: 'tps-100', label: 'Speed Demon' },
  { id: 'tps-500', label: 'Turbo Mode' },
  { id: 'tx-1m', label: '1M Transactions' },
];

// --- Appearance ---
function applyTheme(theme) {
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    document.documentElement.setAttribute('data-theme', theme || 'dark');
  }
}

// Listen for system theme changes when set to "system"
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const themeSelect = document.getElementById('setting-theme');
  if (themeSelect && themeSelect.value === 'system') {
    applyTheme('system');
  }
});

// Apply saved appearance on load
(async () => {
  try {
    const cfg = await window.mykai.config.get();
    applyTheme(cfg.theme || 'dark');
  } catch {}
})();

// --- Window Controls ---
$('#btn-minimize').addEventListener('click', () => window.mykai.window.minimize());
$('#btn-maximize').addEventListener('click', () => window.mykai.window.maximize());
$('#btn-close').addEventListener('click', () => window.mykai.window.close());

// --- Events from backend ---
window.mykai.node.onStatusUpdate((status) => {
  updateUI(status);
  // Keep the Local Node row in My Nodes in sync with the top status. Without
  // this, the table only refreshes on its 2-minute cadence and can show
  // "Syncing" for up to 2 min after the node has actually transitioned to
  // synced — exactly the inconsistency users reported between the top
  // "Running" indicator and the table's "Syncing" label.
  if (typeof refreshLocalNodeRow === 'function') refreshLocalNodeRow(status);
});
window.mykai.node.onActivity((msg) => { lastLogTime = Date.now(); addActivity(msg); });
window.mykai.node.onMilestone((m) => showMilestoneToast(m));
window.mykai.node.onAlerts((alerts) => renderAlerts(alerts));
window.mykai.node.onHealth((h) => renderHealth(h));

// --- Health card ---
// Snapshot shape (from main's health-checks.ts):
//   { overall: 'ok'|'warn'|'fail', checks: HealthCheck[], qualityHints: {...} }
// Checks with severity='ok' are hidden; only warn/fail are shown.
// Dismissals live in-memory only — reset on next warn, clear on restart.
const _dismissedHealthIds = new Set();

function renderHealth(snapshot) {
  const card = document.querySelector('#health-card');
  if (!card || !snapshot) return;

  const issues = (snapshot.checks || []).filter(
    c => c.severity !== 'ok' && !_dismissedHealthIds.has(c.id)
  );

  // Remove "ok" checks the user had previously dismissed — if they go green,
  // clear the dismissal so future recurrences show normally.
  for (const check of snapshot.checks || []) {
    if (check.severity === 'ok') _dismissedHealthIds.delete(check.id);
  }

  // Hide the card entirely when there's nothing to say — the absence of
  // warnings IS the "healthy" signal. Also hide when the node is stopped
  // or in an error state (no state to meaningfully report).
  const state = (currentState || 'stopped');
  if (state === 'stopped' || state === 'error' || issues.length === 0) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');

  // Styling on the card reflects the most severe visible issue.
  card.classList.remove('health-ok', 'health-warn', 'health-fail');
  const overall = issues.some(i => i.severity === 'fail') ? 'fail' : 'warn';
  card.classList.add('health-' + overall);

  const icon = document.querySelector('#health-icon');
  const label = document.querySelector('#health-label');
  const hint = document.querySelector('#health-expand-hint');
  icon.textContent = '\u26a0';   // warning triangle — only shown when something's wrong
  const count = issues.length;
  label.textContent = count === 1 ? '1 thing to check' : `${count} things to check`;
  hint.textContent = card.classList.contains('expanded') ? 'click to collapse' : 'click for details';

  // Render issues list
  const list = document.querySelector('#health-issues');
  list.innerHTML = '';
  for (const issue of issues) {
    const el = document.createElement('div');
    el.className = 'health-issue health-' + issue.severity;
    const title = document.createElement('div');
    title.className = 'health-issue-title';
    title.textContent = issue.title;
    el.appendChild(title);
    if (issue.detail) {
      const d = document.createElement('div');
      d.className = 'health-issue-detail';
      d.textContent = issue.detail;
      el.appendChild(d);
    }
    if (issue.actions && issue.actions.length > 0) {
      const actions = document.createElement('div');
      actions.className = 'health-issue-actions';
      issue.actions.forEach((a, idx) => {
        const btn = document.createElement('button');
        btn.className = 'health-issue-btn' + (idx > 0 ? ' secondary' : '');
        btn.textContent = a.label;
        btn.addEventListener('click', () => handleHealthAction(issue.id, a.action));
        actions.appendChild(btn);
      });
      el.appendChild(actions);
    }
    list.appendChild(el);
  }

  // Expand/collapse
  const expanded = card.classList.contains('expanded');
  if (overall === 'ok') {
    list.classList.add('hidden');
    card.classList.remove('expanded');
  } else if (expanded) {
    list.classList.remove('hidden');
  } else {
    list.classList.add('hidden');
  }
}

async function handleHealthAction(issueId, action) {
  switch (action) {
    case 'fix-clock':
      await window.mykai.clock.fixNow();
      break;
    case 'restart-node':
      await window.mykai.node.restart();
      break;
    case 'copy-diagnostic':
      await copyDiagnosticInfo();
      break;
    case 'open-data-folder':
      await window.mykai.shell.openDataFolder();
      break;
    case 'retry-kasmap':
      await window.mykai.kasmap.retry();
      _dismissedHealthIds.add(issueId);  // hide the warning immediately; reconnect attempt is now in-flight
      window.mykai.node.health().then(renderHealth);
      break;
    case 'dismiss':
      _dismissedHealthIds.add(issueId);
      window.mykai.node.health().then(renderHealth);
      break;
  }
}

// Click the summary bar to expand/collapse when there are issues
document.querySelector('#health-summary')?.addEventListener('click', () => {
  const card = document.querySelector('#health-card');
  if (card.classList.contains('health-ok')) return;   // nothing to expand
  card.classList.toggle('expanded');
  window.mykai.node.health().then(renderHealth);
});

// Initial fetch so the card renders without waiting for the first 10s push
window.mykai.node.health().then(renderHealth).catch(() => {});

function renderAlerts(alerts) {
  const panel = document.querySelector('#alerts-panel');
  const indicator = document.querySelector('#status-indicator');
  if (!panel) return;

  const hasAttention = Array.isArray(alerts) && alerts.some(a => {
    const sev = (a && a.severity || '').toLowerCase();
    return sev === 'warning' || sev === 'error';
  });
  if (indicator) indicator.classList.toggle('has-warning', hasAttention);

  if (!Array.isArray(alerts) || alerts.length === 0) {
    panel.innerHTML = '';
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  panel.innerHTML = alerts.map((a, i) => {
    const sev = (a.severity || 'info').toLowerCase();
    const esc = escapeHtml; // hoisted module-level helper; alias kept for local readability
    const isClockSkew = (a.type || '').toLowerCase() === 'clock_skew';
    let actionHtml = '';
    if (isClockSkew) {
      actionHtml = `<div class="alert-actions">
           <button class="alert-btn" data-alert-idx="${i}" data-alert-action="clock-fix">Fix automatically now</button>
           <span class="alert-note">Windows will ask for permission</span>
         </div>`;
    } else if (a.action) {
      actionHtml = `<div class="alert-action">${esc(a.action)}</div>`;
    }
    // Error-severity alerts get a "Copy diagnostic info" button so users
    // can grab state for support without hunting through Settings.
    if (sev === 'error') {
      actionHtml += `<div class="alert-actions" style="margin-top:6px">
           <button class="alert-btn" data-alert-action="copy-diagnostic">Copy diagnostic info</button>
         </div>`;
    }
    return `
      <div class="alert-card ${esc(sev)}">
        <div class="alert-title">${esc(a.title)}</div>
        <div class="alert-message">${esc(a.message)}</div>
        ${actionHtml}
      </div>`;
  }).join('');
}

// Delegated click handler for alert action buttons
document.addEventListener('click', async (e) => {
  const btn = e.target.closest && e.target.closest('[data-alert-action="clock-fix"]');
  if (!btn) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Asking Windows for permission…';
  try {
    const result = await window.mykai.clock.fixNow();
    if (result && result.ok) {
      btn.textContent = 'Clock synced — checking…';
      // The alert will clear naturally on the next heartbeat (or sooner via remeasureNow)
      setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 30000);
    } else {
      btn.textContent = 'Fix cancelled';
      setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 3000);
    }
  } catch {
    btn.textContent = 'Fix failed — try again';
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 3000);
  }
});
window.mykai.gamification.onStatsUpdate((stats) => updateGameStats(stats));
window.mykai.node.onSyncPhase((phase) => updateSyncBars(phase));
window.mykai.health.onAgentStatus((s) => updateAgentIndicator(s));
window.mykai.node.onUtxoResync((data) => handleUtxoResync(data));
window.mykai.finality.onUpdate((stats) => updateFinalityStats(stats));
window.mykai.finality.onChainFlip((flip) => handleChainFlip(flip));

// v0.5: shard contribution dashboard widget. Polls shard:stats every 10s.
// Hides entirely when feature is off (stats === null).
function formatBytesShort(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v < 10 ? v.toFixed(1) + ' ' + units[i] : Math.round(v) + ' ' + units[i];
}
async function refreshShardCard() {
  try {
    const stats = await window.mykai.shard?.stats?.();
    const card = document.getElementById('shard-card');
    if (!card) return;
    if (!stats || !stats.enabled) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    document.getElementById('shard-stat-blocks').textContent =
      (stats.blockCount || 0).toLocaleString();
    document.getElementById('shard-stat-used').textContent =
      formatBytesShort(stats.totalBytes || 0);
    document.getElementById('shard-stat-budget').textContent =
      (stats.budgetGB || 0) + ' GB';
    document.getElementById('shard-stat-rate').textContent =
      String(stats.capturedLast60s || 0);
    // Status line: blocks/min + oldest-block age hint when we have data
    let status = '';
    if (stats.blockCount > 0 && stats.oldestDaa != null && stats.newestDaa != null) {
      const range = stats.newestDaa - stats.oldestDaa;
      status = `DAA range: ${stats.oldestDaa.toLocaleString()} → ${stats.newestDaa.toLocaleString()} (${range.toLocaleString()} span)`;
    } else if (stats.blockCount === 0) {
      status = 'waiting for kaspad…';
    }
    document.getElementById('shard-card-status').textContent = status;
  } catch (err) {
    // Silent — feature might not be wired yet on older main process versions.
  }
}
// Immediate poll on load, then every 10s.
refreshShardCard();
setInterval(refreshShardCard, 10_000);

// v0.4: storage-mode change handler. Main process fires this from
// ipc-handlers.js after config:set persists. Renderer shows the right
// confirmation dialog (especially for the destructive pruned->archival
// transition which requires a kaspad re-sync from network) and triggers
// the kaspad restart so the new flags take effect.
window.mykai.config.onStorageModeChanged?.((info) => {
  const { oldMode, newMode, requiresFullResync } = info;
  if (oldMode === newMode) return; // retention-days-only change; no friction needed
  // Going INTO archival from pruned/retention: this is the big one — kaspad
  // will start collecting history from now forward (NOT recover past data).
  // High-friction confirmation: type DELETE HISTORY to be sure.
  if (newMode === 'archival' && requiresFullResync) {
    const confirmText = 'KEEP ARCHIVE';
    const typed = window.prompt(
      'Enabling archival mode\n\n' +
      'Your node will stop deleting old blocks and start growing forever\n' +
      '(~1-2 GB per day after the initial archive is rebuilt).\n\n' +
      'IMPORTANT: This does NOT recover history from BEFORE you enable archival.\n' +
      'Your node only archives blocks from now forward. To get older history,\n' +
      'import a snapshot from another archival operator after enabling.\n\n' +
      `Type "${confirmText}" to confirm:`,
      ''
    );
    if (typed !== confirmText) {
      addActivity('Archival mode change cancelled.');
      // Revert the config silently.
      window.mykai.config.set({ nodeStorageMode: oldMode });
      // Reload settings UI to show the reverted state.
      loadSettings();
      return;
    }
    addActivity('Archival mode enabled — restarting kaspad with --archival flag.');
    window.mykai.node.restart?.();
    return;
  }
  // Leaving archival: kaspad will gradually delete accumulated history on
  // the next pruning advance. Type DELETE HISTORY to confirm.
  if (oldMode === 'archival' && newMode !== 'archival') {
    const confirmText = 'DELETE HISTORY';
    const typed = window.prompt(
      'Disabling archival mode\n\n' +
      'Your node will start deleting historical blocks. This cannot be undone\n' +
      'without re-importing or re-syncing an archive (which you cannot do\n' +
      'from the network without help).\n\n' +
      `Type "${confirmText}" to confirm:`,
      ''
    );
    if (typed !== confirmText) {
      addActivity('Archival mode change cancelled.');
      window.mykai.config.set({ nodeStorageMode: 'archival' });
      loadSettings();
      return;
    }
    addActivity(`Archival mode disabled — switching to ${newMode}. Kaspad will gradually prune.`);
    window.mykai.node.restart?.();
    return;
  }
  // pruned <-> retention transitions are non-destructive; just restart kaspad.
  addActivity(`Storage mode changed: ${oldMode} → ${newMode}. Restarting kaspad.`);
  window.mykai.node.restart?.();
});

// --- Info-icon click-to-pin popover ---
// Native HTML title="" already shows on hover, but Windows suppresses it
// the moment you click. Users expect the click to PIN the explanation
// open instead of dismissing it. This handler reads the same text from
// the closest ancestor with a title="" attribute and shows it in a
// custom popover that stays open until the user clicks outside or hits
// Escape.
(function setupInfoPopover() {
  const popover = document.getElementById('info-popover');
  const popoverText = document.getElementById('info-popover-text');
  const popoverClose = document.getElementById('info-popover-close');
  if (!popover || !popoverText) return;

  let pinned = false; // true while a tooltip is open

  function showPopover(anchor, text) {
    popoverText.textContent = text;
    popover.classList.remove('hidden');
    // Position below-and-left of the anchor; flip if it would go off-screen.
    const rect = anchor.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + popRect.width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - popRect.width - 8);
    }
    if (top + popRect.height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - popRect.height - 6);
    }
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    pinned = true;
  }

  function hidePopover() {
    popover.classList.add('hidden');
    pinned = false;
  }

  document.addEventListener('click', (e) => {
    const icon = e.target.closest && e.target.closest('.info-icon');
    if (icon) {
      // Click on info icon — pin the popover for the closest titled ancestor.
      const titled = icon.closest('[title]');
      const text = titled?.getAttribute('title');
      if (text) {
        // Stop the click from also bubbling to handlers that toggle the
        // surrounding card (e.g. the mining-card header).
        e.stopPropagation();
        showPopover(icon, text);
      }
      return;
    }
    // Click anywhere else — close the popover if it's pinned, but ignore
    // clicks on the popover itself so users can select / read the text.
    if (pinned && !e.target.closest('#info-popover')) {
      hidePopover();
    }
  });

  popoverClose?.addEventListener('click', (e) => {
    e.stopPropagation();
    hidePopover();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pinned) hidePopover();
  });
})();

// --- Status UI ---
function updateUI(status) {
  const prevState = currentState;
  currentState = status.state;
  isLoading = false;

  $('#status-indicator').className = status.state;
  $('#status-text').textContent = getStateLabel(status.state);
  $('#status-subtext').textContent = getStateSubtext(status);

  const syncDetailEl = $('#sync-detail');
  // Don't overwrite sync detail when UTXO resync timer is running
  if (!utxoResyncTimer) {
    if (status.syncDetail && (status.state === 'syncing' || status.state === 'starting')) {
      syncDetailEl.textContent = status.syncDetail;
      syncDetailEl.classList.remove('hidden');
    } else if (status.state === 'synced' || status.state === 'stopped') {
      syncDetailEl.classList.add('hidden');
    }
  }

  $('#endpoint-url').textContent = status.wrpcEndpoint || 'ws://localhost:17110';

  const btnToggle = $('#btn-toggle');
  btnToggle.disabled = false;
  const isRunning = status.state !== 'stopped' && status.state !== 'error';
  btnToggle.textContent = isRunning ? 'Stop Node' : 'Start Node';
  btnToggle.classList.toggle('btn-start', !isRunning);
  btnToggle.classList.remove('loading');

  $('#stat-peers').textContent = status.peerCount || '0';
  $('#stat-daa').textContent = fmtNum(status.daaScore);
  $('#stat-mempool').textContent = status.mempoolSize || '0';
  // Store base for smooth client-side ticking
  lastUptimeBase = status.uptimeSeconds || 0;
  lastUptimeTimestamp = Date.now();
  $('#stat-network').textContent = status.networkName || '—';
  // Kaspad version as reported by RPC getInfo.serverVersion. '—' when
  // the node isn't running / RPC hasn't replied yet.
  $('#stat-version').textContent = status.serverVersion ? `v${status.serverVersion}` : '—';

  // Show/hide sync bars based on state
  if (status.state === 'syncing') {
    $('#sync-bar-container').classList.remove('hidden');
  } else if (status.state === 'synced' || status.state === 'stopped') {
    $('#sync-bar-container').classList.add('hidden');
  }

  if (prevState !== currentState) {
    $('#status-indicator').classList.add('flash');
    setTimeout(() => $('#status-indicator').classList.remove('flash'), 600);
  }
}

function getStateLabel(state) {
  return { stopped: 'Offline', starting: 'Starting...', syncing: 'Syncing', synced: 'Running', error: 'Error' }[state] || state;
}

function getStateSubtext(status) {
  const peers = status.peerCount > 0 ? `${status.peerCount} peers connected` : '';
  switch (status.state) {
    case 'stopped': return 'Press Start to connect to the Kaspa network';
    case 'starting': return 'Preparing node...';
    case 'syncing': return peers || 'Connecting to the Kaspa network...';
    case 'synced': return peers ? `${status.peerCount} peers — Your node is live` : 'Your node is live';
    case 'error': return status.errorMessage || 'Something went wrong. Try restarting.';
    default: return '';
  }
}

// --- Gamification ---
function updateGameStats(stats) {
  $('#game-blocks').textContent = fmtNum(stats.blocksValidated);
  $('#game-tx').textContent = fmtNum(stats.transactionsSeen);
  $('#game-tps').textContent = Math.round(stats.currentTps);
  renderMilestones(stats.milestones);
}

function renderMilestones(unlocked) {
  // Milestones are now shown only as toast popovers, no badge bar
}

function showMilestoneToast(m) {
  const toast = $('#milestone-toast');
  toast.querySelector('.toast-text').textContent = `${m.label} — ${m.description}`;
  toast.classList.remove('hidden');
  // Stay until clicked
  toast.onclick = () => toast.classList.add('hidden');
  addActivity(`Achievement unlocked: ${m.label}!`, 'milestone-item');
}

// --- KasFinality (silent — data goes to KaspaBI) ---
function updateFinalityStats(stats) { /* silent */ }
function handleChainFlip(flip) { /* silent */ }

// --- UTXO Resync Progress ---
// During UTXO rebuild we enter "setup mode" — a drastically simplified UI
// for non-tech users. We hide all the scary noise (health warnings, peer
// counts, stats grid full of zeros, status timers) and show just one
// calm message: "Setting up your node..." with a rough ETA and a clear
// "keep it running" instruction. The whole-body class is removed when
// rebuild finishes.
function handleUtxoResync(data) {
  const syncDetail = $('#sync-detail');

  if (data.phase === 'start') {
    utxoResyncStartTime = Date.now();
    utxoResyncEstimate = data.estimateSeconds;
    document.body.classList.add('setup-mode');
    addActivity('Setting up your node...');

    if (utxoResyncTimer) clearInterval(utxoResyncTimer);
    utxoResyncTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - utxoResyncStartTime) / 1000);

      let line1;
      // If we have an estimate from a previous run, show remaining time.
      // First-time users see a range instead of a specific number.
      if (utxoResyncEstimate > 0) {
        const remaining = Math.max(0, utxoResyncEstimate - elapsed);
        if (remaining > 60) {
          line1 = `About ${Math.ceil(remaining / 60)} more minutes`;
        } else if (remaining > 0) {
          line1 = 'Almost done...';
        } else {
          // Went over the estimate — just show elapsed
          const over = Math.round((elapsed - utxoResyncEstimate) / 60);
          line1 = over > 0 ? `Taking a bit longer than usual` : 'Almost done...';
        }
      } else {
        // First-time setup — give a range, not a fake specific number
        const elapsedMin = Math.floor(elapsed / 60);
        line1 = elapsedMin < 1
          ? 'First-time setup — usually 10-20 minutes'
          : `${elapsedMin} min so far — usually 10-20 minutes total`;
      }

      const line2 = 'Keep MyKAI running, don\u2019t let your computer sleep.';
      syncDetail.innerHTML = `${line1}<br><span style="font-size:11px;opacity:0.75;font-weight:400">${line2}</span>`;
      syncDetail.classList.remove('hidden');
    }, 1000);
  }

  if (data.phase === 'done') {
    if (utxoResyncTimer) { clearInterval(utxoResyncTimer); utxoResyncTimer = null; }
    document.body.classList.remove('setup-mode');
    syncDetail.classList.add('hidden');
    syncDetail.textContent = '';
    utxoResyncEstimate = data.actualSeconds;
    addActivity('Setup complete — your node is joining the Kaspa network');
  }
}

// --- Connection Indicators ---
function updateAgentIndicator(s) {
  const el = $('#agent-indicator');
  if (s.connected) {
    el.className = 'conn-indicator connected';
    el.querySelector('.conn-label').textContent = s.name ? `${s.name} connected` : 'Agent connected';
  } else {
    el.className = 'conn-indicator disconnected';
    el.querySelector('.conn-label').textContent = 'No agent connected';
  }
}

function updateKasMapIndicator(kmStatus, kmConfig) {
  const el = $('#kasmap-indicator');
  if (!kmConfig?.enabled || !kmConfig?.token) {
    el.className = 'conn-indicator disconnected';
    el.querySelector('.conn-label').textContent = 'KasMap not configured';
  } else if (kmStatus?.connected) {
    const ago = kmStatus.lastResult ? Math.round((Date.now() - kmStatus.lastResult.time) / 1000) : '?';
    const mode = kmStatus.mode === 'alert' ? ' [ALERT — 1min]' : '';
    el.className = 'conn-indicator connected';
    el.querySelector('.conn-label').textContent = `KasMap linked — heartbeat ${ago}s ago${mode}`;
  } else {
    el.className = 'conn-indicator disconnected';
    el.querySelector('.conn-label').textContent = 'KasMap connecting...';
  }
}

// --- Node Stats (reward dashboard) ---
async function updateHealthStats() {
  const stats = await window.mykai.gamification.stats();
  if (!stats) return;

  // Current Run — store base for smooth ticking
  const streak = stats.currentStreakSeconds || 0;
  lastStreakBase = streak;
  lastStreakTimestamp = Date.now();
  $('#health-streak').textContent = fmtUptime(streak);

  // Best Run
  const best = stats.longestStreakSeconds || 0;
  $('#health-best-streak').textContent = fmtUptime(best);
  if (streak > 0 && streak >= best) {
    $('#health-best-streak').style.color = 'var(--gold)';
  } else {
    $('#health-best-streak').style.color = '';
  }

  // Total Uptime (cumulative all-time)
  const total = stats.totalUptimeSeconds || 0;
  $('#health-total-uptime').textContent = fmtUptime(total);
}

// --- Sync Bars ---
// Format raw counts as compact numbers — 1.2M / 4.5K / 234 — for the
// sync-row count labels. Keeps the line short on narrow windows while
// still conveying scale. Same convention the dashboard tiles use.
function fmtCount(n) {
  if (!n || n < 1000) return String(n || 0);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'K';
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0) + 'M';
  return (n / 1_000_000_000).toFixed(1) + 'B';
}

// Estimate a sync percentage from the downloaded count for the Headers /
// Blocks rows when kaspad's IBD-percent regex hasn't fired yet.
//
// Background: kaspad emits "IBD: Processed N block headers (X%)" log lines
// only AFTER it finishes pre-IBD work (pruning-point negotiation, header-
// proof building, UTXO snapshot download). That phase can take 5-30 minutes
// during which the user sees a count growing but a static 0% bar — they
// think the node is frozen. Theme 6 (0.3.3) added the count next to the %,
// but the bar itself still didn't move. User feedback (28-04-2026):
// "from the first 1% it should move already".
//
// Fix: while kaspad-reported % is 0 but count is growing, show an estimate
// computed against a generous fixed target (Kaspa chain length is ~30M
// blocks at current DAA). Capped at 95% so kaspad's authoritative % can
// take over without the bar appearing to shrink. Display has a `~` prefix
// to mark it as an estimate; once kaspad reports a real %, the tilde
// drops and we use the authoritative value.
const TARGET_HEADERS_FOR_ESTIMATE = 30_000_000;
const TARGET_BLOCKS_FOR_ESTIMATE  = 30_000_000;
function estimateSyncPct(count, target) {
  if (!count || count <= 0) return 0;
  return Math.min(95, Math.round((count / target) * 100));
}

function updateSyncBars(phase) {
  // Kaspad periodically re-enters "virtual resolving" even on a synced node,
  // which emits sync-phase events. If we unconditionally unhide the container
  // on every event, the status poll hides it ~2s later, producing a visible
  // flash. Skip entirely when we already know we're not syncing.
  if (currentState === 'synced' || currentState === 'stopped' || currentState === 'error') return;

  $('#sync-bar-container').classList.remove('hidden');

  // Headers
  const hp = phase.headers || 0;
  const hCount = phase.headersCount || 0;
  const hUseEstimate = hp === 0 && hCount > 0;
  const hDisplayPct = hUseEstimate ? estimateSyncPct(hCount, TARGET_HEADERS_FOR_ESTIMATE) : hp;
  $('#sync-fill-headers').style.width = hDisplayPct + '%';
  $('#sync-pct-headers').textContent = hUseEstimate ? `~${hDisplayPct}%` : `${hp}%`;
  $('#sync-count-headers').textContent = hCount > 0 ? `${fmtCount(hCount)} downloaded` : '';
  $('#sync-row-headers').classList.toggle('hidden', hp === 0 && phase.blocks === 0 && hCount === 0);

  // Blocks
  const bp = phase.blocks || 0;
  const bCount = phase.blocksCount || 0;
  const bUseEstimate = bp === 0 && bCount > 0;
  const bDisplayPct = bUseEstimate ? estimateSyncPct(bCount, TARGET_BLOCKS_FOR_ESTIMATE) : bp;
  $('#sync-fill-blocks').style.width = bDisplayPct + '%';
  $('#sync-pct-blocks').textContent = bUseEstimate ? `~${bDisplayPct}%` : `${bp}%`;
  $('#sync-count-blocks').textContent = bCount > 0 ? `${fmtCount(bCount)} validated` : '';
  // Only show blocks row once headers have started
  $('#sync-row-blocks').classList.toggle('hidden', bp === 0 && hp < 100 && bCount === 0);
}

// --- Activity Feed ---
function addActivity(msg, extraClass) {
  const list = $('#activity-list');
  const item = document.createElement('div');
  item.className = 'activity-item' + (extraClass ? ' ' + extraClass : '');
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
  // The time string is locally-formatted ints — safe by construction. The
  // message can contain content forwarded from kaspad logs / peer metadata,
  // so escape it before insertion. (Sandbox + contextIsolation are still in
  // place, but treating user-visible text as data, not markup, is the right
  // default for a node UI.)
  item.innerHTML = `<span class="activity-time">${time}</span><span class="activity-msg">${escapeHtml(msg)}</span>`;
  list.appendChild(item);
  while (list.children.length > 100) list.removeChild(list.firstChild);
  list.scrollTop = list.scrollHeight;
}

// --- Log Buffer ---

// --- Controls ---
// Start: normal click. Stop: press and hold 5 seconds to prevent accidental
// stops. Same hold duration as Reset chain data and Start over (Reset
// identity) so all three "red" destructive buttons feel the same.
const STOP_HOLD_MS = 5000;
let stopHoldTimer = null;
let stopHoldStart = 0;
let stopHoldInterval = null;
// Set true when a hold-action successfully fired. The click event that
// follows mouseup is suppressed so the user must RELEASE the button
// before the new action (Start Node) is pressable. Without this, the
// click that fires when they release the held Stop button fires Start
// immediately on the same elementclick (bug reported by Seb 28-04-2026).
let stopHoldFiredSuppressClick = false;

function resetStopHold() {
  if (stopHoldTimer) { clearTimeout(stopHoldTimer); stopHoldTimer = null; }
  if (stopHoldInterval) { clearInterval(stopHoldInterval); stopHoldInterval = null; }
  const btn = $('#btn-toggle');
  btn.style.background = '';
  if (currentState !== 'stopped' && currentState !== 'error') {
    btn.textContent = 'Stop Node';
  }
}

$('#btn-toggle').addEventListener('mousedown', (e) => {
  if (currentState === 'stopped' || currentState === 'error') return;
  const btn = $('#btn-toggle');
  stopHoldStart = Date.now();
  stopHoldInterval = setInterval(() => {
    const elapsed = Date.now() - stopHoldStart;
    const remaining = Math.max(0, STOP_HOLD_MS / 1000 - elapsed / 1000).toFixed(1);
    const pct = Math.min(100, (elapsed / STOP_HOLD_MS) * 100);
    btn.textContent = `Hold ${remaining}s`;
    btn.style.background = `linear-gradient(90deg, var(--red) ${pct}%, var(--bg-card) ${pct}%)`;
    btn.style.color = 'white';
  }, 50);
  stopHoldTimer = setTimeout(async () => {
    clearInterval(stopHoldInterval);
    stopHoldInterval = null;
    btn.style.background = '';
    btn.style.color = '';
    btn.textContent = 'Stopping...';
    btn.disabled = true;
    // Arm click-suppression — the upcoming mouseup will fire a click on
    // the (newly-relabelled) Start Node button. We don't want that click
    // to actually start the node; the user must release and re-press.
    stopHoldFiredSuppressClick = true;
    $('#status-text').textContent = 'Stopping...';
    $('#status-subtext').textContent = 'Shutting down gracefully...';
    await window.mykai.node.stop();
  }, STOP_HOLD_MS);
});

$('#btn-toggle').addEventListener('mouseup', resetStopHold);
$('#btn-toggle').addEventListener('mouseleave', resetStopHold);

$('#btn-toggle').addEventListener('click', async () => {
  // Suppress the click that fires on mouseup right after a successful
  // hold-to-stop. Without this, the user holds Stop -> action fires ->
  // button label flips to "Start Node" -> mouseup fires click on the
  // newly-labelled button -> Start fires immediately, defeating the
  // friction of the hold pattern. They must RELEASE first, then click
  // again deliberately.
  if (stopHoldFiredSuppressClick) {
    stopHoldFiredSuppressClick = false;
    return;
  }
  if (currentState !== 'stopped' && currentState !== 'error') return;
  const btn = $('#btn-toggle');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = 'Starting...';
  $('#status-text').textContent = 'Starting...';
  $('#status-subtext').textContent = 'Preparing node...';
  $('#status-indicator').className = 'starting';
  const result = await window.mykai.node.start();
  if (!result.ok) {
    $('#status-text').textContent = 'Error';
    $('#status-subtext').textContent = result.error;
    $('#status-indicator').className = 'error';
    btn.textContent = 'Start';
    btn.disabled = false;
    btn.classList.remove('loading');
    addActivity('Start failed: ' + result.error);
  }
});

$('#btn-copy-endpoint').addEventListener('click', async () => {
  await window.mykai.clipboard.copy($('#endpoint-url').textContent);
  $('#btn-copy-endpoint').textContent = 'Copied!';
  setTimeout(() => { $('#btn-copy-endpoint').textContent = 'Copy'; }, 2000);
});

// --- Panel Switching ---
function showPanel(panel) {
  activePanel = panel;
  $('#activity-feed').classList.toggle('hidden', panel !== 'activity');
  $('#mining-panel').classList.toggle('hidden', panel !== 'mining');
  $('#settings-panel').classList.toggle('hidden', panel !== 'settings');
  $('#btn-settings').classList.toggle('active', panel === 'settings');

  if (panel === 'mining') loadMiningLogs();
  if (panel === 'settings') {
    // Land on the first tab whenever Settings is (re)opened from the
    // dashboard. Doing this here (not inside loadSettings) means the
    // Discard handler — which calls loadSettings directly — keeps the
    // user on whatever tab they were editing rather than jumping back.
    showSettingsTab('general');
    loadSettings();
  }
}

// Settings link toggles settings panel; clicking again returns to activity
$('#btn-settings').addEventListener('click', (e) => { e.preventDefault(); showPanel(activePanel === 'settings' ? 'activity' : 'settings'); });
// Close button in settings header returns to activity
$('#btn-close-settings').addEventListener('click', (e) => { e.preventDefault(); showPanel('activity'); });

// Settings tab strip: clicking a tab swaps which .settings-tab-page is
// visible. Tabs are pure visual paging — the form is one DOM tree, so
// dirty-tracking + Save/Discard in the header keep working across all
// tabs without per-tab state to thread through.
function showSettingsTab(name) {
  document.querySelectorAll('.settings-tab-link').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === name);
  });
  document.querySelectorAll('.settings-tab-page').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.tab !== name);
  });
}
document.querySelectorAll('.settings-tab-link').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    showSettingsTab(el.dataset.tab);
  });
});

// Settings dirty-tracking: any user edit flips the header to show
// Save + Discard and hide Close. Save persists; Discard reloads from
// store; either resets dirty to false. Removes the always-visible
// bottom Save button — the header now carries the action.
let _settingsDirty = false;
function setSettingsDirty(dirty) {
  _settingsDirty = dirty;
  $('#btn-save-settings').classList.toggle('hidden', !dirty);
  $('#btn-discard-settings').classList.toggle('hidden', !dirty);
  $('#btn-close-settings').classList.toggle('hidden', dirty);
}
// Delegated listener: any input/change inside the settings panel marks
// dirty. Caller (loadSettings) resets dirty=false after programmatic
// repopulation by skipping the propagation guard.
let _settingsLoading = false;
$('#settings-panel').addEventListener('input', () => { if (!_settingsLoading) setSettingsDirty(true); });
$('#settings-panel').addEventListener('change', () => { if (!_settingsLoading) setSettingsDirty(true); });
$('#btn-discard-settings').addEventListener('click', async (e) => {
  e.preventDefault();
  await loadSettings();
});
// Mining title toggles mining detail panel
$('#btn-mining-panel')?.addEventListener('click', () => showPanel(activePanel === 'mining' ? 'activity' : 'mining'));

// --- Settings ---
// Settings is a flat info-only panel — no expensive work on open. The two IPC
// calls it legitimately needs (config + kasmap status) are parallelized.
// Storage is read from the main Stats grid's #stat-storage (already populated
// by the heartbeat cycle); Settings must never trigger a fresh DAG walk just
// to render a number.
async function loadSettings() {
  _settingsLoading = true;
  const [cfg, kmStatus] = await Promise.all([
    window.mykai.config.get(),
    window.mykai.kasmap.status(),
  ]);

  $('#setting-network').value = cfg.network;
  $('#setting-visibility').value = cfg.nodeVisibility || 'public';
  $('#setting-launch-startup').checked = cfg.launchOnStartup !== false;
  $('#setting-tray').checked = cfg.minimizeToTray;
  $('#setting-peers').value = cfg.outpeers;
  // v0.4: storage mode controls
  const storageMode = cfg.nodeStorageMode || 'pruned';
  $('#setting-storage-mode').value = storageMode;
  $('#setting-retention-days').value = cfg.retentionDays || 30;
  // v0.5: shard contribution slider
  const shardSizeGB = cfg.shardSizeGB || 0;
  $('#setting-shard-size-gb').value = shardSizeGB;
  updateShardSizeHint(shardSizeGB);
  // Show/hide retention slider only in retention mode
  $('#retention-days-row').style.display = (storageMode === 'retention') ? '' : 'none';
  // Show only the hint matching the active mode
  $('#storage-mode-hint-pruned').style.display    = (storageMode === 'pruned')    ? '' : 'none';
  $('#storage-mode-hint-retention').style.display = (storageMode === 'retention') ? '' : 'none';
  $('#storage-mode-hint-archival').style.display  = (storageMode === 'archival')  ? '' : 'none';
  // Disable archival option on testnet (kaspad would refuse anyway, but
  // surface the reason in the UI rather than letting the user try and fail).
  const archivalOption = $('#setting-storage-mode').querySelector('option[value="archival"]');
  if (archivalOption) {
    const isTestnet = cfg.network === 'testnet';
    archivalOption.disabled = isTestnet;
    $('#storage-mode-hint-testnet').style.display = isTestnet ? '' : 'none';
  }
  $('#setting-datadir').textContent = cfg.dataDir;
  // Re-use the value already displayed in the main Stats grid. No disk walk.
  $('#setting-storage').textContent = $('#stat-storage').textContent || '—';

  // Node mode
  $('#setting-mode').value = cfg.nodeMode || 'bundled';
  $('#setting-remote-url').value = cfg.remoteUrl || '';
  $('#remote-settings').classList.toggle('hidden', cfg.nodeMode !== 'remote');

  // Updates
  $('#setting-autoupdate').checked = cfg.autoUpdate !== false;

  // Keep computer awake during first-time UTXO setup. Default ON.
  $('#setting-prevent-sleep').checked = cfg.preventSleepDuringSetup !== false;

  // Share error diagnostics (Tier 2 / Tier 3 consent). Default ON.
  $('#setting-share-diagnostics').checked = cfg.shareErrorDiagnostics !== false;

  // Monitoring
  // contributeMonitoring is always on — no UI toggle

  // KasMap
  const km = cfg.kasmap || {};
  $('#setting-kasmap-enabled').checked = km.enabled;
  $('#kasmap-settings').classList.toggle('hidden', !km.enabled);
  $('#setting-kasmap-token').value = km.token || '';
  // Hide "get a token" hint if token already exists
  $('#kasmap-no-token').classList.toggle('hidden', !!km.token);

  // Account Key
  $('#setting-account-key').textContent = cfg.accountKey || '—';

  // Mining
  $('#setting-mining-enabled').checked = cfg.miningEnabled;
  $('#mining-settings').classList.toggle('hidden', !cfg.miningEnabled);
  $('#setting-mining-address').value = cfg.miningAddress || '';
  $('#setting-stratum-bind').value = cfg.stratumBind || 'localhost';
  $('#setting-stratum-port').value = cfg.stratumPort || 5555;

  // Appearance
  $('#setting-theme').value = cfg.theme || 'dark';
  applyTheme(cfg.theme || 'dark');

  // KasMap status
  const statusLine = $('#kasmap-status-line');
  if (km.enabled && km.token) {
    statusLine.classList.remove('hidden');
    statusLine.textContent = kmStatus.connected
      ? `Broadcasting — last heartbeat ${kmStatus.lastResult ? Math.round((Date.now() - kmStatus.lastResult.time) / 1000) + 's ago' : 'pending'}`
      : 'Not broadcasting';
  } else {
    statusLine.classList.add('hidden');
  }

  // App version + update status (Theme G of 0.3.5).
  // Show "You're on vX.Y.Z" + the update status line. The Upgrade now
  // button only un-hides once we know an update is fully downloaded —
  // pressing it before then would call installApp() with no payload.
  try {
    const myV = await window.mykai.app.version();
    const el = $('#app-version-current');
    if (el) el.textContent = `v${myV || '?'}`;
  } catch (_) {
    const el = $('#app-version-current');
    if (el) el.textContent = '?';
  }
  await refreshAppVersionStatus();
  // Settings now reflect persisted state — clear dirty flag and reset
  // header to the default Close link. Done after all DOM writes so the
  // delegated input/change listener doesn't see them as user edits.
  _settingsLoading = false;
  setSettingsDirty(false);
}

// Reconcile #app-version-status + #btn-upgrade-now against the live
// renderer-side flags (set by onAppAvailable/onAppDownloaded) plus a
// best-effort poll of the updater for cases where Settings opens
// before any update event fired. Safe to call repeatedly — it's
// idempotent and cheap.
async function refreshAppVersionStatus() {
  const statusEl = $('#app-version-status');
  const upgradeBtn = $('#btn-upgrade-now');
  if (!statusEl || !upgradeBtn) return;

  // Live state wins — events have already told us the truth.
  if (latestAppUpdateInfo && appUpdateDownloadedFlag) {
    statusEl.textContent = `v${latestAppUpdateInfo.version} downloaded — restart to apply`;
    upgradeBtn.textContent = `Upgrade to v${latestAppUpdateInfo.version}`;
    upgradeBtn.disabled = false;
    upgradeBtn.classList.remove('hidden');
    return;
  }
  if (latestAppUpdateInfo) {
    statusEl.textContent = `Downloading v${latestAppUpdateInfo.version}…`;
    upgradeBtn.classList.add('hidden');
    return;
  }

  // No event yet — fall back to a one-shot status query so the panel
  // shows something useful instead of "Checking…" forever if Settings
  // opens before the 5s startup delay elapses.
  try {
    const us = await window.mykai.update.status();
    if (us && us.appUpdateAvailable && us.manifest) {
      statusEl.textContent = `v${us.manifest.appVersion} available — fetching…`;
    } else {
      statusEl.textContent = 'Up to date';
    }
  } catch (_) {
    statusEl.textContent = '';
  }
  upgradeBtn.classList.add('hidden');
}

// Settings: "Upgrade now" — only meaningful once a download is complete
// (button is hidden in every other state). Calling installApp() at the
// wrong moment is a no-op in updater.ts, but we keep the UI honest by
// only un-hiding the button when we KNOW an installer is staged.
$('#btn-upgrade-now').addEventListener('click', () => {
  window.mykai.update.installApp();
});

// Settings: "Check for updates" — a deliberate, user-initiated trigger
// for users who want to know "is there a new version?" without waiting
// for the 8h periodic check. Disables itself for a beat so impatient
// double-clicks don't flood the GitHub API.
$('#btn-check-updates').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const statusEl = $('#app-version-status');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  if (statusEl) statusEl.textContent = 'Checking for updates…';
  try {
    await window.mykai.update.check();
  } catch (_) {
    if (statusEl) statusEl.textContent = 'Check failed — try again later';
  }
  // Give the update events a beat to land before we paint the result.
  setTimeout(() => {
    refreshAppVersionStatus();
    btn.disabled = false;
    btn.textContent = 'Check';
  }, 1500);
});

$('#setting-mode').addEventListener('change', (e) => {
  $('#remote-settings').classList.toggle('hidden', e.target.value !== 'remote');
});

// v0.5: Archive Pool contribution hint — update text based on the value.
function updateShardSizeHint(gb) {
  const hint = document.getElementById('shard-size-hint');
  if (!hint) return;
  const n = Number(gb) || 0;
  if (n === 0) {
    hint.textContent = '0 GB = not in the pool. Your node still validates the chain normally.';
    hint.style.color = '';
  } else if (n < 50) {
    hint.textContent = `${n} GB — small pool contribution, helpful for recent blocks. App restart required.`;
    hint.style.color = '';
  } else if (n < 500) {
    hint.textContent = `${n} GB — meaningful pool contribution. App restart required after save.`;
    hint.style.color = '';
  } else if (n < 2000) {
    hint.textContent = `${n} GB — large pool contribution; covers significant historical depth. Verify your disk has the space + headroom. App restart required.`;
    hint.style.color = 'var(--kaspa-amber,#f5a623)';
  } else {
    hint.textContent = `${n} GB — dedicated archive operator territory. Confirm your hardware can sustain this. App restart required.`;
    hint.style.color = 'var(--kaspa-amber,#f5a623)';
  }
}
$('#setting-shard-size-gb').addEventListener('input', (e) => {
  updateShardSizeHint(e.target.value);
});

// v0.4: storage mode picker — show the matching hint + the retention slider
// only when applicable. The actual save happens on btn-save-settings.
$('#setting-storage-mode').addEventListener('change', (e) => {
  const mode = e.target.value;
  $('#retention-days-row').style.display = (mode === 'retention') ? '' : 'none';
  $('#storage-mode-hint-pruned').style.display    = (mode === 'pruned')    ? '' : 'none';
  $('#storage-mode-hint-retention').style.display = (mode === 'retention') ? '' : 'none';
  $('#storage-mode-hint-archival').style.display  = (mode === 'archival')  ? '' : 'none';
});

// v0.4: re-evaluate testnet/archival disable when the network field changes.
// (Network change itself triggers settings-dirty via the panel-level listener.)
$('#setting-network').addEventListener('change', (e) => {
  const isTestnet = e.target.value === 'testnet';
  const archivalOption = $('#setting-storage-mode').querySelector('option[value="archival"]');
  if (archivalOption) archivalOption.disabled = isTestnet;
  $('#storage-mode-hint-testnet').style.display = isTestnet ? '' : 'none';
  // If user was on archival and switches to testnet, force-pick pruned to
  // prevent saving an invalid combo. They can re-pick after switching back.
  if (isTestnet && $('#setting-storage-mode').value === 'archival') {
    $('#setting-storage-mode').value = 'pruned';
    $('#setting-storage-mode').dispatchEvent(new Event('change'));
  }
});

$('#setting-kasmap-enabled').addEventListener('change', (e) => {
  $('#kasmap-settings').classList.toggle('hidden', !e.target.checked);
});

$('#setting-mining-enabled').addEventListener('change', (e) => {
  $('#mining-settings').classList.toggle('hidden', !e.target.checked);
});

$('#link-kasmap-nodes').addEventListener('click', (e) => {
  e.preventDefault();
  window.mykai.shell.openExternal('https://www.kasmap.org/en/mykasmap/account/nodes');
});

$('#btn-kasmap-verify').addEventListener('click', async () => {
  const token = $('#setting-kasmap-token').value.trim();
  const resultEl = $('#kasmap-verify-result');
  if (!token) { resultEl.textContent = 'Enter a token first'; resultEl.className = 'error'; resultEl.classList.remove('hidden'); return; }
  resultEl.textContent = 'Verifying...';
  resultEl.className = '';
  resultEl.classList.remove('hidden');
  const result = await window.mykai.kasmap.verify(token);
  if (result.ok) {
    resultEl.textContent = `Linked to @${result.username || 'verified'}`;
    resultEl.className = 'success';
  } else {
    resultEl.textContent = result.error || 'Invalid token';
    resultEl.className = 'error';
  }
});

// --- Cloud Nodes ---
$('#btn-generate-cloud-script').addEventListener('click', async () => {
  const resultEl = $('#cloud-script-result');
  resultEl.classList.remove('hidden');
  resultEl.textContent = 'Generating...';
  resultEl.className = 'setting-hint';
  try {
    const result = await window.mykai.cloud.generateScript();
    if (result.ok) {
      resultEl.innerHTML = `<span class="success">Script saved to your Downloads folder!</span>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:8px;line-height:1.6">
        <strong style="color:var(--text-primary)">Workflow for <a href="#" id="link-fluxcloud" style="color:var(--kaspa-teal);text-decoration:underline">Flux Cloud</a>:</strong><br>
        1. Open your FluxCloud dashboard for the node<br>
        2. Go to <strong>Secure Shell</strong> tab<br>
        3. In <strong>Volume Browser</strong>, click the upload button and upload the file<br>
        4. Select <strong>/bin/sh</strong> from the dropdown and click <strong>+ New Terminal</strong><br>
        5. Type this command and press Enter:<br>
        <code id="btn-copy-cloud-cmd" style="color:var(--kaspa-teal);display:inline-block;margin-top:4px;background:var(--bg-primary);padding:4px 8px;border-radius:4px;cursor:pointer">sh /app/data/mykai-monitor.sh &amp;</code> <span style="color:var(--text-secondary);font-size:11px">(click to copy)</span><br><br>
        Repeat for each cloud node. Same file works for all of them.<br>
        <span style="color:var(--text-secondary)">For other cloud providers (Hetzner, VPS, home server), the same script works — just adjust the upload method.</span>
        </div>`;
      // Attach event listeners after HTML is rendered
      const cmdBtn = document.getElementById('btn-copy-cloud-cmd');
      if (cmdBtn) {
        cmdBtn.addEventListener('click', () => {
          window.mykai.clipboard.copy('sh /app/data/mykai-monitor.sh &');
          cmdBtn.textContent = 'Copied!';
          setTimeout(() => { cmdBtn.innerHTML = 'sh /app/data/mykai-monitor.sh &amp;'; }, 2000);
        });
      }
      const fluxLink = document.getElementById('link-fluxcloud');
      if (fluxLink) {
        fluxLink.addEventListener('click', (ev) => {
          ev.preventDefault();
          window.mykai.shell.openExternal('https://cloud.runonflux.com/marketplace/2945f4c3-23be-4f60-8e63-b3f85b0bf8fe');
        });
      }
    } else {
      resultEl.innerHTML = `<span class="error">${result.error}</span>`;
    }
  } catch (err) {
    resultEl.innerHTML = `<span class="error">Failed: ${err.message}</span>`;
  }
});

$('#btn-copy-account-key').addEventListener('click', async () => {
  const key = $('#setting-account-key').textContent;
  if (key && key !== '—') {
    await window.mykai.clipboard.copy(key);
    $('#btn-copy-account-key').textContent = 'Copied!';
    setTimeout(() => { $('#btn-copy-account-key').textContent = 'Copy'; }, 2000);
  }
});

// Diagnostic report copy button — shared handler used by Settings and by
// any error-severity alert card that wants to offer the same action.
// `button` is optional: the health-card action handler invokes this without
// any element to update, so all element interactions are guarded.
async function copyDiagnosticInfo(button) {
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Gathering diagnostic info…';
  }
  try {
    const report = await window.mykai.diagnostic.build();
    await window.mykai.clipboard.copy(report);
    if (button) {
      button.textContent = 'Copied! paste into email or chat';
      setTimeout(() => { button.textContent = original; button.disabled = false; }, 30000);
    }
  } catch (err) {
    if (button) {
      button.textContent = 'Failed — try again';
      setTimeout(() => { button.textContent = original; button.disabled = false; }, 3000);
    }
  }
}

$('#btn-copy-diagnostic').addEventListener('click', (e) => copyDiagnosticInfo(e.currentTarget));

// --- Drive picker for data directory ---
let _selectedDrivePath = null;

async function openDrivePicker() {
  const modal = $('#drive-picker-modal');
  const list = $('#drive-list');
  const confirm = $('#btn-drive-confirm');
  list.innerHTML = '<div class="setting-hint">Scanning drives…</div>';
  confirm.disabled = true;
  _selectedDrivePath = null;
  modal.classList.remove('hidden');

  try {
    const drives = await window.mykai.drives.list();
    list.innerHTML = '';
    if (!drives || drives.length === 0) {
      list.innerHTML = '<div class="setting-hint">No drives found. Use "Choose folder…" to pick manually.</div>';
      return;
    }

    const currentDir = await window.mykai.dataDir.current();
    const currentLetter = currentDir && currentDir.match(/^([A-Za-z]):/) ? currentDir.slice(0, 2).toUpperCase() : '';

    for (const d of drives) {
      const row = document.createElement('label');
      row.className = 'drive-row' + (!d.suitable ? ' disabled' : '');
      const freeGB = (d.freeBytes / 1073741824).toFixed(1);
      const totalGB = (d.totalBytes / 1073741824).toFixed(0);
      const kindLabel = {
        'internal-ssd': 'Internal SSD',
        'internal-hdd': 'Internal HDD',
        'external-ssd': 'External SSD',
        'external-hdd': 'External HDD',
        'usb-stick': 'USB stick',
        'usb-2-0': 'USB 2.0 drive',
        'network': 'Network drive',
        'optical': 'Optical drive',
        'unknown': 'Unknown',
      }[d.kind] || 'Drive';
      const isCurrent = d.letter.toUpperCase() === currentLetter;
      row.innerHTML = `
        <input type="radio" name="drive" value="${d.letter}" ${!d.suitable || isCurrent ? 'disabled' : ''}>
        <div class="drive-row-main">
          <div class="drive-row-title">${d.letter}${d.label ? ' — ' + d.label : ''} (${kindLabel})</div>
          <div class="drive-row-sub">${freeGB} GB free of ${totalGB} GB${isCurrent ? ' · currently in use' : ''}${d.reason ? ' · ' + d.reason : ''}</div>
        </div>
      `;
      const input = row.querySelector('input');
      if (d.suitable && !isCurrent) {
        row.addEventListener('click', () => {
          list.querySelectorAll('.drive-row').forEach(r => r.classList.remove('selected'));
          row.classList.add('selected');
          input.checked = true;
          _selectedDrivePath = d.letter + '\\MyKAI\\kaspad-data';
          confirm.disabled = false;
        });
      }
      list.appendChild(row);
    }
  } catch (err) {
    list.innerHTML = `<div class="setting-hint">Couldn't scan drives: ${err.message}</div>`;
  }
}

async function confirmDriveMove() {
  if (!_selectedDrivePath) return;
  const progress = $('#drive-move-progress');
  const bar = $('#drive-move-bar');
  const status = $('#drive-move-status');
  const confirm = $('#btn-drive-confirm');
  const cancel = $('#btn-drive-cancel');
  progress.classList.remove('hidden');
  confirm.disabled = true;
  cancel.disabled = true;
  status.textContent = 'Starting…';

  window.mykai.dataDir.onProgress((p) => {
    const pct = p.bytesTotal > 0 ? Math.round((p.bytesDone / p.bytesTotal) * 100) : 0;
    bar.value = pct;
    const doneGB = (p.bytesDone / 1073741824).toFixed(2);
    const totalGB = (p.bytesTotal / 1073741824).toFixed(2);
    status.textContent = `${pct}% — ${doneGB} / ${totalGB} GB (${p.filesDone}/${p.filesTotal} files)`;
  });

  const result = await window.mykai.dataDir.move(_selectedDrivePath);
  if (result.ok) {
    status.textContent = 'Done — your node is restarting from the new location.';
    setTimeout(() => { $('#drive-picker-modal').classList.add('hidden'); location.reload(); }, 1500);
  } else {
    status.textContent = `Couldn't move data: ${result.error}`;
    cancel.disabled = false;
  }
}

$('#btn-change-datadir')?.addEventListener('click', openDrivePicker);
$('#btn-drive-cancel')?.addEventListener('click', () => $('#drive-picker-modal').classList.add('hidden'));
$('#btn-drive-confirm')?.addEventListener('click', confirmDriveMove);
$('#btn-choose-folder')?.addEventListener('click', async () => {
  const chosen = await window.mykai.drives.chooseFolder();
  if (!chosen) return;
  _selectedDrivePath = chosen;
  $('#btn-drive-confirm').disabled = false;
  // Show the chosen path in the list
  const list = $('#drive-list');
  list.innerHTML = `<div class="drive-row selected"><div class="drive-row-main"><div class="drive-row-title">${chosen}</div><div class="drive-row-sub">Custom folder selected</div></div></div>`;
});

// Delegated click handler for diagnostic buttons on alert cards
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-alert-action="copy-diagnostic"]');
  if (!btn) return;
  copyDiagnosticInfo(btn);
});

$('#btn-save-settings').addEventListener('click', async () => {
  // v0.4: clamp retention days to kaspad's hard floor of 2 (panics below).
  const retentionDaysRaw = parseInt($('#setting-retention-days').value, 10) || 0;
  const retentionDays = retentionDaysRaw >= 2 ? retentionDaysRaw : 0;
  await window.mykai.config.set({
    network: $('#setting-network').value,
    nodeMode: $('#setting-mode').value,
    remoteUrl: $('#setting-remote-url').value.trim(),
    nodeVisibility: $('#setting-visibility').value,
    // v0.4: telemetry is now opt-in via Privacy section, NOT hardcoded true.
    // Reads the actual checkbox state. Sovereign-fork ethos: never call home
    // without explicit consent. Existing v0.3.x users were migrated to false
    // in config-store.js DEFAULTS.
    contributeMonitoring: $('#setting-contribute-monitoring')?.checked === true,
    shareErrorDiagnostics: $('#setting-share-diagnostics').checked,
    preventSleepDuringSetup: $('#setting-prevent-sleep').checked,
    autoUpdate: $('#setting-autoupdate').checked,
    launchOnStartup: $('#setting-launch-startup').checked,
    // autoStart is always true — kaspad starts whenever MyKAI opens. No UI toggle.
    autoStart: true,
    minimizeToTray: $('#setting-tray').checked,
    outpeers: parseInt($('#setting-peers').value, 10),
    // v0.4: storage mode + retention days
    nodeStorageMode: $('#setting-storage-mode').value,
    retentionDays: retentionDays,
    // v0.5: archival contribution amount in GB (0 = feature off)
    shardSizeGB: Math.max(0, parseInt($('#setting-shard-size-gb').value, 10) || 0),
    kasmap: {
      enabled: $('#setting-kasmap-enabled').checked,
      token: $('#setting-kasmap-token').value.trim(),
    },
    miningEnabled: $('#setting-mining-enabled').checked,
    miningAddress: $('#setting-mining-address').value.trim(),
    stratumBind: $('#setting-stratum-bind').value,
    stratumPort: parseInt($('#setting-stratum-port').value, 10) || 5555,
    theme: $('#setting-theme').value,
  });
  applyTheme($('#setting-theme').value);
  // Update mining UI visibility
  updateMiningUI();
  addActivity('Settings saved');
  setSettingsDirty(false);
  showPanel('activity');
});

// Identity backup folder — opens Documents\MyKAI\ in the OS file
// explorer. Lets users drag identity.json to OneDrive / USB / etc.
$('#btn-open-backup-folder')?.addEventListener('click', async () => {
  const result = await window.mykai.shell.openBackupFolder();
  if (result?.ok === false) {
    addActivity(`Couldn't open backup folder: ${result.error}`, 'activity-error');
  }
});

// Recover from accountKey — opens the recovery modal for users who
// want to manually paste a key (e.g. consolidating across devices, or
// just verifying their cloud-side row is intact). Same flow as the
// first-run "I have an accountKey" path. Wired late in app.js so the
// showRecoveryModal helper is already defined.
$('#btn-recover-from-key')?.addEventListener('click', () => {
  showRecoveryModal();
});

// Reset identity — IRREVERSIBLE from the app's perspective. Wipes
// accountKey + nodeId + all lifetime stats from electron-store and
// triggers a relaunch. The keyed backup file in Documents\MyKAI\
// SURVIVES (Theme 1.C) so the user can recover via "Recover from
// accountKey" if they change their mind. The backend's
// `config:reset-identity` IPC handler is the ONLY programmatic reset
// path — PC cleaners can no longer destroy identity, only the user
// themselves via this button.
//
// UX: 5-second press-and-hold pattern, mirroring Stop Node's 3-second
// hold. The hold itself IS the confirmation — no modal dialogs (which
// can be dismissed by stray Enter keys). Visual progress fill during
// hold tells the user "if you keep holding, this WILL fire."
//
// Click-suppression: same "must release before pressing again" rule
// as Stop Node. After hold fires, the click that follows mouseup is
// ignored. Plain clicks (without the hold) are silent no-ops — the
// hold is the only path to action.
let resetHoldTimer = null;
let resetHoldStart = 0;
let resetHoldInterval = null;
let resetHoldFiredSuppressClick = false;
const RESET_HOLD_MS = 5000;

function clearResetHoldVisuals() {
  if (resetHoldTimer) { clearTimeout(resetHoldTimer); resetHoldTimer = null; }
  if (resetHoldInterval) { clearInterval(resetHoldInterval); resetHoldInterval = null; }
  const btn = $('#btn-reset-identity');
  if (!btn) return;
  // Don't reset visuals if the action already fired — "Resetting..."
  // should stay on screen until the relaunch happens.
  if (btn.disabled) return;
  btn.style.background = '';
  btn.style.color = '';
  btn.textContent = 'Start over';
}

$('#btn-reset-identity')?.addEventListener('mousedown', () => {
  const btn = $('#btn-reset-identity');
  if (btn.disabled) return;
  resetHoldStart = Date.now();
  resetHoldInterval = setInterval(() => {
    const elapsed = Date.now() - resetHoldStart;
    const remaining = Math.max(0, RESET_HOLD_MS / 1000 - elapsed / 1000).toFixed(1);
    const pct = Math.min(100, (elapsed / RESET_HOLD_MS) * 100);
    btn.textContent = `Hold ${remaining}s`;
    btn.style.background = `linear-gradient(90deg, var(--red) ${pct}%, var(--bg-card) ${pct}%)`;
    btn.style.color = 'white';
  }, 50);
  resetHoldTimer = setTimeout(async () => {
    clearInterval(resetHoldInterval);
    resetHoldInterval = null;
    btn.style.background = '';
    btn.style.color = '';
    btn.textContent = 'Resetting...';
    btn.disabled = true;
    resetHoldFiredSuppressClick = true;
    try {
      await window.mykai.config.resetIdentity();
      // App relaunches via main process — this line should never execute.
    } catch (err) {
      addActivity(`Reset identity failed: ${err?.message ?? err}`, 'activity-error');
      btn.disabled = false;
      btn.textContent = 'Start over';
    }
  }, RESET_HOLD_MS);
});

$('#btn-reset-identity')?.addEventListener('mouseup', clearResetHoldVisuals);
$('#btn-reset-identity')?.addEventListener('mouseleave', clearResetHoldVisuals);

$('#btn-reset-identity')?.addEventListener('click', () => {
  // Click should NEVER fire the reset directly. Either:
  //  (a) The user just released after a 5-second hold → action already
  //      fired in the timeout above. Suppress this click.
  //  (b) The user clicked without holding → silent no-op. The hold is
  //      the only path to action.
  if (resetHoldFiredSuppressClick) {
    resetHoldFiredSuppressClick = false;
  }
  // (b) — silent no-op falls through here. The "Hold Xs" countdown
  // only appears during mousedown, so a quick click leaves the
  // unchanged "Reset identity" label — communicating by absence that
  // they need to hold.
});

// Reset chain data — heavy-hammer escape hatch for stuck sync (Theme F
// of 0.3.4 plan). Same hold-to-confirm UX as Reset Identity above:
// 5-second hold with red progress fill, click-suppress on release, no
// modal dialogs (the hold IS the confirmation). Wipes ~37 GB of local
// Kaspa chain DB and starts a fresh ~2-4 hour sync. Preserves identity
// (accountKey + lifetime stats). Surfaced specifically for users hit
// by Morris's UTXO rebuild loop (where every restart was resetting
// rebuild progress to zero) — gives them a deliberate, one-time
// "blow it all away and try again" path.
let chainResetHoldTimer = null;
let chainResetHoldStart = 0;
let chainResetHoldInterval = null;
let chainResetHoldFiredSuppressClick = false;
const CHAIN_RESET_HOLD_MS = 5000;

function clearChainResetHoldVisuals() {
  if (chainResetHoldTimer) { clearTimeout(chainResetHoldTimer); chainResetHoldTimer = null; }
  if (chainResetHoldInterval) { clearInterval(chainResetHoldInterval); chainResetHoldInterval = null; }
  const btn = $('#btn-reset-chain-data');
  if (!btn) return;
  if (btn.disabled) return; // action already fired — leave "Resetting…" visible
  btn.style.background = '';
  btn.style.color = '';
  btn.textContent = 'Reset chain data';
}

$('#btn-reset-chain-data')?.addEventListener('mousedown', () => {
  const btn = $('#btn-reset-chain-data');
  if (btn.disabled) return;
  chainResetHoldStart = Date.now();
  chainResetHoldInterval = setInterval(() => {
    const elapsed = Date.now() - chainResetHoldStart;
    const remaining = Math.max(0, CHAIN_RESET_HOLD_MS / 1000 - elapsed / 1000).toFixed(1);
    const pct = Math.min(100, (elapsed / CHAIN_RESET_HOLD_MS) * 100);
    btn.textContent = `Hold ${remaining}s`;
    btn.style.background = `linear-gradient(90deg, var(--red) ${pct}%, var(--bg-card) ${pct}%)`;
    btn.style.color = 'white';
  }, 50);
  chainResetHoldTimer = setTimeout(async () => {
    clearInterval(chainResetHoldInterval);
    chainResetHoldInterval = null;
    btn.style.background = '';
    btn.style.color = '';
    btn.textContent = 'Resetting chain…';
    btn.disabled = true;
    chainResetHoldFiredSuppressClick = true;
    addActivity('Resetting chain data — this will take 2–4 hours to re-sync from scratch.');
    try {
      const result = await window.mykai.node.resetChainData();
      if (result?.ok === false) {
        addActivity(`Chain reset failed: ${result.error}`, 'activity-error');
        btn.disabled = false;
        btn.textContent = 'Reset chain data';
      } else {
        // Success: kaspad restarted fresh. The dashboard's sync state
        // will update via the normal status-update flow.
        addActivity('Chain data wiped. Fresh sync starting — see the Headers progress.');
        btn.textContent = 'Reset done';
        // Re-enable after a moment so user can use the button again
        // if they ever want a second reset (rare but possible).
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = 'Reset chain data';
        }, 3000);
      }
    } catch (err) {
      addActivity(`Chain reset failed: ${err?.message ?? err}`, 'activity-error');
      btn.disabled = false;
      btn.textContent = 'Reset chain data';
    }
  }, CHAIN_RESET_HOLD_MS);
});

$('#btn-reset-chain-data')?.addEventListener('mouseup', clearChainResetHoldVisuals);
$('#btn-reset-chain-data')?.addEventListener('mouseleave', clearChainResetHoldVisuals);

$('#btn-reset-chain-data')?.addEventListener('click', () => {
  // Same click-suppression as Reset identity. A short click without a
  // hold is a silent no-op — only the 5-second hold actually triggers.
  if (chainResetHoldFiredSuppressClick) {
    chainResetHoldFiredSuppressClick = false;
  }
});

// --- Recovery flow + First-run modal (Themes 3 + 5 of the 0.3.3 plan) ---
//
// Recovery flow: user pastes their accountKey OR nodeId, we POST to
// the Insights /api/recover-by-key endpoint, server returns matching
// nodes, user picks one, we restore both keys + a stat snapshot
// locally, app relaunches.
//
// First-run modal: fires once on a genuine first launch (electron-store
// empty AND Documents\MyKAI\identity.json missing). Two paths: paste
// existing accountKey → recovery flow, or start fresh → close modal.

let _recoverySelectedMatch = null;
const _KEY_RX = /^(acc|node)_[0-9a-f]{32}$/;

function showRecoveryModal(initialKey) {
  $('#recovery-modal').classList.remove('hidden');
  $('#recovery-input').value = initialKey || '';
  $('#recovery-error').classList.add('hidden');
  $('#recovery-error').textContent = '';
  $('#recovery-matches').classList.add('hidden');
  $('#recovery-matches-list').innerHTML = '';
  $('#btn-recovery-restore').classList.add('hidden');
  $('#btn-recovery-lookup').classList.remove('hidden');
  $('#btn-recovery-lookup').disabled = false;
  _recoverySelectedMatch = null;
  setTimeout(() => $('#recovery-input').focus(), 50);
}

function hideRecoveryModal() {
  $('#recovery-modal').classList.add('hidden');
}

function recoveryShowError(msg) {
  $('#recovery-error').classList.remove('hidden');
  $('#recovery-error').textContent = msg;
}

function fmtUptimeShort(seconds) {
  if (!seconds) return '0';
  const days = Math.floor(seconds / 86400);
  if (days > 0) return `${days}d ${Math.floor((seconds % 86400) / 3600)}h`;
  const hours = Math.floor(seconds / 3600);
  if (hours > 0) return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
  const mins = Math.floor(seconds / 60);
  return `${mins}m`;
}

function fmtCountShort(n) {
  if (!n || n < 1000) return String(n || 0);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'K';
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0) + 'M';
  return (n / 1_000_000_000).toFixed(1) + 'B';
}

function renderRecoveryMatches(matches) {
  const list = $('#recovery-matches-list');
  list.innerHTML = '';
  matches.forEach((m, idx) => {
    const wrap = document.createElement('label');
    wrap.className = 'recovery-match' + (idx === 0 ? ' selected' : '');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'recovery-match';
    radio.value = String(idx);
    radio.checked = idx === 0;
    radio.addEventListener('change', () => {
      list.querySelectorAll('.recovery-match').forEach(el => el.classList.remove('selected'));
      wrap.classList.add('selected');
      _recoverySelectedMatch = matches[idx];
    });
    const body = document.createElement('div');
    body.className = 'recovery-match-body';
    const nameEl = document.createElement('div');
    nameEl.className = 'recovery-match-name';
    nameEl.textContent = m.nodeName || 'Unnamed node';
    const statsEl = document.createElement('div');
    statsEl.className = 'recovery-match-stats';
    const lastSeen = m.lastHeartbeatAt ? new Date(m.lastHeartbeatAt).toLocaleString() : '—';
    statsEl.textContent =
      `${fmtUptimeShort(m.totalUptimeSeconds)} uptime · ${fmtCountShort(m.blocksValidated)} blocks · last seen ${lastSeen}`;
    const idEl = document.createElement('div');
    idEl.className = 'recovery-match-id';
    idEl.textContent = m.nodeId;
    body.appendChild(nameEl);
    body.appendChild(statsEl);
    body.appendChild(idEl);
    wrap.appendChild(radio);
    wrap.appendChild(body);
    list.appendChild(wrap);
  });
  // Default selection = first row
  _recoverySelectedMatch = matches[0] || null;
  $('#recovery-matches').classList.remove('hidden');
  $('#btn-recovery-lookup').classList.add('hidden');
  $('#btn-recovery-restore').classList.remove('hidden');
  $('#btn-recovery-restore').disabled = false;
}

$('#btn-recovery-cancel')?.addEventListener('click', hideRecoveryModal);

$('#btn-recovery-lookup')?.addEventListener('click', async () => {
  const key = $('#recovery-input').value.trim().toLowerCase();
  if (!_KEY_RX.test(key)) {
    recoveryShowError('Key must be acc_… or node_… followed by 32 hex characters.');
    return;
  }
  $('#recovery-error').classList.add('hidden');
  $('#btn-recovery-lookup').disabled = true;
  $('#btn-recovery-lookup').textContent = 'Looking up…';
  try {
    const result = await window.mykai.recovery.lookup(key);
    $('#btn-recovery-lookup').textContent = 'Look up';
    if (!result?.ok) {
      const friendly = ({
        'invalid-format': 'Key format is invalid.',
        'network': 'Could not reach the recovery server. Check your internet connection.',
        'http': 'Server error — please try again in a few minutes.',
        'parse': 'Server response was malformed.',
        'timeout': 'Lookup timed out. Check your connection and try again.',
      })[result?.code] || (result?.error || 'Lookup failed.');
      recoveryShowError(friendly);
      $('#btn-recovery-lookup').disabled = false;
      return;
    }
    if (!result.matches || result.matches.length === 0) {
      recoveryShowError('No nodes found under this key. Double-check the value, or contact support if you\'re sure this was your accountKey.');
      $('#btn-recovery-lookup').disabled = false;
      return;
    }
    // result.source tells us whether the data came from a local
    // Documents\MyKAI\identity_acc_<key>.json file (full-fidelity
    // pre-Reset snapshot) or from the Insights cloud (good fallback,
    // may have lower values if heartbeats hadn't fully caught up).
    // The picker shows a small badge above the list so users know
    // which backup they're restoring from.
    const sourceLabel = $('#recovery-source-label');
    if (sourceLabel) {
      if (result.source === 'local') {
        sourceLabel.textContent = '\u2713 Found in your local backup (Documents\\MyKAI\\) \u2014 full restore';
        sourceLabel.style.color = 'var(--kaspa-teal)';
      } else if (result.source === 'cloud') {
        sourceLabel.textContent = 'Found in our cloud backup';
        sourceLabel.style.color = 'var(--text-secondary)';
      } else {
        sourceLabel.textContent = '';
      }
    }
    renderRecoveryMatches(result.matches);
  } catch (err) {
    $('#btn-recovery-lookup').textContent = 'Look up';
    $('#btn-recovery-lookup').disabled = false;
    recoveryShowError(`Lookup failed: ${err?.message ?? err}`);
  }
});

$('#btn-recovery-restore')?.addEventListener('click', async () => {
  if (!_recoverySelectedMatch) {
    recoveryShowError('Pick a node first.');
    return;
  }
  const m = _recoverySelectedMatch;
  const confirmed = confirm(
    `Restore "${m.nodeName || 'this node'}"?\n\n` +
    `${fmtUptimeShort(m.totalUptimeSeconds)} uptime · ${fmtCountShort(m.blocksValidated)} blocks\n\n` +
    `MyKAI will restart and your stats will reappear.`
  );
  if (!confirmed) return;
  $('#btn-recovery-restore').disabled = true;
  $('#btn-recovery-restore').textContent = 'Restoring…';
  try {
    const result = await window.mykai.recovery.apply(m);
    if (result?.ok === false) {
      recoveryShowError(`Restore failed: ${result.error || 'Unknown error.'}`);
      $('#btn-recovery-restore').disabled = false;
      $('#btn-recovery-restore').textContent = 'Restore selected';
    }
    // On success the app relaunches — control never returns here.
  } catch (err) {
    recoveryShowError(`Restore failed: ${err?.message ?? err}`);
    $('#btn-recovery-restore').disabled = false;
    $('#btn-recovery-restore').textContent = 'Restore selected';
  }
});

// First-run modal — fires once when main process detects a genuine
// first run (no electron-store identity AND no Documents backup).
window.mykai.firstRun?.onPrompt(() => {
  $('#firstrun-modal').classList.remove('hidden');
});

$('#btn-firstrun-paste')?.addEventListener('click', () => {
  $('#firstrun-modal').classList.add('hidden');
  showRecoveryModal();
});

$('#btn-firstrun-fresh')?.addEventListener('click', async () => {
  $('#firstrun-modal').classList.add('hidden');
  // Open the backup folder so the user can drag identity.json to a
  // safe place. Their fresh accountKey is already in there.
  try {
    await window.mykai.shell.openBackupFolder();
    addActivity('Welcome! Your accountKey is in Documents\\MyKAI\\identity.json — drag it to OneDrive or your password manager for offsite backup.');
  } catch { /* ignore */ }
});

// --- Smooth second-by-second counters ---
let lastUptimeBase = 0;      // last known uptime from backend
let lastUptimeTimestamp = 0;  // when we received it
let lastStreakBase = 0;
let lastStreakTimestamp = 0;

function startActivityTracker() {
  activityInterval = setInterval(() => {
    // Smooth streak counter
    if (lastStreakBase > 0 && currentState !== 'stopped') {
      const elapsed = Math.floor((Date.now() - lastStreakTimestamp) / 1000);
      $('#health-streak').textContent = fmtUptime(lastStreakBase + elapsed);
    }

    // Last activity indicator (only during syncing)
    if (lastLogTime === 0 || currentState === 'stopped' || currentState === 'synced') {
      $('#last-activity').classList.add('hidden');
    } else {
      const ago = Math.floor((Date.now() - lastLogTime) / 1000);
      $('#last-activity').innerHTML = `<span class="activity-dot"></span> Node active — last update ${ago}s ago`;
      $('#last-activity').classList.remove('hidden');
    }
  }, 1000);
}

// --- Helpers ---
function fmtNum(n) {
  if (!n || n === 0) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtUptime(s) {
  if (!s || s === 0) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// --- Mining UI ---
let miningLogLines = [];

async function updateMiningUI() {
  try {
    const cfg = await window.mykai.config.get();
    const miningCard = $('#mining-card');
    // Mining panel is toggled via mining card header click
    const minerIndicator = $('#miner-indicator');

    if (cfg.miningEnabled && cfg.miningAddress) {
      miningCard.classList.remove('hidden');
      // Mining panel accessible via mining card header click
      minerIndicator.classList.remove('hidden');
      $('#mining-card-body').classList.remove('hidden');
      $('#mining-asic-guide').classList.remove('hidden');
      $('#btn-mining-toggle').textContent = 'Enabled';
      $('#btn-mining-toggle').classList.add('active');

      // Get connection URLs
      const urls = await window.mykai.mining.connectionUrls();
      $('#mining-url').textContent = urls.lan || '—';
      $('#mining-guide-url').textContent = urls.lan || '—';

      // Get mining status
      const status = await window.mykai.mining.status();
      if (status) {
        const stats = status.stats || {};
        const workers = stats.workers || [];
        const totalHash = stats.totalHashrate || 0;
        const hashStr = totalHash >= 1000 ? `${(totalHash / 1000).toFixed(1)} TH/s` : `${totalHash.toFixed(1)} GH/s`;

        $('#mining-miner-count').textContent = workers.length;
        $('#mining-hashrate').textContent = hashStr;
        $('#mining-blocks').textContent = stats.totalBlocks || 0;

        // Get rewards from gamification
        const gStats = await window.mykai.gamification.stats();
        $('#mining-reward').textContent = `${(gStats?.totalRewardKas || 0).toFixed(1)} KAS`;

        // Update miner indicator
        if (workers.length > 0) {
          minerIndicator.classList.remove('disconnected');
          minerIndicator.classList.add('connected');
          minerIndicator.querySelector('.conn-label').textContent = `${workers.length} miner${workers.length > 1 ? 's' : ''} connected — ${hashStr}`;
        } else {
          minerIndicator.classList.remove('connected');
          minerIndicator.classList.add('disconnected');
          minerIndicator.querySelector('.conn-label').textContent = 'No miner connected';
        }

        // Update workers table in mining panel
        updateWorkersTable(workers);
      }
    } else {
      miningCard.classList.add('hidden');
      // Mining panel hidden with mining card
      minerIndicator.classList.add('hidden');
    }
  } catch (_) {}
}

function updateWorkersTable(workers) {
  const table = $('#mining-workers-table');
  const empty = $('#mining-workers-empty');

  if (!workers || workers.length === 0) {
    table.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  table.innerHTML = workers.map(w => {
    const hash = w.hashrate >= 1000 ? `${(w.hashrate / 1000).toFixed(1)} TH/s` : `${(w.hashrate || 0).toFixed(1)} GH/s`;
    const statusDot = w.connected ? 'online' : 'offline';
    return `<div class="mining-worker-row">
      <span class="mining-worker-name">${w.name || 'unknown'}</span>
      <span class="mining-worker-val">${hash}</span>
      <span class="mining-worker-status"><span class="my-node-dot ${statusDot}"></span>${w.connected ? 'Online' : 'Offline'}</span>
      <span class="mining-worker-val">${w.sharesFound || 0}</span>
      <span class="mining-worker-val">${w.blocksFound || 0}</span>
      <span class="mining-worker-val">${fmtUptime(w.uptime || 0)}</span>
    </div>`;
  }).join('');
}

function loadMiningLogs() {
  window.mykai.mining.logs().then(logs => {
    if (logs?.length) {
      $('#mining-log-output').textContent = logs.join('\n');
      $('#mining-log-output').scrollTop = $('#mining-log-output').scrollHeight;
    }
  });
}

// Mining copy URL button
$('#btn-copy-mining-url').addEventListener('click', async () => {
  const url = $('#mining-url').textContent;
  if (url && url !== '—') {
    await window.mykai.clipboard.copy(url);
    $('#btn-copy-mining-url').textContent = 'Copied!';
    setTimeout(() => { $('#btn-copy-mining-url').textContent = 'Copy'; }, 2000);
  }
});

// Mining toggle button
$('#btn-mining-toggle').addEventListener('click', async () => {
  const status = await window.mykai.mining.status();
  if (status.state === 'running') {
    await window.mykai.mining.stop();
  } else {
    const result = await window.mykai.mining.start();
    if (!result.ok) addActivity(`Mining error: ${result.error}`);
  }
  updateMiningUI();
});

// Mining event listeners
window.mykai.mining.onStatusUpdate((s) => {
  updateMiningUI();
});

window.mykai.mining.onLog((line) => {
  miningLogLines.push(line);
  if (miningLogLines.length > 200) miningLogLines.shift();
  if (activePanel === 'mining') {
    const el = $('#mining-log-output');
    el.textContent += line + '\n';
    el.scrollTop = el.scrollHeight;
  }
});

window.mykai.mining.onBlockFound(() => {
  addActivity('Block found! Your miner earned KAS');
  updateMiningUI();
});

// Miner indicator click → show mining panel
$('#miner-indicator').addEventListener('click', () => showPanel('mining'));

// --- My Nodes (Cloud Monitoring) ---
// Two data sources merge into the table:
//   - Local Node row: live, sourced from `node:status-update` events (~1 Hz).
//     Whenever the local state transitions, we re-render the table from the
//     cached cloud data — that way the local row never lags behind the top
//     status indicator (used to be visibly stale because updateMyNodes only
//     polled cloud + status every 2 minutes).
//   - Cloud node rows: HTTP-fetched from Insights at the 2-minute cadence
//     (Insights itself only refreshes every 5 min anyway, so polling more
//     often would be wasted bandwidth).
let _lastCloudNodes = [];          // cache of last successful cloud-status fetch
let _lastLocalStatus = null;        // cache of latest local status for fast re-render
let _lastRenderedLocalState = null; // last state we rendered for, gates re-renders

function renderMyNodesTable(localStatus, cloudNodes) {
  const section = $('#my-nodes-section');
  const table = $('#my-nodes-table');
  const countEl = $('#my-nodes-count');
  if (!section || !table || !countEl) return;

  const nodes = [];

  // Local node row — always live from the most recent status-update
  if (localStatus) {
    nodes.push({
      nodeName: 'Local Node',
      status: localStatus.state === 'synced' ? 'synced' : localStatus.state === 'stopped' ? 'stopped' : localStatus.state,
      daaScore: localStatus.daaScore,
      peerCount: localStatus.peerCount,
      nodeVersion: localStatus.serverVersion,
      lastSeen: Date.now(),
      isLocal: true,
    });
  }

  for (const n of cloudNodes) {
    if (n.nodeName === 'Local Node') continue;
    nodes.push(n);
  }

  if (nodes.length <= 1 && cloudNodes.length === 0) {
    // Only local node and never had cloud data — hide section
    section.classList.add('hidden');
    return;
  }

  // Only show nodes that are actually alive — based on lastSeen, not cached status.
  // Insights keeps the last-known status indefinitely, so a node that died days ago
  // still reports status="synced". Trust lastSeen as ground truth.
  const ALIVE_MS = 60 * 60 * 1000; // 1 hour
  const now = Date.now();
  const visibleNodes = nodes.filter(n => {
    if (n.isLocal) return true;
    if (!n.lastSeen) return false;
    const age = now - new Date(n.lastSeen).getTime();
    return age < ALIVE_MS;
  });

  section.classList.remove('hidden');
  countEl.textContent = `(${visibleNodes.length})`;

  table.innerHTML = visibleNodes.map(n => {
    const st = n.status || 'stopped';
    const statusClass = st === 'synced' ? 'online' : (st === 'syncing' || st === 'starting') ? 'syncing' : 'offline';
    const statusLabel = st === 'synced' ? 'Synced' : st === 'syncing' ? 'Syncing' : st === 'stopped' ? 'Stopped' : st;
    const ago = n.isLocal ? 'live' : (n.lastSeen ? formatTimeAgo(n.lastSeen) : '—');
    const daa = n.daaScore ? fmtNum(n.daaScore) : '—';
    const peers = n.peerCount ?? '—';
    let name = n.nodeName || 'Cloud Node';
    // Use geo-IP location from Insights if the name is generic
    if ((name === 'Cloud Node' || name === 'Local Node') && n.geoCity && n.geoCountry) {
      name = `${name} — ${n.geoCity}, ${n.geoCountry}`;
    }
    return `<div class="my-node-row">
      <span class="my-node-name">${name}</span>
      <span class="my-node-status"><span class="my-node-dot ${statusClass}"></span>${statusLabel}</span>
      <span class="my-node-val">${daa}</span>
      <span class="my-node-val">${peers}</span>
      <span class="my-node-val">${n.nodeVersion || '—'}</span>
      <span class="my-node-val">${ago}</span>
    </div>`;
  }).join('');
}

async function updateMyNodes() {
  try {
    const result = await window.mykai.cloud.status();
    const localStatus = await window.mykai.node.status();
    if (result.ok && result.nodes) _lastCloudNodes = result.nodes;
    _lastLocalStatus = localStatus;
    _lastRenderedLocalState = localStatus?.state ?? null;
    renderMyNodesTable(localStatus, _lastCloudNodes);
  } catch (_) {
    $('#my-nodes-section').classList.add('hidden');
  }
}

/** Fast path: re-render the table using cached cloud data. Called when the
 *  local node's state transitions (e.g. syncing → synced) so the Local
 *  Node row in the table never lags the top status indicator. No network. */
function refreshLocalNodeRow(localStatus) {
  if (!localStatus) return;
  _lastLocalStatus = localStatus;
  // Only re-render on actual state transitions; same-state status updates
  // arrive ~1 Hz and re-rendering the whole table that often is wasteful
  // when the only thing that's changed is the daaScore counter.
  if (localStatus.state === _lastRenderedLocalState) return;
  _lastRenderedLocalState = localStatus.state;
  renderMyNodesTable(localStatus, _lastCloudNodes);
}

function formatTimeAgo(isoOrTs) {
  const ts = typeof isoOrTs === 'string' ? new Date(isoOrTs).getTime() : isoOrTs;
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// --- Init ---
async function init() {
  // Populate version in the title bar — tiny, subtle, once.
  try {
    const v = await window.mykai.app.version();
    if (v) $('#titlebar-version').textContent = `v${v}`;
  } catch (_) {}

  const status = await window.mykai.node.status();
  if (status) updateUI(status);
  const stats = await window.mykai.gamification.stats();
  if (stats) updateGameStats(stats);
  renderMilestones(stats?.milestones || []);
  startActivityTracker();
  addActivity('MyKAI Node started');

  // Load storage size
  try {
    const dataSize = await window.mykai.config.dataSize();
    if (dataSize) $('#stat-storage').textContent = dataSize;
  } catch (_) {}

  // Load cloud node status and mining UI
  updateMyNodes();
  updateMiningUI();

  // Update connection indicators and health stats every 5 seconds
  setInterval(async () => {
    if (currentState !== 'stopped') {
      const agentStatus = await window.mykai.health.agentStatus();
      updateAgentIndicator(agentStatus);
      await updateHealthStats();
      const cfg = await window.mykai.config.get();
      const kmStatus = await window.mykai.kasmap.status();
      updateKasMapIndicator(kmStatus, cfg.kasmap);
    }
  }, 5000);

  // Cloud nodes heartbeat every 5 min — polling every 30s was wasteful
  // (1 HTTPS call every 30s over hours accumulates TIME_WAIT sockets).
  // 2-min cadence still feels live since the underlying data only refreshes
  // every 5 min server-side anyway.
  setInterval(updateMyNodes, 120000);
  setInterval(updateMiningUI, 5000);
  // Refresh storage size every 2 minutes — kaspad prunes in the background,
  // so the hero card would otherwise show a stale boot-time value forever.
  setInterval(async () => {
    try {
      const dataSize = await window.mykai.config.dataSize();
      if (dataSize) $('#stat-storage').textContent = dataSize;
    } catch (_) {}
  }, 120000);

  // Keep polling status every 2s until we get a non-stopped state
  // This catches the auto-start race condition
  let pollCount = 0;
  const startupPoll = setInterval(async () => {
    pollCount++;
    const s = await window.mykai.node.status();
    if (s) updateUI(s);
    // Stop polling after 30s or once we're past 'stopped'
    if (pollCount > 15 || (s && s.state !== 'stopped')) {
      clearInterval(startupPoll);
    }
  }, 2000);
}

// --- Update System ---
let pendingUpdateVersion = null;
let pendingUpdateType = null; // 'kaspad' | 'app'

// Kaspad-only update available
window.mykai.update.onKaspadAvailable((info) => {
  pendingUpdateVersion = info.newVersion;
  pendingUpdateType = 'kaspad';

  if (info.urgency === 'critical') {
    showCriticalUpdateModal(info);
  } else {
    showUpdateBanner(info);
  }
  addActivity(`Update available: kaspad v${info.newVersion}` + (info.urgency === 'critical' ? ' (CRITICAL)' : ''));
});

// Live app-update state, kept on the renderer so Settings + banner can
// reconcile against it without an IPC round-trip every render. Set by
// onAppAvailable / onAppDownloaded; read by refreshAppVersionStatus().
let latestAppUpdateInfo = null;       // { version, releaseNotes, ... }
let appUpdateDownloadedFlag = false;  // flips true the moment download finishes

// Full app update available — show the banner IMMEDIATELY in a
// "Downloading…" state. Pre-0.3.5 bug: the banner waited for
// `app-update-downloaded`, leaving a silent 30s–3min gap (size of the
// installer is ~117 MB) during which the activity feed said
// "App update vX.Y.Z available" but the UI was otherwise empty —
// users assumed nothing was happening and pressed buttons in confusion.
// Now the user sees download progress live, then the banner flips to
// "Restart now" once the download finishes.
window.mykai.update.onAppAvailable((info) => {
  pendingUpdateType = 'app';
  latestAppUpdateInfo = info;
  appUpdateDownloadedFlag = false;
  addActivity(`App update v${info.version} available — downloading…`);

  const banner = $('#update-banner');
  banner.classList.remove('hidden', 'critical');
  $('#update-banner-text').textContent = `Downloading MyKAI Node v${info.version}…`;
  $('#btn-update-action').textContent = 'Downloading…';
  $('#btn-update-action').disabled = true;
  // No "Later" while the download is in flight — pressing it would just
  // hide the banner without stopping the download, which is misleading.
  // It re-appears once we transition to "Restart now".
  $('#btn-update-dismiss').classList.add('hidden');

  const progressEl = $('#update-progress');
  progressEl.classList.remove('hidden');
  $('#update-progress-fill').style.width = '0%';
  $('#update-progress-text').textContent = 'Starting download…';

  // Mirror to Settings panel if it's already open; harmless no-op otherwise.
  refreshAppVersionStatus();
});

// App-update download progress. The bridge has existed in preload since
// 0.2.x but no renderer ever subscribed — user reports of "stuck on
// Available" were really "115 MB downloading silently." Now we show the
// live byte count + percent in the banner (and mirror to Settings).
window.mykai.update.onAppProgress((p) => {
  const progressEl = $('#update-progress');
  const pct = Math.max(0, Math.min(100, Math.round(p.percent || 0)));
  if (!progressEl.classList.contains('hidden')) {
    $('#update-progress-fill').style.width = pct + '%';
    const mb = ((p.bytesReceived || 0) / (1024 * 1024)).toFixed(1);
    const totalMb = ((p.totalBytes || 0) / (1024 * 1024)).toFixed(1);
    $('#update-progress-text').textContent = `${mb} / ${totalMb} MB (${pct}%)`;
  }
  const settingsStatus = $('#app-version-status');
  if (settingsStatus && latestAppUpdateInfo) {
    settingsStatus.textContent = `Downloading v${latestAppUpdateInfo.version} — ${pct}%`;
  }
});

// Full app update downloaded and ready — flip the banner to its
// "Restart now" state. info.releaseNotes comes from our custom
// update-manifest.json (preferred user-friendly text we control) or
// falls back to whatever electron-updater pulled from latest.yml.
// Either may be empty; we just drop the dash-segment in that case.
window.mykai.update.onAppDownloaded((info) => {
  latestAppUpdateInfo = info;
  appUpdateDownloadedFlag = true;
  const banner = $('#update-banner');
  banner.classList.remove('hidden', 'critical');
  const notesSegment = info.releaseNotes ? ` — ${info.releaseNotes}` : '';
  $('#update-banner-text').textContent = `MyKAI Node v${info.version} ready${notesSegment}`;
  $('#btn-update-action').textContent = 'Restart now';
  $('#btn-update-action').disabled = false;
  $('#btn-update-dismiss').classList.remove('hidden');
  $('#update-progress').classList.add('hidden');

  $('#btn-update-action').onclick = () => window.mykai.update.installApp();
  $('#btn-update-dismiss').onclick = () => banner.classList.add('hidden');

  addActivity(`App update v${info.version} downloaded — ready to install`);
  refreshAppVersionStatus();
});

// Kaspad download progress
window.mykai.update.onProgress((p) => {
  const progressEl = $('#update-progress');
  const modalProgress = $('#update-modal-progress');

  if (!progressEl.classList.contains('hidden')) {
    $('#update-progress-fill').style.width = p.percent + '%';
    const mb = (p.bytesReceived / (1024 * 1024)).toFixed(1);
    const totalMb = (p.totalBytes / (1024 * 1024)).toFixed(1);
    $('#update-progress-text').textContent = `${mb} / ${totalMb} MB (${p.percent}%)`;
  }
  if (!modalProgress.classList.contains('hidden')) {
    $('#update-modal-fill').style.width = p.percent + '%';
  }
});

// Install step updates (for kaspad hot-swap)
window.mykai.update.onStep((msg) => {
  const modalStep = $('#update-modal-step');
  if (modalStep) modalStep.textContent = msg;
  $('#update-progress-text').textContent = msg;

  // If complete, hide modal after 3 seconds
  if (msg.includes('complete')) {
    setTimeout(() => {
      $('#update-modal').classList.add('hidden');
      $('#update-banner').classList.add('hidden');
    }, 3000);
  }
});

// Kaspad update complete
window.mykai.update.onComplete((info) => {
  addActivity(`kaspad updated to v${info.version}`);
  pendingUpdateVersion = null;
  pendingUpdateType = null;
});

// Update errors. We used to filter out "No update-manifest / 404 /
// Manifest fetch" because those are normal Channel B states when no
// release exists yet. But the same filter was masking REAL Channel A
// (electron-updater) failures — checksum mismatch, blockmap delta
// failure, signature error — which are the failures that have left
// non-tech users stranded since 0.2.28.
//
// Now: only suppress the EXACT Channel-B-no-manifest case (URL contains
// `update-manifest`); every other error from autoUpdater is tagged with
// `[autoUpdater]` upstream and shown verbatim. Worst case the user sees
// a slightly scary line in the activity feed; right now we'd rather
// scary + true than silent + broken.
window.mykai.update.onError((msg) => {
  const m = String(msg || '');
  const isChannelBNoManifest =
    m.includes('No update-manifest') ||
    m.includes('Manifest fetch timeout') ||
    (m.includes('404') && !m.includes('[autoUpdater]'));
  if (isChannelBNoManifest) return;
  addActivity(`Update error: ${m}`);
  // Don't auto-hide the banner anymore — if download failed mid-flight,
  // we want the user to see the error sit alongside the half-finished
  // state. They can dismiss manually.
  const modalBtn = $('#btn-update-modal-action');
  if (modalBtn) {
    modalBtn.disabled = false;
    modalBtn.textContent = 'Retry Update';
  }
});

function showUpdateBanner(info) {
  const banner = $('#update-banner');
  banner.classList.remove('hidden', 'critical');
  if (info.urgency === 'recommended') {
    banner.classList.add('critical'); // red accent for recommended too, to get attention
  }
  $('#update-banner-text').textContent = `kaspad v${info.newVersion} available` +
    (info.releaseNotes ? ` — ${info.releaseNotes}` : '');
  $('#btn-update-action').textContent = 'Update';
  $('#btn-update-dismiss').classList.remove('hidden');
  $('#update-progress').classList.add('hidden');

  $('#btn-update-action').onclick = () => startKaspadUpdate();
  $('#btn-update-dismiss').onclick = () => {
    banner.classList.add('hidden');
    window.mykai.update.dismiss(info.newVersion);
  };
}

function showCriticalUpdateModal(info) {
  const modal = $('#update-modal');
  modal.classList.remove('hidden');

  let text = info.releaseNotes || 'A critical consensus upgrade is required for your node to stay on the network.';
  $('#update-modal-text').textContent = text;

  // Show fork deadline countdown if available
  if (info.forkDeadline) {
    const countdownEl = $('#update-modal-countdown');
    countdownEl.classList.remove('hidden');
    const deadline = new Date(info.forkDeadline).getTime();
    const updateCountdown = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        countdownEl.textContent = 'Fork deadline has passed!';
        countdownEl.style.color = 'var(--red)';
      } else {
        const hours = Math.floor(remaining / 3600000);
        const mins = Math.floor((remaining % 3600000) / 60000);
        countdownEl.textContent = `Deadline: ${hours}h ${mins}m remaining`;
      }
    };
    updateCountdown();
    setInterval(updateCountdown, 60000);
  }

  $('#update-modal-progress').classList.add('hidden');
  const btn = $('#btn-update-modal-action');
  btn.disabled = false;
  btn.textContent = 'Update kaspad Now';
  btn.onclick = () => startKaspadUpdate(true);
}

function startKaspadUpdate(isModal = false) {
  // Show progress in appropriate container
  if (isModal) {
    $('#update-modal-progress').classList.remove('hidden');
    $('#btn-update-modal-action').disabled = true;
    $('#btn-update-modal-action').textContent = 'Updating...';
    $('#update-modal-fill').style.width = '0%';
  } else {
    $('#update-progress').classList.remove('hidden');
    $('#btn-update-action').disabled = true;
    $('#btn-update-dismiss').classList.add('hidden');
  }
  window.mykai.update.installKaspad();
}

init();
