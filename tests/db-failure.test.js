import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import path from 'node:path';
import fs from 'node:fs';
import { postJson, getJson, waitForServer } from './helpers.js';

const TEST_PORT = 9093;
const BASE = `http://localhost:${TEST_PORT}`;
const DB_DIR = path.resolve('./data/test-db-failure');

function cleanDb() {
  if (fs.existsSync(DB_DIR)) {
    fs.rmSync(DB_DIR, { recursive: true, force: true });
  }
}

function spawnServer(extraEnv = {}) {
  return spawn('node', ['src/server.js'], {
    env: {
      ...process.env,
      API_KEY: 'k',
      PORT: String(TEST_PORT),
      RATE_LIMIT_PER_MIN: '100',
      DATABASE_URL: path.join(DB_DIR, 'signals.db'),
      DB_FAIL_RATE: '0',
      ...extraEnv,
    },
  });
}

// ── Test: Retry succeeds with moderate fail rate ────────────────────────
test('db-failure: retry succeeds with 30% fail rate', async () => {
  cleanDb();
  const proc = spawnServer({ DB_FAIL_RATE: '0.3' });
  await waitForServer(BASE);

  try {
    // With 30% fail rate and 3 retries, most requests should succeed
    const results = [];
    for (let i = 0; i < 5; i++) {
      const r = await postJson(`${BASE}/v1/signals`, {
        headers: { 'x-api-key': 'k' },
        body: { userId: 'u-retry', type: 'note', payload: String(i) },
      });
      results.push(r.status);
    }

    const successes = results.filter((s) => s === 200 || s === 201).length;
    // With retry, most should succeed even at 30% fail rate
    assert.ok(successes >= 3, `Expected >= 3 successes with retry, got ${successes}`);
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: 503 when DB always fails ──────────────────────────────────────
test('db-failure: returns 503 when DB always fails', async () => {
  cleanDb();
  const proc = spawnServer({ DB_FAIL_RATE: '1.0' });
  await waitForServer(BASE);

  try {
    const { status, body } = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'u-fail', type: 'note', payload: 'fail' },
    });

    assert.equal(status, 503, 'Expected 503 when DB is fully down');
    assert.equal(body.error, 'db_unavailable');
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: 503 includes Retry-After header ───────────────────────────────
test('db-failure: 503 includes Retry-After header', async () => {
  cleanDb();
  const proc = spawnServer({ DB_FAIL_RATE: '1.0' });
  await waitForServer(BASE);

  try {
    const { status, headers } = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'u-header', type: 'note', payload: 'fail' },
    });

    assert.equal(status, 503);
    assert.ok('retry-after' in headers, 'Missing Retry-After header on 503');
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: No duplicates on retry with idempotency key ───────────────────
test('db-failure: no duplicates after retry with idempotency key', async () => {
  cleanDb();
  const proc = spawnServer({ DB_FAIL_RATE: '0.3' });
  await waitForServer(BASE);

  try {
    const idem = 'retry-idem-key';
    // Send same idempotent request multiple times (some may fail, some retry)
    const results = [];
    for (let i = 0; i < 5; i++) {
      const r = await postJson(`${BASE}/v1/signals`, {
        headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
        body: { userId: 'u-idem-retry', type: 'note', payload: 'safe' },
      });
      results.push(r);
    }

    // All successful responses should have the same id
    const successResults = results.filter((r) => r.status === 200 || r.status === 201);
    if (successResults.length > 1) {
      const ids = successResults.map((r) => r.body.id);
      const uniqueIds = [...new Set(ids)];
      assert.equal(uniqueIds.length, 1, `Expected 1 unique id, got ${uniqueIds.length}`);
    }
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: GET /v1/signals returns 503 when DB is down ───────────────────
test('db-failure: GET signals returns 503 when DB always fails', async () => {
  cleanDb();
  const proc = spawnServer({ DB_FAIL_RATE: '1.0' });
  await waitForServer(BASE);

  try {
    const { status, body } = await getJson(
      `${BASE}/v1/signals?userId=anyone`,
      { headers: { 'x-api-key': 'k' } }
    );

    assert.equal(status, 503);
    assert.equal(body.error, 'db_unavailable');
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});


