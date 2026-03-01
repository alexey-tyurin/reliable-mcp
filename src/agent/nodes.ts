import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { McpClientManager, McpToolDefinition } from '../mcp/client.js';
import type { AgentState, ToolResult } from './state.js';
import { createLogger } from '../observability/logger.js';

const SYSTEM_PROMPT = `You are a helpful travel assistant that can check weather conditions and flight statuses.
When asked about weather, use the get_weather tool with the city name.
When asked about flight status, use the get_flight_status tool with the flight number.
When asked about both weather and flight in a single question, call both tools.
Always provide clear, concise answers based on the tool results.`;

export interface LlmLike {
  invoke: (messages: BaseMessage[]) => Promise<BaseMessage>;
  bindTools: (tools: LangChainTool[]) => LlmLike;
}

export interface LangChainTool {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ToolCallInfo {
  name: string;
  args: Record<string, unknown>;
  id: string;
}

interface RouteResult {
  messages: BaseMessage[];
  error?: { message: string; code: string } | null;
}

interface ExecuteToolsResult {
  messages: BaseMessage[];
  toolResults: ToolResult[];
}

interface RespondResult {
  messages: BaseMessage[];
  error?: { message: string; code: string } | null;
}

const logger = createLogger('agent-nodes');

function convertToLangChainTools(tools: McpToolDefinition[]): LangChainTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function getToolCallsFromLastMessage(messages: BaseMessage[]): ToolCallInfo[] {
  const lastMessage = messages[messages.length - 1];

  if (!lastMessage || !(lastMessage instanceof AIMessage)) {
    return [];
  }

  const toolCalls = lastMessage.tool_calls;
  if (!toolCalls || toolCalls.length === 0) {
    return [];
  }

  return toolCalls.map((call) => ({
    name: call.name,
    args: call.args as Record<string, unknown>,
    id: call.id ?? '',
  }));
}

export function createRouteNode(
  llm: LlmLike,
  mcpManager: McpClientManager,
): (state: AgentState) => Promise<RouteResult> {
  return async function routeNode(state: AgentState): Promise<RouteResult> {
    try {
      const tools = await mcpManager.listAllTools();
      const langchainTools = convertToLangChainTools(tools);
      const boundLlm = llm.bindTools(langchainTools);

      const systemMessage = { role: 'system', content: SYSTEM_PROMPT };
      const messagesWithSystem = [systemMessage, ...state.messages] as BaseMessage[];

      const response = await boundLlm.invoke(messagesWithSystem);

      return { messages: [response] };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'Route node LLM call failed');

      return {
        messages: [new AIMessage("I'm having trouble processing your request. Please try again.")],
        error: { message, code: 'LLM_ROUTE_FAILED' },
      };
    }
  };
}

export function shouldExecuteTools(state: AgentState): 'execute_tools' | 'respond' {
  if (state.error) {
    return 'respond';
  }

  const toolCalls = getToolCallsFromLastMessage(state.messages);
  return toolCalls.length > 0 ? 'execute_tools' : 'respond';
}

export function createExecuteToolsNode(
  mcpManager: McpClientManager,
): (state: AgentState) => Promise<ExecuteToolsResult> {
  return async function executeToolsNode(state: AgentState): Promise<ExecuteToolsResult> {
    const toolCalls = getToolCallsFromLastMessage(state.messages);

    const resultPromises = toolCalls.map(async (call) => {
      const mcpResult = await mcpManager.callTool({
        name: call.name,
        arguments: call.args,
      });

      const toolMessage = new ToolMessage({
        content: mcpResult.content,
        tool_call_id: call.id,
      });

      const toolResult: ToolResult = {
        toolName: mcpResult.toolName,
        content: mcpResult.content,
        isError: mcpResult.isError,
      };

      return { toolMessage, toolResult };
    });

    const results = await Promise.all(resultPromises);

    return {
      messages: results.map((r) => r.toolMessage as BaseMessage),
      toolResults: results.map((r) => r.toolResult),
    };
  };
}

export function createRespondNode(
  llm: LlmLike,
): (state: AgentState) => Promise<RespondResult> {
  return async function respondNode(state: AgentState): Promise<RespondResult> {
    try {
      const systemMessage = { role: 'system', content: SYSTEM_PROMPT };
      const messagesWithSystem = [systemMessage, ...state.messages] as BaseMessage[];

      const response = await llm.invoke(messagesWithSystem);

      return { messages: [response] };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'Respond node LLM call failed');

      return {
        messages: [new AIMessage("I'm having trouble processing your request. Please try again.")],
        error: { message, code: 'LLM_RESPOND_FAILED' },
      };
    }
  };
}
