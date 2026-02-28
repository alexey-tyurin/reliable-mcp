import pino from 'pino';
import type { Logger } from 'pino';

export function createLogger(serviceName?: string): Logger {
  const service = serviceName ?? process.env['SERVICE_ROLE'] ?? 'unknown-service';

  return pino({
    name: service,
    level: process.env['LOG_LEVEL'] ?? 'info',
    formatters: {
      level(label: string): { level: string } {
        return { level: label };
      },
    },
    base: { service },
  });
}
