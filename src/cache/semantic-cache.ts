import { cosineSimilarity } from '../utils/cosine-similarity.js';
import { createLogger } from '../observability/logger.js';

const DEFAULT_SIMILARITY_THRESHOLD = 0.92;
const DEFAULT_TIMEOUT_MS = 500;
const SCAN_COUNT = 100;

const TTL_BY_QUERY_TYPE = new Map<QueryType, number>([
  ['weather', 1800],
  ['flight', 300],
  ['mixed', 300],
]);

export type QueryType = 'weather' | 'flight' | 'mixed';

interface CacheEntry {
  embedding: number[];
  response: string;
  queryType: QueryType;
}

export interface SemanticCacheRedis {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, mode: string, ttl: number) => Promise<unknown>;
  scan: (cursor: number | string, ...args: (string | number)[]) => Promise<[string, string[]]>;
  del: (...keys: string[]) => Promise<number>;
  status: string;
}

export interface EmbeddingProvider {
  generateEmbedding: (text: string) => Promise<number[]>;
}

interface SemanticCacheOptions {
  similarityThreshold?: number;
  timeoutMs?: number;
}

export interface SemanticCache {
  lookup: (query: string, queryType: QueryType) => Promise<string | null>;
  store: (query: string, response: string, queryType: QueryType) => Promise<void>;
}

function buildKey(): string {
  return `scache:${crypto.randomUUID()}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Cache operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export function createSemanticCache(
  redis: SemanticCacheRedis,
  embeddingProvider: EmbeddingProvider,
  options?: SemanticCacheOptions,
): SemanticCache {
  const logger = createLogger('semantic-cache');
  const similarityThreshold = options?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function isRedisAvailable(): boolean {
    return redis.status === 'ready';
  }

  async function scanAllKeys(): Promise<string[]> {
    const allKeys: string[] = [];
    let cursor = '0';

    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'scache:*', 'COUNT', SCAN_COUNT);
      cursor = nextCursor;
      allKeys.push(...keys);
    } while (cursor !== '0');

    return allKeys;
  }

  async function findBestMatch(queryEmbedding: number[]): Promise<string | null> {
    const keys = await scanAllKeys();

    if (keys.length === 0) {
      return null;
    }

    let bestResponse: string | null = null;
    let bestSimilarity = -Infinity;

    for (const key of keys) {
      const raw = await redis.get(key);

      if (!raw) {
        continue;
      }

      const entry = JSON.parse(raw) as CacheEntry;
      const similarity = cosineSimilarity(queryEmbedding, entry.embedding);

      if (similarity >= similarityThreshold && similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestResponse = entry.response;
      }
    }

    return bestResponse;
  }

  async function lookup(query: string, queryType: QueryType): Promise<string | null> {
    if (!isRedisAvailable()) {
      return null;
    }

    try {
      const queryEmbedding = await embeddingProvider.generateEmbedding(query);
      const response = await withTimeout(findBestMatch(queryEmbedding), timeoutMs);

      if (response) {
        logger.info({ queryType, event: 'cache_hit' }, 'Semantic cache hit');
      } else {
        logger.info({ queryType, event: 'cache_miss' }, 'Semantic cache miss');
      }

      return response;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ queryType, error: message, event: 'cache_miss' }, 'Semantic cache lookup failed, bypassing cache');
      return null;
    }
  }

  async function store(query: string, response: string, queryType: QueryType): Promise<void> {
    if (!isRedisAvailable()) {
      return;
    }

    try {
      const embedding = await embeddingProvider.generateEmbedding(query);
      const entry: CacheEntry = { embedding, response, queryType };
      const key = buildKey();
      const ttl = TTL_BY_QUERY_TYPE.get(queryType) ?? 300;

      await withTimeout(
        redis.set(key, JSON.stringify(entry), 'EX', ttl),
        timeoutMs,
      );

      logger.info({ queryType, key, event: 'cache_store' }, 'Semantic cache entry stored');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ queryType, error: message }, 'Semantic cache store failed, bypassing cache');
    }
  }

  return { lookup, store };
}
