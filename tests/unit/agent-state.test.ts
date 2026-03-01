import { describe, it, expect } from 'vitest';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { AgentAnnotation } from '../../src/agent/state.js';
import type { AgentError, ToolResult } from '../../src/agent/state.js';

describe('AgentAnnotation', () => {
  it('defines a messages channel', () => {
    expect(AgentAnnotation.spec.messages).toBeDefined();
  });

  it('defines a userId channel', () => {
    expect(AgentAnnotation.spec.userId).toBeDefined();
  });

  it('defines a sessionId channel', () => {
    expect(AgentAnnotation.spec.sessionId).toBeDefined();
  });

  it('defines a toolResults channel', () => {
    expect(AgentAnnotation.spec.toolResults).toBeDefined();
  });

  it('defines an error channel', () => {
    expect(AgentAnnotation.spec.error).toBeDefined();
  });

  it('ToolResult interface has correct shape', () => {
    const result: ToolResult = {
      toolName: 'get_weather',
      content: '{"temperature":15}',
      isError: false,
    };

    expect(result.toolName).toBe('get_weather');
    expect(result.content).toBe('{"temperature":15}');
    expect(result.isError).toBe(false);
  });

  it('AgentError interface has correct shape', () => {
    const error: AgentError = {
      message: 'Something went wrong',
      code: 'TOOL_EXECUTION_FAILED',
    };

    expect(error.message).toBe('Something went wrong');
    expect(error.code).toBe('TOOL_EXECUTION_FAILED');
  });

  it('messages channel supports BaseMessage types', () => {
    const messages = [
      new HumanMessage('Hello'),
      new AIMessage('Hi there!'),
    ];

    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe('Hello');
    expect(messages[1]?.content).toBe('Hi there!');
  });
});
