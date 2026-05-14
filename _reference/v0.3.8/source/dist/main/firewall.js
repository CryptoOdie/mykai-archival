"use strict";
/**
 * Windows Firewall rule management for runtime-conditional ports.
 *
 * The NSIS installer opens port 16111 (Kaspa mainnet) at install time. But
 * testnet (16211) and mining (5555) are only needed if the user actively
 * uses those features — opening them by default would expand the attack
 * surface unnecessarily. This module manages those rules at runtime.
 *
 * Flow when we need to add/remove a rule:
 *  1. Show a native "are you sure?" dialog so the user knows what's coming
 *  2. If approved, spawn PowerShell with -Verb RunAs (triggers Windows UAC)
 *  3. Elevated shell runs the netsh command, returns exit code
 *
 * Same pattern as clock-offset's clock:fix-now handler.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FW_MAINNET = exports.FW_MINING = exports.FW_TESTNET = void 0;
exports.requestOpenPort = requestOpenPort;
exports.requestRemovePort = requestRemovePort;
exports.isRuleActive = isRuleActive;
const electron_1 = require("electron");
const child_process_1 = require("child_process");
/** Spawn a PowerShell Start-Process -Verb RunAs child to run netsh elevated. */
function runElevatedNetsh(netshCommand) {
    return new Promise((resolve) => {
        // Escape any embedded double quotes in the netsh command for PowerShell
        const escaped = netshCommand.replace(/"/g, '\\"');
        const ps = `$proc = Start-Process cmd -ArgumentList '/c ${escaped}' -Verb RunAs -WindowStyle Hidden -PassThru -Wait; exit $proc.ExitCode`;
        const child = (0, child_process_1.spawn)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
        let stderr = '';
        child.stderr?.on('data', (d) => { stderr += d.toString(); });
        child.on('exit', (code) => {
            if (code === 0)
                resolve({ ok: true });
            else
                resolve({ ok: false, error: stderr || `exit ${code}` });
        });
        child.on('error', (err) => resolve({ ok: false, error: err.message }));
    });
}
/** Show a native OK/Cancel dialog asking the user if we may change the firewall. */
async function confirmFirewallChange(parentWindow, title, message, detail) {
    const result = await electron_1.dialog.showMessageBox(parentWindow || undefined, {
        type: 'question',
        buttons: ['OK', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title,
        message,
        detail,
        noLink: true,
    });
    return result.response === 0;
}
/**
 * Open a Windows Firewall inbound TCP rule for the given port, after asking
 * the user to confirm. Returns { ok, error?, cancelled? }.
 */
async function requestOpenPort(parentWindow, spec, userFriendlyPurpose) {
    const approved = await confirmFirewallChange(parentWindow, 'Allow through Windows Firewall?', `Allow ${userFriendlyPurpose} to reach your node?`, `MyKAI needs to open inbound port ${spec.port} so ${userFriendlyPurpose} can connect. Click OK and Windows will ask for your permission.`);
    if (!approved)
        return { ok: false, cancelled: true };
    const cmd = `netsh advfirewall firewall add rule name=\\"${spec.ruleName}\\" dir=in action=allow protocol=TCP localport=${spec.port} description=\\"${spec.description}\\"`;
    return runElevatedNetsh(cmd);
}
/**
 * Remove a Windows Firewall rule we previously added, after asking the user
 * to confirm (so they see UAC coming). Returns { ok, error?, cancelled? }.
 */
async function requestRemovePort(parentWindow, ruleName, userFriendlyPurpose) {
    const approved = await confirmFirewallChange(parentWindow, 'Remove Windows Firewall rule?', `Stop allowing ${userFriendlyPurpose}?`, `MyKAI wants to remove the firewall rule that allowed ${userFriendlyPurpose}. Click OK and Windows will ask for your permission.`);
    if (!approved)
        return { ok: false, cancelled: true };
    const cmd = `netsh advfirewall firewall delete rule name=\\"${ruleName}\\"`;
    return runElevatedNetsh(cmd);
}
// --- Rule specs (shared across the codebase) ---
exports.FW_TESTNET = {
    ruleName: 'MyKAI Node - Kaspa P2P (testnet)',
    port: 16211,
    description: 'Added by MyKAI Node. Required for inbound testnet peer connections.',
};
exports.FW_MINING = {
    ruleName: 'MyKAI Node - Stratum Mining',
    port: 5555,
    description: 'Added by MyKAI Node. Required for LAN/external miners to connect to the stratum bridge.',
};
exports.FW_MAINNET = {
    ruleName: 'MyKAI Node - Kaspa P2P (mainnet)',
    port: 16111,
    description: 'Added by MyKAI Node. Required for inbound mainnet peer connections.',
};
/**
 * Check if a firewall rule with the given name exists. Read-only — does not
 * require elevation, runs as the current user. Returns false on any error.
 */
function isRuleActive(ruleName) {
    return new Promise((resolve) => {
        const child = (0, child_process_1.spawn)('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${ruleName}`], { windowsHide: true });
        let stdout = '';
        child.stdout?.on('data', (d) => { stdout += d.toString(); });
        child.on('exit', (code) => {
            // netsh returns 1 when rule is not found. When found, it prints the
            // rule details; we look for a recognizable field to confirm.
            resolve(code === 0 && /Enabled:\s*Yes/i.test(stdout));
        });
        child.on('error', () => resolve(false));
    });
}
//# sourceMappingURL=firewall.js.map