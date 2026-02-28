type AsyncFunction<TArgs extends unknown[], TResult> = (
  ...args: TArgs
) => Promise<TResult>;

interface RetryOptions {
  maxRetries: number;
  baseDelay?: number;
  maxDelay?: number;
  jitterFactor?: number;
  retryOn?: (error: unknown) => boolean;
}

function computeDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  jitterFactor: number,
): number {
  const exponential = baseDelay * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxDelay);
  const jitter = capped * jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, capped + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withRetry<TArgs extends unknown[], TResult>(
  fn: AsyncFunction<TArgs, TResult>,
  options: RetryOptions,
): AsyncFunction<TArgs, TResult> {
  const {
    maxRetries,
    baseDelay = 200,
    maxDelay = 5000,
    jitterFactor = 0.3,
    retryOn = (): boolean => true,
  } = options;

  return async (...args: TArgs): Promise<TResult> => {
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn(...args);
      } catch (error: unknown) {
        lastError = error;

        const isLastAttempt = attempt === maxRetries;
        if (isLastAttempt || !retryOn(error)) {
          throw error;
        }

        const delay = computeDelay(attempt, baseDelay, maxDelay, jitterFactor);
        await sleep(delay);
      }
    }

    throw lastError;
  };
}
