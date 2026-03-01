import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import { createLogger } from '../observability/logger.js';

const DEFAULT_TTL_SECONDS = 86400;

export interface RedisLike {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, mode: string, ttl: number) => Promise<unknown>;
  status: string;
}

interface SerializedToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
  type?: string;
}

interface SerializedMessage {
  type: string;
  content: string;
  tool_calls?: SerializedToolCall[];
  tool_call_id?: string;
}

interface SessionStoreOptions {
  ttlSeconds?: number;
}

export interface SessionStore {
  loadSession: (userId: string, sessionId: string) => Promise<BaseMessage[]>;
  saveSession: (userId: string, sessionId: string, messages: BaseMessage[]) => Promise<void>;
}

function buildKey(userId: string, sessionId: string): string {
  return `session:${userId}:${sessionId}`;
}

function serializeMessages(messages: BaseMessage[]): string {
  const serialized: SerializedMessage[] = messages.map((msg) => {
    const base: SerializedMessage = {
      type: msg._getType(),
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
    };

    if (msg._getType() === 'ai') {
      const aiMsg = msg as AIMessage;
      if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
        base.tool_calls = aiMsg.tool_calls.map((tc) => {
          const serialized: SerializedToolCall = { name: tc.name, args: tc.args as Record<string, unknown> };
          if (tc.id !== undefined) { serialized.id = tc.id; }
          if (tc.type !== undefined) { serialized.type = tc.type; }
          return serialized;
        });
      }
    }

    if (msg._getType() === 'tool') {
      base.tool_call_id = (msg as ToolMessage).tool_call_id;
    }

    return base;
  });
  return JSON.stringify(serialized);
}

function deserializeMessages(raw: string): BaseMessage[] {
  const parsed = JSON.parse(raw) as SerializedMessage[];
  return parsed.map((item) => {
    switch (item.type) {
      case 'human':
        return new HumanMessage(item.content);
      case 'ai': {
        if (item.tool_calls && item.tool_calls.length > 0) {
          const toolCalls: ToolCall[] = item.tool_calls.map((tc) => ({
            name: tc.name,
            args: tc.args as Record<string, unknown>,
            ...(tc.id !== undefined ? { id: tc.id } : {}),
            type: 'tool_call' as const,
          }));
          return new AIMessage({ content: item.content, tool_calls: toolCalls });
        }
        return new AIMessage(item.content);
      }
      case 'tool':
        return new ToolMessage({
          content: item.content,
          tool_call_id: item.tool_call_id ?? '',
        });
      default:
        return new HumanMessage(item.content);
    }
  });
}

export function createSessionStore(
  redis: RedisLike,
  options?: SessionStoreOptions,
): SessionStore {
  const logger = createLogger('session-store');
  const ttlSeconds = options?.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  function isRedisAvailable(): boolean {
    return redis.status === 'ready';
  }

  async function loadSession(userId: string, sessionId: string): Promise<BaseMessage[]> {
    if (!isRedisAvailable()) {
      return [];
    }

    try {
      const key = buildKey(userId, sessionId);
      const raw = await redis.get(key);

      if (!raw) {
        return [];
      }

      return deserializeMessages(raw);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ userId, sessionId, error: message }, 'Failed to load session');
      return [];
    }
  }

  async function saveSession(
    userId: string,
    sessionId: string,
    messages: BaseMessage[],
  ): Promise<void> {
    if (!isRedisAvailable()) {
      return;
    }

    try {
      const key = buildKey(userId, sessionId);
      const serialized = serializeMessages(messages);
      await redis.set(key, serialized, 'EX', ttlSeconds);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ userId, sessionId, error: message }, 'Failed to save session');
    }
  }

  return { loadSession, saveSession };
}
