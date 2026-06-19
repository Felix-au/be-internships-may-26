import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import path from 'node:path';
import fs from 'node:fs';
import { postJson, waitForServer } from './helpers.js';

const TEST_PORT = 9092;
const BASE = `http://localhost:${TEST_PORT}`;
const DB_DIR = path.resolve('./data/test-rate-limit');

// Ensure clean DB for this test suite
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
      RATE_LIMIT_PER_MIN: '5',
      DATABASE_URL: path.join(DB_DIR, 'signals.db'),
      DB_FAIL_RATE: '0',
      ...extraEnv,
    },
  });
}

// ── Test: Basic rate limit — 5 allowed, 6th is 429 ──────────────────────
test('rate limit: allow 5 per minute, 6th is 429', async () => {
  cleanDb();
  const proc = spawnServer();
  await waitForServer(BASE);

  try {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const { status } = await postJson(`${BASE}/v1/signals`, {
        headers: { 'x-api-key': 'k' },
        body: { userId: 'u-basic', type: 'note', payload: String(i) },
      });
      statuses.push(status);
    }

    const counts = statuses.reduce((acc, c) => ((acc[c] = (acc[c] || 0) + 1), acc), {});
    assert.equal(counts[200] || counts[201] || 0,
      (counts[200] || 0) + (counts[201] || 0));
    // At least 5 should succeed, at least 1 should be 429
    const successCount = statuses.filter((s) => s === 200 || s === 201).length;
    assert.ok(successCount >= 5, `Expected >=5 successes, got ${successCount}`);
    assert.ok(statuses.includes(429), 'Expected at least one 429');
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: Concurrent burst — exactly RATE succeed ───────────────────────
test('rate limit: concurrent burst — exactly 5 succeed out of 10', async () => {
  cleanDb();
  const proc = spawnServer();
  await waitForServer(BASE);

  try {
    const promises = Array.from({ length: 10 }, (_, i) =>
      postJson(`${BASE}/v1/signals`, {
        headers: { 'x-api-key': 'k' },
        body: { userId: 'u-burst', type: 'note', payload: String(i) },
      })
    );
    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.status === 200 || r.status === 201);
    const rateLimited = results.filter((r) => r.status === 429);

    assert.equal(successes.length, 5, `Expected 5 successes, got ${successes.length}`);
    assert.equal(rateLimited.length, 5, `Expected 5 rate-limited, got ${rateLimited.length}`);
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: Different users are independent ───────────────────────────────
test('rate limit: different users have independent limits', async () => {
  cleanDb();
  const proc = spawnServer();
  await waitForServer(BASE);

  try {
    // User A: 5 requests
    for (let i = 0; i < 5; i++) {
      await postJson(`${BASE}/v1/signals`, {
        headers: { 'x-api-key': 'k' },
        body: { userId: 'user-a', type: 'note', payload: String(i) },
      });
    }

    // User B: should still be allowed
    const { status } = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'user-b', type: 'note', payload: 'first' },
    });

    assert.ok(status === 200 || status === 201, `Expected 200/201 for user-b, got ${status}`);
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: Rate-limit response headers ───────────────────────────────────
test('rate limit: response includes rate-limit headers', async () => {
  cleanDb();
  const proc = spawnServer();
  await waitForServer(BASE);

  try {
    const { headers } = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'u-headers', type: 'note', payload: 'x' },
    });

    assert.ok('x-ratelimit-remaining' in headers, 'Missing X-RateLimit-Remaining header');
    assert.ok('x-ratelimit-reset' in headers, 'Missing X-RateLimit-Reset header');

    const remaining = Number(headers['x-ratelimit-remaining']);
    assert.ok(remaining >= 0, `Remaining should be >= 0, got ${remaining}`);
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: 429 response includes retry-after ─────────────────────────────
test('rate limit: 429 response includes Retry-After header', async () => {
  cleanDb();
  const proc = spawnServer();
  await waitForServer(BASE);

  try {
    // Exhaust limit
    for (let i = 0; i < 5; i++) {
      await postJson(`${BASE}/v1/signals`, {
        headers: { 'x-api-key': 'k' },
        body: { userId: 'u-retry', type: 'note', payload: String(i) },
      });
    }

    // 6th should be 429 with Retry-After
    const { status, headers } = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'u-retry', type: 'note', payload: 'over' },
    });

    assert.equal(status, 429);
    assert.ok('retry-after' in headers, 'Missing Retry-After header on 429');
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});


