import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { McpClientManager, McpToolResult } from '../../src/mcp/client.js';
import type { AgentState } from '../../src/agent/state.js';

function createMockLlm(): {
  invoke: ReturnType<typeof vi.fn>;
  bindTools: ReturnType<typeof vi.fn>;
} {
  const mockInvoke = vi.fn();
  return {
    invoke: mockInvoke,
    bindTools: vi.fn().mockReturnValue({ invoke: mockInvoke }),
  };
}

function createMockMcpManager(): McpClientManager {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn().mockResolvedValue({
      toolName: 'get_weather',
      content: '{"city":"London","temperature":15}',
      isError: false,
    }),
    listAllTools: vi.fn().mockResolvedValue([
      {
        name: 'get_weather',
        description: 'Get current weather temperature for a city',
        inputSchema: {
          type: 'object',
          properties: {
            city: { type: 'string' },
            units: { type: 'string', enum: ['celsius', 'fahrenheit'] },
          },
          required: ['city'],
        },
      },
      {
        name: 'get_flight_status',
        description: 'Get flight status by flight number',
        inputSchema: {
          type: 'object',
          properties: {
            flight_number: { type: 'string' },
            date: { type: 'string' },
          },
          required: ['flight_number'],
        },
      },
    ]),
  };
}

function createBaseState(overrides?: Partial<AgentState>): AgentState {
  return {
    messages: [new HumanMessage('What is the weather in London?')],
    userId: 'user1',
    sessionId: 'session1',
    toolResults: [],
    error: null,
    ...overrides,
  };
}

