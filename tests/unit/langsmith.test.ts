import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentState } from '../../src/agent/state.js';
import { HumanMessage, AIMessage } from '@langchain/core/messages';

interface RunCreateParams {
  name: string;
  run_type: string;
  inputs: Record<string, unknown>;
  extra?: Record<string, unknown>;
  tags?: string[];
}

interface RunUpdateParams {
  end_time: number;
  outputs?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  error?: string;
}

function createMockLangSmithClient(): {
  createRun: ReturnType<typeof vi.fn>;
  updateRun: ReturnType<typeof vi.fn>;
} {
  return {
    createRun: vi.fn().mockResolvedValue(undefined),
    updateRun: vi.fn().mockResolvedValue(undefined),
  };
}

function createBaseInput(): AgentState {
  return {
    messages: [new HumanMessage('What is the weather?')],
    userId: 'user-123',
    sessionId: 'session-456',
    toolResults: [],
    error: null,
  };
}

function createBaseResult(): AgentState {
  return {
    messages: [
      new HumanMessage('What is the weather?'),
      new AIMessage('The weather is sunny.'),
    ],
    userId: 'user-123',
    sessionId: 'session-456',
    toolResults: [],
    error: null,
  };
}

describe('createTracedInvoke', () => {
  let createTracedInvoke: typeof import('../../src/observability/langsmith.js').createTracedInvoke;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../src/observability/langsmith.js');
    createTracedInvoke = mod.createTracedInvoke;
  });

  it('calls the underlying invoke and returns its result', async () => {
    const mockClient = createMockLangSmithClient();
    const result = createBaseResult();
    const mockInvoke = vi.fn().mockResolvedValue(result);

    const tracedInvoke = createTracedInvoke(mockInvoke, mockClient);
    const actual = await tracedInvoke(createBaseInput(), { cacheHit: false });

    expect(mockInvoke).toHaveBeenCalledOnce();
    expect(actual).toBe(result);
  });

  it('creates a LangSmith run with metadata tags', async () => {
    const mockClient = createMockLangSmithClient();
    const mockInvoke = vi.fn().mockResolvedValue(createBaseResult());

    const tracedInvoke = createTracedInvoke(mockInvoke, mockClient);
    await tracedInvoke(createBaseInput(), { cacheHit: false });

    expect(mockClient.createRun).toHaveBeenCalledOnce();

    const createArgs = mockClient.createRun.mock.calls[0] as [RunCreateParams];
    const params = createArgs[0];
    expect(params.name).toBe('agent-run');
    expect(params.run_type).toBe('chain');
    expect(params.tags).toContain('user:user-123');
    expect(params.tags).toContain('session:session-456');
    expect(params.tags).toContain('cache:miss');
  });

  it('tags cache hit when cacheHit is true', async () => {
    const mockClient = createMockLangSmithClient();
    const mockInvoke = vi.fn().mockResolvedValue(createBaseResult());

    const tracedInvoke = createTracedInvoke(mockInvoke, mockClient);
    await tracedInvoke(createBaseInput(), { cacheHit: true });

    const createArgs = mockClient.createRun.mock.calls[0] as [RunCreateParams];
    expect(createArgs[0].tags).toContain('cache:hit');
  });

  it('updates the run with output metadata on success', async () => {
    const mockClient = createMockLangSmithClient();
    const result = createBaseResult();
    result.toolResults = [
      { toolName: 'get_weather', content: '{"temp":15}', isError: false },
    ];
    const mockInvoke = vi.fn().mockResolvedValue(result);

    const tracedInvoke = createTracedInvoke(mockInvoke, mockClient);
    await tracedInvoke(createBaseInput(), { cacheHit: false });

    expect(mockClient.updateRun).toHaveBeenCalledOnce();

    const updateArgs = mockClient.updateRun.mock.calls[0] as [string, RunUpdateParams];
    const params = updateArgs[1];
    expect(params.end_time).toBeGreaterThan(0);
    expect(params.extra).toBeDefined();
    expect(params.extra!['metadata']).toMatchObject({
      user_id: 'user-123',
      session_id: 'session-456',
      cache_hit: false,
      tools_called: ['get_weather'],
    });
    expect(params.extra!['metadata']).toHaveProperty('latency_ms');
    expect((params.extra!['metadata'] as Record<string, unknown>)['latency_ms']).toBeGreaterThanOrEqual(0);
  });

  it('records tools_called from toolResults', async () => {
    const mockClient = createMockLangSmithClient();
    const result = createBaseResult();
    result.toolResults = [
      { toolName: 'get_weather', content: '{}', isError: false },
      { toolName: 'get_flight_status', content: '{}', isError: false },
    ];
    const mockInvoke = vi.fn().mockResolvedValue(result);

    const tracedInvoke = createTracedInvoke(mockInvoke, mockClient);
    await tracedInvoke(createBaseInput(), { cacheHit: false });

    const updateArgs = mockClient.updateRun.mock.calls[0] as [string, RunUpdateParams];
    const metadata = updateArgs[1].extra!['metadata'] as Record<string, unknown>;
    expect(metadata['tools_called']).toEqual(['get_weather', 'get_flight_status']);
  });

  it('includes tool tags for dashboard filtering', async () => {
    const mockClient = createMockLangSmithClient();
    const result = createBaseResult();
    result.toolResults = [
      { toolName: 'get_weather', content: '{}', isError: false },
    ];
    const mockInvoke = vi.fn().mockResolvedValue(result);

    const tracedInvoke = createTracedInvoke(mockInvoke, mockClient);
    await tracedInvoke(createBaseInput(), { cacheHit: false });

    const updateArgs = mockClient.updateRun.mock.calls[0] as [string, RunUpdateParams];
    const tags = updateArgs[1].extra!['tags'] as string[];
    expect(tags).toContain('tool:get_weather');
  });

  it('records error metadata when agent result has error', async () => {
    const mockClient = createMockLangSmithClient();
    const result = createBaseResult();
    result.error = { message: 'LLM call failed', code: 'LLM_ROUTE_FAILED' };
    const mockInvoke = vi.fn().mockResolvedValue(result);

    const tracedInvoke = createTracedInvoke(mockInvoke, mockClient);
    await tracedInvoke(createBaseInput(), { cacheHit: false });

    const updateArgs = mockClient.updateRun.mock.calls[0] as [string, RunUpdateParams];
    const metadata = updateArgs[1].extra!['metadata'] as Record<string, unknown>;
    expect(metadata['error']).toBe('LLM_ROUTE_FAILED');

    const tags = updateArgs[1].extra!['tags'] as string[];
    expect(tags).toContain('error:LLM_ROUTE_FAILED');
  });

  it('updates the run with error when invoke throws', async () => {
    const mockClient = createMockLangSmithClient();
    const mockInvoke = vi.fn().mockRejectedValue(new Error('Invoke failed'));

    const tracedInvoke = createTracedInvoke(mockInvoke, mockClient);
    await expect(tracedInvoke(createBaseInput(), { cacheHit: false }))
      .rejects.toThrow('Invoke failed');

    expect(mockClient.updateRun).toHaveBeenCalledOnce();
    const updateArgs = mockClient.updateRun.mock.calls[0] as [string, RunUpdateParams];
    expect(updateArgs[1].error).toBe('Invoke failed');
  });

  it('still throws original error even if updateRun fails', async () => {
    const mockClient = createMockLangSmithClient();
    mockClient.updateRun.mockRejectedValue(new Error('LangSmith down'));
    const mockInvoke = vi.fn().mockRejectedValue(new Error('Invoke failed'));

    const tracedInvoke = createTracedInvoke(mockInvoke, mockClient);
    await expect(tracedInvoke(createBaseInput(), { cacheHit: false }))
      .rejects.toThrow('Invoke failed');
  });

  it('does not block or fail when createRun fails', async () => {
    const mockClient = createMockLangSmithClient();
    mockClient.createRun.mockRejectedValue(new Error('LangSmith down'));
    const result = createBaseResult();
    const mockInvoke = vi.fn().mockResolvedValue(result);

    const tracedInvoke = createTracedInvoke(mockInvoke, mockClient);
    const actual = await tracedInvoke(createBaseInput(), { cacheHit: false });

    expect(actual).toBe(result);
  });
});

describe('buildRunTags', () => {
  let buildRunTags: typeof import('../../src/observability/langsmith.js').buildRunTags;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../src/observability/langsmith.js');
    buildRunTags = mod.buildRunTags;
  });

  it('builds tags from user, session, and cache hit', () => {
    const tags = buildRunTags('user-1', 'sess-2', true);
    expect(tags).toContain('user:user-1');
    expect(tags).toContain('session:sess-2');
    expect(tags).toContain('cache:hit');
  });

  it('builds cache:miss tag when not a hit', () => {
    const tags = buildRunTags('u', 's', false);
    expect(tags).toContain('cache:miss');
  });
});
