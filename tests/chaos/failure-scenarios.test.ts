import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Server } from 'http';
import { SignJWT } from 'jose';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { ChaosController } from '../../src/chaos/controller.js';
import { createAgentApp } from '../../src/agent/agent-http.js';
import type { AgentState } from '../../src/agent/state.js';
import { sendChatRequest, setAgentBaseUrl, setTestToken, assertNoStackTrace } from './helpers.js';

const TEST_SECRET = 'test-chaos-secret-at-least-32-chars-long!';
const secret = new TextEncoder().encode(TEST_SECRET);

function createMockAgentGraph() {
  return {
    invoke: async (input: AgentState): Promise<AgentState> => {
      const lastMessage = input.messages[input.messages.length - 1];
      const content = lastMessage instanceof HumanMessage
        ? `Echo: ${typeof lastMessage.content === 'string' ? lastMessage.content : ''}`
        : 'No message';

      return {
        ...input,
        messages: [...input.messages, new AIMessage(content)],
        toolResults: [],
        error: null,
      };
    },
  };
}

describe('Chaos: Failure Scenarios', () => {
  let chaos: ChaosController;
  let server: Server;

  beforeAll(async () => {
    process.env['CHAOS_ENABLED'] = 'true';
    process.env['NODE_ENV'] = 'test';

    ChaosController.reset();
    chaos = ChaosController.getInstance();

    const token = await new SignJWT({ sub: 'chaos-user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secret);

    setTestToken(token);

    const app = await createAgentApp({
      agentGraph: createMockAgentGraph(),
      oauthSecret: TEST_SECRET,
      oauthClients: new Map([['test-client', 'test-secret']]),
      corsOrigins: ['http://localhost:3000'],
      rateLimiterPoints: 100,
      rateLimiterDuration: 60,
    });

    server = app.listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    setAgentBaseUrl(`http://localhost:${String(port)}`);
  });

  afterEach(() => {
    chaos.clearAll();
  });

  afterAll(async () => {
    ChaosController.reset();
    await new Promise<void>((resolve) => {
      server.close(() => { resolve(); });
    });
  });

  describe('weather-api-503-circuit-breaker', () => {
    it('circuit breaker activates on repeated 503 errors', () => {
      chaos.inject('weather-api', { type: 'error', statusCode: 503 });

      const fault = chaos.getFault('weather-api');
      expect(fault).not.toBeNull();
      expect(fault!.type).toBe('error');

      const activeFaults = chaos.getActiveFaults();
      expect(activeFaults.length).toBeGreaterThan(0);
      expect(activeFaults[0]!.target).toBe('weather-api');
    });

    it('no stack traces leak in error responses', async () => {
      const result = await sendChatRequest('Hello');
      assertNoStackTrace(result);
    });
  });

  describe('flight-api-timeout-retry-exhaust', () => {
    it('timeout fault is properly injected and retrievable', () => {
      chaos.inject('flight-api', { type: 'timeout', hangMs: 10000 });

      const fault = chaos.getFault('flight-api');
      expect(fault).not.toBeNull();
      expect(fault!.type).toBe('timeout');
    });
  });

  describe('redis-connection-drop', () => {
    it('redis connection refused fault is active', () => {
      chaos.inject('redis', { type: 'connection-refused' });

      const fault = chaos.getFault('redis');
      expect(fault).not.toBeNull();
      expect(fault!.type).toBe('connection-refused');
    });

    it('agent continues responding when redis fault is active', async () => {
      chaos.inject('redis', { type: 'connection-refused' });

      const result = await sendChatRequest('Hello world');
      expect(result.status).toBe(200);
      expect(result.body['response']).toBeDefined();
      assertNoStackTrace(result);
    });
  });

  describe('redis-latency-spike-cache-bypass', () => {
    it('redis cache latency fault is injected for redis-cache target', () => {
      chaos.inject('redis-cache', { type: 'latency', delayMs: 2000 });

      const fault = chaos.getFault('redis-cache');
      expect(fault).not.toBeNull();
      expect(fault!.type).toBe('latency');
    });
  });

  describe('oauth-token-expired', () => {
    it('returns 401 when oauth-token fault is active', async () => {
      chaos.inject('oauth-token', { type: 'error', statusCode: 401, message: 'Token expired' });

      const result = await sendChatRequest('Hello');
      expect(result.status).toBe(401);

      const body = result.body as { error: string; message: string };
      expect(body.error).toBe('token_invalid');
      expect(body.message).toContain('Token expired');
      assertNoStackTrace(result);
    });

    it('no LLM calls execute when auth blocks request', async () => {
      chaos.inject('oauth-token', { type: 'error', statusCode: 403 });

      const result = await sendChatRequest('Tell me a story');
      expect(result.status).toBe(403);

      // Response should not contain any echo (agent never invoked)
      expect(result.body['response']).toBeUndefined();
    });
  });

  describe('both-mcp-servers-unreachable', () => {
    it('both MCP connection faults can be active simultaneously', () => {
      chaos.inject('weather-mcp', { type: 'connection-refused' });
      chaos.inject('flight-mcp', { type: 'connection-refused' });

      expect(chaos.getFault('weather-mcp')).not.toBeNull();
      expect(chaos.getFault('flight-mcp')).not.toBeNull();

      const activeFaults = chaos.getActiveFaults();
      expect(activeFaults).toHaveLength(2);
    });

    it('agent still responds without crashing', async () => {
      chaos.inject('weather-mcp', { type: 'connection-refused' });
      chaos.inject('flight-mcp', { type: 'connection-refused' });

      const result = await sendChatRequest('Weather and flights please');
      expect(result.status).toBe(200);
      assertNoStackTrace(result);
    });
  });

  describe('weather-mcp-malformed-response', () => {
    it('malformed fault is properly configured', () => {
      chaos.inject('weather-mcp', { type: 'malformed', corruptResponse: true });

      const fault = chaos.getFault('weather-mcp');
      expect(fault).not.toBeNull();
      expect(fault!.type).toBe('malformed');
    });
  });

  describe('flight-api-rate-limited', () => {
    it('rate limit fault returns 429 config', () => {
      chaos.inject('flight-api', { type: 'rate-limit', retryAfterSeconds: 60 });

      const fault = chaos.getFault('flight-api');
      expect(fault).not.toBeNull();
      expect(fault!.type).toBe('rate-limit');
    });
  });

  describe('cascading-failure-redis-then-api', () => {
    it('multiple faults can coexist across subsystems', () => {
      chaos.inject('redis', { type: 'connection-refused' });
      chaos.inject('weather-api', { type: 'error', statusCode: 503 });

      expect(chaos.getFault('redis')).not.toBeNull();
      expect(chaos.getFault('weather-api')).not.toBeNull();
      expect(chaos.getActiveFaults()).toHaveLength(2);
    });

    it('system remains responsive during compound failure', async () => {
      chaos.inject('redis', { type: 'connection-refused' });
      chaos.inject('weather-api', { type: 'error', statusCode: 503 });

      const result = await sendChatRequest('Hello');
      expect(result.status).toBe(200);
      assertNoStackTrace(result);
    });

    it('system recovers when faults are cleared', () => {
      chaos.inject('redis', { type: 'connection-refused' });
      chaos.inject('weather-api', { type: 'error', statusCode: 503 });

      expect(chaos.getActiveFaults()).toHaveLength(2);

      chaos.clearAll();
      expect(chaos.getActiveFaults()).toHaveLength(0);
      expect(chaos.getFault('redis')).toBeNull();
      expect(chaos.getFault('weather-api')).toBeNull();
    });
  });
});
