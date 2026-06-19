import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dbPath = process.env.DATABASE_URL || './data/signals.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// Schema
db.exec(`
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_created ON signals(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_idem_key ON signals(idempotency_key) WHERE idempotency_key IS NOT NULL;
`);

// ---------------------------------------------------------------------------
// Failure simulation (provided by challenge)
// ---------------------------------------------------------------------------
function maybeFail() {
  const rate = Number(process.env.DB_FAIL_RATE || 0);
  if (rate > 0 && Math.random() < rate) {
    const err = new Error('simulated_db_failure');
    err.code = 'SQLITE_BUSY';
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Retry with exponential back-off + jitter
// ---------------------------------------------------------------------------
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 50;
const MAX_DELAY_MS = 500;

/**
 * Classify whether an error is transient and worth retrying.
 */
function isTransient(err) {
  if (!err) return false;
  if (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED') return true;
  if (err.message && err.message.includes('simulated_db_failure')) return true;
  return false;
}

/**
 * Synchronous sleep using a spin-wait loop.
 * better-sqlite3 is fully synchronous so we cannot use async timers.
 */
function syncSleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // spin
  }
}

/**
 * Execute `fn` with up to `maxRetries` attempts on transient failures.
 * Uses exponential back-off with full jitter to avoid thundering herd.
 */
function withRetry(fn, maxRetries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (attempt === maxRetries || !isTransient(err)) throw err;
      const baseDelay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
      const jitter = Math.floor(Math.random() * baseDelay);
      syncSleep(baseDelay + jitter);
    }
  }
}

// ---------------------------------------------------------------------------
// Prepared statements (created lazily, cached by better-sqlite3)
// ---------------------------------------------------------------------------
const stmtInsert = db.prepare(
  'INSERT INTO signals (user_id, type, payload, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?)'
);

const stmtInsertOrIgnore = db.prepare(
  'INSERT OR IGNORE INTO signals (user_id, type, payload, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?)'
);

const stmtSelectByIdem = db.prepare(
  `SELECT id, user_id AS userId, type, payload,
          idempotency_key AS idempotencyKey, created_at AS createdAt
   FROM signals WHERE idempotency_key = ?`
);

const stmtList = db.prepare(
  `SELECT id, user_id AS userId, type, payload,
          idempotency_key AS idempotencyKey, created_at AS createdAt
   FROM signals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
);

const stmtCountRecent = db.prepare(
  'SELECT COUNT(*) AS cnt FROM signals WHERE user_id = ? AND created_at > ?'
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a signal (simple — no idempotency handling).
 */
export function insertSignal(userId, type, payload, idemKey, nowMs) {
  return withRetry(() => {
    maybeFail();
    return stmtInsert.run(userId, type, String(payload), idemKey || null, nowMs);
  });
}

/**
 * Atomic idempotent insert.
 * Uses INSERT OR IGNORE + SELECT inside a transaction to avoid TOCTOU races.
 * Returns { row, created } where `created` is true if a new row was inserted.
 */
const txnInsertAtomic = db.transaction((userId, type, payload, idemKey, nowMs) => {
  maybeFail();
  const info = stmtInsertOrIgnore.run(userId, type, String(payload), idemKey, nowMs);
  const row = stmtSelectByIdem.get(idemKey);
  return { row, created: info.changes > 0 };
});

export function insertSignalAtomic(userId, type, payload, idemKey, nowMs) {
  return withRetry(() => txnInsertAtomic(userId, type, payload, idemKey, nowMs));
}

/**
 * Look up a signal by its idempotency key.
 */
export function getByIdemKey(idemKey) {
  return withRetry(() => {
    maybeFail();
    return stmtSelectByIdem.get(idemKey);
  });
}

/**
 * List signals for a user, newest first.
 */
export function listSignals(userId, limit) {
  return withRetry(() => {
    maybeFail();
    return stmtList.all(userId, limit);
  });
}

/**
 * Count signals for a user since `sinceMs`.
 * Useful for DB-backed rate limiting in multi-instance scenarios.
 */
export function countRecentSignals(userId, sinceMs) {
  return withRetry(() => {
    maybeFail();
    return stmtCountRecent.get(userId, sinceMs).cnt;
  });
}

/**
 * Close the database (for graceful shutdown).
 */
export function closeDb() {
  db.close();
}
