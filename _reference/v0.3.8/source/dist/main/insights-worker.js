"use strict";
/**
 * Insights payload serializer worker.
 *
 * Runs JSON.stringify + gzip off the main thread. The Insights envelope
 * routinely hits 1–2 MB raw, and stringifying + gzipping that synchronously
 * on the event loop blocks for ~200–500 ms. During that window
 * setInterval(..., 1000) ticks pile up and drain in a burst when the event
 * loop finally resumes — the observable symptom of the "142 new blocks in
 * one second" bug on a node that is actually keeping pace.
 *
 * Protocol:
 *   main → worker : { id: number, payload: any }
 *   worker → main : { id, ok: true,  rawBytes, gz: Buffer }   // transferred
 *                 | { id, ok: false, error: string }
 *
 * The gzipped Buffer is returned via the transfer list so the ArrayBuffer
 * backing store moves to the main thread without a memcpy. Main-thread
 * fallback: if the worker errors or exits, MonitoringContributor falls back
 * to inline sync stringify+gzip for that flush, logs _lastSendError, and
 * a fresh worker is spawned for the next flush.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const worker_threads_1 = require("worker_threads");
const zlib_1 = __importDefault(require("zlib"));
if (!worker_threads_1.parentPort) {
    throw new Error('insights-worker must be run as a worker_threads Worker');
}
worker_threads_1.parentPort.on('message', (msg) => {
    const { id, payload } = msg;
    try {
        const json = JSON.stringify(payload);
        const rawBytes = Buffer.byteLength(json);
        // Sync gzip inside the worker is fine — the main thread is free.
        const gz = zlib_1.default.gzipSync(json);
        // Transfer the underlying ArrayBuffer so the main thread gets the bytes
        // without a copy. The Buffer view is reconstructed on the receiving side.
        worker_threads_1.parentPort.postMessage({ id, ok: true, rawBytes, gz }, [gz.buffer]);
    }
    catch (err) {
        worker_threads_1.parentPort.postMessage({
            id,
            ok: false,
            error: err?.message || String(err),
        });
    }
});
//# sourceMappingURL=insights-worker.js.map