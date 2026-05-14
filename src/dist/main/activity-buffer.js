"use strict";
/**
 * Small in-memory ring buffer of recent activity feed lines.
 *
 * Populated as a side-effect when main.ts sends `node:activity` messages to
 * the renderer. Read by the diagnostic report builder so we can include the
 * last N lines in a support dump without asking the renderer to export its DOM.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordActivity = recordActivity;
exports.getRecentActivity = getRecentActivity;
// Headroom for diagnostic dumps. We expose 100 lines via the diagnostic
// (see diagnostic.ts) and the buffer should hold a bit more so the
// "last 100" call captures the most recent 100 even if the buffer just
// rotated. Larger buffer also helps cover startup bursts where 30-50
// "New peer connected" lines arrive in the first 30 seconds.
const MAX_LINES = 200;
const buffer = [];
/** Record an activity line. Timestamps it and keeps the last MAX_LINES entries. */
function recordActivity(msg) {
    const line = `${new Date().toISOString().replace('T', ' ').substring(0, 19)}  ${msg}`;
    buffer.push(line);
    if (buffer.length > MAX_LINES)
        buffer.shift();
}
/** Return the last `count` lines (most recent last). Returns a copy. */
function getRecentActivity(count = 30) {
    return buffer.slice(-count);
}
//# sourceMappingURL=activity-buffer.js.map