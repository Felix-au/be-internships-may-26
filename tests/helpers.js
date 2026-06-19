import http from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';

/**
 * Poll the server's /healthz endpoint until it responds 200,
 * or throw after `timeoutMs` milliseconds.
 */
export async function waitForServer(base, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { status } = await getJson(`${base}/healthz`, { headers: {} });
      if (status === 200) return;
    } catch {
      // server not ready yet
    }
    await wait(100);
  }
  throw new Error(`Server at ${base} did not start within ${timeoutMs}ms`);
}

/**
 * POST JSON and return { status, headers, body }.
 */
export async function postJson(url, { headers, body }) {
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

/**
 * GET JSON and return { status, headers, body }.
 */
export async function getJson(url, { headers }) {
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
