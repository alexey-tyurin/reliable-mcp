import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createWeatherMcpServer } from '../../src/mcp/weather-server.js';
import type { WeatherOutput } from '../../src/mcp/schemas.js';

const MOCK_WEATHER_API_RESPONSE = {
  location: { name: 'London', country: 'United Kingdom' },
  current: {
    temp_c: 15.2,
    temp_f: 59.4,
    condition: { text: 'Partly cloudy' },
    humidity: 72,
  },
};

function createSuccessFetch(): typeof fetch {
  return async (): Promise<Response> => {
    return new Response(JSON.stringify(MOCK_WEATHER_API_RESPONSE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function createFailingFetch(status: number): typeof fetch {
  return async (): Promise<Response> => {
    return new Response(JSON.stringify({ error: { message: 'Service unavailable' } }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

describe('Weather MCP Server', () => {
  let httpServer: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const { app } = await createWeatherMcpServer({
      weatherApiKey: 'test-key',
      fetchFn: createSuccessFetch(),
      retryOptions: { maxRetries: 0 },
    });
    httpServer = app.listen(0);
    const addr = httpServer.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => { resolve(); });
    });
  });

  it('returns health check', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; service: string; uptime: number };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('weather-mcp');
    expect(typeof body.uptime).toBe('number');
  });

  it('lists the get_weather tool', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: 'test-client', version: '1.0.0' });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();

      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe('get_weather');
      expect(tools[0]?.description).toBe('Get current weather temperature for a city');
    } finally {
      await client.close();
    }
  });

  it('returns weather data for a valid city (celsius default)', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: 'test-client', version: '1.0.0' });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'get_weather',
        arguments: { city: 'London' },
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);

      const textContent = result.content[0] as { type: string; text: string };
      expect(textContent.type).toBe('text');

      const parsed = JSON.parse(textContent.text) as WeatherOutput;
      expect(parsed.city).toBe('London');
      expect(parsed.country).toBe('United Kingdom');
      expect(parsed.temperature).toBe(15.2);
      expect(parsed.units).toBe('celsius');
      expect(parsed.condition).toBe('Partly cloudy');
      expect(parsed.humidity).toBe(72);
      expect(parsed.timestamp).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it('returns weather data in fahrenheit when requested', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: 'test-client', version: '1.0.0' });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'get_weather',
        arguments: { city: 'London', units: 'fahrenheit' },
      });

      expect(result.isError).toBeFalsy();
      const textContent = result.content[0] as { type: string; text: string };
      const parsed = JSON.parse(textContent.text) as WeatherOutput;

      expect(parsed.temperature).toBe(59.4);
      expect(parsed.units).toBe('fahrenheit');
    } finally {
      await client.close();
    }
  });

  it('returns user-friendly error when weather API fails', async () => {
    const { app: failApp } = await createWeatherMcpServer({
      weatherApiKey: 'test-key',
      fetchFn: createFailingFetch(500),
      retryOptions: { maxRetries: 0 },
    });
    const failServer = failApp.listen(0);
    const failAddr = failServer.address() as AddressInfo;
    const failUrl = `http://localhost:${failAddr.port}`;

    try {
      const transport = new StreamableHTTPClientTransport(new URL(`${failUrl}/mcp`));
      const client = new Client({ name: 'test-client', version: '1.0.0' });

      try {
        await client.connect(transport);
        const result = await client.callTool({
          name: 'get_weather',
          arguments: { city: 'London' },
        });

        expect(result.isError).toBe(true);
        const textContent = result.content[0] as { type: string; text: string };
        expect(textContent.text).toContain('temporarily unavailable');
        expect(textContent.text).not.toMatch(/stack|Error|at\s/);
      } finally {
        await client.close();
      }
    } finally {
      await new Promise<void>((resolve) => {
        failServer.close(() => { resolve(); });
      });
    }
  });
});
