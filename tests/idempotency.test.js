import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

const TEST_PORT = 9091;
const BASE = `http://localhost:${TEST_PORT}`;
const DB_DIR = path.resolve('./data/test-idempotency');

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
      RATE_LIMIT_PER_MIN: '100', // High limit so rate-limit doesn't interfere
      DATABASE_URL: path.join(DB_DIR, 'signals.db'),
      DB_FAIL_RATE: '0',
      ...extraEnv,
    },
  });
}

// ── Test: Same key returns same resource ────────────────────────────────
test('idempotency: same key returns same resource', async () => {
  cleanDb();
  const proc = spawnServer();
  await wait(500);

  try {
    const a = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'k', 'Idempotency-Key': 'key-1' },
      body: { userId: 'u1', type: 'note', payload: 'x' },
    });
    const b = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'k', 'Idempotency-Key': 'key-1' },
      body: { userId: 'u1', type: 'note', payload: 'x' },
    });

    assert.equal(a.body.id, b.body.id, 'Same idempotency key should return same id');
    assert.equal(a.body.idempotencyKey, b.body.idempotencyKey);
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: Concurrent requests with same key produce exactly 1 row ──────
test('idempotency: concurrent requests with same key — only 1 row created', async () => {
  cleanDb();
  const proc = spawnServer();
  await wait(500);

  try {
    const idem = 'concurrent-key-1';
    const promises = Array.from({ length: 5 }, () =>
      postJson(`${BASE}/v1/signals`, {
        headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
        body: { userId: 'u-conc', type: 'note', payload: 'concurrent' },
      })
    );

    const results = await Promise.all(promises);

    // All should succeed (200 or 201)
    for (const r of results) {
      assert.ok(r.status === 200 || r.status === 201, `Expected 200/201, got ${r.status}`);
    }

    // All should return the same id
    const ids = results.map((r) => r.body.id);
    const uniqueIds = [...new Set(ids)];
    assert.equal(uniqueIds.length, 1, `Expected 1 unique id, got ${uniqueIds.length}: ${ids}`);

    // Verify only 1 row exists via GET
    const list = await getJson(`${BASE}/v1/signals?userId=u-conc&limit=100`, {
      headers: { 'x-api-key': 'k' },
    });
    assert.equal(list.body.items.length, 1, 'Expected exactly 1 row in DB');
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: Different keys create different resources ─────────────────────
test('idempotency: different keys create different resources', async () => {
  cleanDb();
  const proc = spawnServer();
  await wait(500);

  try {
    const a = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'k', 'Idempotency-Key': 'key-a' },
      body: { userId: 'u2', type: 'note', payload: 'a' },
    });
    const b = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'k', 'Idempotency-Key': 'key-b' },
      body: { userId: 'u2', type: 'note', payload: 'b' },
    });

    assert.notEqual(a.body.id, b.body.id, 'Different keys should create different resources');
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: No idempotency key creates separate resources each time ──────
test('idempotency: no key creates separate resources', async () => {
  cleanDb();
  const proc = spawnServer();
  await wait(500);

  try {
    const a = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'u3', type: 'note', payload: 'a' },
    });
    const b = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'u3', type: 'note', payload: 'b' },
    });

    assert.notEqual(a.body.id, b.body.id, 'No key should create separate resources');
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: First request returns 201, duplicate returns 200 ──────────────
test('idempotency: first request 201, duplicate 200', async () => {
  cleanDb();
  const proc = spawnServer();
  await wait(500);

  try {
    const a = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'k', 'Idempotency-Key': 'status-key' },
      body: { userId: 'u-status', type: 'note', payload: 'x' },
    });
    const b = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'k', 'Idempotency-Key': 'status-key' },
      body: { userId: 'u-status', type: 'note', payload: 'x' },
    });

    assert.equal(a.status, 201, 'First request should be 201');
    assert.equal(b.status, 200, 'Duplicate should be 200');
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────
async function postJson(url, { headers, body }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        let chunks = '';
        res.on('data', (d) => (chunks += d));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: JSON.parse(chunks || '{}'),
          });
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getJson(url, { headers }) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let chunks = '';
      res.on('data', (d) => (chunks += d));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: JSON.parse(chunks || '{}'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
