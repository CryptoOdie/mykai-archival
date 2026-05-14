"use strict";
/**
 * Programmatic CPU profiler for the startup window.
 *
 * Why: hand-rolled JS-level timing has reached its limit. The catch-up
 * freeze on every fresh install consumes seconds of CPU we cannot see
 * from inside our timing wrappers — most likely native code (ws frame
 * parsing, V8 JIT compilation, IPC bridge serialization). Need a real
 * sampling profiler.
 *
 * Approach: use Node's `inspector` API (programmatic V8 profiler) to
 * record a CPU profile from process start until either:
 *   1. 60 seconds elapsed
 *   2. The activity feed has been quiet for 5 seconds (catch-up done)
 * whichever comes first.
 *
 * Output: writes `userData/startup.cpuprofile` (V8 CPU profile JSON).
 * User loads it in Chrome DevTools → Performance tab → Load profile.
 * Bottom-up view shows which functions consumed the most CPU. Native
 * functions show up too (`(garbage collector)`, `(program)`, ws/zlib
 * native calls, etc).
 *
 * Cost: ~1-3% overhead while sampling at 1ms resolution. Safe to leave
 * always-on during the first 60s of every startup; it's the structural
 * cost of finding the freeze root cause. Once the freeze is fixed, this
 * module can be removed or env-gated.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startStartupProfile = startStartupProfile;
exports.stopStartupProfile = stopStartupProfile;
exports.isProfilingActive = isProfilingActive;
const inspector_1 = require("inspector");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
let session = null;
let stopTimer = null;
let started = false;
let stopped = false;
const PROFILE_DURATION_MS = 60_000;
const SAMPLING_INTERVAL_US = 1000; // 1ms — fine enough to catch sub-second hot functions
/** Begin sampling. Idempotent. Writes to userData/startup.cpuprofile
 *  when stopped (either via timer or explicit stop()). */
function startStartupProfile(userDataDir) {
    if (started)
        return;
    started = true;
    try {
        session = new inspector_1.Session();
        session.connect();
        session.post('Profiler.enable');
        session.post('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US });
        session.post('Profiler.start');
        stopTimer = setTimeout(() => {
            stopStartupProfile(userDataDir);
        }, PROFILE_DURATION_MS);
    }
    catch (err) {
        // Profiler unavailable (e.g., inspector blocked) — silently skip.
        session = null;
    }
}
/** Stop sampling and write the profile to disk. Idempotent. The optional
 *  done callback fires (with or without error) once the file has been
 *  flushed and the inspector session disconnected — wired into the app's
 *  `before-quit` handler so a user-initiated close still produces a
 *  profile even before the 60 s timer fires. */
function stopStartupProfile(userDataDir, done) {
    if (stopped) {
        done?.();
        return;
    }
    if (!session) {
        stopped = true;
        done?.();
        return;
    }
    stopped = true;
    if (stopTimer) {
        clearTimeout(stopTimer);
        stopTimer = null;
    }
    try {
        session.post('Profiler.stop', (err, params) => {
            try {
                if (!err && params?.profile) {
                    const outPath = path_1.default.join(userDataDir, 'startup.cpuprofile');
                    fs_1.default.writeFileSync(outPath, JSON.stringify(params.profile));
                }
            }
            catch {
                // best-effort
            }
            try {
                session?.disconnect();
            }
            catch { }
            session = null;
            done?.();
        });
    }
    catch {
        done?.();
    }
}
/** True iff the profiler was started and has not yet been flushed. Used
 *  by main.ts's before-quit hook to decide whether to defer the quit
 *  until the profile lands. */
function isProfilingActive() {
    return started && !stopped;
}
//# sourceMappingURL=cpu-profiler.js.map