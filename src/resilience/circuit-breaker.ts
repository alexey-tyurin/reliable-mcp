import CircuitBreaker from 'opossum';
import { CircuitOpenError } from '../utils/errors.js';

type AsyncFunction<TArgs extends unknown[], TResult> = (
  ...args: TArgs
) => Promise<TResult>;

interface CircuitBreakerConfig {
  name: string;
  timeout?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  rollingCountTimeout?: number;
  volumeThreshold?: number;
}

const DEFAULTS = {
  timeout: false as const,
  errorThresholdPercentage: 50,
  resetTimeout: 30_000,
  rollingCountTimeout: 60_000,
  volumeThreshold: 5,
};

function isOpenBreakerError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code: string }).code === 'EOPENBREAKER'
  );
}

export function createCircuitBreaker<TArgs extends unknown[], TResult>(
  fn: AsyncFunction<TArgs, TResult>,
  config: CircuitBreakerConfig,
): AsyncFunction<TArgs, TResult> {
  const breaker = new CircuitBreaker(fn, {
    timeout: config.timeout ?? DEFAULTS.timeout,
    errorThresholdPercentage:
      config.errorThresholdPercentage ?? DEFAULTS.errorThresholdPercentage,
    resetTimeout: config.resetTimeout ?? DEFAULTS.resetTimeout,
    rollingCountTimeout:
      config.rollingCountTimeout ?? DEFAULTS.rollingCountTimeout,
    volumeThreshold: config.volumeThreshold ?? DEFAULTS.volumeThreshold,
  });

  return async (...args: TArgs): Promise<TResult> => {
    try {
      return await breaker.fire(...args);
    } catch (error: unknown) {
      if (isOpenBreakerError(error)) {
        throw new CircuitOpenError(config.name);
      }
      throw error;
    }
  };
}
