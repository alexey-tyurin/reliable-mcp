export class TimeoutError extends Error {
  public readonly timeoutMs: number;
  public readonly operation: string;

  constructor(timeoutMs: number, operation: string) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
    this.operation = operation;
  }
}

export class CircuitOpenError extends Error {
  public readonly circuitName: string;

  constructor(circuitName: string) {
    super(`Circuit breaker '${circuitName}' is open`);
    this.name = 'CircuitOpenError';
    this.circuitName = circuitName;
  }
}

export class RateLimitError extends Error {
  public readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`Rate limit exceeded, retry after ${retryAfterSeconds}s`);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ApiError extends Error {
  public readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}
