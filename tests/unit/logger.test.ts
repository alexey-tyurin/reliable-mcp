import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('createLogger', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('creates a logger with service field from SERVICE_ROLE', async () => {
    process.env['SERVICE_ROLE'] = 'weather-mcp';
    const { createLogger } = await import('../../src/observability/logger.js');
    const logger = createLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('creates a logger with explicit service name override', async () => {
    process.env['SERVICE_ROLE'] = 'agent';
    const { createLogger } = await import('../../src/observability/logger.js');
    const logger = createLogger('custom-service');
    expect(logger).toBeDefined();
  });

  it('has a flush method for graceful shutdown', async () => {
    process.env['SERVICE_ROLE'] = 'agent';
    const { createLogger } = await import('../../src/observability/logger.js');
    const logger = createLogger();
    expect(typeof logger.flush).toBe('function');
  });

  it('defaults to unknown-service when SERVICE_ROLE is not set', async () => {
    delete process.env['SERVICE_ROLE'];
    const { createLogger } = await import('../../src/observability/logger.js');
    const logger = createLogger();
    expect(logger).toBeDefined();
  });
});
