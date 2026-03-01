import { ChaosController } from '../controller.js';
import type { FaultTarget } from '../fault-types.js';
import type { Redis as IORedis } from 'ioredis';
import { createLogger } from '../../observability/logger.js';

const logger = createLogger('chaos-redis');

const COMMANDS_TO_WRAP = ['get', 'set', 'del', 'hget', 'hset', 'expire', 'ttl', 'keys', 'mget'] as const;

export function wrapRedisWithChaos(
  client: IORedis,
  target: FaultTarget = 'redis',
): () => void {
  const originals = new Map<string, (...args: unknown[]) => unknown>();

  for (const cmd of COMMANDS_TO_WRAP) {
    const original = Reflect.get(client, cmd) as ((...args: unknown[]) => unknown) | undefined;
    if (typeof original !== 'function') continue;

    originals.set(cmd, original);

    const wrapped = async (...args: unknown[]): Promise<unknown> => {
      const controller = ChaosController.getInstance();
      const fault = controller.getFault(target);

      if (!fault) {
        return original.apply(client, args);
      }

      logger.debug({ target, cmd, faultType: fault.type }, 'Chaos Redis fault triggered');

      switch (fault.type) {
        case 'latency':
          await new Promise((r) => setTimeout(r, fault.delayMs));
          return original.apply(client, args);
        case 'error':
          throw new Error(`Chaos Redis error: ${fault.message ?? 'connection lost'}`);
        case 'timeout':
          await new Promise((r) => setTimeout(r, fault.hangMs));
          throw new Error('Chaos Redis timeout');
        case 'connection-refused':
          throw new Error('Redis connection refused (chaos)');
        default:
          return original.apply(client, args);
      }
    };

    Reflect.set(client, cmd, wrapped);
  }

  return (): void => {
    for (const [cmd, original] of originals) {
      Reflect.set(client, cmd, original);
    }
    originals.clear();
  };
}
