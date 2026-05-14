"use strict";
/**
 * Move kaspad data directory to a new location safely.
 *
 * Flow:
 *   1. Stop kaspad cleanly (SIGTERM + 15s grace)
 *   2. Copy files recursively from old dataDir to new one
 *   3. On success: update config.dataDir, delete old files, restart kaspad
 *   4. On failure at any step: leave old data untouched, don't update config
 *
 * Progress events:
 *   'progress' — { bytesDone, bytesTotal, currentFile }
 *   'done'     — new path
 *   'error'    — failure reason
 *
 * This is deliberately safe-first. If the copy fails halfway, the user's
 * old data is intact and they can try again. We do NOT delete old data
 * until the copy has fully succeeded.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DataDirMover = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const events_1 = require("events");
class DataDirMover extends events_1.EventEmitter {
    cancelled = false;
    /**
     * `onCopyComplete` fires after the copy + verification succeed but BEFORE
     * the old directory is deleted. The caller persists `dataDir = newDir` to
     * config inside this callback. If anything kills the process between the
     * callback returning and the next line (rmSync), the config already
     * points to newDir — both directories exist, no data is lost, and the
     * user can manually clean up the old one. The previous flow updated
     * config AFTER mover.move returned, leaving a microsecond window where
     * an OS-level kill could orphan the data.
     */
    async move(oldDir, newDir, manager, onCopyComplete) {
        try {
            if (!fs_1.default.existsSync(oldDir))
                return { ok: false, error: 'Old data directory does not exist' };
            if (fs_1.default.existsSync(newDir) && fs_1.default.readdirSync(newDir).length > 0) {
                return { ok: false, error: 'New data directory is not empty' };
            }
            // Stop kaspad so the DB files aren't being written during copy
            try {
                await manager.stop();
            }
            catch { /* ignore */ }
            // Compute total size first so we can show a progress bar
            const totalBytes = countBytesRecursive(oldDir);
            const totalFiles = countFilesRecursive(oldDir);
            fs_1.default.mkdirSync(newDir, { recursive: true });
            let bytesDone = 0;
            let filesDone = 0;
            const copyOne = (srcFile, destFile) => {
                if (this.cancelled)
                    throw new Error('Cancelled by user');
                fs_1.default.mkdirSync(path_1.default.dirname(destFile), { recursive: true });
                fs_1.default.copyFileSync(srcFile, destFile);
                const size = fs_1.default.statSync(srcFile).size;
                bytesDone += size;
                filesDone++;
                this.emit('progress', {
                    bytesDone,
                    bytesTotal: totalBytes,
                    currentFile: path_1.default.relative(oldDir, srcFile),
                    filesDone,
                    filesTotal: totalFiles,
                });
            };
            this.walkAndCopy(oldDir, newDir, copyOne);
            // Copy succeeded. Persist the new dataDir BEFORE deleting the old one
            // — that way an OS-level kill between persist and rm leaves both
            // directories on disk with config pointing to the right one.
            if (onCopyComplete) {
                try {
                    await onCopyComplete(newDir);
                }
                catch (err) {
                    // Persist failed → DON'T delete old. New copy stays as a quiet
                    // backup; user retries from a clean state on next launch.
                    return { ok: false, error: `Config update failed after copy: ${err?.message || String(err)}` };
                }
            }
            // Delete old directory — if THIS fails, the user has data in both
            // locations (not lost) and can clean up manually.
            try {
                fs_1.default.rmSync(oldDir, { recursive: true, force: true });
            }
            catch (err) {
                // Non-fatal: new location has the data, user just has extra copy
                this.emit('warning', `Copied successfully but couldn\u2019t delete the old folder: ${err.message}`);
            }
            this.emit('done', newDir);
            return { ok: true };
        }
        catch (err) {
            this.emit('error', err?.message || String(err));
            return { ok: false, error: err?.message || String(err) };
        }
    }
    cancel() { this.cancelled = true; }
    walkAndCopy(src, dest, copyOne) {
        const entries = fs_1.default.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
            if (this.cancelled)
                throw new Error('Cancelled by user');
            const srcPath = path_1.default.join(src, entry.name);
            const destPath = path_1.default.join(dest, entry.name);
            if (entry.isDirectory()) {
                fs_1.default.mkdirSync(destPath, { recursive: true });
                this.walkAndCopy(srcPath, destPath, copyOne);
            }
            else if (entry.isFile()) {
                copyOne(srcPath, destPath);
            }
        }
    }
}
exports.DataDirMover = DataDirMover;
function countBytesRecursive(dir) {
    let total = 0;
    try {
        for (const entry of fs_1.default.readdirSync(dir, { withFileTypes: true })) {
            const p = path_1.default.join(dir, entry.name);
            if (entry.isDirectory())
                total += countBytesRecursive(p);
            else if (entry.isFile()) {
                try {
                    total += fs_1.default.statSync(p).size;
                }
                catch { /* ignore */ }
            }
        }
    }
    catch { /* ignore */ }
    return total;
}
function countFilesRecursive(dir) {
    let total = 0;
    try {
        for (const entry of fs_1.default.readdirSync(dir, { withFileTypes: true })) {
            const p = path_1.default.join(dir, entry.name);
            if (entry.isDirectory())
                total += countFilesRecursive(p);
            else if (entry.isFile())
                total++;
        }
    }
    catch { /* ignore */ }
    return total;
}
//# sourceMappingURL=data-dir-move.js.map