import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { McpClientManager } from '../../src/mcp/client.js';
import type { SessionStore } from '../../src/cache/session-store.js';
import type { LangSmithClientLike } from '../../src/observability/langsmith.js';
import type { MetricsTracker } from '../../src/observability/metrics.js';

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
        description: 'Get current weather',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ]),
    resetCircuitBreakers: vi.fn(),
  };
}

function createMockSessionStore(): SessionStore {
  return {
    loadSession: vi.fn().mockResolvedValue([]),
    saveSession: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockLangSmithClient(): LangSmithClientLike & {
  createRun: ReturnType<typeof vi.fn>;
  updateRun: ReturnType<typeof vi.fn>;
} {
  return {
    createRun: vi.fn().mockResolvedValue(undefined),
    updateRun: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockMetricsTracker(): MetricsTracker & {
  recordError: ReturnType<typeof vi.fn>;
  recordCacheResult: ReturnType<typeof vi.fn>;
  recordCircuitBreakerTransition: ReturnType<typeof vi.fn>;
} {
  return {
    recordError: vi.fn(),
    getErrorCounts: vi.fn().mockReturnValue(new Map()),
    recordCacheResult: vi.fn(),
    getCacheHitRate: vi.fn().mockReturnValue(0),
    recordCircuitBreakerTransition: vi.fn(),
    getCircuitBreakerTransitions: vi.fn().mockReturnValue([]),
    getSnapshot: vi.fn().mockReturnValue({
      errorCounts: new Map(),
      cacheHitRate: 0,
      circuitBreakerTransitions: [],
    }),
  };
}

describe('Agent Graph', () => {
  let createAgentGraph: typeof import('../../src/agent/graph.js').createAgentGraph;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../src/agent/graph.js');
    createAgentGraph = mod.createAgentGraph;
  });

  describe('createAgentGraph', () => {
    it('creates a compiled graph', () => {
      const mockLlm = createMockLlm();
      const mockManager = createMockMcpManager();
      const mockSessionStore = createMockSessionStore();

      const graph = createAgentGraph({
        llm: mockLlm,
        mcpManager: mockManager,
        sessionStore: mockSessionStore,
      });

      expect(graph).toBeDefined();
      expect(typeof graph.invoke).toBe('function');
    });

    it('routes to respond when LLM returns plain message (no tools)', async () => {
      const mockLlm = createMockLlm();
      const mockManager = createMockMcpManager();
      const mockSessionStore = createMockSessionStore();

      const directResponse = new AIMessage('Hello! How can I help you today?');
      mockLlm.invoke.mockResolvedValue(directResponse);

      const graph = createAgentGraph({
        llm: mockLlm,
        mcpManager: mockManager,
        sessionStore: mockSessionStore,
      });

      const result = await graph.invoke({
        messages: [new HumanMessage('Hello')],
        userId: 'user1',
        sessionId: 'session1',
        toolResults: [],
        error: null,
      });

      expect(result.messages.length).toBeGreaterThanOrEqual(2);

      const lastMessage = result.messages[result.messages.length - 1] as BaseMessage;
      expect(lastMessage).toBeInstanceOf(AIMessage);
    });

    it('routes through execute_tools when LLM returns tool calls', async () => {
      const mockLlm = createMockLlm();
      const mockManager = createMockMcpManager();
      const mockSessionStore = createMockSessionStore();

      const toolCallMessage = new AIMessage({
        content: '',
        tool_calls: [
          { name: 'get_weather', args: { city: 'London' }, id: 'call_1', type: 'tool_call' },
        ],
      });
      const finalResponse = new AIMessage('The weather in London is 15°C.');

      mockLlm.invoke
        .mockResolvedValueOnce(toolCallMessage)
        .mockResolvedValueOnce(finalResponse);

      const graph = createAgentGraph({
        llm: mockLlm,
        mcpManager: mockManager,
        sessionStore: mockSessionStore,
      });

      const result = await graph.invoke({
        messages: [new HumanMessage('What is the weather in London?')],
        userId: 'user1',
        sessionId: 'session1',
        toolResults: [],
        error: null,
      });

      const lastMessage = result.messages[result.messages.length - 1] as BaseMessage;
      expect(lastMessage).toBeInstanceOf(AIMessage);
      expect(lastMessage.content).toContain('weather in London');

      const hasToolMessage = result.messages.some(
        (m: BaseMessage) => m instanceof ToolMessage,
      );
      expect(hasToolMessage).toBe(true);
    });

    it('loads previous session messages before processing', async () => {
      const mockLlm = createMockLlm();
      const mockManager = createMockMcpManager();
      const mockSessionStore = createMockSessionStore();

      const previousMessages = [
        new HumanMessage('Previous question'),
        new AIMessage('Previous answer'),
      ];
      (mockSessionStore.loadSession as ReturnType<typeof vi.fn>).mockResolvedValue(previousMessages);

      const directResponse = new AIMessage('Follow-up response');
      mockLlm.invoke.mockResolvedValue(directResponse);

      const graph = createAgentGraph({
        llm: mockLlm,
        mcpManager: mockManager,
        sessionStore: mockSessionStore,
      });

      const result = await graph.invoke({
        messages: [new HumanMessage('Follow-up question')],
        userId: 'user1',
        sessionId: 'session1',
        toolResults: [],
        error: null,
      });

      expect(mockSessionStore.loadSession).toHaveBeenCalledWith('user1', 'session1');
      expect(result.messages.length).toBeGreaterThanOrEqual(3);
    });

    it('saves session after processing', async () => {
      const mockLlm = createMockLlm();
      const mockManager = createMockMcpManager();
      const mockSessionStore = createMockSessionStore();

      const directResponse = new AIMessage('Hello!');
      mockLlm.invoke.mockResolvedValue(directResponse);

      const graph = createAgentGraph({
        llm: mockLlm,
        mcpManager: mockManager,
        sessionStore: mockSessionStore,
      });

      await graph.invoke({
        messages: [new HumanMessage('Hello')],
        userId: 'user1',
        sessionId: 'session1',
        toolResults: [],
        error: null,
      });

      expect(mockSessionStore.saveSession).toHaveBeenCalledWith(
        'user1',
        'session1',
        expect.arrayContaining([
          expect.objectContaining({ content: 'Hello' }),
        ]),
      );
    });

    it('handles combined weather+flight query in single turn', async () => {
      const mockLlm = createMockLlm();
      const mockManager = createMockMcpManager();
      const mockSessionStore = createMockSessionStore();

      (mockManager.listAllTools as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          name: 'get_weather',
          description: 'Get weather',
          inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
        {
          name: 'get_flight_status',
          description: 'Get flight status',
          inputSchema: { type: 'object', properties: { flight_number: { type: 'string' } }, required: ['flight_number'] },
        },
      ]);

      const toolCallMessage = new AIMessage({
        content: '',
        tool_calls: [
          { name: 'get_weather', args: { city: 'London' }, id: 'call_1', type: 'tool_call' },
          { name: 'get_flight_status', args: { flight_number: 'UA123' }, id: 'call_2', type: 'tool_call' },
        ],
      });

      const callToolFn = mockManager.callTool as ReturnType<typeof vi.fn>;
      callToolFn.mockImplementation(async (call: { name: string }) => {
        if (call.name === 'get_weather') {
          return { toolName: 'get_weather', content: '{"temperature":15}', isError: false };
        }
        return { toolName: 'get_flight_status', content: '{"status":"on_time"}', isError: false };
      });

      const finalResponse = new AIMessage(
        'London is 15°C and flight UA123 is on time.',
      );

      mockLlm.invoke
        .mockResolvedValueOnce(toolCallMessage)
        .mockResolvedValueOnce(finalResponse);

      const graph = createAgentGraph({
        llm: mockLlm,
        mcpManager: mockManager,
        sessionStore: mockSessionStore,
      });

      const result = await graph.invoke({
        messages: [new HumanMessage('Weather in London and status of UA123?')],
        userId: 'user1',
        sessionId: 'session1',
        toolResults: [],
        error: null,
      });

      const toolMessages = result.messages.filter(
        (m: BaseMessage) => m instanceof ToolMessage,
      );
      expect(toolMessages).toHaveLength(2);

      const lastMessage = result.messages[result.messages.length - 1] as BaseMessage;
      expect(lastMessage.content).toContain('UA123');
    });

    it('traces invocations via LangSmith client when provided', async () => {
      const mockLlm = createMockLlm();
      const mockManager = createMockMcpManager();
      const mockSessionStore = createMockSessionStore();
      const mockLangSmith = createMockLangSmithClient();
      const mockMetrics = createMockMetricsTracker();

      const directResponse = new AIMessage('Hello!');
      mockLlm.invoke.mockResolvedValue(directResponse);

      const graph = createAgentGraph({
        llm: mockLlm,
        mcpManager: mockManager,
        sessionStore: mockSessionStore,
        langSmithClient: mockLangSmith,
        metricsTracker: mockMetrics,
      });

      await graph.invoke(
        {
          messages: [new HumanMessage('Hello')],
          userId: 'user1',
          sessionId: 'session1',
          toolResults: [],
          error: null,
        },
        { cacheHit: false },
      );

      expect(mockLangSmith.createRun).toHaveBeenCalledOnce();
      expect(mockLangSmith.updateRun).toHaveBeenCalledOnce();
    });

    it('works without LangSmith client (tracing optional)', async () => {
      const mockLlm = createMockLlm();
      const mockManager = createMockMcpManager();
      const mockSessionStore = createMockSessionStore();

      const directResponse = new AIMessage('Hello!');
      mockLlm.invoke.mockResolvedValue(directResponse);

      const graph = createAgentGraph({
        llm: mockLlm,
        mcpManager: mockManager,
        sessionStore: mockSessionStore,
      });

      const result = await graph.invoke({
        messages: [new HumanMessage('Hello')],
        userId: 'user1',
        sessionId: 'session1',
        toolResults: [],
        error: null,
      });

      const lastMessage = result.messages[result.messages.length - 1] as BaseMessage;
      expect(lastMessage).toBeInstanceOf(AIMessage);
    });

    it('records cache hit in metrics tracker', async () => {
      const mockLlm = createMockLlm();
      const mockManager = createMockMcpManager();
      const mockSessionStore = createMockSessionStore();
      const mockLangSmith = createMockLangSmithClient();
      const mockMetrics = createMockMetricsTracker();

      const directResponse = new AIMessage('Hello!');
      mockLlm.invoke.mockResolvedValue(directResponse);

      const graph = createAgentGraph({
        llm: mockLlm,
        mcpManager: mockManager,
        sessionStore: mockSessionStore,
        langSmithClient: mockLangSmith,
        metricsTracker: mockMetrics,
      });

      await graph.invoke(
        {
          messages: [new HumanMessage('Hello')],
          userId: 'user1',
          sessionId: 'session1',
          toolResults: [],
          error: null,
        },
        { cacheHit: true },
      );

      expect(mockMetrics.recordCacheResult).toHaveBeenCalledWith(true);
    });

    it('records error in metrics tracker when result has error', async () => {
      const mockLlm = createMockLlm();
      const mockManager = createMockMcpManager();
      const mockSessionStore = createMockSessionStore();
      const mockLangSmith = createMockLangSmithClient();
      const mockMetrics = createMockMetricsTracker();

      mockLlm.invoke.mockRejectedValueOnce(new Error('LLM failed'));
      mockLlm.invoke.mockResolvedValueOnce(
        new AIMessage("I'm having trouble processing your request. Please try again."),
      );

      const graph = createAgentGraph({
        llm: mockLlm,
        mcpManager: mockManager,
        sessionStore: mockSessionStore,
        langSmithClient: mockLangSmith,
        metricsTracker: mockMetrics,
      });

      const result = await graph.invoke(
        {
          messages: [new HumanMessage('Hello')],
          userId: 'user1',
          sessionId: 'session1',
          toolResults: [],
          error: null,
        },
        { cacheHit: false },
      );

      if (result.error) {
        expect(mockMetrics.recordError).toHaveBeenCalledWith(result.error.code);
      }
    });
  });
});
