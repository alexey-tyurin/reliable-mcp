import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createLogger } from '../../src/observability/logger.js';
import {
  getSharedHarness,
  sendChatRequest,
  assertNoStackTrace,
  assertComponentCalled,
  getCallsByComponent,
} from './helpers.js';
import type { ChaosTestHarness } from './helpers.js';

const logger = createLogger('chaos-recovery-test');

describe('Chaos: Recovery Scenarios (full stack)', () => {
  let harness: ChaosTestHarness;

  beforeAll(async () => {
    harness = await getSharedHarness();
  });

  afterEach(() => {
    harness.chaos.clearAll();
    harness.mcpManager.resetCircuitBreakers();
    harness.callLogs.length = 0;
  });

  describe('weather API recovery', () => {
    it('time-bounded fault expires automatically', () => {
      vi.useFakeTimers();

      harness.chaos.inject('weather-api', { type: 'error', statusCode: 503 }, 5000);

      expect(harness.chaos.getFault('weather-api')).not.toBeNull();

      vi.advanceTimersByTime(5100);

      expect(harness.chaos.getFault('weather-api')).toBeNull();
      logger.info('[CHAOS-TEST] Time-bounded fault expired as expected');

      vi.useRealTimers();
    });

    it('service resumes after fault is manually cleared — full LLM call succeeds', async () => {
      const faultId = harness.chaos.inject('weather-api', { type: 'error', statusCode: 503 });

      const duringFault = await sendChatRequest(
        harness.agentBaseUrl,
        harness.testToken,
        'What is the weather in London?',
        'recovery-weather-503-during-fault',
      );
      expect(duringFault.status).toBe(200);
      assertNoStackTrace(duringFault);

      const llmCallsDuring = getCallsByComponent(harness.callLogs, 'llm');
      logger.info(
        { llmCallsDuring: llmCallsDuring.length },
        '[CHAOS-TEST] LLM calls during weather fault',
      );

      harness.callLogs.length = 0;
      harness.chaos.clear(faultId);

      expect(harness.chaos.getFault('weather-api')).toBeNull();

      const afterRecovery = await sendChatRequest(
        harness.agentBaseUrl,
        harness.testToken,
        'What is the weather in London?',
        'recovery-weather-503-after-clear',
      );
      expect(afterRecovery.status).toBe(200);
      assertNoStackTrace(afterRecovery);
      assertComponentCalled(harness.callLogs, 'llm');

      const weatherCalls = getCallsByComponent(harness.callLogs, 'weather-api');
      logger.info(
        { weatherFetchCount: weatherCalls.length, toolWasCalled: weatherCalls.length > 0 },
        '[CHAOS-TEST] Weather recovery verified — fault cleared, LLM responded successfully',
      );
    });
  });

  describe('Redis recovery', () => {
    it('system works during fault, then resumes after clearing — full stack verified', async () => {
      const faultId = harness.chaos.inject('redis', { type: 'connection-refused' });

      const duringFault = await sendChatRequest(
        harness.agentBaseUrl,
        harness.testToken,
        'What is the status of flight TEST001?',
        'recovery-redis-down-during-fault',
      );
      expect(duringFault.status).toBe(200);
      assertComponentCalled(harness.callLogs, 'llm');

      logger.info(
        { llmCalls: getCallsByComponent(harness.callLogs, 'llm').length },
        '[CHAOS-TEST] LLM calls during Redis fault — agent running in degraded mode',
      );

      harness.callLogs.length = 0;
      harness.chaos.clear(faultId);
      expect(harness.chaos.getFault('redis')).toBeNull();

      const afterRecovery = await sendChatRequest(
        harness.agentBaseUrl,
        harness.testToken,
        'What is the status of flight TEST001?',
        'recovery-redis-down-after-clear',
      );
      expect(afterRecovery.status).toBe(200);
      assertNoStackTrace(afterRecovery);
      assertComponentCalled(harness.callLogs, 'llm');

      logger.info('[CHAOS-TEST] Redis recovery confirmed — full stack operational');
    });
  });

  describe('compound failure recovery', () => {
    it('full service restored when all faults are cleared — LLM + MCP + weather API all working', async () => {
      const redisFault = harness.chaos.inject('redis', { type: 'connection-refused' });
      const weatherFault = harness.chaos.inject('weather-api', { type: 'error', statusCode: 503 });

      expect(harness.chaos.getActiveFaults()).toHaveLength(2);

      const duringFailure = await sendChatRequest(
        harness.agentBaseUrl,
        harness.testToken,
        'What is the weather in Paris?',
        'recovery-compound-redis-weather-during',
      );
      expect(duringFailure.status).toBe(200);
      assertComponentCalled(harness.callLogs, 'llm');

      logger.info(
        {
          faultCount: harness.chaos.getActiveFaults().length,
          llmCalls: getCallsByComponent(harness.callLogs, 'llm').length,
        },
        '[CHAOS-TEST] During compound failure — system degraded but responsive',
      );

      harness.callLogs.length = 0;
      harness.chaos.clear(redisFault);
      harness.chaos.clear(weatherFault);
      harness.mcpManager.resetCircuitBreakers();

      expect(harness.chaos.getActiveFaults()).toHaveLength(0);

      const afterRecovery = await sendChatRequest(
        harness.agentBaseUrl,
        harness.testToken,
        'What is the weather in Paris?',
        'recovery-compound-redis-weather-after',
      );
      expect(afterRecovery.status).toBe(200);
      assertNoStackTrace(afterRecovery);
      assertComponentCalled(harness.callLogs, 'llm');
      assertComponentCalled(harness.callLogs, 'weather-api');

      logger.info(
        {
          componentsSeen: [...new Set(harness.callLogs.map((l) => l.component))],
        },
        '[CHAOS-TEST] Compound recovery — all components active again',
      );
    });

    it('partial recovery restores cleared subsystem while other remains faulted', async () => {
      const redisFault = harness.chaos.inject('redis', { type: 'connection-refused' });
      harness.chaos.inject('weather-api', { type: 'error', statusCode: 503 });

      harness.chaos.clear(redisFault);

      expect(harness.chaos.getFault('redis')).toBeNull();
      expect(harness.chaos.getFault('weather-api')).not.toBeNull();
      expect(harness.chaos.getActiveFaults()).toHaveLength(1);

      logger.info('[CHAOS-TEST] Partial recovery — redis cleared, weather still faulted');
    });
  });

  describe('auth recovery', () => {
    it('auth resumes after token fault is cleared — full LLM pipeline processes again', async () => {
      const faultId = harness.chaos.inject('oauth-token', {
        type: 'error',
        statusCode: 401,
        message: 'Token expired (chaos)',
      });

      const duringFault = await sendChatRequest(
        harness.agentBaseUrl,
        harness.testToken,
        'What is the weather?',
        'recovery-auth-401-during-fault',
      );
      expect(duringFault.status).toBe(401);

      const llmCallsDuring = getCallsByComponent(harness.callLogs, 'llm');
      expect(llmCallsDuring).toHaveLength(0);
      logger.info('[CHAOS-TEST] Auth fault active — no LLM calls (correct)');

      harness.callLogs.length = 0;
      harness.chaos.clear(faultId);

      const afterRecovery = await sendChatRequest(
        harness.agentBaseUrl,
        harness.testToken,
        'What is the status of flight TEST001?',
        'recovery-auth-401-after-clear',
      );
      expect(afterRecovery.status).toBe(200);
      expect(afterRecovery.body['response']).toBeDefined();
      assertComponentCalled(harness.callLogs, 'llm');

      logger.info(
        { llmCalls: getCallsByComponent(harness.callLogs, 'llm').length },
        '[CHAOS-TEST] Auth recovery — LLM pipeline active again',
      );
    });
  });
});
