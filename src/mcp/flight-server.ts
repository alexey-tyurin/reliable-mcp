import { randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { FlightInputSchema } from './schemas.js';
import type { FlightInput, FlightOutput } from './schemas.js';
import type { FlightProvider } from './flight-provider.js';
import { createMockFlightProvider } from './mock-flight-provider.js';
import { createFlightAwareProvider } from './flightaware-provider.js';
import type { FlightAwareConfig } from './flightaware-provider.js';
import { createHealthHandler } from '../utils/health.js';
import { createLogger } from '../observability/logger.js';
import type { Logger } from 'pino';

export interface FlightServerConfig {
  provider: 'mock' | 'flightaware';
  fixturesDir?: string;
  flightAwareConfig?: Omit<FlightAwareConfig, 'abortSignal'>;
}

interface FlightServerResult {
  app: express.Express;
  abortController: AbortController;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

async function buildFlightProvider(
  config: FlightServerConfig,
  abortSignal: AbortSignal,
): Promise<FlightProvider> {
  if (config.provider === 'flightaware') {
    if (!config.flightAwareConfig) {
      throw new Error('flightAwareConfig is required when provider is flightaware');
    }
    return createFlightAwareProvider({
      ...config.flightAwareConfig,
      abortSignal,
    });
  }

  const fixturesDir = config.fixturesDir ?? 'fixtures/flights';
  return createMockFlightProvider(fixturesDir);
}

function registerFlightTool(
  mcpServer: McpServer,
  provider: FlightProvider,
  logger: Logger,
): void {
  // @ts-expect-error -- zod v3 (project) vs zod v4 (MCP SDK) type incompatibility
  // with exactOptionalPropertyTypes. Structurally identical at runtime.
  mcpServer.tool(
    'get_flight_status',
    'Get current status of a flight by flight number',
    FlightInputSchema.shape,
    async (params: Record<string, unknown>) => {
      try {
        const input: FlightInput = FlightInputSchema.parse(params);
        const result: FlightOutput = await provider.getFlightStatus(input);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message }, 'get_flight_status tool error');

        return {
          content: [
            {
              type: 'text' as const,
              text: 'Flight status is temporarily unavailable. Try again in a few minutes.',
            },
          ],
          isError: true,
        };
      }
    },
  );
}

async function createSession(
  provider: FlightProvider,
  logger: Logger,
  sessions: Map<string, McpSession>,
): Promise<McpSession> {
  const mcpServer = new McpServer({
    name: 'flight-mcp',
    version: '1.0.0',
  });

  registerFlightTool(mcpServer, provider, logger);

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

export async function createFlightMcpServer(
  config: FlightServerConfig,
): Promise<FlightServerResult> {
  const abortController = new AbortController();
  const provider = await buildFlightProvider(config, abortController.signal);
  const logger = createLogger('flight-mcp');
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
        const session = await createSession(provider, logger, sessions);
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

  app.get('/health', createHealthHandler('flight-mcp'));

  return { app, abortController };
}
