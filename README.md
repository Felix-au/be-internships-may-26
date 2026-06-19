# Signals Challenge (Node.js + Fastify)

A minimal production-leaning service that can **handle load**, **rate limit**, and **avoid duplicates** via idempotency.

---

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Start development server
npm run dev

# Run tests
npm test

# Benchmark
npm run bench
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_KEY` | `change-me` | API key for authentication (sent via `X-API-Key` header) |
| `PORT` | `8080` | Server port |
| `DATABASE_URL` | `./data/signals.db` | Path to SQLite database file |
| `RATE_LIMIT_PER_MIN` | `5` | Max requests per user per minute |
| `DB_FAIL_RATE` | `0` | Simulated DB failure rate (0.0–1.0) for testing |

---

## API Endpoints

### `POST /v1/signals`

Create a new signal.

**Headers:**
- `X-API-Key` (required) — API authentication key
- `Idempotency-Key` (optional) — Prevents duplicate creation
- `Content-Type: application/json`

**Body:**
```json
{ "userId": "string", "type": "string", "payload": "string" }
```

**Response (201 Created):**
```json
{
  "id": 1,
  "userId": "user-123",
  "type": "click",
  "payload": "button-A",
  "idempotencyKey": "abc-123",
  "createdAt": 1718800000000
}
```

**Rate Limited (429):**
```json
{ "error": "rate_limited", "remaining": 0, "resetMs": 1718800060000 }
```

**Response Headers:**
- `X-RateLimit-Remaining` — Remaining requests in window
- `X-RateLimit-Reset` — Window reset timestamp (Unix seconds)
- `Retry-After` — Seconds to wait (on 429/503)

### `GET /v1/signals?userId=...&limit=...`

List signals for a user, newest first.

**Query Parameters:**
- `userId` (required) — Filter by user
- `limit` (optional, default: 20, max: 100) — Number of results

**Response (200):**
```json
{ "items": [{ "id": 1, "userId": "user-123", "type": "click", ... }] }
```

### `GET /healthz`

Health check (no authentication required).

**Response (200):**
```json
{ "ok": true }
```

---

## Architecture Decisions

### Sliding Window Rate Limiter
Uses a **sliding window log** algorithm instead of a fixed window. Each user's request timestamps are tracked in a sorted array, and expired entries are evicted on every check. This prevents burst attacks at window boundaries. Concurrency-safe within a single Node.js process (JavaScript is single-threaded).

### Atomic Idempotency
Replaces the naive check-then-insert pattern (vulnerable to TOCTOU races) with **`INSERT OR IGNORE` + `SELECT` inside a SQLite transaction**. The `UNIQUE` constraint on `idempotency_key` is the ultimate guard — concurrent requests with the same key will never create duplicates.

### Retry with Exponential Backoff + Jitter
All DB operations are wrapped in a retry loop (up to 3 attempts) with exponential backoff and **full jitter** to avoid thundering herd effects. Transient errors (`SQLITE_BUSY`, simulated failures) are retried; permanent errors fail immediately.

### Graceful Shutdown
The server handles `SIGTERM`/`SIGINT` to close HTTP connections and the SQLite database cleanly, preventing data corruption.

---

## Testing

```bash
# Run all tests
npm test

# Run individual test suites
node --test tests/rate-limit.test.js       # Rate limiting (5 tests)
node --test tests/idempotency.test.js      # Idempotency (5 tests)
node --test tests/db-failure.test.js       # DB failure handling (5 tests)
node --test tests/validation.test.js       # Input validation (8 tests)
node --test tests/signals-list.test.js     # GET listing (6 tests)
```

**Test isolation:** Each test suite uses a unique port and separate database directory to avoid cross-test interference.

| Suite | Tests | Coverage |
|-------|-------|----------|
| Rate Limit | 5 | Basic enforcement, concurrent burst, user independence, headers, retry-after |
| Idempotency | 5 | Same key dedup, concurrent 5-way dedup, different keys, no-key behavior, status codes |
| DB Failure | 5 | Retry at 30% fail rate, 503 at 100%, retry-after header, no duplicates on retry, GET failure |
| Validation | 8 | Healthz, API key auth, body field validation, query param validation |
| Signals List | 6 | Listing, limit, cap at 100, ordering, empty results, user isolation |

**Total: 29 tests**

---

## Docker

```bash
# Build and run
docker build -t signals-challenge .
docker run -p 8080:8080 --env-file .env signals-challenge

# Or use docker-compose
docker compose up
```

---

## Deployment

See [Render Deploy Guide](../render-deploy-guide.md) for deployment to Render.

---

## Scale

See [SCALE.md](./SCALE.md) for the 10k RPS production architecture plan.
