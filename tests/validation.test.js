import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import path from 'node:path';
import fs from 'node:fs';
import { postJson, getJson, waitForServer } from './helpers.js';

const TEST_PORT = 9094;
const BASE = `http://localhost:${TEST_PORT}`;
const DB_DIR = path.resolve('./data/test-validation');

function cleanDb() {
  if (fs.existsSync(DB_DIR)) {
    fs.rmSync(DB_DIR, { recursive: true, force: true });
  }
}

function spawnServer() {
  return spawn('node', ['src/server.js'], {
    env: {
      ...process.env,
      API_KEY: 'test-secret',
      PORT: String(TEST_PORT),
      RATE_LIMIT_PER_MIN: '100',
      DATABASE_URL: path.join(DB_DIR, 'signals.db'),
      DB_FAIL_RATE: '0',
    },
  });
}

// ── Test: Healthz returns 200 ──────────────────────────────────────────
test('validation: GET /healthz returns 200 ok', async () => {
  cleanDb();
  const proc = spawnServer();
  await waitForServer(BASE);

  try {
    const { status, body } = await getJson(`${BASE}/healthz`, { headers: {} });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: Healthz does not require API key ──────────────────────────────
test('validation: healthz does not require API key', async () => {
  cleanDb();
  const proc = spawnServer();
  await waitForServer(BASE);

  try {
    const { status } = await getJson(`${BASE}/healthz`, { headers: {} });
    assert.equal(status, 200, 'Healthz should not require API key');
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: Missing API key returns 401 ──────────────────────────────────
test('validation: missing API key returns 401', async () => {
  cleanDb();
  const proc = spawnServer();
  await waitForServer(BASE);

  try {
    const { status, body } = await postJson(`${BASE}/v1/signals`, {
      headers: {},
      body: { userId: 'u1', type: 'note', payload: 'x' },
    });
    assert.equal(status, 401);
    assert.equal(body.error, 'unauthorized');
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: Wrong API key returns 401 ────────────────────────────────────
test('validation: wrong API key returns 401', async () => {
  cleanDb();
  const proc = spawnServer();
  await waitForServer(BASE);

  try {
    const { status, body } = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'wrong-key' },
      body: { userId: 'u1', type: 'note', payload: 'x' },
    });
    assert.equal(status, 401);
    assert.equal(body.error, 'unauthorized');
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: Missing body fields returns 400 ──────────────────────────────
test('validation: missing userId returns 400', async () => {
  cleanDb();
  const proc = spawnServer();
  await waitForServer(BASE);

  try {
    const { status, body } = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'test-secret' },
      body: { type: 'note', payload: 'x' },
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_body');
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

test('validation: missing type returns 400', async () => {
  cleanDb();
  const proc = spawnServer();
  await waitForServer(BASE);

  try {
    const { status, body } = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'test-secret' },
      body: { userId: 'u1', payload: 'x' },
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_body');
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

test('validation: missing payload returns 400', async () => {
  cleanDb();
  const proc = spawnServer();
  await waitForServer(BASE);

  try {
    const { status, body } = await postJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'test-secret' },
      body: { userId: 'u1', type: 'note' },
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_body');
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});

// ── Test: GET signals with missing userId returns 400 ──────────────────
test('validation: GET /v1/signals without userId returns 400', async () => {
  cleanDb();
  const proc = spawnServer();
  await waitForServer(BASE);

  try {
    const { status, body } = await getJson(`${BASE}/v1/signals`, {
      headers: { 'x-api-key': 'test-secret' },
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'missing_userId');
  } finally {
    proc.kill();
    await wait(200);
    cleanDb();
  }
});


