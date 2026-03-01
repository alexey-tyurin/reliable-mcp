export type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerTransition {
  circuitName: string;
  from: CircuitState;
  to: CircuitState;
  timestamp: number;
}

interface MetricsSnapshot {
  errorCounts: Map<string, number>;
  cacheHitRate: number;
  circuitBreakerTransitions: CircuitBreakerTransition[];
}

export interface MetricsTracker {
  recordError: (errorType: string) => void;
  getErrorCounts: () => Map<string, number>;
  recordCacheResult: (hit: boolean) => void;
  getCacheHitRate: () => number;
  recordCircuitBreakerTransition: (circuitName: string, from: CircuitState, to: CircuitState) => void;
  getCircuitBreakerTransitions: (circuitName: string) => CircuitBreakerTransition[];
  getSnapshot: () => MetricsSnapshot;
}

interface ModelCost {
  input: number;
  output: number;
}

const DEFAULT_COST: ModelCost = { input: 0.00000015, output: 0.0000006 };

export const MODEL_COSTS = new Map<string, ModelCost>([
  ['gpt-4o-mini', { input: 0.00000015, output: 0.0000006 }],
  ['gpt-4o', { input: 0.0000025, output: 0.00001 }],
  ['default', DEFAULT_COST],
]);

export function estimateTokenCost(model: string, inputTokens: number, outputTokens: number): number {
  const costs = MODEL_COSTS.get(model) ?? DEFAULT_COST;
  return inputTokens * costs.input + outputTokens * costs.output;
}

export function createMetricsTracker(): MetricsTracker {
  const errorCounts = new Map<string, number>();
  let cacheHits = 0;
  let cacheTotal = 0;
  const circuitTransitions: CircuitBreakerTransition[] = [];

  function recordError(errorType: string): void {
    const current = errorCounts.get(errorType) ?? 0;
    errorCounts.set(errorType, current + 1);
  }

  function getErrorCounts(): Map<string, number> {
    return new Map(errorCounts);
  }

  function recordCacheResult(hit: boolean): void {
    cacheTotal++;
    if (hit) {
      cacheHits++;
    }
  }

  function getCacheHitRate(): number {
    if (cacheTotal === 0) {
      return 0;
    }
    return cacheHits / cacheTotal;
  }

  function recordCircuitBreakerTransition(circuitName: string, from: CircuitState, to: CircuitState): void {
    circuitTransitions.push({ circuitName, from, to, timestamp: Date.now() });
  }

  function getCircuitBreakerTransitions(circuitName: string): CircuitBreakerTransition[] {
    return circuitTransitions.filter((t) => t.circuitName === circuitName);
  }

  function getSnapshot(): MetricsSnapshot {
    return {
      errorCounts: getErrorCounts(),
      cacheHitRate: getCacheHitRate(),
      circuitBreakerTransitions: [...circuitTransitions],
    };
  }

  return {
    recordError,
    getErrorCounts,
    recordCacheResult,
    getCacheHitRate,
    recordCircuitBreakerTransition,
    getCircuitBreakerTransitions,
    getSnapshot,
  };
}
