import { loadEnv } from '../config/env.js';
import type { AgentEnv } from '../config/env.js';
import { createLogger } from '../observability/logger.js';
import { createRedisClient } from '../config/redis.js';
import { createShutdownRegistry } from '../utils/graceful-shutdown.js';
import { createMcpClientManager } from '../mcp/client.js';
import { createSessionStore } from '../cache/session-store.js';
import type { RedisLike } from '../cache/session-store.js';
import { createAgentGraph } from '../agent/graph.js';
import { createAgentApp } from '../agent/agent-http.js';
import type { LlmLike, LangChainTool } from '../agent/nodes.js';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseMessage } from '@langchain/core/messages';
import { Client as LangSmithClient } from 'langsmith';

const CORS_ORIGINS = ['http://localhost:3000'];
const RATE_LIMITER_POINTS = 30;
const RATE_LIMITER_DURATION = 60;
const CONNECTION_DRAIN_TIMEOUT = 5000;

function wrapChatModel(chatModel: ChatOpenAI): LlmLike {
  return {
    invoke: async (messages: BaseMessage[]): Promise<BaseMessage> => {
      return await chatModel.invoke(messages);
    },
    bindTools: (tools: LangChainTool[]): LlmLike => {
      const bound = chatModel.bindTools(tools);
      return {
        invoke: async (messages: BaseMessage[]): Promise<BaseMessage> => {
          return await bound.invoke(messages);
        },
        bindTools: (): LlmLike => {
          throw new Error('Cannot rebind tools on already-bound model');
        },
      };
    },
  };
}

async function main(): Promise<void> {
  const env = loadEnv() as AgentEnv;
  const logger = createLogger('agent');
  const registry = createShutdownRegistry();

  const redis = createRedisClient(env.REDIS_URL);
  try {
    await redis.connect();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ error: message }, 'Redis connection failed, starting in degraded mode');
  }

  const sessionStore = createSessionStore(redis as unknown as RedisLike);

  const mcpManager = createMcpClientManager({
    weatherMcpUrl: env.WEATHER_MCP_URL,
    flightMcpUrl: env.FLIGHT_MCP_URL,
  });

  try {
    await mcpManager.connect();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ error: message }, 'MCP client connection failed, some tools may be unavailable');
  }

  const chatModel = new ChatOpenAI({
    modelName: 'gpt-5-nano',
    openAIApiKey: env.OPENAI_API_KEY,
  });
  const llm = wrapChatModel(chatModel);

  const langSmithClient = env.LANGSMITH_API_KEY
    ? new LangSmithClient({ apiKey: env.LANGSMITH_API_KEY })
    : undefined;

  const graphConfig: Parameters<typeof createAgentGraph>[0] = {
    llm,
    mcpManager,
    sessionStore,
  };

  if (langSmithClient) {
    graphConfig.langSmithClient = langSmithClient;
  }

  const agentGraph = createAgentGraph(graphConfig);

  const oauthClients = new Map<string, string>([
    ['default-client', env.OAUTH_SECRET],
  ]);

  const app = await createAgentApp({
    agentGraph,
    oauthSecret: env.OAUTH_SECRET,
    oauthClients,
    corsOrigins: CORS_ORIGINS,
    rateLimiterPoints: RATE_LIMITER_POINTS,
    rateLimiterDuration: RATE_LIMITER_DURATION,
  });

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'Agent service ready');
  });

  registry.register('http-server', () =>
    new Promise<void>((resolve) => {
      server.close(() => { resolve(); });
      setTimeout(() => { resolve(); }, CONNECTION_DRAIN_TIMEOUT);
    }),
  );
  registry.register('mcp-client', async () => {
    await mcpManager.disconnect();
  });
  registry.register('redis', async () => {
    await redis.quit();
  });
  registry.register('logger', () => {
    logger.flush();
  });

  registry.onShutdown();

  logger.info('Agent graph initialized, ready to process requests');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`Fatal startup error: ${message}`);
  process.exit(1);
});
