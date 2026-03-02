import { describe, it, expect, beforeEach } from 'vitest';
import {
  createMetricsTracker,
  estimateTokenCost,
  MODEL_COSTS,
} from '../../src/observability/metrics.js';
import type { MetricsTracker } from '../../src/observability/metrics.js';

describe('estimateTokenCost', () => {
  it('calculates cost for gpt-4o-mini', () => {
    const cost = estimateTokenCost('gpt-4o-mini', 100, 50);
    const nanoCost = MODEL_COSTS.get('gpt-4o-mini')!;
    const expected = 100 * nanoCost.input + 50 * nanoCost.output;
    expect(cost).toBeCloseTo(expected, 10);
  });

  it('calculates cost for gpt-4o', () => {
    const cost = estimateTokenCost('gpt-4o', 200, 100);
    const gpoCost = MODEL_COSTS.get('gpt-4o')!;
    const expected = 200 * gpoCost.input + 100 * gpoCost.output;
    expect(cost).toBeCloseTo(expected, 10);
  });

  it('returns zero for zero tokens', () => {
    const cost = estimateTokenCost('gpt-4o-mini', 0, 0);
    expect(cost).toBe(0);
  });

  it('uses fallback cost for unknown model', () => {
    const cost = estimateTokenCost('unknown-model', 100, 50);
    const defaultCost = MODEL_COSTS.get('default')!;
    const expected = 100 * defaultCost.input + 50 * defaultCost.output;
    expect(cost).toBeCloseTo(expected, 10);
  });
});

describe('MetricsTracker', () => {
  let tracker: MetricsTracker;

  beforeEach(() => {
    tracker = createMetricsTracker();
  });

  describe('recordError', () => {
    it('increments error count for a given type', () => {
      tracker.recordError('TimeoutError');
      tracker.recordError('TimeoutError');
      tracker.recordError('CircuitOpenError');

      const counts = tracker.getErrorCounts();
      expect(counts.get('TimeoutError')).toBe(2);
      expect(counts.get('CircuitOpenError')).toBe(1);
    });

    it('returns zero for unrecorded error types', () => {
      const counts = tracker.getErrorCounts();
      expect(counts.get('SomeError')).toBeUndefined();
    });
  });

  describe('recordCacheResult', () => {
    it('tracks cache hits and misses', () => {
      tracker.recordCacheResult(true);
      tracker.recordCacheResult(true);
      tracker.recordCacheResult(false);

      const rate = tracker.getCacheHitRate();
      expect(rate).toBeCloseTo(2 / 3, 5);
    });

    it('returns zero hit rate when no cache results recorded', () => {
      const rate = tracker.getCacheHitRate();
      expect(rate).toBe(0);
    });

    it('returns 1.0 when all hits', () => {
      tracker.recordCacheResult(true);
      tracker.recordCacheResult(true);
      expect(tracker.getCacheHitRate()).toBe(1);
    });
  });

  describe('recordCircuitBreakerTransition', () => {
    it('records state transitions with timestamps', () => {
      tracker.recordCircuitBreakerTransition('weather-api', 'closed', 'open');
      tracker.recordCircuitBreakerTransition('weather-api', 'open', 'half-open');

      const transitions = tracker.getCircuitBreakerTransitions('weather-api');
      expect(transitions).toHaveLength(2);
      expect(transitions[0]).toMatchObject({
        circuitName: 'weather-api',
        from: 'closed',
        to: 'open',
      });
      expect(transitions[0]).toHaveProperty('timestamp');
      expect(transitions[1]).toMatchObject({
        circuitName: 'weather-api',
        from: 'open',
        to: 'half-open',
      });
    });

    it('returns empty array for circuit with no transitions', () => {
      const transitions = tracker.getCircuitBreakerTransitions('nonexistent');
      expect(transitions).toEqual([]);
    });
  });

  describe('getSnapshot', () => {
    it('returns a combined snapshot of all metrics', () => {
      tracker.recordError('TimeoutError');
      tracker.recordCacheResult(true);
      tracker.recordCacheResult(false);
      tracker.recordCircuitBreakerTransition('flight-api', 'closed', 'open');

      const snapshot = tracker.getSnapshot();

      expect(snapshot.errorCounts.get('TimeoutError')).toBe(1);
      expect(snapshot.cacheHitRate).toBeCloseTo(0.5, 5);
      expect(snapshot.circuitBreakerTransitions).toHaveLength(1);
    });
  });
});
