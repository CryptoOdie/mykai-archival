"use strict";
/**
 * Safe HTTP response body reader.
 *
 * Every HTTP call site used to do `let body = ''; res.on('data', c => body += c)`
 * which is unbounded — a misbehaving remote server sending multi-MB or never-
 * closing responses would accumulate forever in main-process memory. This
 * helper caps the body at a sensible ceiling and destroys the socket if the
 * ceiling is exceeded.
 *
 * Default cap is 10 MB, plenty for JSON APIs we talk to (Insights heartbeat
 * responses, KasMap, GitHub releases manifests). Override per call if you
 * legitimately expect bigger (e.g. downloading an installer).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.readBody = readBody;
function readBody(res, maxBytes = 10_000_000) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        res.on('data', (chunk) => {
            const chunkLen = typeof chunk === 'string'
                ? Buffer.byteLength(chunk)
                : chunk.length;
            size += chunkLen;
            if (size > maxBytes) {
                res.destroy();
                reject(new Error(`Response body exceeded ${maxBytes} bytes (got ${size})`));
                return;
            }
            body += chunk.toString();
        });
        res.on('end', () => resolve(body));
        res.on('error', reject);
    });
}
//# sourceMappingURL=http-body.js.map