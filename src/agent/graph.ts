import { StateGraph, START, END } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import { AgentAnnotation } from './state.js';
import type { AgentState } from './state.js';
import {
  createRouteNode,
  createExecuteToolsNode,
  createRespondNode,
  shouldExecuteTools,
} from './nodes.js';
import type { LlmLike } from './nodes.js';
import type { McpClientManager } from '../mcp/client.js';
import type { SessionStore } from '../cache/session-store.js';
import { createLogger } from '../observability/logger.js';
import { createTracedInvoke } from '../observability/langsmith.js';
import type { LangSmithClientLike } from '../observability/langsmith.js';
import type { MetricsTracker } from '../observability/metrics.js';

export interface AgentGraphConfig {
  llm: LlmLike;
  mcpManager: McpClientManager;
  sessionStore: SessionStore;
  langSmithClient?: LangSmithClientLike;
  metricsTracker?: MetricsTracker;
}

export interface InvokeOptions {
  cacheHit?: boolean;
}

interface CompiledAgentGraph {
  invoke: (input: AgentState, options?: InvokeOptions) => Promise<AgentState>;
}

const logger = createLogger('agent-graph');

export function createAgentGraph(config: AgentGraphConfig): CompiledAgentGraph {
  const routeNode = createRouteNode(config.llm, config.mcpManager);
  const executeToolsNode = createExecuteToolsNode(config.mcpManager);
  const respondNode = createRespondNode(config.llm);

  const graph = new StateGraph(AgentAnnotation)
    .addNode('route', routeNode)
    .addNode('execute_tools', executeToolsNode)
    .addNode('respond', respondNode)
    .addEdge(START, 'route')
    .addConditionalEdges('route', shouldExecuteTools, {
      execute_tools: 'execute_tools',
      respond: 'respond',
    })
    .addEdge('execute_tools', 'respond')
    .addEdge('respond', END);

  const compiled = graph.compile();

  async function coreInvoke(input: AgentState): Promise<AgentState> {
    const previousMessages = await loadSessionMessages(
      config.sessionStore,
      input.userId,
      input.sessionId,
    );

    const inputWithHistory: AgentState = {
      ...input,
      messages: [...previousMessages, ...input.messages],
    };

    const result = await compiled.invoke(inputWithHistory) as AgentState;

    await saveSessionMessages(
      config.sessionStore,
      input.userId,
      input.sessionId,
      result.messages,
    );

    return result;
  }

  const tracedInvoke = config.langSmithClient
    ? createTracedInvoke(coreInvoke, config.langSmithClient)
    : null;

  return {
    invoke: async (input: AgentState, options?: InvokeOptions): Promise<AgentState> => {
      const cacheHit = options?.cacheHit ?? false;

      if (config.metricsTracker) {
        config.metricsTracker.recordCacheResult(cacheHit);
      }

      const result = tracedInvoke
        ? await tracedInvoke(input, { cacheHit })
        : await coreInvoke(input);

      if (result.error && config.metricsTracker) {
        config.metricsTracker.recordError(result.error.code);
      }

      return result;
    },
  };
}

async function loadSessionMessages(
  sessionStore: SessionStore,
  userId: string,
  sessionId: string,
): Promise<BaseMessage[]> {
  try {
    return await sessionStore.loadSession(userId, sessionId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ userId, sessionId, error: message }, 'Failed to load session');
    return [];
  }
}

async function saveSessionMessages(
  sessionStore: SessionStore,
  userId: string,
  sessionId: string,
  messages: BaseMessage[],
): Promise<void> {
  try {
    await sessionStore.saveSession(userId, sessionId, messages);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ userId, sessionId, error: message }, 'Failed to save session');
  }
}
