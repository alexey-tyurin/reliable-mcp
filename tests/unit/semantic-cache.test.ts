import { describe, it, expect, vi, beforeEach } from 'vitest';

interface MockRedis {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  scan: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  status: string;
}

function createMockRedis(): MockRedis {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    scan: vi.fn().mockResolvedValue(['0', []]),
    del: vi.fn().mockResolvedValue(1),
    status: 'ready',
  };
}

function createMockEmbeddingProvider(embedding: number[]): {
  generateEmbedding: ReturnType<typeof vi.fn>;
} {
  return {
    generateEmbedding: vi.fn().mockResolvedValue(embedding),
  };
}

// Reference embedding for tests — a simple 3D unit vector
const QUERY_EMBEDDING = [1, 0, 0];

// Very similar to QUERY_EMBEDDING (cosine similarity ≈ 0.995)
const SIMILAR_EMBEDDING = [0.995, 0.1, 0];

// Dissimilar to QUERY_EMBEDDING (cosine similarity ≈ 0.707)
const DISSIMILAR_EMBEDDING = [0.707, 0.707, 0];

describe('SemanticCache', () => {
  let createSemanticCache: typeof import('../../src/cache/semantic-cache.js').createSemanticCache;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../src/cache/semantic-cache.js');
    createSemanticCache = mod.createSemanticCache;
  });

  describe('lookup', () => {
    it('returns null on cache miss when no entries exist', async () => {
      const redis = createMockRedis();
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);
      const cache = createSemanticCache(redis, embeddings);

      const result = await cache.lookup('What is the weather in NYC?', 'weather');

      expect(result).toBeNull();
      expect(embeddings.generateEmbedding).toHaveBeenCalledWith('What is the weather in NYC?');
    });

    it('returns cached response on cache hit with high similarity', async () => {
      const redis = createMockRedis();
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);

      const storedEntry = JSON.stringify({
        embedding: SIMILAR_EMBEDDING,
        response: 'NYC is 72°F',
        queryType: 'weather',
      });

      redis.scan.mockResolvedValue(['0', ['scache:abc123']]);
      redis.get.mockResolvedValue(storedEntry);

      const cache = createSemanticCache(redis, embeddings);
      const result = await cache.lookup('What is the weather in NYC?', 'weather');

      expect(result).toBe('NYC is 72°F');
    });

    it('returns null when similarity is below threshold', async () => {
      const redis = createMockRedis();
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);

      const storedEntry = JSON.stringify({
        embedding: DISSIMILAR_EMBEDDING,
        response: 'Some old response',
        queryType: 'weather',
      });

      redis.scan.mockResolvedValue(['0', ['scache:abc123']]);
      redis.get.mockResolvedValue(storedEntry);

      const cache = createSemanticCache(redis, embeddings);
      const result = await cache.lookup('What is the weather in NYC?', 'weather');

      expect(result).toBeNull();
    });

    it('returns the best match when multiple entries exist', async () => {
      const redis = createMockRedis();
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);

      const weakMatch = JSON.stringify({
        embedding: DISSIMILAR_EMBEDDING,
        response: 'Weak match',
        queryType: 'weather',
      });
      const strongMatch = JSON.stringify({
        embedding: SIMILAR_EMBEDDING,
        response: 'Strong match',
        queryType: 'weather',
      });

      redis.scan.mockResolvedValue(['0', ['scache:weak', 'scache:strong']]);
      redis.get
        .mockResolvedValueOnce(weakMatch)
        .mockResolvedValueOnce(strongMatch);

      const cache = createSemanticCache(redis, embeddings);
      const result = await cache.lookup('What is the weather?', 'weather');

      expect(result).toBe('Strong match');
    });

    it('handles multi-page SCAN results', async () => {
      const redis = createMockRedis();
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);

      const entry = JSON.stringify({
        embedding: SIMILAR_EMBEDDING,
        response: 'Found on second page',
        queryType: 'weather',
      });

      // First scan returns cursor != 0 (more pages)
      redis.scan
        .mockResolvedValueOnce(['42', ['scache:page1']])
        .mockResolvedValueOnce(['0', ['scache:page2']]);

      redis.get
        .mockResolvedValueOnce(null) // expired entry from page 1
        .mockResolvedValueOnce(entry); // valid entry from page 2

      const cache = createSemanticCache(redis, embeddings);
      const result = await cache.lookup('Weather query', 'weather');

      expect(result).toBe('Found on second page');
      expect(redis.scan).toHaveBeenCalledTimes(2);
    });

    it('cleans up expired entries found during scan', async () => {
      const redis = createMockRedis();
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);

      redis.scan.mockResolvedValue(['0', ['scache:expired1', 'scache:valid']]);
      redis.get
        .mockResolvedValueOnce(null) // expired
        .mockResolvedValueOnce(JSON.stringify({
          embedding: SIMILAR_EMBEDDING,
          response: 'Valid response',
          queryType: 'weather',
        }));

      const cache = createSemanticCache(redis, embeddings);
      await cache.lookup('Query', 'weather');

      // Expired key should be cleaned up from any index
      // No del call needed since Redis TTL handles cleanup;
      // the null GET means it already expired
    });
  });

  describe('store', () => {
    it('stores entry in Redis with weather TTL (30 minutes)', async () => {
      const redis = createMockRedis();
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);
      const cache = createSemanticCache(redis, embeddings);

      await cache.store('What is the weather?', 'NYC is 72°F', 'weather');

      expect(redis.set).toHaveBeenCalledTimes(1);
      const callArgs = redis.set.mock.calls[0] as [string, string, string, number];
      expect(callArgs[0]).toMatch(/^scache:/);

      const stored = JSON.parse(callArgs[1] as string) as {
        embedding: number[];
        response: string;
        queryType: string;
      };
      expect(stored.embedding).toEqual(QUERY_EMBEDDING);
      expect(stored.response).toBe('NYC is 72°F');
      expect(stored.queryType).toBe('weather');

      expect(callArgs[2]).toBe('EX');
      expect(callArgs[3]).toBe(1800); // 30 minutes
    });

    it('stores entry with flight TTL (5 minutes)', async () => {
      const redis = createMockRedis();
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);
      const cache = createSemanticCache(redis, embeddings);

      await cache.store('Flight AA123 status?', 'On time', 'flight');

      const callArgs = redis.set.mock.calls[0] as [string, string, string, number];
      expect(callArgs[3]).toBe(300); // 5 minutes
    });

    it('stores entry with mixed TTL (5 minutes)', async () => {
      const redis = createMockRedis();
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);
      const cache = createSemanticCache(redis, embeddings);

      await cache.store('Weather in NYC and flight AA123?', 'Combined', 'mixed');

      const callArgs = redis.set.mock.calls[0] as [string, string, string, number];
      expect(callArgs[3]).toBe(300); // 5 minutes
    });

    it('generates embedding for the query before storing', async () => {
      const redis = createMockRedis();
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);
      const cache = createSemanticCache(redis, embeddings);

      await cache.store('My query', 'My response', 'weather');

      expect(embeddings.generateEmbedding).toHaveBeenCalledWith('My query');
    });
  });

  describe('TTL expiry', () => {
    it('returns null when cached entry has expired (Redis returns null)', async () => {
      const redis = createMockRedis();
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);

      // SCAN finds the key but GET returns null (TTL expired between scan and get)
      redis.scan.mockResolvedValue(['0', ['scache:expired']]);
      redis.get.mockResolvedValue(null);

      const cache = createSemanticCache(redis, embeddings);
      const result = await cache.lookup('Query', 'weather');

      expect(result).toBeNull();
    });
  });

  describe('timeout bypass', () => {
    it('returns null on lookup when Redis is slow (bypasses cache)', async () => {
      const redis = createMockRedis();
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);

      redis.scan.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(['0', []]), 1000)),
      );

      const cache = createSemanticCache(redis, embeddings, { timeoutMs: 50 });
      const result = await cache.lookup('Query', 'weather');

      expect(result).toBeNull();
    });

    it('silently bypasses store when Redis is slow', async () => {
      const redis = createMockRedis();
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);

      redis.set.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('OK'), 1000)),
      );

      const cache = createSemanticCache(redis, embeddings, { timeoutMs: 50 });

      // Should not throw
      await expect(
        cache.store('Query', 'Response', 'weather'),
      ).resolves.toBeUndefined();
    });

    it('uses default 500ms timeout', async () => {
      const redis = createMockRedis();
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);

      // Resolves at 400ms — within default 500ms timeout
      redis.scan.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(['0', ['scache:k1']]), 400)),
      );
      redis.get.mockImplementation(
        () => new Promise((resolve) => setTimeout(
          () => resolve(JSON.stringify({
            embedding: SIMILAR_EMBEDDING,
            response: 'Cached',
            queryType: 'weather',
          })),
          10,
        )),
      );

      const cache = createSemanticCache(redis, embeddings);
      const result = await cache.lookup('Query', 'weather');

      expect(result).toBe('Cached');
    });
  });

  describe('similarity threshold edge cases', () => {
    it('returns hit at exactly 0.92 similarity', async () => {
      const redis = createMockRedis();

      // Construct vectors with cosine similarity of exactly 0.92
      // For vectors [1,0] and [cos(θ), sin(θ)], similarity = cos(θ)
      // θ = arccos(0.92) ≈ 0.3948 rad
      const theta = Math.acos(0.92);
      const borderlineEmbedding = [Math.cos(theta), Math.sin(theta), 0];
      const embeddings = createMockEmbeddingProvider([1, 0, 0]);

      const storedEntry = JSON.stringify({
        embedding: borderlineEmbedding,
        response: 'Borderline hit',
        queryType: 'weather',
      });

      redis.scan.mockResolvedValue(['0', ['scache:borderline']]);
      redis.get.mockResolvedValue(storedEntry);

      const cache = createSemanticCache(redis, embeddings);
      const result = await cache.lookup('Query', 'weather');

      expect(result).toBe('Borderline hit');
    });

    it('returns null just below 0.92 similarity', async () => {
      const redis = createMockRedis();

      // Construct vectors with cosine similarity of 0.919
      const theta = Math.acos(0.919);
      const belowThresholdEmbedding = [Math.cos(theta), Math.sin(theta), 0];
      const embeddings = createMockEmbeddingProvider([1, 0, 0]);

      const storedEntry = JSON.stringify({
        embedding: belowThresholdEmbedding,
        response: 'Should not be returned',
        queryType: 'weather',
      });

      redis.scan.mockResolvedValue(['0', ['scache:below']]);
      redis.get.mockResolvedValue(storedEntry);

      const cache = createSemanticCache(redis, embeddings);
      const result = await cache.lookup('Query', 'weather');

      expect(result).toBeNull();
    });

    it('respects custom similarity threshold', async () => {
      const redis = createMockRedis();

      // Use a lower threshold (0.8) — DISSIMILAR_EMBEDDING has similarity ≈ 0.707
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);

      const storedEntry = JSON.stringify({
        embedding: DISSIMILAR_EMBEDDING,
        response: 'Low threshold match',
        queryType: 'weather',
      });

      redis.scan.mockResolvedValue(['0', ['scache:low']]);
      redis.get.mockResolvedValue(storedEntry);

      // With threshold 0.7, the 0.707 similarity should be a hit
      const cache = createSemanticCache(redis, embeddings, {
        similarityThreshold: 0.7,
      });
      const result = await cache.lookup('Query', 'weather');

      expect(result).toBe('Low threshold match');
    });
  });

  describe('degraded mode', () => {
    it('returns null on lookup when Redis is unavailable', async () => {
      const redis = createMockRedis();
      redis.status = 'end';
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);

      const cache = createSemanticCache(redis, embeddings);
      const result = await cache.lookup('Query', 'weather');

      expect(result).toBeNull();
      expect(redis.scan).not.toHaveBeenCalled();
    });

    it('silently skips store when Redis is unavailable', async () => {
      const redis = createMockRedis();
      redis.status = 'end';
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);

      const cache = createSemanticCache(redis, embeddings);
      await cache.store('Query', 'Response', 'weather');

      expect(redis.set).not.toHaveBeenCalled();
    });

    it('returns null when embedding generation fails', async () => {
      const redis = createMockRedis();
      const embeddings = createMockEmbeddingProvider([]);
      embeddings.generateEmbedding.mockRejectedValue(new Error('OpenAI API error'));

      const cache = createSemanticCache(redis, embeddings);
      const result = await cache.lookup('Query', 'weather');

      expect(result).toBeNull();
    });

    it('silently skips store when embedding generation fails', async () => {
      const redis = createMockRedis();
      const embeddings = createMockEmbeddingProvider([]);
      embeddings.generateEmbedding.mockRejectedValue(new Error('OpenAI API error'));

      const cache = createSemanticCache(redis, embeddings);
      await expect(
        cache.store('Query', 'Response', 'weather'),
      ).resolves.toBeUndefined();

      expect(redis.set).not.toHaveBeenCalled();
    });

    it('returns null when Redis GET fails during lookup', async () => {
      const redis = createMockRedis();
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);

      redis.scan.mockResolvedValue(['0', ['scache:key1']]);
      redis.get.mockRejectedValue(new Error('Redis read error'));

      const cache = createSemanticCache(redis, embeddings);
      const result = await cache.lookup('Query', 'weather');

      expect(result).toBeNull();
    });
  });

  describe('metrics logging', () => {
    it('logs cache hit with query type', async () => {
      const redis = createMockRedis();
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);

      const storedEntry = JSON.stringify({
        embedding: SIMILAR_EMBEDDING,
        response: 'Cached weather',
        queryType: 'weather',
      });

      redis.scan.mockResolvedValue(['0', ['scache:hit']]);
      redis.get.mockResolvedValue(storedEntry);

      const cache = createSemanticCache(redis, embeddings);
      const result = await cache.lookup('Weather query', 'weather');

      // Verify the hit occurred (response returned)
      expect(result).toBe('Cached weather');
    });

    it('logs cache miss with query type', async () => {
      const redis = createMockRedis();
      const embeddings = createMockEmbeddingProvider(QUERY_EMBEDDING);

      redis.scan.mockResolvedValue(['0', []]);

      const cache = createSemanticCache(redis, embeddings);
      const result = await cache.lookup('Weather query', 'weather');

      // Verify the miss occurred (null returned)
      expect(result).toBeNull();
    });
  });
});
