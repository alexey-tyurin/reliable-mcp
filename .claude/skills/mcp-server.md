# Skill: MCP Server (Streamable HTTP)

Use this pattern when creating or modifying any MCP server in this project. Both `weather-server.ts` and `flight-server.ts` follow this exact structure.

## Architecture

Each MCP server is an Express app that:
1. Mounts the MCP SDK's `StreamableHTTPServerTransport` at `POST /mcp`
2. Exposes `GET /health` for Docker health checks
3. Runs in its own Docker container with its own port
4. Registers all resources in the graceful shutdown registry

## File Structure

For a new MCP server called `example`:

```
src/mcp/example-server.ts          # Server + tool handler
src/mcp/schemas.ts                 # Add zod schemas here (shared file)
src/entrypoints/example-mcp.ts     # Docker entrypoint
tests/integration/mcp-example.test.ts  # Integration tests
```

## Implementation Template

### 1. Schema (in `src/mcp/schemas.ts`)

```typescript
import { z } from 'zod';

export const ExampleInputSchema = z.object({
  param: z.string().describe('Description for LLM'),
});

export const ExampleOutputSchema = z.object({
  result: z.string(),
  timestamp: z.string().datetime(),
});

export type ExampleInput = z.infer<typeof ExampleInputSchema>;
export type ExampleOutput = z.infer<typeof ExampleOutputSchema>;
```

### 2. Server (`src/mcp/example-server.ts`)

```typescript
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ExampleInputSchema } from './schemas.js';
import { createCircuitBreaker } from '../resilience/circuit-breaker.js';
import { withRetry } from '../resilience/retry.js';
import { withTimeout } from '../resilience/timeout.js';
import { healthHandler } from '../utils/health.js';
import { logger } from '../observability/logger.js';

export function createExampleMcpServer(): { app: express.Express; mcpServer: McpServer } {
  const app = express();
  const mcpServer = new McpServer({
    name: 'example-mcp',
    version: '1.0.0',
  });

  // Register tool
  mcpServer.tool(
    'tool_name',
    'Description for LLM tool listing',
    ExampleInputSchema.shape,  // Pass the raw shape for MCP SDK
    async (params) => {
      // 1. Validate (zod already handled by MCP SDK, but double-check if needed)
      const input = ExampleInputSchema.parse(params);

      // 2. Call external API (wrapped in resilience stack)
      const result = await callExternalApi(input);

      // 3. Return as MCP TextContent
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }
  );

  // Mount MCP transport
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  app.post('/mcp', async (req, res) => {
    await transport.handleRequest(req, res, req.body);
  });

  // Health check
  app.get('/health', healthHandler('example-mcp'));

  // Connect transport to server
  mcpServer.connect(transport);

  return { app, mcpServer };
}

// External API call — ALWAYS wrapped: circuit breaker → retry → timeout
const callExternalApi = createCircuitBreaker(
  withRetry(
    withTimeout(async (input: ExampleInput): Promise<ExampleOutput> => {
      const response = await fetch(`https://api.example.com/data?q=${encodeURIComponent(input.param)}`, {
        headers: { 'Authorization': `Bearer ${env.EXAMPLE_API_KEY}` },
      });
      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }
      const data = await response.json();
      // Map to output schema
      return ExampleOutputSchema.parse({
        result: data.value,
        timestamp: new Date().toISOString(),
      });
    }, 5000),  // 5s timeout
  ),
  { name: 'example-api' }  // circuit breaker name for metrics
);
```

### 3. Entrypoint (`src/entrypoints/example-mcp.ts`)

```typescript
import { createExampleMcpServer } from '../mcp/example-server.js';
import { loadEnv } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { registerShutdown, onShutdown } from '../utils/graceful-shutdown.js';

const env = loadEnv('example-mcp');
const { app, mcpServer } = createExampleMcpServer();

const server = app.listen(env.PORT, () => {
  logger.info({ service: 'example-mcp', port: env.PORT }, 'MCP server ready');
});

// Register cleanup
registerShutdown('http-server', () => new Promise<void>((resolve) => server.close(() => resolve())));
registerShutdown('mcp-server', () => mcpServer.close());

onShutdown();
```

### 4. Integration Test (`tests/integration/mcp-example.test.ts`)

Write these BEFORE the implementation (TDD):

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createExampleMcpServer } from '../../src/mcp/example-server.js';
import type { AddressInfo } from 'net';

describe('Example MCP Server', () => {
  let server: ReturnType<typeof import('http').createServer>;
  let baseUrl: string;

  beforeAll(async () => {
    const { app } = createExampleMcpServer();
    server = app.listen(0);  // Random port
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns health check', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('example-mcp');
  });

  it('handles valid tool call', async () => {
    // Send MCP tool call via HTTP
    // Assert response shape matches ExampleOutputSchema
  });

  it('returns error for invalid input', async () => {
    // Send malformed params
    // Assert error response is user-friendly, no stack trace
  });

  it('degrades gracefully when API is down', async () => {
    // Mock API to 500
    // Assert error response is friendly
  });
});
```

## Docker Compose Entry

```yaml
example-mcp:
  build: .
  command: node dist/entrypoints/example-mcp.js
  ports:
    - "3003:3003"
  env_file: .env
  environment:
    - SERVICE_ROLE=example-mcp
    - PORT=3003
  depends_on:
    redis:
      condition: service_healthy
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:3003/health"]
    interval: 10s
    timeout: 5s
    retries: 3
  restart: unless-stopped
```

## Checklist

Before considering an MCP server done:

- [ ] Zod schema for input AND output in `schemas.ts`
- [ ] Tool handler validates input, calls API via resilience stack, maps to output schema
- [ ] External API call wrapped: circuit breaker → retry → timeout (see resilience-wrapper skill)
- [ ] Express app with `POST /mcp` and `GET /health`
- [ ] Entrypoint in `src/entrypoints/` with graceful shutdown
- [ ] HTTP server registered in shutdown registry
- [ ] Integration tests written FIRST, covering: health check, valid call, invalid input, API failure
- [ ] Docker Compose service entry with health check
- [ ] No `any` types, no `console.log`, no hardcoded secrets
- [ ] File under 200 lines
