import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChaosController } from '../../src/chaos/controller.js';

describe('ChaosController', () => {
  beforeEach(() => {
    process.env['CHAOS_ENABLED'] = 'true';
    process.env['NODE_ENV'] = 'test';
    ChaosController.reset();
  });

  afterEach(() => {
    ChaosController.reset();
  });

  it('returns a singleton instance', () => {
    const a = ChaosController.getInstance();
    const b = ChaosController.getInstance();
    expect(a).toBe(b);
  });

  describe('inject/clear lifecycle', () => {
    it('injects a fault and returns a fault id', () => {
      const controller = ChaosController.getInstance();
      const id = controller.inject('weather-api', { type: 'error', statusCode: 503 });

      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });

    it('getFault returns the injected fault config', () => {
      const controller = ChaosController.getInstance();
      controller.inject('weather-api', { type: 'error', statusCode: 503 });

      const fault = controller.getFault('weather-api');
      expect(fault).not.toBeNull();
      expect(fault!.type).toBe('error');
    });

    it('getFault returns null for non-injected targets', () => {
      const controller = ChaosController.getInstance();
      const fault = controller.getFault('flight-api');
      expect(fault).toBeNull();
    });

    it('clear removes a specific fault', () => {
      const controller = ChaosController.getInstance();
      const id = controller.inject('weather-api', { type: 'error', statusCode: 503 });

      controller.clear(id);
      expect(controller.getFault('weather-api')).toBeNull();
    });

    it('clearAll removes all faults', () => {
      const controller = ChaosController.getInstance();
      controller.inject('weather-api', { type: 'error', statusCode: 503 });
      controller.inject('flight-api', { type: 'timeout', hangMs: 5000 });

      controller.clearAll();
      expect(controller.getFault('weather-api')).toBeNull();
      expect(controller.getFault('flight-api')).toBeNull();
    });

    it('getActiveFaults returns a readonly snapshot', () => {
      const controller = ChaosController.getInstance();
      controller.inject('weather-api', { type: 'error', statusCode: 503 });
      controller.inject('redis', { type: 'connection-refused' });

      const active = controller.getActiveFaults();
      expect(active).toHaveLength(2);
      expect(active[0]!.target).toBe('weather-api');
      expect(active[1]!.target).toBe('redis');
    });
  });

  describe('duration-based expiry', () => {
    it('expires faults after durationMs', () => {
      vi.useFakeTimers();
      const controller = ChaosController.getInstance();
      controller.inject('weather-api', { type: 'error', statusCode: 503 }, 1000);

      expect(controller.getFault('weather-api')).not.toBeNull();

      vi.advanceTimersByTime(1100);
      expect(controller.getFault('weather-api')).toBeNull();

      vi.useRealTimers();
    });

    it('does not expire faults without duration', () => {
      vi.useFakeTimers();
      const controller = ChaosController.getInstance();
      controller.inject('weather-api', { type: 'error', statusCode: 503 });

      vi.advanceTimersByTime(60000);
      expect(controller.getFault('weather-api')).not.toBeNull();

      vi.useRealTimers();
    });
  });

  describe('probabilistic skipping', () => {
    it('skips fault when probability check fails', () => {
      const controller = ChaosController.getInstance();
      controller.inject('weather-api', { type: 'error', statusCode: 503, probability: 0 });

      // probability=0 means Math.random() always > 0, so always skipped
      const fault = controller.getFault('weather-api');
      expect(fault).toBeNull();
    });

    it('returns fault when probability is 1', () => {
      const controller = ChaosController.getInstance();
      controller.inject('weather-api', { type: 'error', statusCode: 503, probability: 1 });

      const fault = controller.getFault('weather-api');
      expect(fault).not.toBeNull();
    });
  });

  describe('reset for isolation', () => {
    it('clears the singleton instance', () => {
      const a = ChaosController.getInstance();
      a.inject('weather-api', { type: 'error', statusCode: 503 });

      ChaosController.reset();

      const b = ChaosController.getInstance();
      expect(b).not.toBe(a);
      expect(b.getActiveFaults()).toHaveLength(0);
    });
  });
});
