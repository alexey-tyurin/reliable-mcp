import express from 'express';
import { loadEnv } from '../config/env.js';
import type { AgentEnv } from '../config/env.js';
import { createLogger } from '../observability/logger.js';
import { createRedisClient } from '../config/redis.js';
import { createHealthHandler } from '../utils/health.js';
import { createShutdownRegistry } from '../utils/graceful-shutdown.js';
import { createMcpClientManager } from '../mcp/client.js';
import { createSessionStore } from '../cache/session-store.js';
import type { RedisLike } from '../cache/session-store.js';
import { createAgentGraph } from '../agent/graph.js';
import type { LlmLike, LangChainTool } from '../agent/nodes.js';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseMessage } from '@langchain/core/messages';

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
    modelName: 'gpt-4o-mini',
    openAIApiKey: env.OPENAI_API_KEY,
  });
  const llm = wrapChatModel(chatModel);

  const agentGraph = createAgentGraph({
    llm,
    mcpManager,
    sessionStore,
  });

  const app = express();
  app.locals['agentGraph'] = agentGraph;

  app.get('/health', createHealthHandler('agent'));

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'Agent service ready');
  });

  registry.register('http-server', () =>
    new Promise<void>((resolve) => {
      server.close(() => { resolve(); });
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
