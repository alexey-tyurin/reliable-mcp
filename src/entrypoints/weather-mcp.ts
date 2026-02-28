import { loadEnv } from '../config/env.js';
import type { WeatherMcpEnv } from '../config/env.js';
import { createLogger } from '../observability/logger.js';
import { createRedisClient } from '../config/redis.js';
import { createShutdownRegistry } from '../utils/graceful-shutdown.js';
import { createWeatherMcpServer } from '../mcp/weather-server.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger('weather-mcp');
  const registry = createShutdownRegistry();

  if (env.SERVICE_ROLE !== 'weather-mcp') {
    throw new Error(`Expected SERVICE_ROLE=weather-mcp, got ${env.SERVICE_ROLE}`);
  }

  const weatherEnv = env as WeatherMcpEnv;

  const redis = createRedisClient(weatherEnv.REDIS_URL);
  try {
    await redis.connect();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ error: message }, 'Redis connection failed, starting in degraded mode');
  }

  const { app, abortController } = await createWeatherMcpServer({
    weatherApiKey: weatherEnv.WEATHERAPI_KEY,
  });

  const server = app.listen(weatherEnv.PORT, () => {
    logger.info({ port: weatherEnv.PORT }, 'Weather MCP service ready');
  });

  registry.register('http-server', () =>
    new Promise<void>((resolve) => {
      server.close(() => { resolve(); });
    }),
  );
  registry.register('abort-in-flight', () => {
    abortController.abort();
  });
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
