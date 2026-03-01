import { describe, it, expect } from 'vitest';
import { evaluateResilience } from '../eval/evaluators/resilience.js';

describe('Resilience Evaluator', () => {
  it('passes when response contains user-friendly error message', () => {
    const result = evaluateResilience({
      responseBody: { response: 'Weather data is temporarily unavailable. Try again in a few minutes.' },
      statusCode: 200,
      faultType: 'weather-api-500',
    });

    expect(result.pass).toBe(true);
    expect(result.hasUserFriendlyMessage).toBe(true);
  });

  it('fails when stack trace is leaked', () => {
    const result = evaluateResilience({
      responseBody: { response: 'Error at Object.callTool (/src/mcp/client.ts:45:12)' },
      statusCode: 200,
      faultType: 'weather-api-500',
    });

    expect(result.pass).toBe(false);
    expect(result.hasStackTrace).toBe(true);
  });

  it('passes when partial results returned for combined query failure', () => {
    const result = evaluateResilience({
      responseBody: { response: 'The weather in London is 15°C. Flight status is temporarily unavailable.' },
      statusCode: 200,
      faultType: 'flight-api-timeout',
    });

    expect(result.pass).toBe(true);
    expect(result.hasPartialResults).toBe(true);
  });

  it('passes when server returns error status with friendly message', () => {
    const result = evaluateResilience({
      responseBody: { error: 'Something went wrong processing your request. Please try again.' },
      statusCode: 500,
      faultType: 'weather-api-500',
    });

    expect(result.pass).toBe(true);
    expect(result.hasUserFriendlyMessage).toBe(true);
  });

  it('fails when response body is empty', () => {
    const result = evaluateResilience({
      responseBody: {},
      statusCode: 200,
      faultType: 'redis-disconnected',
    });

    expect(result.pass).toBe(false);
  });

  it('detects absence of stack traces in clean error responses', () => {
    const result = evaluateResilience({
      responseBody: { error: 'Too many requests. Please try again later.', retryAfterSeconds: 30 },
      statusCode: 429,
      faultType: 'rate-limit',
    });

    expect(result.hasStackTrace).toBe(false);
    expect(result.pass).toBe(true);
  });
});
