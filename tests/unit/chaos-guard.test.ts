import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertChaosAllowed } from '../../src/chaos/guard.js';

describe('assertChaosAllowed', () => {
  const originalNodeEnv = process.env['NODE_ENV'];
  const originalChaosEnabled = process.env['CHAOS_ENABLED'];

  beforeEach(() => {
    delete process.env['NODE_ENV'];
    delete process.env['CHAOS_ENABLED'];
  });

  afterEach(() => {
    if (originalNodeEnv !== undefined) {
      process.env['NODE_ENV'] = originalNodeEnv;
    } else {
      delete process.env['NODE_ENV'];
    }
    if (originalChaosEnabled !== undefined) {
      process.env['CHAOS_ENABLED'] = originalChaosEnabled;
    } else {
      delete process.env['CHAOS_ENABLED'];
    }
  });

  it('throws when NODE_ENV is production', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['CHAOS_ENABLED'] = 'true';

    expect(() => assertChaosAllowed()).toThrow(
      'FATAL: Chaos framework must never run in production',
    );
  });

  it('throws when CHAOS_ENABLED is not set', () => {
    process.env['NODE_ENV'] = 'test';

    expect(() => assertChaosAllowed()).toThrow(
      'Chaos framework not enabled. Set CHAOS_ENABLED=true',
    );
  });

  it('throws when CHAOS_ENABLED is not "true"', () => {
    process.env['NODE_ENV'] = 'test';
    process.env['CHAOS_ENABLED'] = 'false';

    expect(() => assertChaosAllowed()).toThrow(
      'Chaos framework not enabled. Set CHAOS_ENABLED=true',
    );
  });

  it('passes when NODE_ENV is not production and CHAOS_ENABLED is true', () => {
    process.env['NODE_ENV'] = 'test';
    process.env['CHAOS_ENABLED'] = 'true';

    expect(() => assertChaosAllowed()).not.toThrow();
  });

  it('passes when NODE_ENV is undefined and CHAOS_ENABLED is true', () => {
    process.env['CHAOS_ENABLED'] = 'true';

    expect(() => assertChaosAllowed()).not.toThrow();
  });
});
