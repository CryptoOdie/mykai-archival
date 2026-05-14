"use strict";
/**
 * Identity backup — durable storage for accountKey + lifetime stats.
 *
 * Why this exists:
 *   electron-store puts both ConfigStore (`mykai-node-config.json`) and
 *   Gamification (`mykai-node-gamification.json`) under
 *   `%APPDATA%\Roaming\MyKAI Node\`. PC-cleaner tools (CCleaner, IObit,
 *   Wise Care, etc.) target that path by default for "uninstalled apps"
 *   cleanup. A community user (Morris on 0.2.28) lost his accountKey +
 *   13 days of lifetime stats this way: kaspad's chain DB at
 *   `%APPDATA%\Local\rusty-kaspa\` survived (different path, not
 *   targeted), but MyKAI's identity didn't.
 *
 *   This module mirrors identity to `Documents\MyKAI\identity_acc_<key>.json`
 *   — user-owned data territory that cleaner tools never touch by default.
 *
 * Filename strategy (keyed, never-overwritten):
 *   Each accountKey gets its OWN file: `identity_acc_<32hex>.json`. This
 *   means:
 *     - Multi-machine sync (OneDrive on Documents folder) → each machine
 *       has its own keyed file. No collisions.
 *     - "Reset identity" → old keyed file is preserved as a recoverable
 *       record on disk. The new install just creates a new keyed file
 *       alongside it. User can switch back by pasting the old key.
 *     - Restoring to a previously-used accountKey → the existing keyed
 *       file is updated in place; no foreign data overwritten.
 *
 *   Documents folder accumulates one file per accountKey ever used. With
 *   typical use that's 1-3 files; an active user resetting often might
 *   have a dozen. Negligible disk impact.
 *
 * The ONLY path to a true reset of the CURRENT accountKey is the
 * explicit "Reset identity" Settings button — and even then we DON'T
 * delete the old keyed file (so the user can still recover from it).
 * They have to delete the file themselves to truly burn it.
 *
 * Cloud is NOT a substitute for this — see Theme 5 of the 0.3.3 plan.
 * Cloud-side identity_backup is a recovery NET; this local file is the
 * primary durability mechanism. Most users never need cloud recovery
 * because Documents survives.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBackupFolder = getBackupFolder;
exports.readBackup = readBackup;
exports.listKnownAccountKeys = listKnownAccountKeys;
exports.writeBackupPartial = writeBackupPartial;
exports.deleteBackup = deleteBackup;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const electron_1 = require("electron");
const SCHEMA_VERSION = 1;
const ACC_RX = /^acc_[0-9a-f]{32}$/;
const FILE_RX = /^identity_(acc_[0-9a-f]{32})\.json$/;
/** Pre-keyed-filenames (0.3.3-wip early commits) name. We migrate from
 *  this on next write. Read-only fallback during the brief window
 *  between dev installs and 0.3.3 ship. */
const LEGACY_FILENAME = 'identity.json';
/** `<user-Documents>\MyKAI\` — the durable folder. Created lazily on first write. */
function getBackupFolder() {
    return path_1.default.join(electron_1.app.getPath('documents'), 'MyKAI');
}
/** `<user-Documents>\MyKAI\identity_acc_<key>.json` for a specific accountKey. */
function backupFilePathFor(accountKey) {
    return path_1.default.join(getBackupFolder(), `identity_${accountKey}.json`);
}
/** List all `identity_acc_<key>.json` files in the backup folder, sorted
 *  most-recent updatedAt first. Empty array if folder doesn't exist or
 *  no files match. Best-effort — never throws. */
function listBackupFiles() {
    try {
        const folder = getBackupFolder();
        if (!fs_1.default.existsSync(folder))
            return [];
        const entries = fs_1.default.readdirSync(folder).filter((name) => FILE_RX.test(name));
        const out = [];
        for (const name of entries) {
            try {
                const raw = fs_1.default.readFileSync(path_1.default.join(folder, name), 'utf8');
                const data = JSON.parse(raw);
                if (data.schemaVersion === SCHEMA_VERSION && ACC_RX.test(data.accountKey ?? '')) {
                    out.push(data);
                }
            }
            catch {
                // Bad file — skip silently, don't let one corrupted backup
                // poison the whole scan.
            }
        }
        // Most-recent first, by updatedAt.
        out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        return out;
    }
    catch (err) {
        console.error('[identity-backup] listBackupFiles failed:', err.message);
        return [];
    }
}
/** Try to read the legacy `identity.json` (pre-keyed-filenames) format.
 *  Used as a fallback when no keyed files exist — supports migration
 *  for users who ran a 0.3.3-wip dev build before this rename landed. */
