import { HumanMessage, AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { createLogger } from '../observability/logger.js';

const DEFAULT_TTL_SECONDS = 86400;

export interface RedisLike {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, mode: string, ttl: number) => Promise<unknown>;
  status: string;
}

interface SerializedMessage {
  type: string;
  content: string;
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
  const serialized: SerializedMessage[] = messages.map((msg) => ({
    type: msg._getType(),
    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
  }));
  return JSON.stringify(serialized);
}

function deserializeMessages(raw: string): BaseMessage[] {
  const parsed = JSON.parse(raw) as SerializedMessage[];
  return parsed.map((item) => {
    switch (item.type) {
      case 'human':
        return new HumanMessage(item.content);
      case 'ai':
        return new AIMessage(item.content);
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
