import { describe, it, expect } from 'vitest';
import {
  TimeoutError,
  CircuitOpenError,
  RateLimitError,
  ApiError,
} from '../../src/utils/errors.js';

describe('TimeoutError', () => {
  it('stores timeoutMs and operation', () => {
    const error = new TimeoutError(5000, 'weather-api');
    expect(error.timeoutMs).toBe(5000);
    expect(error.operation).toBe('weather-api');
    expect(error.name).toBe('TimeoutError');
    expect(error.message).toBe('weather-api timed out after 5000ms');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(TimeoutError);
  });
});

describe('CircuitOpenError', () => {
  it('stores circuitName', () => {
    const error = new CircuitOpenError('flight-api');
    expect(error.circuitName).toBe('flight-api');
    expect(error.name).toBe('CircuitOpenError');
    expect(error.message).toBe("Circuit breaker 'flight-api' is open");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CircuitOpenError);
  });
});

describe('RateLimitError', () => {
  it('stores retryAfterSeconds', () => {
    const error = new RateLimitError(60);
    expect(error.retryAfterSeconds).toBe(60);
    expect(error.name).toBe('RateLimitError');
    expect(error.message).toBe('Rate limit exceeded, retry after 60s');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RateLimitError);
  });
});

describe('ApiError', () => {
  it('stores status code and message', () => {
    const error = new ApiError('WeatherAPI returned 503', 503);
    expect(error.status).toBe(503);
    expect(error.name).toBe('ApiError');
    expect(error.message).toBe('WeatherAPI returned 503');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApiError);
  });
});