function readLegacyFile() {
    try {
        const filePath = path_1.default.join(getBackupFolder(), LEGACY_FILENAME);
        if (!fs_1.default.existsSync(filePath))
            return null;
        const raw = fs_1.default.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        if (data.schemaVersion !== SCHEMA_VERSION)
            return null;
        if (!ACC_RX.test(data.accountKey ?? ''))
            return null;
        return data;
    }
    catch {
        return null;
    }
}
/** Read the most-relevant backup. Strategy:
 *    1. If `preferredKey` is provided, look for that exact file. Returns
 *       null if not found (caller can decide whether to fall back).
 *    2. Otherwise, scan all keyed files and return the most-recent.
 *    3. If no keyed files exist, fall back to legacy `identity.json`.
 *
 *  Returns null if nothing relevant is found. */
function readBackup(preferredKey) {
    if (preferredKey && ACC_RX.test(preferredKey)) {
        try {
            const filePath = backupFilePathFor(preferredKey);
            if (!fs_1.default.existsSync(filePath))
                return null;
            const raw = fs_1.default.readFileSync(filePath, 'utf8');
            const data = JSON.parse(raw);
            if (data.schemaVersion !== SCHEMA_VERSION)
                return null;
            return data;
        }
        catch (err) {
            console.error('[identity-backup] read by key failed:', err.message);
            return null;
        }
    }
    const list = listBackupFiles();
    if (list.length > 0) {
        if (list.length > 1) {
            const keys = list.map(b => b.accountKey.slice(0, 12) + '...').join(', ');
            console.log(`[identity-backup] ${list.length} backup files found, picking most-recent. Available: ${keys}`);
        }
        return list[0];
    }
    // Fall back to legacy file if no keyed files exist (one-time migration).
    return readLegacyFile();
}
/** List all known accountKeys present in Documents. Used by the
 *  first-run modal to surface "we found N backed-up identities" if the
 *  user has multiples (rare — only happens on multi-machine Documents
 *  sync or after multiple resets). */
function listKnownAccountKeys() {
    return listBackupFiles().map(b => b.accountKey);
}
/** Merge `updates` into the backup file for `accountKey` (or create one
 *  if it doesn't exist). Caller MUST provide the accountKey — we don't
 *  guess. Schema/timestamp fields are managed automatically.
 *
 *  Best-effort: errors are logged, never thrown. A failed backup write
 *  must never block the desktop's normal operation. */
function writeBackupPartial(accountKey, updates) {
    try {
        if (!ACC_RX.test(accountKey)) {
            console.error('[identity-backup] writeBackupPartial: invalid accountKey, skipping write');
            return;
        }
        const folder = getBackupFolder();
        if (!fs_1.default.existsSync(folder)) {
            fs_1.default.mkdirSync(folder, { recursive: true });
        }
        const now = new Date().toISOString();
        const filePath = backupFilePathFor(accountKey);
        let existing = null;
        try {
            if (fs_1.default.existsSync(filePath)) {
                const raw = fs_1.default.readFileSync(filePath, 'utf8');
                existing = JSON.parse(raw);
            }
        }
        catch {
            existing = null; // corrupted file → overwrite with fresh data
        }
        const merged = {
            schemaVersion: SCHEMA_VERSION,
            accountKey,
            nodeId: existing?.nodeId ?? '',
            nodeName: existing?.nodeName ?? 'Local Node',
            blocksValidated: existing?.blocksValidated ?? 0,
            transactionsSeen: existing?.transactionsSeen ?? 0,
            totalUptimeSeconds: existing?.totalUptimeSeconds ?? 0,
            longestStreakSeconds: existing?.longestStreakSeconds ?? 0,
            peakTps: existing?.peakTps ?? 0,
            firstSyncCompleted: existing?.firstSyncCompleted ?? false,
            sharesAccepted: existing?.sharesAccepted ?? 0,
            blocksFound: existing?.blocksFound ?? 0,
            totalRewardSompi: existing?.totalRewardSompi ?? 0,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            ...updates,
        };
        fs_1.default.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf8');
    }
    catch (err) {
        console.error('[identity-backup] writeBackupPartial failed:', err.message);
    }
}
/** Delete the keyed backup file for a specific accountKey. Used ONLY
 *  by the explicit "Reset identity" Settings button — and even then,
 *  only the CURRENT key's file is touched. Other keyed files (e.g.
 *  from a previous identity the user reset away from) are preserved
 *  as on-disk recovery records. The user has to delete those manually
 *  to truly burn them.
 *
 *  Pass `accountKey` to delete only that specific file, OR omit to
 *  delete the legacy `identity.json` (used during cleanup migration).
 *  No-op if the file doesn't exist. */
function deleteBackup(accountKey) {
    try {
        const filePath = accountKey
            ? backupFilePathFor(accountKey)
            : path_1.default.join(getBackupFolder(), LEGACY_FILENAME);
        if (fs_1.default.existsSync(filePath)) {
            fs_1.default.unlinkSync(filePath);
            console.log(`[identity-backup] file deleted: ${path_1.default.basename(filePath)} (explicit user reset)`);
        }
    }
    catch (err) {
        console.error('[identity-backup] delete failed:', err.message);
    }
}
//# sourceMappingURL=identity-backup.js.map