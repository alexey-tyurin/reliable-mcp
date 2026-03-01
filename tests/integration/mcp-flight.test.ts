import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createFlightMcpServer } from '../../src/mcp/flight-server.js';
import type { FlightOutput } from '../../src/mcp/schemas.js';
import path from 'node:path';

const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/flights');

describe('Flight MCP Server', () => {
  let httpServer: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const { app } = await createFlightMcpServer({
      provider: 'mock',
      fixturesDir: FIXTURES_DIR,
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
    expect(body.service).toBe('flight-mcp');
    expect(typeof body.uptime).toBe('number');
  });

  it('lists the get_flight_status tool', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: 'test-client', version: '1.0.0' });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();

      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe('get_flight_status');
      expect(tools[0]?.description).toBe(
        'Get current status of a flight by flight number',
      );
    } finally {
      await client.close();
    }
  });

  it('returns on-time flight data for TEST001', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: 'test-client', version: '1.0.0' });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'get_flight_status',
        arguments: { flight_number: 'TEST001' },
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);

      const textContent = result.content[0] as { type: string; text: string };
      expect(textContent.type).toBe('text');

      const parsed = JSON.parse(textContent.text) as FlightOutput;
      expect(parsed.flight_number).toBe('TEST001');
      expect(parsed.airline).toBe('Test Airlines');
      expect(parsed.status).toBe('landed');
      expect(parsed.delay_minutes).toBe(0);
      expect(parsed.departure.airport).toBe('JFK');
      expect(parsed.arrival.airport).toBe('LAX');
      expect(parsed.timestamp).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it('returns delayed flight data for TEST002', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: 'test-client', version: '1.0.0' });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'get_flight_status',
        arguments: { flight_number: 'TEST002' },
      });

      expect(result.isError).toBeFalsy();
      const textContent = result.content[0] as { type: string; text: string };
      const parsed = JSON.parse(textContent.text) as FlightOutput;

      expect(parsed.flight_number).toBe('TEST002');
      expect(parsed.status).toBe('delayed');
      expect(parsed.delay_minutes).toBe(45);
    } finally {
      await client.close();
    }
  });

  it('returns cancelled flight data for TEST003', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: 'test-client', version: '1.0.0' });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'get_flight_status',
        arguments: { flight_number: 'TEST003' },
      });

      expect(result.isError).toBeFalsy();
      const textContent = result.content[0] as { type: string; text: string };
      const parsed = JSON.parse(textContent.text) as FlightOutput;

      expect(parsed.flight_number).toBe('TEST003');
      expect(parsed.status).toBe('cancelled');
    } finally {
      await client.close();
    }
  });

  it('returns user-friendly error for unknown flight', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: 'test-client', version: '1.0.0' });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'get_flight_status',
        arguments: { flight_number: 'UNKNOWN999' },
      });

      expect(result.isError).toBe(true);
      const textContent = result.content[0] as { type: string; text: string };
      expect(textContent.text).toContain('temporarily unavailable');
      expect(textContent.text).not.toMatch(/stack|Error|at\s/);
    } finally {
      await client.close();
    }
  });
});
