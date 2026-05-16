"use strict";
/**
 * MyKAI Shard Storage Module (v0.5)
 *
 * The heart of the new architecture. Subscribes to the local pruned kaspad's
 * chain events, captures each accepted block BEFORE kaspad prunes it, stores
 * the body in a local SQLite database (sql.js — pure JS/WASM, no native build
 * needed), and serves it back to the local MCP server / agent-bridge.
 *
 * Architectural rationale (locked rule #21 in project memory):
 *   Every MyKAI install = pruned kaspad + this module. The user picks how
 *   much disk to commit; the module fills that budget with recent-most
 *   blocks from the chain tip, rolling over as the budget fills. Future v0.6
 *   adds P2P serving of these blocks to other MyKAI peers.
 *
 * Why sql.js instead of better-sqlite3:
 *   sql.js is pure JavaScript / WebAssembly. No native build, no MSVC, no
 *   node-gyp. ~3× slower than native SQLite but our write rate (10 blocks/sec
 *   at Crescendo) is well within sql.js's capacity. Migration to native
 *   SQLite is deferred to v0.6 along with the libp2p sidecar.
 *
 * Storage layout:
 *   <userData>/shard-storage.db   sql.js binary database file
 *     - blocks(hash BLOB PK, daa_score INTEGER, body BLOB, size_bytes INTEGER,
 *              captured_at INTEGER, is_accepted INTEGER)
 *     - meta(key TEXT PK, value TEXT)
 *
 * Lifecycle:
 *   init() → loads DB from disk if it exists, else creates fresh
 *   captureBlock(hash, daaScore, bodyBytes) → stores one block
 *   has(hash) → fast lookup
 *   get(hash) → returns body bytes or null
 *   getStats() → blockCount, totalBytes, oldest/newest daa, capture rate
 *   pruneToFit(budgetBytes) → drops oldest blocks until under budget
 *   close() → persists DB to disk
 *
 * The capture loop and pinset manager live in the consumer (main.js wires
 * rpc-monitor events to captureBlock; a periodic interval calls pruneToFit).
 * This module is intentionally just storage — the policy lives upstairs.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShardStorage = void 0;

const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const events_1 = require("events");
const initSqlJs = require('sql.js');

// Persist debounce: we save the DB to disk after this many ms of inactivity.
// Trade-off: smaller = less data loss on crash but more disk churn.
// 10s feels right — at 10 BPS we'd lose at most ~100 blocks on crash,
// which the next chain catch-up will re-capture from kaspad anyway.
const PERSIST_DEBOUNCE_MS = 10_000;

// Max DB-export size before we worry. Pure cap, not a budget. Set high
// (5 TB) — the pinset manager enforces the user's actual disk budget.
const HARD_DB_CAP_BYTES = 5 * 1024 * 1024 * 1024 * 1024;

class ShardStorage extends events_1.EventEmitter {
    /** @type {string} */
    dbPath;
    /** @type {any} sql.js Database instance */
    db = null;
    /** @type {any} sql.js SQL module */
    SQL = null;
    /** @type {NodeJS.Timeout | null} */
    persistTimer = null;
    /** @type {boolean} */
    _dirty = false;
    /** @type {boolean} */
    _initialized = false;
    /** Capture-rate tracking: ring of recent capture timestamps. */
    _recentCaptures = [];
    /** Cached stats — recomputed on capture/prune, served to UI without SQL hit. */
    _stats = {
        blockCount: 0,
        totalBytes: 0,
        oldestDaa: null,
        newestDaa: null,
        capturedLast60s: 0,
    };

    constructor(userDataPath) {
        super();
        this.dbPath = path_1.default.join(userDataPath, 'shard-storage.db');
    }

    /**
     * Initialize the database. Loads from disk if it exists, else creates
     * a fresh schema. Idempotent — safe to call multiple times.
     */
    async init() {
        if (this._initialized) return;
        // Locate the sql-wasm.wasm file (sql.js needs to find it at runtime).
        // In dev: node_modules/sql.js/dist/sql-wasm.wasm
        // In packaged build: resourcesPath/sql.js/sql-wasm.wasm (TBD when packaging)
        this.SQL = await initSqlJs({
            locateFile: (file) => {
                try {
                    return require.resolve(`sql.js/dist/${file}`);
                } catch {
                    return file;
                }
            },
        });
        // Load existing DB if present, else create fresh.
        if (fs_1.default.existsSync(this.dbPath)) {
            const buf = fs_1.default.readFileSync(this.dbPath);
            this.db = new this.SQL.Database(new Uint8Array(buf));
            this.emit('log', `Loaded shard DB from ${this.dbPath} (${buf.length} bytes)`);
        } else {
            this.db = new this.SQL.Database();
            this._createSchema();
            this.emit('log', `Created fresh shard DB at ${this.dbPath}`);
        }
        // Ensure schema is current (handles future schema migrations).
        this._ensureSchema();
        this._refreshStats();
        this._initialized = true;
        this.emit('ready', { ...this._stats });
    }

    _createSchema() {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS blocks (
                hash         BLOB PRIMARY KEY,
                daa_score    INTEGER NOT NULL,
                blue_score   INTEGER,
                body         BLOB NOT NULL,
                size_bytes   INTEGER NOT NULL,
                captured_at  INTEGER NOT NULL,
                is_accepted  INTEGER NOT NULL DEFAULT 1
            );
            CREATE INDEX IF NOT EXISTS idx_blocks_daa ON blocks(daa_score);
            CREATE INDEX IF NOT EXISTS idx_blocks_blue ON blocks(blue_score);
            CREATE INDEX IF NOT EXISTS idx_blocks_captured ON blocks(captured_at);

            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);
        this.db.run(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '2')`);
        this.db.run(`INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', ?)`, [String(Date.now())]);
        this._markDirty();
    }

    _ensureSchema() {
        // Always-safe re-issue: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
        // No-op if schema already current.
        this._createSchema();
        // v0.5.1: blue_score column added for /shard/blocks endpoint.
        // ALTER TABLE ADD COLUMN errors if the column exists, so probe first.
        try {
            const r = this.db.exec(`PRAGMA table_info(blocks)`);
            const cols = r.length > 0 ? r[0].values.map((row) => row[1]) : [];
            if (!cols.includes('blue_score')) {
                this.db.run(`ALTER TABLE blocks ADD COLUMN blue_score INTEGER`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_blocks_blue ON blocks(blue_score)`);
                this.db.run(`UPDATE meta SET value = '2' WHERE key = 'schema_version'`);
                this._markDirty();
                this.emit('log', 'Migrated shard DB schema to v2 (added blue_score column)');
            }
        } catch (err) {
            this.emit('error', { stage: 'migrate', error: err?.message || String(err) });
        }
    }

    /**
     * Bind this storage to a specific Kaspa network (mainnet / TN12 /
     * devnet / simnet). Stored as a meta value on first call; subsequent
     * calls verify the network matches. Mismatch indicates either user
     * config error or a malicious cross-network attack — we refuse to
     * write blocks under the wrong network tag.
     *
     * Returns: { ok: true } on success, { ok: false, error } if the
     * stored network conflicts with the requested one.
     *
     * Defense against the BCH/BSV-class attack: a peer serving honest
     * blocks from a fork or a different network would pass hash
     * verification against their own kaspad, but mixing those blocks
     * into our store would silently corrupt the archive. The network
     * tag is the cross-check that prevents this.
     */
    bindNetwork(networkName) {
        if (!this._initialized) throw new Error('ShardStorage.init() not called');
        if (!networkName || typeof networkName !== 'string') {
            return { ok: false, error: 'invalid network name' };
        }
        const stmt = this.db.prepare(`SELECT value FROM meta WHERE key = 'network_id'`);
        stmt.bind([]);
        let existing = null;
        if (stmt.step()) existing = stmt.getAsObject().value;
        stmt.free();
        if (existing == null) {
            this.db.run(`INSERT INTO meta (key, value) VALUES ('network_id', ?)`, [networkName]);
            this._markDirty();
            this.emit('log', `Bound shard storage to network: ${networkName}`);
            return { ok: true, bound: networkName };
        }
        if (existing !== networkName) {
            this.emit('error', {
                stage: 'network-bind',
                error: `network mismatch: stored=${existing}, requested=${networkName} — refusing writes`,
            });
            return { ok: false, error: `network mismatch: stored=${existing} requested=${networkName}` };
        }
        return { ok: true, bound: existing };
    }

    /** Returns the stored network_id or null if not yet bound. */
    getBoundNetwork() {
        if (!this._initialized) return null;
        try {
            const stmt = this.db.prepare(`SELECT value FROM meta WHERE key = 'network_id'`);
            stmt.bind([]);
            const has = stmt.step();
            const row = has ? stmt.getAsObject() : null;
            stmt.free();
            return row?.value || null;
        } catch {
            return null;
        }
    }

    /**
     * Capture one block into the shard. Idempotent — re-capturing the same
     * hash is a no-op. Returns true if stored, false if already present.
     *
     * @param {Buffer|Uint8Array} hashBytes  32-byte block hash
     * @param {number}             daaScore   block's DAA score
     * @param {Buffer|Uint8Array} bodyBytes  serialized block body
     * @param {boolean}            isAccepted whether the block is in the selected chain
     * @param {number|null}        blueScore  block's blue score (null if unknown — old callers)
     * @returns {boolean}
     */
    captureBlock(hashBytes, daaScore, bodyBytes, isAccepted = true, blueScore = null) {
        if (!this._initialized) throw new Error('ShardStorage.init() not called');
        if (!hashBytes || hashBytes.length !== 32) {
            throw new Error(`ShardStorage.captureBlock: invalid hash length ${hashBytes?.length}`);
        }
        // Idempotency check via SELECT — sql.js doesn't have a clean "did INSERT happen" return.
        const exists = this.has(hashBytes);
        if (exists) return false;
        const sizeBytes = bodyBytes.length;
        const capturedAt = Date.now();
        this.db.run(
            `INSERT INTO blocks (hash, daa_score, blue_score, body, size_bytes, captured_at, is_accepted) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [hashBytes, daaScore, blueScore, bodyBytes, sizeBytes, capturedAt, isAccepted ? 1 : 0]
        );
        // Update cached stats.
        this._stats.blockCount += 1;
        this._stats.totalBytes += sizeBytes;
        if (this._stats.oldestDaa === null || daaScore < this._stats.oldestDaa) {
            this._stats.oldestDaa = daaScore;
        }
        if (this._stats.newestDaa === null || daaScore > this._stats.newestDaa) {
            this._stats.newestDaa = daaScore;
        }
        this._recentCaptures.push(capturedAt);
        // Trim ring older than 60s.
        const cutoff = capturedAt - 60_000;
        while (this._recentCaptures.length > 0 && this._recentCaptures[0] < cutoff) {
            this._recentCaptures.shift();
        }
        this._stats.capturedLast60s = this._recentCaptures.length;
        this._markDirty();
        this.emit('captured', { hash: hashBytes, daaScore, sizeBytes });
        return true;
    }

    /**
     * Quick existence check.
     * @param {Buffer|Uint8Array} hashBytes
     * @returns {boolean}
     */
    has(hashBytes) {
        if (!this._initialized) return false;
        const stmt = this.db.prepare(`SELECT 1 FROM blocks WHERE hash = ?`);
        stmt.bind([hashBytes]);
        const has = stmt.step();
        stmt.free();
        return has;
    }

    /**
     * Fetch a stored block.
     * @param {Buffer|Uint8Array} hashBytes
     * @returns {{daaScore: number, body: Uint8Array, sizeBytes: number, capturedAt: number} | null}
     */
    get(hashBytes) {
        if (!this._initialized) return null;
        const stmt = this.db.prepare(`SELECT daa_score, body, size_bytes, captured_at FROM blocks WHERE hash = ?`);
        stmt.bind([hashBytes]);
        if (!stmt.step()) {
            stmt.free();
            return null;
        }
        const row = stmt.getAsObject();
        stmt.free();
        return {
            daaScore: row.daa_score,
            body: row.body,
            sizeBytes: row.size_bytes,
            capturedAt: row.captured_at,
        };
    }

    /**
     * Return blocks in DAA score range, ascending. Used for indexer
     * backfills and historical scans.
     * @param {number} lowDaa  inclusive
     * @param {number} highDaa exclusive
     * @param {number} limit
     * @returns {Array<{hash: Uint8Array, daaScore: number, body: Uint8Array}>}
     */
    getByDaaRange(lowDaa, highDaa, limit = 1000) {
        if (!this._initialized) return [];
        const stmt = this.db.prepare(
            `SELECT hash, daa_score, body FROM blocks
             WHERE daa_score >= ? AND daa_score < ?
             ORDER BY daa_score ASC LIMIT ?`
        );
        stmt.bind([lowDaa, highDaa, limit]);
        const out = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            out.push({ hash: row.hash, daaScore: row.daa_score, body: row.body });
        }
        stmt.free();
        return out;
    }

    /**
     * Drop the N oldest blocks (by daa_score ASC). Used by pinset manager
     * to enforce disk budget. Returns the number of blocks deleted.
     * @param {number} budgetBytes  target total size after pruning
     * @returns {number}
     */
    pruneToFit(budgetBytes) {
        if (!this._initialized) return 0;
        if (this._stats.totalBytes <= budgetBytes) return 0;
        // Hysteresis: prune to 95% of budget to avoid rapid re-trigger.
        const target = Math.floor(budgetBytes * 0.95);
        let deletedCount = 0;
        let freedBytes = 0;
        // Iterate oldest first; delete in batches of 100 to amortize the
        // sql.js overhead.
        const BATCH = 100;
        while (this._stats.totalBytes - freedBytes > target) {
            const stmt = this.db.prepare(
                `SELECT hash, size_bytes FROM blocks ORDER BY daa_score ASC LIMIT ?`
            );
            stmt.bind([BATCH]);
            const victims = [];
            while (stmt.step()) {
                const row = stmt.getAsObject();
                victims.push({ hash: row.hash, sizeBytes: row.size_bytes });
            }
            stmt.free();
            if (victims.length === 0) break; // empty DB
            this.db.run('BEGIN');
            for (const v of victims) {
                this.db.run(`DELETE FROM blocks WHERE hash = ?`, [v.hash]);
                freedBytes += v.sizeBytes;
                deletedCount += 1;
                if (this._stats.totalBytes - freedBytes <= target) break;
            }
            this.db.run('COMMIT');
        }
        if (deletedCount > 0) {
            this._refreshStats();
            this._markDirty();
            this.emit('pruned', { deletedCount, freedBytes, newTotalBytes: this._stats.totalBytes });
        }
        return deletedCount;
    }

    /**
     * Recompute cached stats from the DB. Called on init and after prune.
     */
    _refreshStats() {
        const r = this.db.exec(`
            SELECT COUNT(*) AS cnt,
                   COALESCE(SUM(size_bytes), 0) AS total,
                   MIN(daa_score) AS min_daa,
                   MAX(daa_score) AS max_daa
            FROM blocks
        `);
        if (r.length === 0 || r[0].values.length === 0) {
            this._stats.blockCount = 0;
            this._stats.totalBytes = 0;
            this._stats.oldestDaa = null;
            this._stats.newestDaa = null;
        } else {
            const [cnt, total, minDaa, maxDaa] = r[0].values[0];
            this._stats.blockCount = cnt;
            this._stats.totalBytes = total;
            this._stats.oldestDaa = minDaa;
            this._stats.newestDaa = maxDaa;
        }
    }

    /**
     * Return current cached stats (for UI / IPC).
     */
    getStats() {
        return { ...this._stats };
    }

    /**
     * The lowest DAA score this pool currently stores. Returned in
     * /shard/dag-info as `pool_floor_daa` — explorer indexers use it to
     * decide whether to bootstrap from this pool or fall back to an
     * archival kaspad for older history.
     * @returns {number | null}
     */
    getPoolFloorDaa() {
        return this._stats.oldestDaa;
    }

    /**
     * Look up the (blue_score, daa_score) of a known hash. Used by
     * /shard/blocks to anchor the forward walk at a low_hash request.
     * @param {Buffer|Uint8Array} hashBytes
     * @returns {{blueScore: number|null, daaScore: number} | null}
     */
    getScoresByHash(hashBytes) {
        if (!this._initialized) return null;
        const stmt = this.db.prepare(`SELECT blue_score, daa_score FROM blocks WHERE hash = ?`);
        stmt.bind([hashBytes]);
        if (!stmt.step()) {
            stmt.free();
            return null;
        }
        const row = stmt.getAsObject();
        stmt.free();
        return { blueScore: row.blue_score, daaScore: row.daa_score };
    }

    /**
     * Return up to `limit` blocks with blue_score strictly greater than
     * `lowBlueScore`, in ascending blue_score order. The workhorse query
     * for /shard/blocks. Skips rows where blue_score IS NULL (legacy
     * pre-migration captures).
     *
     * @param {number} lowBlueScore exclusive lower bound
     * @param {number} limit        max blocks to return (caller should cap at 500)
     * @returns {Array<{hash: Uint8Array, blueScore: number, daaScore: number, body: Uint8Array}>}
     */
    getBlocksAfterBlueScore(lowBlueScore, limit = 100) {
        if (!this._initialized) return [];
        const stmt = this.db.prepare(
            `SELECT hash, blue_score, daa_score, body FROM blocks
             WHERE blue_score IS NOT NULL AND blue_score > ?
             ORDER BY blue_score ASC LIMIT ?`
        );
        stmt.bind([lowBlueScore, limit]);
        const out = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            out.push({
                hash: row.hash,
                blueScore: row.blue_score,
                daaScore: row.daa_score,
                body: row.body,
            });
        }
        stmt.free();
        return out;
    }

    /**
     * Schedule a debounced persist to disk.
     */
    _markDirty() {
        this._dirty = true;
        if (this.persistTimer) clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => this._persistNow(), PERSIST_DEBOUNCE_MS);
    }

    /**
     * Synchronously write the DB to disk. Called on shutdown and on dirty
     * timer fire. We export the entire DB each time because sql.js doesn't
     * have an on-disk format that's incrementally written — the trade-off
     * for being pure JS. At ~1-2 GB pinsets this takes &lt;1 second.
     * Larger pinsets (1 TB+) will need native SQLite (v0.6).
     */
    _persistNow() {
        if (!this._initialized || !this._dirty) return;
        try {
            const bytes = this.db.export();
            const tmpPath = this.dbPath + '.tmp';
            fs_1.default.writeFileSync(tmpPath, Buffer.from(bytes));
            fs_1.default.renameSync(tmpPath, this.dbPath); // atomic on POSIX; nearly so on Windows
            this._dirty = false;
            this.emit('persisted', { bytes: bytes.length });
        } catch (err) {
            this.emit('error', { stage: 'persist', error: err?.message || String(err) });
        }
    }

    /**
     * Persist + close. Call on app shutdown.
     */
    close() {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = null;
        }
        if (this._dirty) this._persistNow();
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        this._initialized = false;
    }
}
exports.ShardStorage = ShardStorage;
//# sourceMappingURL=shard-storage.js.map
