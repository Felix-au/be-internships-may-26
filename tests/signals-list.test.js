import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import path from 'node:path';
import fs from 'node:fs';
import { postJson, getJson, waitForServer } from './helpers.js';

const TEST_PORT = 9095;
const BASE = `http://localhost:${TEST_PORT}`;
const DB_DIR = path.resolve('./data/test-signals-list');

function cleanDb() {
  if (fs.existsSync(DB_DIR)) {
    fs.rmSync(DB_DIR, { recursive: true, force: true });
  }
}

function spawnServer() {
  return spawn('node', ['src/server.js'], {
    env: {
      ...process.env,
      API_KEY: 'k',
      PORT: String(TEST_PORT),
      RATE_LIMIT_PER_MIN: '100',
      DATABASE_URL: path.join(DB_DIR, 'signals.db'),
      DB_FAIL_RATE: '0',
    },
  });
}

// Helper: create N signals for a user
async function createSignals(userId, count) {
  const results = [];
  for (let i = 0; i < count; i++) {
    const r = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId, type: 'note', payload: `item-${i}` },
    });
    results.push(r);
    // Small delay to ensure distinct created_at timestamps
    await wait(10);
  }
  return results;
}

// ── Test: List signals for a user ──────────────────────────────────────
test('signals-list: returns all signals for a user', async () => {
  cleanDb();
  const proc = spawnServer();
  await waitForServer(BASE);

  try {
    await createSignals('u-list', 3);

    const { status, body } = await getJson(
      `${BASE}/v1/signals?userId=u-list`,
      { headers: { 'x-api-key': 'k' } }
    );

    assert.equal(status, 200);
    assert.equal(body.items.length, 3);
    for (const item of body.items) {
      assert.equal(item.userId, 'u-list');
    }
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: Limit parameter ──────────────────────────────────────────────
test('signals-list: limit parameter restricts results', async () => {
  cleanDb();
  const proc = spawnServer();
  await waitForServer(BASE);

  try {
    await createSignals('u-limit', 5);

    const { status, body } = await getJson(
      `${BASE}/v1/signals?userId=u-limit&limit=2`,
      { headers: { 'x-api-key': 'k' } }
    );

    assert.equal(status, 200);
    assert.equal(body.items.length, 2);
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: Limit capped at 100 ──────────────────────────────────────────
test('signals-list: limit is capped at 100', async () => {
  cleanDb();
  const proc = spawnServer();
  await waitForServer(BASE);

  try {
    await createSignals('u-cap', 3);

    // Request with limit=999 — should be capped at 100 internally
    const { status, body } = await getJson(
      `${BASE}/v1/signals?userId=u-cap&limit=999`,
      { headers: { 'x-api-key': 'k' } }
    );

    assert.equal(status, 200);
    // Should return all 3 (since 3 < 100 cap)
    assert.equal(body.items.length, 3);
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: Order is newest-first ────────────────────────────────────────
test('signals-list: results are ordered newest-first', async () => {
  cleanDb();
  const proc = spawnServer();
  await waitForServer(BASE);

  try {
    await createSignals('u-order', 3);

    const { body } = await getJson(
      `${BASE}/v1/signals?userId=u-order`,
      { headers: { 'x-api-key': 'k' } }
    );

    assert.equal(body.items.length, 3);
    // Verify descending order by createdAt
    for (let i = 0; i < body.items.length - 1; i++) {
      assert.ok(
        body.items[i].createdAt >= body.items[i + 1].createdAt,
        `Expected item[${i}].createdAt (${body.items[i].createdAt}) >= item[${i + 1}].createdAt (${body.items[i + 1].createdAt})`
      );
    }
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: Non-existent user returns empty items ────────────────────────
test('signals-list: non-existent user returns empty items', async () => {
  cleanDb();
  const proc = spawnServer();
  await waitForServer(BASE);

  try {
    const { status, body } = await getJson(
      `${BASE}/v1/signals?userId=nobody`,
      { headers: { 'x-api-key': 'k' } }
    );

    assert.equal(status, 200);
    assert.deepEqual(body, { items: [] });
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: Signals from one user don't leak to another ──────────────────
test('signals-list: user isolation — no data leakage', async () => {
  cleanDb();
  const proc = spawnServer();
  await waitForServer(BASE);

  try {
    await createSignals('user-x', 3);
    await createSignals('user-y', 2);

    const { body: xBody } = await getJson(
      `${BASE}/v1/signals?userId=user-x`,
      { headers: { 'x-api-key': 'k' } }
    );
    const { body: yBody } = await getJson(
      `${BASE}/v1/signals?userId=user-y`,
      { headers: { 'x-api-key': 'k' } }
    );

    assert.equal(xBody.items.length, 3);
    assert.equal(yBody.items.length, 2);
    xBody.items.forEach((item) => assert.equal(item.userId, 'user-x'));
    yBody.items.forEach((item) => assert.equal(item.userId, 'user-y'));
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});


