import { TimeoutError } from '../utils/errors.js';

type AsyncFunction<TArgs extends unknown[], TResult> = (
  ...args: TArgs
) => Promise<TResult>;

export function withTimeout<TArgs extends unknown[], TResult>(
  fn: AsyncFunction<TArgs, TResult>,
  timeoutMs: number,
  operation = 'unknown',
): AsyncFunction<TArgs, TResult> {
  return async (...args: TArgs): Promise<TResult> => {
    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new TimeoutError(timeoutMs, operation));
      }, timeoutMs);

      fn(...args)
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  };
}
