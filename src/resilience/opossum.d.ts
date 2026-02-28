declare module 'opossum' {
  interface CircuitBreakerOptions {
    timeout?: number | false;
    errorThresholdPercentage?: number;
    resetTimeout?: number;
    rollingCountTimeout?: number;
    volumeThreshold?: number;
  }

  class CircuitBreaker<TArgs extends unknown[] = unknown[], TResult = unknown> {
    constructor(
      fn: (...args: TArgs) => Promise<TResult>,
      options?: CircuitBreakerOptions,
    );
    fire(...args: TArgs): Promise<TResult>;
    on(event: string, handler: (...args: unknown[]) => void): this;
    opened: boolean;
    shutdown(): void;
  }

  export default CircuitBreaker;
}
