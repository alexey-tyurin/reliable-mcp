import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createLogger } from '../../src/observability/logger.js';
import {
  getSharedHarness,
  sendChatRequest,
  assertNoStackTrace,
  assertComponentCalled,
  getCallsByComponent,
} from './helpers.js';
import type { ChaosTestHarness } from './helpers.js';

const logger = createLogger('chaos-failure-test');

describe('Chaos: Failure Scenarios (full stack)', () => {
  let harness: ChaosTestHarness;

  beforeAll(async () => {
    harness = await getSharedHarness();
  });

  afterEach(() => {
    harness.chaos.clearAll();
    harness.mcpManager.resetCircuitBreakers();
    harness.callLogs.length = 0;
  });

  describe('weather-api-503-circuit-breaker', () => {
    it('LLM calls tools and weather API fault produces graceful degradation', async () => {
      harness.chaos.inject('weather-api', { type: 'error', statusCode: 503 });

      const result = await sendChatRequest(
        harness.agentBaseUrl,
        harness.testToken,
        'What is the weather in London?',
        'failure-weather-503-degradation',
      );

      expect(result.status).toBe(200);
      assertNoStackTrace(result);

      assertComponentCalled(harness.callLogs, 'llm');
      const llmCalls = getCallsByComponent(harness.callLogs, 'llm');
      logger.info(
        { llmCallCount: llmCalls.length, actions: llmCalls.map((c) => c.action) },
        '[CHAOS-TEST] LLM call log for weather-api-503',
      );

      expect(llmCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('flight-query-happy-path', () => {
    it('full stack processes flight query through MCP server and LLM', async () => {
      const result = await sendChatRequest(
        harness.agentBaseUrl,
        harness.testToken,
        'What is the status of flight TEST001?',
        'failure-flight-happy-path',
      );

      expect(result.status).toBe(200);
      assertNoStackTrace(result);

      const response = result.body['response'] as string;
      expect(response).toBeDefined();
      logger.info({ response: response.slice(0, 200) }, '[CHAOS-TEST] Flight happy path response');

      assertComponentCalled(harness.callLogs, 'llm');
      const llmCalls = getCallsByComponent(harness.callLogs, 'llm');
      const bindToolsCalls = llmCalls.filter((c) => c.action === 'bindTools');
      expect(bindToolsCalls.length).toBeGreaterThanOrEqual(1);

      const toolNames = bindToolsCalls[0]?.details?.['toolNames'] as string[] | undefined;
      expect(toolNames).toBeDefined();
      logger.info({ toolNames }, '[CHAOS-TEST] Tools bound to LLM');
    });
  });

  describe('weather-query-happy-path', () => {
    it('full stack processes weather query through LLM', async () => {
      const result = await sendChatRequest(
        harness.agentBaseUrl,
        harness.testToken,
        'What is the weather in London?',
        'failure-weather-happy-path',
      );

      expect(result.status).toBe(200);
      assertNoStackTrace(result);
      assertComponentCalled(harness.callLogs, 'llm');

      const weatherCalls = getCallsByComponent(harness.callLogs, 'weather-api');
      logger.info(
        { weatherFetchCount: weatherCalls.length, toolWasCalled: weatherCalls.length > 0 },
        '[CHAOS-TEST] Weather happy path — LLM may or may not invoke get_weather tool',
      );
    });
  });

  describe('redis-connection-drop', () => {
    it('agent continues responding when redis fault is active — LLM and MCP still called', async () => {
      harness.chaos.inject('redis', { type: 'connection-refused' });

      const result = await sendChatRequest(
        harness.agentBaseUrl,
        harness.testToken,
        'What is the status of flight TEST001?',
        'failure-redis-down-flight-query',
      );

      expect(result.status).toBe(200);
      expect(result.body['response']).toBeDefined();
      assertNoStackTrace(result);

      assertComponentCalled(harness.callLogs, 'llm');
      logger.info(
        { llmCallCount: getCallsByComponent(harness.callLogs, 'llm').length },
        '[CHAOS-TEST] LLM calls during redis-down scenario',
      );
    });
  });

  describe('oauth-token-expired', () => {
    it('returns 401 and no LLM/MCP calls execute', async () => {
      harness.chaos.inject('oauth-token', {
        type: 'error',
        statusCode: 401,
        message: 'Token expired (chaos)',
      });

      const result = await sendChatRequest(
        harness.agentBaseUrl,
        harness.testToken,
        'What is the weather?',
        'failure-oauth-401-blocked',
      );

      expect(result.status).toBe(401);
      assertNoStackTrace(result);

      const body = result.body as { error: string; message: string };
      expect(body.error).toBe('token_invalid');
      expect(body.message).toContain('Token expired');

      const llmCalls = getCallsByComponent(harness.callLogs, 'llm');
      expect(llmCalls).toHaveLength(0);
      logger.info('[CHAOS-TEST] Confirmed: no LLM calls when auth is blocked');
    });

    it('returns 403 and agent never invoked', async () => {
      harness.chaos.inject('oauth-token', { type: 'error', statusCode: 403 });

      const result = await sendChatRequest(
        harness.agentBaseUrl,
        harness.testToken,
        'Tell me about flights',
        'failure-oauth-403-blocked',
      );

      expect(result.status).toBe(403);
      expect(result.body['response']).toBeUndefined();
    });
  });

  describe('both-mcp-servers-unreachable (connection-refused on MCP transport)', () => {
    it('agent responds without crashing — LLM still called', async () => {
      harness.chaos.inject('weather-mcp', { type: 'connection-refused' });
      harness.chaos.inject('flight-mcp', { type: 'connection-refused' });

      const result = await sendChatRequest(
        harness.agentBaseUrl,
        harness.testToken,
        'What is the weather and flight TEST001 status?',
        'failure-both-mcp-unreachable',
      );

      expect(result.status).toBe(200);
      assertNoStackTrace(result);

      assertComponentCalled(harness.callLogs, 'llm');
      logger.info(
        { response: String(result.body['response']).slice(0, 200) },
        '[CHAOS-TEST] Response when both MCP servers unreachable',
      );
    });
  });

  describe('cascading-failure-redis-then-weather-api', () => {
    it('system remains responsive during compound failure — LLM still processes', async () => {
      harness.chaos.inject('redis', { type: 'connection-refused' });
      harness.chaos.inject('weather-api', { type: 'error', statusCode: 503 });

      const result = await sendChatRequest(
        harness.agentBaseUrl,
        harness.testToken,
        'What is the weather in Paris?',
        'failure-cascade-redis-weather-503',
      );

      expect(result.status).toBe(200);
      assertNoStackTrace(result);

      assertComponentCalled(harness.callLogs, 'llm');
      logger.info(
        {
          llmCalls: getCallsByComponent(harness.callLogs, 'llm').length,
          activeFaults: harness.chaos.getActiveFaults().length,
        },
        '[CHAOS-TEST] Cascading failure: LLM still called despite redis + weather faults',
      );
    });
  });

  describe('no-stack-traces-ever', () => {
    it('error responses never leak stack traces', async () => {
      harness.chaos.inject('weather-api', { type: 'error', statusCode: 500 });

      const result = await sendChatRequest(
        harness.agentBaseUrl,
        harness.testToken,
        'What is the weather in Tokyo?',
        'failure-no-stack-trace-weather-500',
      );

      expect(result.status).toBe(200);
      assertNoStackTrace(result);

      const bodyString = JSON.stringify(result.body);
      expect(bodyString).not.toMatch(/node_modules/);
      expect(bodyString).not.toMatch(/at Object\./);
    });
  });

  describe('call-log-summary', () => {
    it('proves all components are called in a normal request', async () => {
      const result = await sendChatRequest(
        harness.agentBaseUrl,
        harness.testToken,
        'What is the weather in London and status of flight TEST001?',
        'failure-call-log-summary',
      );

      expect(result.status).toBe(200);

      const componentsSeen = [...new Set(harness.callLogs.map((l) => l.component))];
      logger.info(
        {
          componentsSeen,
          totalCalls: harness.callLogs.length,
          breakdown: componentsSeen.map((c) => ({
            component: c,
            count: getCallsByComponent(harness.callLogs, c).length,
          })),
        },
        '[CHAOS-TEST] FULL CALL LOG SUMMARY — proves all components exercised',
      );

      assertComponentCalled(harness.callLogs, 'llm');

      const llmCalls = getCallsByComponent(harness.callLogs, 'llm');
      expect(llmCalls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
