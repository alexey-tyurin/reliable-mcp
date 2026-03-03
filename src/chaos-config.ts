import type { ChaosLogger, FaultTarget } from 'mcp-chaos-monkey';
import { configureChaosLogger } from 'mcp-chaos-monkey';
import { createLogger } from './observability/logger.js';

/**
 * The 9 fault targets specific to reliable-mcp.
 * Library uses open `string`; this narrows it for project-level type safety.
 */
export type ReliableMcpTarget =
  | 'weather-api'
  | 'flight-api'
  | 'weather-mcp'
  | 'flight-mcp'
  | 'redis'
  | 'redis-cache'
  | 'redis-session'
  | 'oauth-token'
  | 'llm-api';

const VALID_TARGETS: ReadonlySet<string> = new Set<ReliableMcpTarget>([
  'weather-api',
  'flight-api',
  'weather-mcp',
  'flight-mcp',
  'redis',
  'redis-cache',
  'redis-session',
  'oauth-token',
  'llm-api',
]);

export function isReliableMcpTarget(value: unknown): value is ReliableMcpTarget {
  return typeof value === 'string' && VALID_TARGETS.has(value);
}

export function asReliableMcpTarget(value: FaultTarget): ReliableMcpTarget {
  if (!isReliableMcpTarget(value)) {
    throw new Error(`Invalid fault target: ${value}. Valid targets: ${Array.from(VALID_TARGETS).join(', ')}`);
  }
  return value;
}

let initialized = false;

export function initializeChaos(): void {
  if (initialized) {
    return;
  }
  configureChaosLogger((name: string): ChaosLogger => {
    const logger = createLogger(name);
    return logger;
  });
  initialized = true;
}
