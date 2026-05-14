"use strict";
/**
 * Installation & process detection for the diagnostic dump.
 *
 * Why this exists: a 0.3.3 user (Morris) hit a "Sync hasn't moved in 52
 * minutes" alert. Restart node didn't help. Manual Stop+Start didn't help.
 * Hypothesis: a zombie kaspad.exe from a previous unclean shutdown was
 * holding the chain DB locks, and the user-visible kaspad MyKAI launches
 * keeps retrying but can't make progress. Without the diagnostic
 * surfacing how many kaspad.exe / MyKAI processes are running and how
 * many MyKAI is installed, support has to walk users through Task
 * Manager and Add/Remove Programs manually.
 *
 * Windows-only — MyKAI Node ships as a Windows-only desktop installer.
 * Returns empty results on other platforms so callers don't need to
 * branch.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.countRunningProcesses = countRunningProcesses;
exports.getInstalledMyKAIVersions = getInstalledMyKAIVersions;
exports.getKaspaDataDirs = getKaspaDataDirs;
const child_process_1 = require("child_process");
const util_1 = require("util");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const execAsync = (0, util_1.promisify)(child_process_1.exec);
/** Count running processes by image name (Windows .exe). Returns
 *  { imageName, count: 0, pids: [] } on any error or non-Windows.
 *
 *  Async since 0.3.5 hotfix #5 — was synchronous via execSync() from
 *  0.3.4 onward, which blocked the main event loop for 50–500 ms per
 *  call (worst case >5 s on antivirus contention). On a `previous_session
 *  _unclean` heartbeat trigger this fired during the most-load-sensitive
 *  startup window, which was the structural cause of the multi-second
 *  freeze users reported on every fresh install since 0.3.4. The
 *  diagnostic builder is already async, so awaiting this is free at the
 *  caller. 5 s timeout cap. */
async function countRunningProcesses(imageName) {
    const empty = { imageName, count: 0, pids: [] };
    if (process.platform !== 'win32')
        return empty;
    try {
        const { stdout } = await execAsync(`cmd.exe /c "tasklist /FI \\"IMAGENAME eq ${imageName}\\" /FO CSV /NH"`, { encoding: 'utf-8', timeout: 5000, windowsHide: true });
        if (stdout.toLowerCase().includes('no tasks'))
            return empty;
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        const pids = lines.map((line) => {
            // CSV: "Image Name","PID","Session Name","Session#","Mem Usage"
            const match = line.match(/^"[^"]+","(\d+)"/);
            return match ? parseInt(match[1], 10) : NaN;
        }).filter((n) => Number.isFinite(n));
        return { imageName, count: pids.length, pids };
    }
    catch {
        return empty;
    }
}
/** Query the Windows registry's Add/Remove Programs hives for entries
 *  matching "MyKAI". Covers both per-machine (HKLM) and per-user (HKCU)
 *  installs, plus 32-bit-on-64-bit (WOW6432Node). Returns [] on non-
 *  Windows or if the queries fail.
 *
 *  Async since 0.3.5 hotfix #5 — was three sequential sync execSync()
 *  calls, each up to 10 s timeout. Now runs all three reg queries in
 *  parallel via Promise.all so the worst case is ~one query's duration
 *  instead of the sum. Errors per-hive are swallowed (a non-existent
 *  WOW6432Node hive is normal on pure-x64 systems, etc.). */
async function getInstalledMyKAIVersions() {
    if (process.platform !== 'win32')
        return [];
    const queries = [
        'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ];
    const results = await Promise.all(queries.map((root) => execAsync(`reg query "${root}" /s /f "MyKAI" /d`, { encoding: 'utf-8', timeout: 10000, windowsHide: true })
        .then(({ stdout }) => stdout)
        .catch(() => '')));
    const apps = [];
    for (const result of results) {
        if (!result)
            continue;
        // Each match returns a block like:
        //   HKEY_..\Uninstall\{guid}
        //       DisplayName    REG_SZ    MyKAI Node
        //       DisplayVersion REG_SZ    0.3.3
        //       InstallLocation REG_SZ   C:\Program Files\MyKAI Node
        // Split on the registry path lines (start with HKEY_).
        const blocks = result.split(/(?=^HKEY_)/m);
        for (const block of blocks) {
            if (!block.toLowerCase().includes('mykai'))
                continue;
            const nameMatch = block.match(/DisplayName\s+REG_SZ\s+(.+?)\s*(?:\r?\n|$)/);
            const verMatch = block.match(/DisplayVersion\s+REG_SZ\s+(.+?)\s*(?:\r?\n|$)/);
            const locMatch = block.match(/InstallLocation\s+REG_SZ\s+(.+?)\s*(?:\r?\n|$)/);
            const name = nameMatch?.[1]?.trim();
            // Filter out MyKAI Agent or other adjacent products if any —
            // we only want "MyKAI Node" in this list. Adjust if more
            // MyKAI products ever ship.
            if (name && /mykai/i.test(name)) {
                apps.push({
                    name,
                    version: verMatch?.[1]?.trim() ?? '?',
                    installLocation: locMatch?.[1]?.trim() ?? '?',
                });
            }
        }
    }
    return apps;
}
/** List potential kaspa data dirs that exist on disk. Includes the
 *  default rusty-kaspa locations. Used to surface the case where a
 *  user has multiple kaspa chain dirs (from a previous install or
 *  manual move) competing for kaspad processes' attention. */
function getKaspaDataDirs() {
    const candidates = [
        path_1.default.join(os_1.default.homedir(), 'AppData', 'Local', 'rusty-kaspa'),
        path_1.default.join(os_1.default.homedir(), 'AppData', 'Roaming', 'rusty-kaspa'),
        path_1.default.join(os_1.default.homedir(), '.rusty-kaspa'),
    ];
    return candidates
        .map((p) => ({ path: p, exists: fs_1.default.existsSync(p), sizeMb: -1 }))
        .filter((r) => r.exists);
}
//# sourceMappingURL=installations-info.js.map