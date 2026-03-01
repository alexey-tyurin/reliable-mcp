import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { Server } from 'http';
import { SignJWT } from 'jose';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { ChaosController } from '../../src/chaos/controller.js';
import { createAgentApp } from '../../src/agent/agent-http.js';
import type { AgentState } from '../../src/agent/state.js';
import { sendChatRequest, setAgentBaseUrl, setTestToken, assertNoStackTrace } from './helpers.js';

const TEST_SECRET = 'test-recovery-secret-at-least-32-chars-long!';
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

describe('Chaos: Recovery Scenarios', () => {
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

  describe('weather API recovery', () => {
    it('time-bounded fault expires automatically', () => {
      vi.useFakeTimers();

      chaos.inject('weather-api', { type: 'error', statusCode: 503 }, 5000);

      expect(chaos.getFault('weather-api')).not.toBeNull();

      vi.advanceTimersByTime(5100);

      expect(chaos.getFault('weather-api')).toBeNull();

      vi.useRealTimers();
    });

    it('service resumes after fault is manually cleared', async () => {
      const faultId = chaos.inject('weather-api', { type: 'error', statusCode: 503 });

      expect(chaos.getFault('weather-api')).not.toBeNull();

      chaos.clear(faultId);

      expect(chaos.getFault('weather-api')).toBeNull();

      const result = await sendChatRequest('Hello after recovery');
      expect(result.status).toBe(200);
      assertNoStackTrace(result);
    });
  });

  describe('Redis recovery', () => {
    it('Redis fault clears and operations resume', async () => {
      const faultId = chaos.inject('redis', { type: 'connection-refused' });

      const duringFault = await sendChatRequest('During Redis down');
      expect(duringFault.status).toBe(200);

      chaos.clear(faultId);
      expect(chaos.getFault('redis')).toBeNull();

      const afterRecovery = await sendChatRequest('After Redis recovery');
      expect(afterRecovery.status).toBe(200);
      assertNoStackTrace(afterRecovery);
    });
  });

  describe('compound failure recovery', () => {
    it('full service restored when all faults are cleared', async () => {
      const redisFault = chaos.inject('redis', { type: 'connection-refused' });
      const weatherFault = chaos.inject('weather-api', { type: 'error', statusCode: 503 });

      expect(chaos.getActiveFaults()).toHaveLength(2);

      const duringFailure = await sendChatRequest('During compound failure');
      expect(duringFailure.status).toBe(200);

      chaos.clear(redisFault);
      chaos.clear(weatherFault);

      expect(chaos.getActiveFaults()).toHaveLength(0);

      const afterRecovery = await sendChatRequest('After compound recovery');
      expect(afterRecovery.status).toBe(200);
      assertNoStackTrace(afterRecovery);
    });

    it('partial recovery restores cleared subsystems', () => {
      const redisFault = chaos.inject('redis', { type: 'connection-refused' });
      chaos.inject('weather-api', { type: 'error', statusCode: 503 });

      chaos.clear(redisFault);

      expect(chaos.getFault('redis')).toBeNull();
      expect(chaos.getFault('weather-api')).not.toBeNull();
      expect(chaos.getActiveFaults()).toHaveLength(1);
    });
  });

  describe('auth recovery', () => {
    it('auth resumes after token fault is cleared', async () => {
      const faultId = chaos.inject('oauth-token', {
        type: 'error',
        statusCode: 401,
        message: 'Token expired',
      });

      const duringFault = await sendChatRequest('During auth failure');
      expect(duringFault.status).toBe(401);

      chaos.clear(faultId);

      const afterRecovery = await sendChatRequest('After auth recovery');
      expect(afterRecovery.status).toBe(200);
      expect(afterRecovery.body['response']).toBeDefined();
    });
  });
});
