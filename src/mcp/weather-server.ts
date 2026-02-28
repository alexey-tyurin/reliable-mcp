import { randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  WeatherInputSchema,
  WeatherOutputSchema,
  WeatherApiResponseSchema,
} from './schemas.js';
import type { WeatherInput, WeatherOutput } from './schemas.js';
import { createCircuitBreaker } from '../resilience/circuit-breaker.js';
import { withRetry } from '../resilience/retry.js';
import { withTimeout } from '../resilience/timeout.js';
import { createHealthHandler } from '../utils/health.js';
import { ApiError } from '../utils/errors.js';
import { createLogger } from '../observability/logger.js';
import type { Logger } from 'pino';

export interface WeatherServerConfig {
  weatherApiKey: string;
  fetchFn?: typeof fetch;
  retryOptions?: { maxRetries: number };
  timeoutMs?: number;
}

interface WeatherServerResult {
  app: express.Express;
  abortController: AbortController;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

function createWeatherFetcher(
  config: WeatherServerConfig,
  abortSignal: AbortSignal,
): (input: WeatherInput) => Promise<WeatherOutput> {
  const fetchFn = config.fetchFn ?? globalThis.fetch;
  const logger = createLogger('weather-fetcher');

  const innerFn = async (input: WeatherInput): Promise<WeatherOutput> => {
    const url = `https://api.weatherapi.com/v1/current.json?key=${config.weatherApiKey}&q=${encodeURIComponent(input.city)}&aqi=no`;

    const response = await fetchFn(url, { signal: abortSignal });

    if (!response.ok) {
      throw new ApiError(
        `Weather API returned ${String(response.status)}`,
        response.status,
      );
    }

    const rawData: unknown = await response.json();
    const apiResponse = WeatherApiResponseSchema.parse(rawData);

    const temperature =
      input.units === 'fahrenheit'
        ? apiResponse.current.temp_f
        : apiResponse.current.temp_c;

    return WeatherOutputSchema.parse({
      city: apiResponse.location.name,
      country: apiResponse.location.country,
      temperature,
      units: input.units,
      condition: apiResponse.current.condition.text,
      humidity: apiResponse.current.humidity,
      timestamp: new Date().toISOString(),
    });
  };

  const retryOn = (error: unknown): boolean => {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      return false;
    }
    return true;
  };

  const withTimeoutFn = withTimeout(
    innerFn,
    config.timeoutMs ?? 5000,
    'weather-api',
  );

  const withRetryFn = withRetry(withTimeoutFn, {
    maxRetries: config.retryOptions?.maxRetries ?? 2,
    retryOn,
  });

  const withCircuitBreaker = createCircuitBreaker(withRetryFn, {
    name: 'weather-api',
  });

  return async (input: WeatherInput): Promise<WeatherOutput> => {
    try {
      return await withCircuitBreaker(input);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message, city: input.city }, 'Weather API call failed');
      throw error;
    }
  };
}

function registerWeatherTool(
  mcpServer: McpServer,
  fetchWeather: (input: WeatherInput) => Promise<WeatherOutput>,
  logger: Logger,
): void {
  // @ts-expect-error -- zod v3 (project) vs zod v4 (MCP SDK) type incompatibility
  // with exactOptionalPropertyTypes. Structurally identical at runtime.
  mcpServer.tool(
    'get_weather',
    'Get current weather temperature for a city',
    WeatherInputSchema.shape,
    async (params: Record<string, unknown>) => {
      try {
        const input = WeatherInputSchema.parse(params);
        const result = await fetchWeather(input);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message }, 'get_weather tool error');

        return {
          content: [
            {
              type: 'text' as const,
              text: 'Weather data is temporarily unavailable. Try again in a few minutes.',
            },
          ],
          isError: true,
        };
      }
    },
  );
}

async function createSession(
  fetchWeather: (input: WeatherInput) => Promise<WeatherOutput>,
  logger: Logger,
  sessions: Map<string, McpSession>,
): Promise<McpSession> {
  const mcpServer = new McpServer({
    name: 'weather-mcp',
    version: '1.0.0',
  });

  registerWeatherTool(mcpServer, fetchWeather, logger);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId: string) => {
      sessions.set(sessionId, session);
    },
    onsessionclosed: (sessionId: string) => {
      sessions.delete(sessionId);
    },
  });

  const session: McpSession = { transport, server: mcpServer };

  // @ts-expect-error -- StreamableHTTPServerTransport onclose typing incompatible
  // with exactOptionalPropertyTypes. Safe at runtime.
  await mcpServer.connect(transport);

  return session;
}

export async function createWeatherMcpServer(
  config: WeatherServerConfig,
): Promise<WeatherServerResult> {
  const abortController = new AbortController();
  const fetchWeather = createWeatherFetcher(config, abortController.signal);
  const logger = createLogger('weather-mcp');
  const sessions = new Map<string, McpSession>();

  const app = express();
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const existing = sessionId ? sessions.get(sessionId) : undefined;

      if (existing) {
        await existing.transport.handleRequest(req, res, req.body);
      } else {
        const session = await createSession(fetchWeather, logger, sessions);
        await session.transport.handleRequest(req, res, req.body);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'MCP POST request failed');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  app.get('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const existing = sessionId ? sessions.get(sessionId) : undefined;

      if (existing) {
        await existing.transport.handleRequest(req, res);
      } else {
        res.status(400).json({ error: 'Missing session ID' });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'MCP GET request failed');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  app.delete('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const existing = sessionId ? sessions.get(sessionId) : undefined;

      if (existing) {
        await existing.transport.handleRequest(req, res);
      } else {
        res.status(400).json({ error: 'Missing session ID' });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'MCP DELETE request failed');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  app.get('/health', createHealthHandler('weather-mcp'));

  return { app, abortController };
}
