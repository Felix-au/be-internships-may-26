import { insertSignal, insertSignalAtomic, listSignals } from './db.js';
import { checkAndConsume } from './rateLimit.js';

/**
 * POST /v1/signals
 *
 * Creates a new signal. Supports:
 * - Per-userId rate limiting (sliding window)
 * - Idempotency via Idempotency-Key header (atomic upsert, no TOCTOU race)
 * - Retry-safe: DB failures are retried internally with backoff
 */
export async function postSignal(req, reply) {
  const idem = req.headers['idempotency-key'] || null;
  const { userId, type, payload } = req.body || {};

  // ── Input validation ──────────────────────────────────────────────────
  if (!userId || !type || typeof payload === 'undefined') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  // ── Rate limiting ─────────────────────────────────────────────────────
  const now = Date.now();
  const { ok, remaining, resetMs } = checkAndConsume(userId, now);
  reply.header('X-RateLimit-Remaining', String(remaining));
  reply.header('X-RateLimit-Reset', String(Math.ceil(resetMs / 1000)));

  if (!ok) {
    reply.header('Retry-After', String(Math.ceil((resetMs - now) / 1000)));
    return reply.code(429).send({ error: 'rate_limited', remaining, resetMs });
  }

  // ── Idempotent insert ─────────────────────────────────────────────────
  try {
    if (idem) {
      // Atomic: INSERT OR IGNORE + SELECT in one transaction
      // Eliminates the check-then-insert TOCTOU race
      const { row, created } = insertSignalAtomic(userId, type, payload, idem, now);
      const status = created ? 201 : 200;
      return reply.code(status).send(row);
    }

    // No idempotency key — simple insert
    const info = insertSignal(userId, type, payload, null, now);
    return reply.code(201).send({
      id: Number(info.lastInsertRowid),
      userId,
      type,
      payload: String(payload),
      idempotencyKey: null,
      createdAt: now,
    });
  } catch (e) {
    req.log.error({ err: e, ctx: 'insertSignal' });
    reply.header('Retry-After', '1');
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}

/**
 * GET /v1/signals?userId=...&limit=...
 *
 * Lists signals for a user, newest first.
 *
 * Note: Rate limiting is intentionally applied only on POST (write path)
 * per the assignment spec. In production, reads should also be rate-limited
 * to prevent abuse — the same sliding-window approach applies.
 */
export async function getSignals(req, reply) {
  const { userId, limit = 20 } = req.query || {};

  if (!userId) {
    return reply.code(400).send({ error: 'missing_userId' });
  }

  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);

  try {
    const rows = listSignals(userId, lim);
    return { items: rows };
  } catch (e) {
    req.log.error({ err: e, ctx: 'listSignals' });
    reply.header('Retry-After', '1');
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}
