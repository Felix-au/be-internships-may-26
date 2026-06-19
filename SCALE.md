# Scale Plan — 10k RPS Production Architecture

## Data Model / Indexes

### Current (SQLite)
```sql
CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_user_created ON signals(user_id, created_at);
```

### Production (PostgreSQL)
```sql
CREATE TABLE signals (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  type VARCHAR(100) NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key VARCHAR(255) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Composite index for listing (covering query)
CREATE INDEX idx_signals_user_created
  ON signals(user_id, created_at DESC)
  INCLUDE (id, type, payload, idempotency_key);

-- Partial index for idempotency lookups (skip NULLs)
CREATE UNIQUE INDEX idx_signals_idem_key
  ON signals(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Partition by month for archival and performance at scale
CREATE TABLE signals PARTITION BY RANGE (created_at);
```

**Why PostgreSQL?** SQLite is single-writer and single-file — it cannot scale horizontally. PostgreSQL supports concurrent writers, connection pooling, MVCC, and native `INSERT ... ON CONFLICT` for atomic upserts.

---

## Idempotency Across Instances

### Problem
In-memory checks are instance-local. Two requests with the same `Idempotency-Key` hitting different instances would bypass each other's checks.

### Solution: Two-Layer Approach

1. **Primary Guard — PostgreSQL `INSERT ... ON CONFLICT DO NOTHING`**
   - The `UNIQUE` constraint on `idempotency_key` is the ultimate guard.
   - Use `INSERT ... ON CONFLICT(idempotency_key) DO NOTHING RETURNING *` in a single statement — atomic at the DB level.
   - If `RETURNING` returns no rows, `SELECT` the existing row.
   - Works correctly regardless of which instance handles the request.

2. **Optional Fast-Path — Redis `SET NX`**
   ```
   SET idempotency:{key} {signal_id} NX EX 86400
   ```
   - Check Redis first (fast L1 cache, avoids DB round-trip for repeated keys).
   - TTL of 24h auto-expires old keys (configurable).
   - If Redis returns the existing id, skip DB entirely.
   - If Redis misses, fall through to PostgreSQL (source of truth).

**Consistency guarantee**: The DB unique constraint is the source of truth. Redis is a performance optimization, not a correctness requirement.

---

## Rate Limiting Across Instances

### Problem
In-memory sliding window is instance-local. A user could send `RATE_LIMIT_PER_MIN` requests to *each* instance, exceeding the global limit.

### Solution: Redis Sorted Set with Lua Script

```lua
-- Atomic sliding window via Redis ZSET
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

-- Remove expired entries
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

-- Count current entries
local count = redis.call('ZCARD', key)

if count < limit then
  -- Allow: add this request's timestamp
  redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))
  redis.call('EXPIRE', key, math.ceil(window / 1000))
  return {1, limit - count - 1}  -- {allowed, remaining}
else
  -- Deny
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local resetAt = tonumber(oldest[2]) + window
  return {0, 0, resetAt}  -- {denied, remaining, resetMs}
end
```

**Why Lua?** Executes atomically on the Redis server — no race between `ZCARD` and `ZADD` even under concurrent requests from multiple instances.

**Fallback**: If Redis is unavailable, fall back to local in-memory limiter (fail-open with degraded accuracy, log a warning).

---

## Observability (Logs / Metrics / Alerts)

### Structured Logging
- **Fastify/Pino** provides structured JSON logging out of the box.
- Every request includes: `reqId`, `method`, `url`, `statusCode`, `responseTime`.
- Errors include: stack trace, context (`insertSignal`, `listSignals`), retry attempt number.
- Ship logs to a centralized system (ELK, Datadog, CloudWatch).

### Metrics (Prometheus via `fastify-metrics`)
| Metric | Type | Description |
|--------|------|-------------|
| `http_request_duration_seconds` | Histogram | Latency by route (p50, p95, p99) |
| `http_requests_total` | Counter | Total requests by method, route, status |
| `rate_limit_hits_total` | Counter | 429 responses per userId bucket |
| `db_retries_total` | Counter | Number of retry attempts |
| `db_failures_total` | Counter | Failures after max retries (503s) |
| `idempotency_cache_hits_total` | Counter | Requests served from cache |

### Alerts
- **Error rate** > 1% of requests → PagerDuty (P2)
- **p99 latency** > 500ms sustained for 5min → PagerDuty (P3)
- **503 rate** > 5% → PagerDuty (P1, DB likely degraded)
- **Rate-limit 429 rate** for single user > 100/min → Log anomaly (possible abuse)

