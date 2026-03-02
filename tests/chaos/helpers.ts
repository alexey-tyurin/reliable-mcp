import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { SignJWT } from 'jose';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseMessage } from '@langchain/core/messages';
import { Client as LangSmithClient } from 'langsmith';
import { ChaosController } from '../../src/chaos/controller.js';
import { createWeatherMcpServer } from '../../src/mcp/weather-server.js';
import { createFlightMcpServer } from '../../src/mcp/flight-server.js';
import { createMcpClientManager } from '../../src/mcp/client.js';
import type { McpClientManager } from '../../src/mcp/client.js';
import { createAgentGraph } from '../../src/agent/graph.js';
import { createAgentApp } from '../../src/agent/agent-http.js';
import { createSessionStore } from '../../src/cache/session-store.js';
import type { RedisLike } from '../../src/cache/session-store.js';
import type { LlmLike, LangChainTool } from '../../src/agent/nodes.js';
import type { LangSmithClientLike } from '../../src/observability/langsmith.js';
import { createLogger } from '../../src/observability/logger.js';

const MOCK_WEATHER_API_RESPONSE = {
  location: { name: 'London', country: 'United Kingdom' },
  current: {
    temp_c: 15.2,
    temp_f: 59.4,
    condition: { text: 'Partly cloudy' },
    humidity: 72,
  },
};

const TEST_SECRET = 'test-chaos-secret-at-least-32-chars-long!';
const logger = createLogger('chaos-test');

export interface ChatResponse {
  status: number;
  body: Record<string, unknown>;
  latencyMs: number;
}

export interface CallLog {
  component: string;
  action: string;
  timestamp: number;
  details?: Record<string, unknown>;
}

export interface ChaosTestHarness {
  agentBaseUrl: string;
  testToken: string;
  chaos: ChaosController;
  callLogs: CallLog[];
  mcpManager: McpClientManager;
  cleanup: () => Promise<void>;
}

