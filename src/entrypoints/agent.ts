import express from 'express';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../observability/logger.js';
import { createRedisClient } from '../config/redis.js';
import { createHealthHandler } from '../utils/health.js';
import { createShutdownRegistry } from '../utils/graceful-shutdown.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger('agent');
  const registry = createShutdownRegistry();

  const redis = createRedisClient(env.REDIS_URL);
  try {
    await redis.connect();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ error: message }, 'Redis connection failed, starting in degraded mode');
  }

  const app = express();

  app.get('/health', createHealthHandler('agent'));

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'Agent service ready');
  });

  registry.register('http-server', () =>
    new Promise<void>((resolve) => {
      server.close(() => { resolve(); });
    }),
  );
  registry.register('redis', async () => {
    await redis.quit();
  });
  registry.register('logger', () => {
    logger.flush();
  });

  registry.onShutdown();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`Fatal startup error: ${message}`);
  process.exit(1);
});
