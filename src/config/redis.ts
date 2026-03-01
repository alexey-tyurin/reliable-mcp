import { Redis as IORedis } from 'ioredis';
import { createLogger } from '../observability/logger.js';

const MAX_RETRIES = 20;
const BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 5000;

export function createRedisClient(
  url?: string,
): IORedis {
  const redisUrl = url ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const logger = createLogger('redis');

  const client = new IORedis(redisUrl, {
    retryStrategy(times: number): number | null {
      if (times > MAX_RETRIES) {
        logger.error({ retries: times }, 'Redis max retries exceeded, giving up');
        return null;
      }

      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, times - 1), MAX_DELAY_MS);
      logger.warn({ retries: times, delayMs: delay }, 'Redis reconnecting');
      return delay;
    },
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

  client.on('error', (error: Error) => {
    logger.error({ error: error.message }, 'Redis connection error');
  });

  client.on('connect', () => {
    logger.info('Redis connected');
  });

  client.on('close', () => {
    logger.info('Redis connection closed');
  });

  if (process.env['CHAOS_ENABLED'] === 'true') {
    import('../chaos/interceptors/redis-interceptor.js')
      .then(({ wrapRedisWithChaos }) => {
        wrapRedisWithChaos(client, 'redis');
        logger.info('Redis chaos interceptor wired');
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ error: message }, 'Failed to wire Redis chaos interceptor');
      });
  }

  return client;
}
