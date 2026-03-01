/** What can be disrupted */
export type FaultTarget =
  | 'weather-api'
  | 'flight-api'
  | 'weather-mcp'
  | 'flight-mcp'
  | 'redis'
  | 'redis-cache'
  | 'redis-session'
  | 'oauth-token'
  | 'llm-api';

/** Types of faults that can be injected */
export type FaultConfig =
  | { type: 'latency'; delayMs: number; probability?: number }
  | { type: 'error'; statusCode: number; message?: string; probability?: number }
  | { type: 'timeout'; hangMs: number; probability?: number }
  | { type: 'malformed'; corruptResponse: boolean; probability?: number }
  | { type: 'connection-refused'; probability?: number }
  | { type: 'connection-drop'; afterBytes?: number; probability?: number }
  | { type: 'rate-limit'; retryAfterSeconds: number; probability?: number }
  | { type: 'schema-mismatch'; missingFields: string[]; probability?: number };