function createMockWeatherFetch(callLogs: CallLog[]): typeof fetch {
  return async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    callLogs.push({
      component: 'weather-api',
      action: 'fetch',
      timestamp: Date.now(),
      details: { url: String(input) },
    });
    logger.info({ url: String(input) }, '[CHAOS-TEST] Weather API fetch called');
    return new Response(JSON.stringify(MOCK_WEATHER_API_RESPONSE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function wrapChatModel(chatModel: ChatOpenAI, callLogs: CallLog[]): LlmLike {
  return {
    invoke: async (messages: BaseMessage[]): Promise<BaseMessage> => {
      callLogs.push({
        component: 'llm',
        action: 'invoke',
        timestamp: Date.now(),
        details: { messageCount: messages.length },
      });
      logger.info({ messageCount: messages.length }, '[CHAOS-TEST] LLM invoke called');
      return await chatModel.invoke(messages);
    },
    bindTools: (tools: LangChainTool[]): LlmLike => {
      callLogs.push({
        component: 'llm',
        action: 'bindTools',
        timestamp: Date.now(),
        details: { toolCount: tools.length, toolNames: tools.map((t) => t.function.name) },
      });
      logger.info({ toolNames: tools.map((t) => t.function.name) }, '[CHAOS-TEST] LLM bindTools called');
      const bound = chatModel.bindTools(tools);
      return {
        invoke: async (messages: BaseMessage[]): Promise<BaseMessage> => {
          callLogs.push({
            component: 'llm',
            action: 'invoke-with-tools',
            timestamp: Date.now(),
            details: { messageCount: messages.length },
          });
          logger.info({ messageCount: messages.length }, '[CHAOS-TEST] LLM invoke-with-tools called');
          return await bound.invoke(messages);
        },
        bindTools: (): LlmLike => {
          throw new Error('Cannot rebind tools on already-bound model');
        },
      };
    },
  };
}

function createMockRedis(): RedisLike {
  const store = new Map<string, { value: string; expiresAt: number | null }>();

  return {
    status: 'ready',
    get: async (key: string): Promise<string | null> => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    set: async (key: string, value: string, _mode: string, ttl: number): Promise<unknown> => {
      store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
      return 'OK';
    },
  };
}

let sharedHarness: ChaosTestHarness | null = null;

export async function getSharedHarness(): Promise<ChaosTestHarness> {
  if (!sharedHarness) {
    sharedHarness = await createChaosTestHarness();
  }
  return sharedHarness;
}

export async function cleanupSharedHarness(): Promise<void> {
  if (sharedHarness) {
    await sharedHarness.cleanup();
    sharedHarness = null;
  }
}

async function createChaosTestHarness(): Promise<ChaosTestHarness> {
  process.env['CHAOS_ENABLED'] = 'true';
  process.env['NODE_ENV'] = 'test';

  ChaosController.reset();
  const chaos = ChaosController.getInstance();
  const callLogs: CallLog[] = [];

  const mockWeatherFetch = createMockWeatherFetch(callLogs);
  const { app: weatherApp } = await createWeatherMcpServer({
    weatherApiKey: 'test-chaos-key',
    fetchFn: mockWeatherFetch,
    retryOptions: { maxRetries: 1 },
    timeoutMs: 5000,
  });
  const weatherServer: Server = weatherApp.listen(0);
  const weatherPort = (weatherServer.address() as AddressInfo).port;
  const weatherMcpUrl = `http://localhost:${String(weatherPort)}/mcp`;

  const { app: flightApp } = await createFlightMcpServer({
    provider: 'mock',
    fixturesDir: 'fixtures/flights',
  });
  const flightServer: Server = flightApp.listen(0);
  const flightPort = (flightServer.address() as AddressInfo).port;
  const flightMcpUrl = `http://localhost:${String(flightPort)}/mcp`;

  logger.info(
    { weatherMcpUrl, flightMcpUrl },
    '[CHAOS-TEST] MCP servers started on random ports',
  );

  const mcpManager = createMcpClientManager({ weatherMcpUrl, flightMcpUrl });
  await mcpManager.connect();

  const tools = await mcpManager.listAllTools();
  logger.info(
    { toolCount: tools.length, toolNames: tools.map((t) => t.name) },
    '[CHAOS-TEST] MCP client connected, tools discovered',
  );

  const openaiApiKey = process.env['OPENAI_API_KEY'];
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required for chaos tests (real LLM calls)');
  }

  const chatModel = new ChatOpenAI({
    modelName: 'gpt-4o-mini',
    openAIApiKey: openaiApiKey,
  });
  const llm = wrapChatModel(chatModel, callLogs);

  const mockRedis = createMockRedis();
  const sessionStore = createSessionStore(mockRedis);

  let langSmithClient: LangSmithClientLike | undefined;
  const langSmithApiKey = process.env['LANGSMITH_API_KEY'];
  if (langSmithApiKey) {
    langSmithClient = new LangSmithClient({ apiKey: langSmithApiKey });
    logger.info('[CHAOS-TEST] LangSmith tracing enabled');
  }

  const agentGraph = createAgentGraph({
    llm,
    mcpManager,
    sessionStore,
    langSmithClient,
  });

  const secret = new TextEncoder().encode(TEST_SECRET);
  const token = await new SignJWT({ sub: 'chaos-test-user' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret);

  const app = await createAgentApp({
    agentGraph,
    oauthSecret: TEST_SECRET,
    oauthClients: new Map([['test-client', 'test-secret']]),
    corsOrigins: ['http://localhost:3000'],
    rateLimiterPoints: 100,
    rateLimiterDuration: 60,
  });

  const agentServer: Server = app.listen(0);
  const agentPort = (agentServer.address() as AddressInfo).port;
  const agentBaseUrl = `http://localhost:${String(agentPort)}`;

  logger.info({ agentBaseUrl }, '[CHAOS-TEST] Agent server started');

  async function cleanup(): Promise<void> {
    ChaosController.reset();
    await mcpManager.disconnect();
    await Promise.all([
      new Promise<void>((resolve) => { agentServer.close(() => { resolve(); }); }),
      new Promise<void>((resolve) => { weatherServer.close(() => { resolve(); }); }),
      new Promise<void>((resolve) => { flightServer.close(() => { resolve(); }); }),
    ]);
    logger.info('[CHAOS-TEST] All servers shut down');
  }

  return {
    agentBaseUrl,
    testToken: token,
    chaos,
    callLogs,
    mcpManager,
    cleanup,
  };
}

export async function sendChatRequest(
  baseUrl: string,
  token: string,
  query: string,
  sessionId = 'chaos-test',
): Promise<ChatResponse> {
  const start = Date.now();
  const response = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ message: query, sessionId }),
  });

  const body = await response.json() as Record<string, unknown>;

  return {
    status: response.status,
    body,
    latencyMs: Date.now() - start,
  };
}

export function assertNoStackTrace(response: ChatResponse): void {
  const bodyString = JSON.stringify(response.body);
  const stackTracePattern = /at\s+\w+\s+\(.*:\d+:\d+\)/;
  if (stackTracePattern.test(bodyString)) {
    throw new Error(`Stack trace found in response: ${bodyString}`);
  }
}

export function getCallsByComponent(callLogs: CallLog[], component: string): CallLog[] {
  return callLogs.filter((log) => log.component === component);
}

export function assertComponentCalled(callLogs: CallLog[], component: string): void {
  const calls = getCallsByComponent(callLogs, component);
  if (calls.length === 0) {
    throw new Error(`Expected component '${component}' to be called, but it was not. Logged components: ${[...new Set(callLogs.map((l) => l.component))].join(', ')}`);
  }
}

