import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import { SignJWT } from 'jose';
import { createAgentApp } from '../../src/agent/agent-http.js';
import type { AgentAppConfig } from '../../src/agent/agent-http.js';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { AgentState } from '../../src/agent/state.js';

const TEST_SECRET = 'test-oauth-secret-at-least-32-chars-long!';
const TEST_CLIENTS = new Map([['test-client', 'test-secret']]);
const secret = new TextEncoder().encode(TEST_SECRET);

async function signTestToken(sub: string, expiresIn = '1h'): Promise<string> {
  return await new SignJWT({ sub })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
}

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

function buildConfig(overrides?: Partial<AgentAppConfig>): AgentAppConfig {
  return {
    agentGraph: createMockAgentGraph(),
    oauthSecret: TEST_SECRET,
    oauthClients: TEST_CLIENTS,
    corsOrigins: ['http://localhost:3000'],
    rateLimiterPoints: 30,
    rateLimiterDuration: 60,
    ...overrides,
  };
}

describe('Agent HTTP App', () => {
  let server: Server;
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    token = await signTestToken('test-user');
    const app = createAgentApp(buildConfig());
    server = app.listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    baseUrl = `http://localhost:${String(port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => { resolve(); });
    });
  });

  describe('GET /health', () => {
    it('returns 200 with health status', async () => {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(200);

      const body = await response.json() as { status: string; service: string };
      expect(body.status).toBe('ok');
      expect(body.service).toBe('agent');
    });
  });

  describe('POST /oauth/token', () => {
    it('returns JWT for valid credentials', async () => {
      const response = await fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: 'test-client',
          client_secret: 'test-secret',
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { access_token: string; token_type: string };
      expect(body.token_type).toBe('Bearer');
      expect(typeof body.access_token).toBe('string');
    });
  });

  describe('POST /chat', () => {
    it('returns response from agent for valid request', async () => {
      const response = await fetch(`${baseUrl}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: 'Hello',
          sessionId: 'session-1',
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { response: string };
      expect(body.response).toBe('Echo: Hello');
    });

    it('returns 401 without auth header', async () => {
      const response = await fetch(`${baseUrl}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Hello',
          sessionId: 'session-1',
        }),
      });

      expect(response.status).toBe(401);
    });

    it('returns 400 for missing message field', async () => {
      const response = await fetch(`${baseUrl}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ sessionId: 'session-1' }),
      });

      expect(response.status).toBe(400);
    });

    it('returns 400 for missing sessionId field', async () => {
      const response = await fetch(`${baseUrl}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ message: 'Hello' }),
      });

      expect(response.status).toBe(400);
    });

    it('returns 413 for oversized body', async () => {
      const largeMessage = 'x'.repeat(20000);
      const response = await fetch(`${baseUrl}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: largeMessage,
          sessionId: 'session-1',
        }),
      });

      expect(response.status).toBe(413);
    });
  });

  describe('Security headers', () => {
    it('includes helmet security headers', async () => {
      const response = await fetch(`${baseUrl}/health`);

      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit exceeded', async () => {
      const rateLimitedApp = createAgentApp(buildConfig({
        rateLimiterPoints: 2,
        rateLimiterDuration: 60,
      }));
      const rateLimitedServer = rateLimitedApp.listen(0);
      const address = rateLimitedServer.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const rlBaseUrl = `http://localhost:${String(port)}`;

      try {
        const headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        };
        const body = JSON.stringify({ message: 'Hello', sessionId: 'rl-session' });

        await fetch(`${rlBaseUrl}/chat`, { method: 'POST', headers, body });
        await fetch(`${rlBaseUrl}/chat`, { method: 'POST', headers, body });
        const thirdResponse = await fetch(`${rlBaseUrl}/chat`, { method: 'POST', headers, body });

        expect(thirdResponse.status).toBe(429);
        const responseBody = await thirdResponse.json() as { error: string };
        expect(responseBody.error).toBeDefined();
      } finally {
        await new Promise<void>((resolve) => {
          rateLimitedServer.close(() => { resolve(); });
        });
      }
    });
  });

  describe('Agent error handling', () => {
    it('returns 500 with friendly message when agent fails', async () => {
      const failingGraph = {
        invoke: async (): Promise<AgentState> => {
          throw new Error('LLM connection failed');
        },
      };

      const failApp = createAgentApp(buildConfig({ agentGraph: failingGraph }));
      const failServer = failApp.listen(0);
      const address = failServer.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const failBaseUrl = `http://localhost:${String(port)}`;

      try {
        const response = await fetch(`${failBaseUrl}/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ message: 'Hello', sessionId: 'fail-session' }),
        });

        expect(response.status).toBe(500);
        const body = await response.json() as { error: string };
        expect(body.error).toBeDefined();
        // Should not contain stack trace or internal error details
        expect(body.error).not.toContain('LLM connection failed');
      } finally {
        await new Promise<void>((resolve) => {
          failServer.close(() => { resolve(); });
        });
      }
    });
  });
});
