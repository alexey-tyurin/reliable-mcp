import { createLogger } from '../observability/logger.js';

const SHUTDOWN_TIMEOUT = 9000;

type CleanupFn = () => Promise<void> | void;

interface ShutdownEntry {
  name: string;
  cleanup: CleanupFn;
}

export interface ShutdownRegistry {
  register: (name: string, cleanup: CleanupFn) => void;
  shutdown: () => Promise<void>;
  getRegisteredNames: () => string[];
  onShutdown: () => void;
}

export function createShutdownRegistry(
  timeoutMs: number = SHUTDOWN_TIMEOUT,
): ShutdownRegistry {
  const entries: ShutdownEntry[] = [];
  let shutdownInProgress = false;
  const logger = createLogger('shutdown');

  async function shutdown(): Promise<void> {
    if (shutdownInProgress) {
      return;
    }
    shutdownInProgress = true;

    logger.info('Starting graceful shutdown...');

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        logger.error('Shutdown timeout reached, forcing exit');
        resolve();
      }, timeoutMs);
    });

    const cleanupPromise = runCleanup();

    await Promise.race([cleanupPromise, timeoutPromise]);
  }

  async function runCleanup(): Promise<void> {
    const reversed = [...entries].reverse();

    for (const entry of reversed) {
      try {
        logger.info({ resource: entry.name }, 'Cleaning up resource');
        await entry.cleanup();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ resource: entry.name, error: message }, 'Cleanup failed');
      }
    }

    logger.info('Graceful shutdown complete');
  }

  function register(name: string, cleanup: CleanupFn): void {
    entries.push({ name, cleanup });
  }

  function getRegisteredNames(): string[] {
    return entries.map((entry) => entry.name);
  }

  function onShutdown(): void {
    const handler = (): void => {
      logger.info('SIGTERM received');
      shutdown()
        .then(() => {
          process.exit(0);
        })
        .catch(() => {
          process.exit(1);
        });
    };

    process.on('SIGTERM', handler);
    process.on('SIGINT', handler);
  }

  return { register, shutdown, getRegisteredNames, onShutdown };
}
