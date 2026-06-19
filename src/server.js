import Fastify from 'fastify';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { postSignal, getSignals } from './signals.js';
import { closeDb } from './db.js';

dotenv.config();

const API_KEY = process.env.API_KEY || 'change-me';
const PORT = Number(process.env.PORT || 8080);

// ---------------------------------------------------------------------------
// App factory — exported so tests can create isolated instances
// ---------------------------------------------------------------------------
export function buildApp(opts = {}) {
  const app = Fastify({
    logger: opts.logger !== false ? { level: opts.logLevel || 'info' } : false,
    genReqId: () => crypto.randomUUID(),
    ...opts,
  });

  // ── Authentication hook ─────────────────────────────────────────────
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    const key = req.headers['x-api-key'];
    if (!key || key !== API_KEY) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  // ── Routes ──────────────────────────────────────────────────────────
  app.get('/healthz', async () => ({ ok: true }));
  app.post('/v1/signals', postSignal);
  app.get('/v1/signals', getSignals);

  return app;
}

// ---------------------------------------------------------------------------
// Server start (only when run directly, not imported by tests)
// ---------------------------------------------------------------------------
const app = buildApp();

export async function startServer() {
  await app.listen({ host: '0.0.0.0', port: PORT });
  return app;
}

// Auto-start only when this file is the entry point
const entryFile = process.argv[1];
if (entryFile && (entryFile.endsWith('server.js') || entryFile.endsWith('server'))) {
  startServer().catch((e) => {
    app.log.error(e);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function gracefulShutdown(signal) {
  app.log.info({ signal }, 'Received shutdown signal, closing server...');
  app.close().then(() => {
    closeDb();
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export { app };
