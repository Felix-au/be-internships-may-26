/**
 * Sliding-window-log rate limiter.
 *
 * Each userId maps to a sorted array of request timestamps.
 * On every call we:
 *   1. Evict timestamps older than the window.
 *   2. Check if the count is below the limit.
 *   3. If allowed, record the new timestamp.
 *
 * Concurrency safety (single-instance):
 *   JavaScript is single-threaded — checkAndConsume runs to completion
 *   before the next event-loop tick, so no in-flight race is possible
 *   within one Node.js process.
 *
 * Multi-instance note:
 *   For horizontal scaling this must move to a shared store (Redis ZSET
 *   with a Lua script). See SCALE.md for the full design.
 */

const RATE = Number(process.env.RATE_LIMIT_PER_MIN || 5);
const WINDOW_MS = 60_000;

/** @type {Map<string, number[]>} userId → sorted timestamps */
const buckets = new Map();

/**
 * Check and (if allowed) consume one request from the user's quota.
 *
 * @param {string} userId
 * @param {number} nowMs  - injectable clock for testing
 * @returns {{ ok: boolean, remaining: number, resetMs: number }}
 */
export function checkAndConsume(userId, nowMs = Date.now()) {
  const windowStart = nowMs - WINDOW_MS;
  let timestamps = buckets.get(userId);

  if (!timestamps) {
    timestamps = [];
    buckets.set(userId, timestamps);
  }

  // Evict expired entries (older than window start)
  while (timestamps.length > 0 && timestamps[0] <= windowStart) {
    timestamps.shift();
  }

  if (timestamps.length >= RATE) {
    // Rate exceeded — earliest timestamp determines when the window resets
    const resetMs = timestamps[0] + WINDOW_MS;
    return { ok: false, remaining: 0, resetMs };
  }

  // Record this request
  timestamps.push(nowMs);
  const remaining = Math.max(RATE - timestamps.length, 0);
  const resetMs = timestamps[0] + WINDOW_MS;
  return { ok: true, remaining, resetMs };
}

/**
 * Clear all rate-limit state. Used in tests to reset between runs.
 */
export function _reset() {
  buckets.clear();
}

// ---------------------------------------------------------------------------
// Periodic cleanup of stale entries to prevent memory leaks
// ---------------------------------------------------------------------------
const CLEANUP_INTERVAL_MS = 5 * 60_000; // every 5 minutes

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  for (const [userId, timestamps] of buckets) {
    // Remove all expired timestamps
    while (timestamps.length > 0 && timestamps[0] <= windowStart) {
      timestamps.shift();
    }
    // If no timestamps remain, remove the user entry entirely
    if (timestamps.length === 0) {
      buckets.delete(userId);
    }
  }
}, CLEANUP_INTERVAL_MS);

// Don't keep process alive just for cleanup
if (cleanupTimer.unref) {
  cleanupTimer.unref();
}
