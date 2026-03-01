import { loadEnv } from '../config/env.js';
import type { FlightMcpEnv } from '../config/env.js';
import { createLogger } from '../observability/logger.js';
import { createRedisClient } from '../config/redis.js';
import { createShutdownRegistry } from '../utils/graceful-shutdown.js';
import { createFlightMcpServer } from '../mcp/flight-server.js';
import type { FlightServerConfig } from '../mcp/flight-server.js';
import path from 'node:path';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger('flight-mcp');
  const registry = createShutdownRegistry();

  if (env.SERVICE_ROLE !== 'flight-mcp') {
    throw new Error(`Expected SERVICE_ROLE=flight-mcp, got ${env.SERVICE_ROLE}`);
  }

  const flightEnv = env as FlightMcpEnv;

  const redis = createRedisClient(flightEnv.REDIS_URL);
  try {
    await redis.connect();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ error: message }, 'Redis connection failed, starting in degraded mode');
  }

  const serverConfig: FlightServerConfig = flightEnv.FLIGHT_PROVIDER === 'flightaware'
    ? {
        provider: 'flightaware',
        flightAwareConfig: {
          apiKey: (flightEnv as FlightMcpEnv & { FLIGHTAWARE_API_KEY: string }).FLIGHTAWARE_API_KEY,
        },
      }
    : {
        provider: 'mock',
        fixturesDir: path.resolve('fixtures/flights'),
      };

  const { app, abortController } = await createFlightMcpServer(serverConfig);

  const server = app.listen(flightEnv.PORT, () => {
    logger.info({ port: flightEnv.PORT }, 'Flight MCP service ready');
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