### Health Checks
- `GET /healthz` — basic liveness (already implemented).
- `GET /readyz` — readiness check that pings DB and Redis, returns 503 if either is unreachable.

---

## Failure Modes (DB Down / Partial Outages / Retries)

### Retry with Exponential Backoff + Jitter (Implemented)
```
Attempt 0: immediate
Attempt 1: ~50-100ms delay
Attempt 2: ~100-200ms delay
Attempt 3: ~200-400ms delay (max)
→ 503 with Retry-After header
```
Full jitter prevents thundering herd: `delay = random(0, min(cap, base * 2^attempt))`.

### Circuit Breaker Pattern (Production)
Using a library like `opossum`:
- **Closed** → normal operation
- **Open** → after N consecutive failures, fast-fail all requests (503) without touching DB
- **Half-Open** → after cooldown, allow one probe request to test DB health

Benefits:
- Prevents cascading failures (don't pile up connections to a failing DB).
- Reduces recovery time (DB isn't overwhelmed by retries).

### Bulkhead Pattern
- Separate connection pools for read vs. write operations.
- `/healthz` never touches the DB, so it stays healthy even during outages.
- Rate limiting uses Redis (separate from DB), so it continues working.

### Queue-Based Decoupling (Write-Heavy)
For ultra-high write throughput:
```
Client → API → Redis Stream / Kafka → Consumer → PostgreSQL
```
- API acknowledges immediately (202 Accepted) after writing to the queue.
- Consumer processes writes with its own retry logic.
- Idempotency key checked at both API layer (Redis) and consumer layer (DB).

---

## 10k RPS Design Sketch (Infra & Cost Ballpark)

### Architecture
```
                    ┌─────────────────┐
                    │   CloudFlare    │
                    │   (DDoS / WAF)  │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │   ALB / NGINX   │
                    │ (Load Balancer) │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
       ┌──────▼──────┐ ┌────▼────┐ ┌───────▼─────┐
       │  Node.js #1 │ │  ...#N  │ │  Node.js #8 │
       │  (Fastify)  │ │         │ │  (Fastify)  │
       └──────┬──────┘ └─────┬───┘ └────────┬────┘
              │              │              │
       ┌──────▼──────────────▼──────────────▼──────┐
       │              Redis Cluster                │
       │   (Rate Limit + Idempotency Cache)        │
       │   Primary + 2 Replicas                    │
       └──────────────────┬────────────────────────┘
                          │
       ┌──────────────────▼────────────────────────┐
       │         PostgreSQL (RDS Multi-AZ)         │
       │   Writer + Read Replica                   │
       │   + PgBouncer (Connection Pooling)        │
       └───────────────────────────────────────────┘
```

### Capacity Planning

| Component | Spec | Rationale |
|-----------|------|-----------|
| **Node.js instances** | 4-8 × c5.xlarge (4 vCPU, 8 GB) | Fastify handles ~15k req/s per core; 4 instances give ~60k headroom |
| **Redis** | ElastiCache r6g.large (2 vCPU, 13 GB) | Rate-limit ZSET + idempotency keys; ~100k ops/s per node |
| **PostgreSQL** | RDS db.r6g.xlarge (4 vCPU, 32 GB) Multi-AZ | Writes: ~10k inserts/s with pgBouncer; Read replica for GET queries |
| **PgBouncer** | Transaction-mode pooling, 200 connections | Avoid connection exhaustion from N × Node instances |
| **Load Balancer** | ALB (or NGINX) | Sticky sessions not needed (all state in Redis/PG) |

### Cost Estimate (AWS, us-east-1, monthly)

| Resource | Monthly Cost |
|----------|-------------|
| 4× c5.xlarge (Node.js) | ~$490 |
| 1× ElastiCache r6g.large | ~$230 |
| 1× RDS r6g.xlarge Multi-AZ | ~$730 |
| ALB + data transfer | ~$150 |
| **Total** | **~$1,600/mo** |

### Key Optimizations at Scale
1. **Connection pooling** — PgBouncer in transaction mode limits active DB connections.
2. **Read replicas** — Route `GET /v1/signals` to read replicas.
3. **Idempotency TTL** — Auto-expire keys older than 24h to bound storage.
4. **Partitioning** — Monthly partitions on `created_at` for fast archival (`DROP PARTITION`).
5. **Horizontal scaling** — Add Node.js instances behind the load balancer; no shared state.
6. **CDN/WAF** — CloudFlare for DDoS protection and edge-level rate limiting.
