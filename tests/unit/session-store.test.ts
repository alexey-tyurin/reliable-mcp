import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import type { SessionStore } from '../../src/cache/session-store.js';

function createMockRedis(): {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  status: string;
} {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    status: 'ready',
  };
}

describe('SessionStore', () => {
  let createSessionStore: typeof import('../../src/cache/session-store.js').createSessionStore;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../src/cache/session-store.js');
    createSessionStore = mod.createSessionStore;
  });

  describe('loadSession', () => {
    it('returns empty messages when no session exists', async () => {
      const redis = createMockRedis();
      const store: SessionStore = createSessionStore(redis);

      const messages = await store.loadSession('user1', 'session1');

      expect(messages).toEqual([]);
      expect(redis.get).toHaveBeenCalledWith('session:user1:session1');
    });

    it('returns deserialized messages from Redis', async () => {
      const redis = createMockRedis();
      const storedMessages = [
        { type: 'human', content: 'Hello' },
        { type: 'ai', content: 'Hi there!' },
      ];
      redis.get.mockResolvedValue(JSON.stringify(storedMessages));

      const store: SessionStore = createSessionStore(redis);
      const messages = await store.loadSession('user1', 'session1');

      expect(messages).toHaveLength(2);
      expect(messages[0]).toBeInstanceOf(HumanMessage);
      expect(messages[0]?.content).toBe('Hello');
      expect(messages[1]).toBeInstanceOf(AIMessage);
      expect(messages[1]?.content).toBe('Hi there!');
    });

    it('returns empty messages when Redis is unavailable', async () => {
      const redis = createMockRedis();
      redis.get.mockRejectedValue(new Error('Connection refused'));

      const store: SessionStore = createSessionStore(redis);
      const messages = await store.loadSession('user1', 'session1');

      expect(messages).toEqual([]);
    });
  });

  describe('saveSession', () => {
    it('serializes and saves messages to Redis', async () => {
      const redis = createMockRedis();
      const store: SessionStore = createSessionStore(redis);

      const messages = [
        new HumanMessage('Hello'),
        new AIMessage('Hi there!'),
      ];

      await store.saveSession('user1', 'session1', messages);

      expect(redis.set).toHaveBeenCalledTimes(1);
      const callArgs = redis.set.mock.calls[0] as [string, string, string, number];
      expect(callArgs[0]).toBe('session:user1:session1');

      const saved = JSON.parse(callArgs[1] as string) as { type: string; content: string }[];
      expect(saved).toHaveLength(2);
      expect(saved[0]?.type).toBe('human');
      expect(saved[0]?.content).toBe('Hello');
      expect(saved[1]?.type).toBe('ai');
      expect(saved[1]?.content).toBe('Hi there!');
    });

    it('sets TTL on session key', async () => {
      const redis = createMockRedis();
      const store: SessionStore = createSessionStore(redis, { ttlSeconds: 3600 });

      await store.saveSession('user1', 'session1', [new HumanMessage('Hello')]);

      const callArgs = redis.set.mock.calls[0] as [string, string, string, number];
      expect(callArgs[2]).toBe('EX');
      expect(callArgs[3]).toBe(3600);
    });

    it('does not throw when Redis is unavailable', async () => {
      const redis = createMockRedis();
      redis.set.mockRejectedValue(new Error('Connection refused'));

      const store: SessionStore = createSessionStore(redis);
      const messages = [new HumanMessage('Hello')];

      await expect(store.saveSession('user1', 'session1', messages)).resolves.toBeUndefined();
    });
  });

  describe('degraded mode', () => {
    it('works without Redis when status is not ready', async () => {
      const redis = createMockRedis();
      redis.status = 'end';

      const store: SessionStore = createSessionStore(redis);
      const messages = await store.loadSession('user1', 'session1');

      expect(messages).toEqual([]);
      expect(redis.get).not.toHaveBeenCalled();
    });
  });
});
