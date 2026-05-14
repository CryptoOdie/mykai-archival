"use strict";
/**
 * Session shutdown log.
 *
 * Writes `<userData>/last-session.json` at startup with `ended_clean: false`.
 * The before-quit hook flips `ended_clean: true` and records the end reason.
 * At next startup we read the previous file BEFORE overwriting, so the next
 * heartbeat can carry an authoritative report of how the prior session ended:
 *
 *   - File missing on startup        → first launch, no prior session
 *   - Prior file `ended_clean: true` → graceful shutdown (window close, Stop
 *                                       Node, OS shutdown, before-quit fired)
 *   - Prior file `ended_clean: false`→ prior session was force-killed,
 *                                       crashed (segfault / OOM), or the
 *                                       host lost power. before-quit didn't
 *                                       fire to set the flag.
 *
 * Insights gets either `previous_session_clean` or `previous_session_unclean`
 * as the next heartbeat's Tier-2 trigger, with the prior session's metadata
 * attached. After the first successful Tier-2 attach the flag clears so we
 * don't re-report on every heartbeat.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initSessionLog = initSessionLog;
exports.recordSessionEnd = recordSessionEnd;
exports.getPreviousSession = getPreviousSession;
exports.isPreviousSessionPending = isPreviousSessionPending;
exports.markPreviousSessionReported = markPreviousSessionReported;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
let _previousSession = null;
let _currentSessionFile = null;
let _previousReported = false;
function getSessionFilePath() {
    return path_1.default.join(electron_1.app.getPath('userData'), 'last-session.json');
}
/** Read prior session file (if any), then overwrite with a fresh
 *  in-progress record. Call once during main initialize() before any
 *  Tier-2 heartbeat work. */
function initSessionLog(monitorVersion) {
    const filePath = getSessionFilePath();
    // 1) Read prior session BEFORE we overwrite it.
    try {
        if (fs_1.default.existsSync(filePath)) {
            const content = fs_1.default.readFileSync(filePath, 'utf-8');
            const prior = JSON.parse(content);
            // Sanity-check the shape — corrupted JSON / pre-feature data is
            // treated as "no prior session" rather than letting bogus values
            // propagate to Insights.
            if (typeof prior?.started_at === 'number') {
                _previousSession = prior;
            }
        }
    }
    catch { /* ignore — corrupted or unreadable; treat as no prior session */ }
    // 2) Write a fresh "in progress" marker. ended_clean stays false until
    //    before-quit flips it.
    const current = {
        started_at: Date.now(),
        ended_at: null,
        ended_clean: false,
        end_reason: null,
        monitor_version: monitorVersion,
        uptime_seconds: 0,
    };
    try {
        fs_1.default.writeFileSync(filePath, JSON.stringify(current, null, 2));
        _currentSessionFile = filePath;
    }
    catch { /* ignore */ }
}
/** Mark the current session as cleanly ended. Called from main's
 *  before-quit hook. */
function recordSessionEnd(reason) {
    if (!_currentSessionFile)
        return;
    try {
        const content = fs_1.default.readFileSync(_currentSessionFile, 'utf-8');
        const session = JSON.parse(content);
        session.ended_at = Date.now();
        session.ended_clean = true;
        session.end_reason = reason;
        session.uptime_seconds = Math.max(0, Math.floor((session.ended_at - session.started_at) / 1000));
        fs_1.default.writeFileSync(_currentSessionFile, JSON.stringify(session, null, 2));
    }
    catch { /* ignore — best effort; we'd rather complete shutdown than block */ }
}
/** Returns the prior session's record, or null if this is the first launch
 *  or the prior file was missing/corrupted. Stable across calls. */
function getPreviousSession() {
    return _previousSession;
}
/** True when there's a prior-session record we haven't yet attached to a
 *  heartbeat. shouldAttachDiagnostic uses this to fire the one-shot
 *  previous_session_* trigger. */
function isPreviousSessionPending() {
    return _previousSession !== null && !_previousReported;
}
/** Mark the prior-session record as reported. Called by the heartbeat
 *  pre-send hook after a successful Tier-2 attach that included it. */
function markPreviousSessionReported() {
    _previousReported = true;
}
//# sourceMappingURL=session-log.js.map