describe('Agent Nodes', () => {
  let createRouteNode: typeof import('../../src/agent/nodes.js').createRouteNode;
  let createExecuteToolsNode: typeof import('../../src/agent/nodes.js').createExecuteToolsNode;
  let createRespondNode: typeof import('../../src/agent/nodes.js').createRespondNode;
  let shouldExecuteTools: typeof import('../../src/agent/nodes.js').shouldExecuteTools;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../src/agent/nodes.js');
    createRouteNode = mod.createRouteNode;
    createExecuteToolsNode = mod.createExecuteToolsNode;
    createRespondNode = mod.createRespondNode;
    shouldExecuteTools = mod.shouldExecuteTools;
  });

  describe('routeNode', () => {
    it('calls LLM with messages and returns AI message', async () => {
      const mockLlm = createMockLlm();
      const mockManager = createMockMcpManager();
      const aiMessage = new AIMessage('The weather in London is...');
      mockLlm.invoke.mockResolvedValue(aiMessage);

      const routeNode = createRouteNode(mockLlm, mockManager);
      const state = createBaseState();
      const result = await routeNode(state);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toBe(aiMessage);
    });

    it('binds MCP tools to the LLM', async () => {
      const mockLlm = createMockLlm();
      const mockManager = createMockMcpManager();
      const aiMessage = new AIMessage('Let me check that for you.');
      mockLlm.invoke.mockResolvedValue(aiMessage);

      const routeNode = createRouteNode(mockLlm, mockManager);
      await routeNode(createBaseState());

      expect(mockLlm.bindTools).toHaveBeenCalledTimes(1);
      const toolArgs = mockLlm.bindTools.mock.calls[0] as [unknown[]];
      expect(toolArgs[0]).toHaveLength(2);
    });

    it('returns error state when LLM call fails', async () => {
      const mockLlm = createMockLlm();
      const mockManager = createMockMcpManager();
      mockLlm.invoke.mockRejectedValue(new Error('LLM unavailable'));

      const routeNode = createRouteNode(mockLlm, mockManager);
      const result = await routeNode(createBaseState());

      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('LLM_ROUTE_FAILED');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.content).toContain('trouble processing');
    });
  });

  describe('shouldExecuteTools', () => {
    it('returns "execute_tools" when last message has tool calls', () => {
      const aiMessage = new AIMessage({
        content: '',
        tool_calls: [{ name: 'get_weather', args: { city: 'London' }, id: 'call_1', type: 'tool_call' }],
      });
      const state = createBaseState({ messages: [new HumanMessage('hello'), aiMessage] });

      expect(shouldExecuteTools(state)).toBe('execute_tools');
    });

    it('returns "respond" when last message has no tool calls', () => {
      const aiMessage = new AIMessage('Here is the answer.');
      const state = createBaseState({ messages: [new HumanMessage('hello'), aiMessage] });

      expect(shouldExecuteTools(state)).toBe('respond');
    });

    it('returns "respond" when last message is not an AI message', () => {
      const state = createBaseState();

      expect(shouldExecuteTools(state)).toBe('respond');
    });

    it('returns "respond" when error is present', () => {
      const state = createBaseState({
        error: { message: 'Something failed', code: 'LLM_ROUTE_FAILED' },
      });

      expect(shouldExecuteTools(state)).toBe('respond');
    });
  });

  describe('executeToolsNode', () => {
    it('executes all tool calls from the last AI message', async () => {
      const mockManager = createMockMcpManager();
      const aiMessage = new AIMessage({
        content: '',
        tool_calls: [
          { name: 'get_weather', args: { city: 'London' }, id: 'call_1', type: 'tool_call' },
        ],
      });
      const state = createBaseState({
        messages: [new HumanMessage('Weather in London?'), aiMessage],
      });

      const executeToolsNode = createExecuteToolsNode(mockManager);
      const result = await executeToolsNode(state);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toBeInstanceOf(ToolMessage);
      expect((result.messages[0] as ToolMessage).content).toBe('{"city":"London","temperature":15}');
      expect(result.toolResults).toHaveLength(1);
    });

    it('executes multiple tool calls in parallel for combined queries', async () => {
      const mockManager = createMockMcpManager();
      const callToolFn = mockManager.callTool as ReturnType<typeof vi.fn>;
      callToolFn.mockImplementation(
        async (call: { name: string }): Promise<McpToolResult> => {
          if (call.name === 'get_weather') {
            return { toolName: 'get_weather', content: '{"temperature":15}', isError: false };
          }
          return { toolName: 'get_flight_status', content: '{"status":"on_time"}', isError: false };
        },
      );

      const aiMessage = new AIMessage({
        content: '',
        tool_calls: [
          { name: 'get_weather', args: { city: 'London' }, id: 'call_1', type: 'tool_call' },
          { name: 'get_flight_status', args: { flight_number: 'UA123' }, id: 'call_2', type: 'tool_call' },
        ],
      });
      const state = createBaseState({
        messages: [new HumanMessage('Weather in London and flight UA123?'), aiMessage],
      });

      const executeToolsNode = createExecuteToolsNode(mockManager);
      const result = await executeToolsNode(state);

      expect(result.messages).toHaveLength(2);
      expect(result.toolResults).toHaveLength(2);
      expect(callToolFn).toHaveBeenCalledTimes(2);
    });

    it('handles tool execution failure gracefully', async () => {
      const mockManager = createMockMcpManager();
      const callToolFn = mockManager.callTool as ReturnType<typeof vi.fn>;
      callToolFn.mockResolvedValue({
        toolName: 'get_weather',
        content: 'Weather data is temporarily unavailable.',
        isError: true,
      });

      const aiMessage = new AIMessage({
        content: '',
        tool_calls: [
          { name: 'get_weather', args: { city: 'London' }, id: 'call_1', type: 'tool_call' },
        ],
      });
      const state = createBaseState({
        messages: [new HumanMessage('Weather?'), aiMessage],
      });

      const executeToolsNode = createExecuteToolsNode(mockManager);
      const result = await executeToolsNode(state);

      expect(result.messages).toHaveLength(1);
      const toolMsg = result.messages[0] as ToolMessage;
      expect(toolMsg.content).toContain('temporarily unavailable');
      expect(result.toolResults[0]?.isError).toBe(true);
    });
  });

  describe('respondNode', () => {
    it('calls LLM to generate final response from tool results', async () => {
      const mockLlm = createMockLlm();
      const finalResponse = new AIMessage('The weather in London is 15°C, partly cloudy.');
      mockLlm.invoke.mockResolvedValue(finalResponse);

      const respondNode = createRespondNode(mockLlm);

      const aiMessage = new AIMessage({
        content: '',
        tool_calls: [
          { name: 'get_weather', args: { city: 'London' }, id: 'call_1', type: 'tool_call' },
        ],
      });
      const toolMessage = new ToolMessage({
        content: '{"city":"London","temperature":15}',
        tool_call_id: 'call_1',
      });

      const state = createBaseState({
        messages: [
          new HumanMessage('Weather in London?'),
          aiMessage,
          toolMessage,
        ] as BaseMessage[],
      });

      const result = await respondNode(state);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.content).toContain('weather in London');
    });

    it('returns error message when LLM fails during respond', async () => {
      const mockLlm = createMockLlm();
      mockLlm.invoke.mockRejectedValue(new Error('LLM unavailable'));

      const respondNode = createRespondNode(mockLlm);
      const result = await respondNode(createBaseState());

      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('LLM_RESPOND_FAILED');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.content).toContain('trouble processing');
    });
  });
});
