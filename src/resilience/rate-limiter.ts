import { RateLimiterAbstract, RateLimiterRes } from 'rate-limiter-flexible';
import { RateLimitError } from '../utils/errors.js';

type RateLimitCheck = (key: string) => Promise<void>;

function isRateLimiterRes(value: unknown): value is RateLimiterRes {
  return (
    typeof value === 'object' &&
    value !== null &&
    'msBeforeNext' in value
  );
}

export function createRateLimiter(
  limiter: RateLimiterAbstract,
): RateLimitCheck {
  return async (key: string): Promise<void> => {
    try {
      await limiter.consume(key);
    } catch (error: unknown) {
      if (isRateLimiterRes(error)) {
        const retryAfterSeconds = Math.ceil(error.msBeforeNext / 1000);
        throw new RateLimitError(retryAfterSeconds);
      }
      throw error;
    }
  };
}
