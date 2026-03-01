import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AgentEnv, WeatherMcpEnv, FlightMcpEnv } from '../../src/config/env.js';

describe('loadEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('agent service', () => {
    it('parses valid agent env vars', async () => {
      process.env['SERVICE_ROLE'] = 'agent';
      process.env['OPENAI_API_KEY'] = 'sk-test-key';
      process.env['LANGSMITH_API_KEY'] = 'ls-test-key';
      process.env['OAUTH_SECRET'] = 'a-secret-that-is-at-least-32-chars';
      process.env['REDIS_URL'] = 'redis://localhost:6379';

      const { loadEnv } = await import('../../src/config/env.js');
      const env = loadEnv() as AgentEnv;

      expect(env.SERVICE_ROLE).toBe('agent');
      expect(env.OPENAI_API_KEY).toBe('sk-test-key');
      expect(env.LANGSMITH_API_KEY).toBe('ls-test-key');
      expect(env.OAUTH_SECRET).toBe('a-secret-that-is-at-least-32-chars');
      expect(env.PORT).toBe(3000);
      expect(env.WEATHER_MCP_URL).toBe('http://localhost:3001/mcp');
      expect(env.FLIGHT_MCP_URL).toBe('http://localhost:3002/mcp');
    });

    it('throws when OPENAI_API_KEY is missing for agent', async () => {
      process.env['SERVICE_ROLE'] = 'agent';
      process.env['LANGSMITH_API_KEY'] = 'ls-test-key';
      process.env['OAUTH_SECRET'] = 'a-secret-that-is-at-least-32-chars';
      delete process.env['OPENAI_API_KEY'];

      const { loadEnv } = await import('../../src/config/env.js');
      expect(() => loadEnv()).toThrow();
    });

    it('throws when OAUTH_SECRET is missing for agent', async () => {
      process.env['SERVICE_ROLE'] = 'agent';
      process.env['OPENAI_API_KEY'] = 'sk-test-key';
      process.env['LANGSMITH_API_KEY'] = 'ls-test-key';
      delete process.env['OAUTH_SECRET'];

      const { loadEnv } = await import('../../src/config/env.js');
      expect(() => loadEnv()).toThrow();
    });

    it('uses custom PORT when provided', async () => {
      process.env['SERVICE_ROLE'] = 'agent';
      process.env['OPENAI_API_KEY'] = 'sk-test-key';
      process.env['LANGSMITH_API_KEY'] = 'ls-test-key';
      process.env['OAUTH_SECRET'] = 'a-secret-that-is-at-least-32-chars';
      process.env['PORT'] = '4000';

      const { loadEnv } = await import('../../src/config/env.js');
      const env = loadEnv();

      expect(env.PORT).toBe(4000);
    });
  });

  describe('weather-mcp service', () => {
    it('parses valid weather-mcp env vars', async () => {
      process.env['SERVICE_ROLE'] = 'weather-mcp';
      process.env['WEATHERAPI_KEY'] = 'test-weather-key';
      process.env['REDIS_URL'] = 'redis://localhost:6379';

      const { loadEnv } = await import('../../src/config/env.js');
      const env = loadEnv() as WeatherMcpEnv;

      expect(env.SERVICE_ROLE).toBe('weather-mcp');
      expect(env.WEATHERAPI_KEY).toBe('test-weather-key');
      expect(env.PORT).toBe(3001);
    });

    it('throws when WEATHERAPI_KEY is missing', async () => {
      process.env['SERVICE_ROLE'] = 'weather-mcp';
      delete process.env['WEATHERAPI_KEY'];

      const { loadEnv } = await import('../../src/config/env.js');
      expect(() => loadEnv()).toThrow();
    });
  });

  describe('flight-mcp service', () => {
    it('parses valid flight-mcp env vars with mock provider', async () => {
      process.env['SERVICE_ROLE'] = 'flight-mcp';
      process.env['REDIS_URL'] = 'redis://localhost:6379';

      const { loadEnv } = await import('../../src/config/env.js');
      const env = loadEnv() as FlightMcpEnv;

      expect(env.SERVICE_ROLE).toBe('flight-mcp');
      expect(env.FLIGHT_PROVIDER).toBe('mock');
      expect(env.PORT).toBe(3002);
    });

    it('requires FLIGHTAWARE_API_KEY when provider is flightaware', async () => {
      process.env['SERVICE_ROLE'] = 'flight-mcp';
      process.env['FLIGHT_PROVIDER'] = 'flightaware';
      delete process.env['FLIGHTAWARE_API_KEY'];

      const { loadEnv } = await import('../../src/config/env.js');
      expect(() => loadEnv()).toThrow();
    });

    it('parses flightaware provider with API key', async () => {
      process.env['SERVICE_ROLE'] = 'flight-mcp';
      process.env['FLIGHT_PROVIDER'] = 'flightaware';
      process.env['FLIGHTAWARE_API_KEY'] = 'fa-test-key';
      process.env['REDIS_URL'] = 'redis://localhost:6379';

      const { loadEnv } = await import('../../src/config/env.js');
      const env = loadEnv() as FlightMcpEnv;

      expect(env.FLIGHT_PROVIDER).toBe('flightaware');
      expect(env.FLIGHTAWARE_API_KEY).toBe('fa-test-key');
    });
  });

  describe('shared validation', () => {
    it('throws when SERVICE_ROLE is missing', async () => {
      delete process.env['SERVICE_ROLE'];

      const { loadEnv } = await import('../../src/config/env.js');
      expect(() => loadEnv()).toThrow();
    });

    it('throws when SERVICE_ROLE is invalid', async () => {
      process.env['SERVICE_ROLE'] = 'invalid-service';

      const { loadEnv } = await import('../../src/config/env.js');
      expect(() => loadEnv()).toThrow();
    });

    it('uses default REDIS_URL', async () => {
      process.env['SERVICE_ROLE'] = 'weather-mcp';
      process.env['WEATHERAPI_KEY'] = 'test-key';
      delete process.env['REDIS_URL'];

      const { loadEnv } = await import('../../src/config/env.js');
      const env = loadEnv();

      expect(env.REDIS_URL).toBe('redis://localhost:6379');
    });
  });
});
