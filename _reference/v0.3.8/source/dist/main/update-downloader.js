"use strict";
/**
 * Update Downloader — download files with progress + SHA-256 verification.
 * Used by the updater for kaspad hot-swap downloads.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateDownloader = void 0;
const https_1 = __importDefault(require("https"));
const http_1 = __importDefault(require("http"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const events_1 = require("events");
class UpdateDownloader extends events_1.EventEmitter {
    aborted = false;
    /**
     * Download a file to the staging directory with progress events.
     * Returns the local file path on success.
     */
    async download(url, destDir, filename) {
        this.aborted = false;
        const destPath = path_1.default.join(destDir, filename);
        // Ensure staging directory exists
        if (!fs_1.default.existsSync(destDir))
            fs_1.default.mkdirSync(destDir, { recursive: true });
        // Remove any previous partial download
        if (fs_1.default.existsSync(destPath))
            fs_1.default.unlinkSync(destPath);
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const mod = parsed.protocol === 'https:' ? https_1.default : http_1.default;
            const makeRequest = (requestUrl, redirects = 0) => {
                if (redirects > 5) {
                    reject(new Error('Too many redirects'));
                    return;
                }
                const reqParsed = new URL(requestUrl);
                const reqMod = reqParsed.protocol === 'https:' ? https_1.default : http_1.default;
                const req = reqMod.get(requestUrl, {
                    headers: { 'User-Agent': 'MyKAI-Node-Updater' },
                    timeout: 30000,
                }, (res) => {
                    // Follow redirects (GitHub Releases redirects to S3)
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        makeRequest(res.headers.location, redirects + 1);
                        return;
                    }
                    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
                        return;
                    }
                    const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
                    let bytesReceived = 0;
                    const file = fs_1.default.createWriteStream(destPath);
                    res.on('data', (chunk) => {
                        if (this.aborted) {
                            res.destroy();
                            file.close();
                            try {
                                fs_1.default.unlinkSync(destPath);
                            }
                            catch { }
                            reject(new Error('Download aborted'));
                            return;
                        }
                        bytesReceived += chunk.length;
                        this.emit('progress', {
                            bytesReceived,
                            totalBytes,
                            percent: totalBytes > 0 ? Math.round((bytesReceived / totalBytes) * 100) : 0,
                        });
                    });
                    res.pipe(file);
                    file.on('finish', () => {
                        file.close(() => resolve(destPath));
                    });
                    file.on('error', (err) => {
                        try {
                            fs_1.default.unlinkSync(destPath);
                        }
                        catch { }
                        reject(err);
                    });
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
            };
            makeRequest(url);
        });
    }
    /**
     * Verify SHA-256 checksum of a downloaded file.
     */
    async verifyChecksum(filePath, expectedSha256) {
        return new Promise((resolve, reject) => {
            const hash = crypto_1.default.createHash('sha256');
            const stream = fs_1.default.createReadStream(filePath);
            stream.on('data', (data) => hash.update(data));
            stream.on('end', () => resolve(hash.digest('hex').toLowerCase() === expectedSha256.toLowerCase()));
            stream.on('error', reject);
        });
    }
    /**
     * Abort an in-progress download.
     */
    abort() {
        this.aborted = true;
    }
    /**
     * Clean up the staging directory.
     */
    cleanStaging(stagingDir) {
        try {
            if (fs_1.default.existsSync(stagingDir)) {
                for (const file of fs_1.default.readdirSync(stagingDir)) {
                    try {
                        fs_1.default.unlinkSync(path_1.default.join(stagingDir, file));
                    }
                    catch { }
                }
            }
        }
        catch { }
    }
}
exports.UpdateDownloader = UpdateDownloader;
//# sourceMappingURL=update-downloader.js.map