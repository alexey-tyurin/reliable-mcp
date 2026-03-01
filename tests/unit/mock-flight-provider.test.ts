import { describe, it, expect } from 'vitest';
import { createMockFlightProvider } from '../../src/mcp/mock-flight-provider.js';
import type { FlightOutput } from '../../src/mcp/schemas.js';
import path from 'node:path';

const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/flights');

describe('MockFlightProvider', () => {
  it('returns on-time flight data for TEST001', async () => {
    const provider = createMockFlightProvider(FIXTURES_DIR);
    const result = await provider.getFlightStatus({ flight_number: 'TEST001' });

    expect(result.flight_number).toBe('TEST001');
    expect(result.airline).toBe('Test Airlines');
    expect(result.status).toBe('landed');
    expect(result.delay_minutes).toBe(0);
    expect(result.departure.airport).toBe('JFK');
    expect(result.arrival.airport).toBe('LAX');
    expect(result.timestamp).toBeDefined();
  });

  it('returns delayed flight data for TEST002', async () => {
    const provider = createMockFlightProvider(FIXTURES_DIR);
    const result = await provider.getFlightStatus({ flight_number: 'TEST002' });

    expect(result.flight_number).toBe('TEST002');
    expect(result.status).toBe('delayed');
    expect(result.delay_minutes).toBe(45);
    expect(result.departure.airport).toBe('ORD');
    expect(result.arrival.airport).toBe('MIA');
  });

  it('returns cancelled flight data for TEST003', async () => {
    const provider = createMockFlightProvider(FIXTURES_DIR);
    const result = await provider.getFlightStatus({ flight_number: 'TEST003' });

    expect(result.flight_number).toBe('TEST003');
    expect(result.status).toBe('cancelled');
    expect(result.departure.actual).toBeNull();
    expect(result.arrival.estimated).toBeNull();
  });

  it('returns in-air flight data for TEST004', async () => {
    const provider = createMockFlightProvider(FIXTURES_DIR);
    const result = await provider.getFlightStatus({ flight_number: 'TEST004' });

    expect(result.flight_number).toBe('TEST004');
    expect(result.status).toBe('in_air');
    expect(result.delay_minutes).toBe(15);
    expect(result.departure.airport).toBe('LHR');
    expect(result.arrival.airport).toBe('JFK');
  });

  it('throws ApiError for unknown flight number', async () => {
    const provider = createMockFlightProvider(FIXTURES_DIR);

    await expect(
      provider.getFlightStatus({ flight_number: 'UNKNOWN999' }),
    ).rejects.toThrow('Flight not found: UNKNOWN999');
  });

  it('returns valid FlightOutput shape with timestamp', async () => {
    const provider = createMockFlightProvider(FIXTURES_DIR);
    const result: FlightOutput = await provider.getFlightStatus({
      flight_number: 'TEST001',
    });

    expect(result).toMatchObject({
      flight_number: expect.any(String),
      airline: expect.any(String),
      status: expect.any(String),
      departure: expect.objectContaining({
        airport: expect.any(String),
        scheduled: expect.any(String),
      }),
      arrival: expect.objectContaining({
        airport: expect.any(String),
        scheduled: expect.any(String),
      }),
      delay_minutes: expect.any(Number),
      timestamp: expect.any(String),
    });
  });

  it('ignores date parameter in mock provider', async () => {
    const provider = createMockFlightProvider(FIXTURES_DIR);
    const result = await provider.getFlightStatus({
      flight_number: 'TEST001',
      date: '2025-06-15',
    });

    expect(result.flight_number).toBe('TEST001');
  });
});
