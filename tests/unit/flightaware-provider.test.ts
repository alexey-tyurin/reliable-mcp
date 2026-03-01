import { describe, it, expect } from 'vitest';
import { createFlightAwareProvider } from '../../src/mcp/flightaware-provider.js';
import type { FlightOutput } from '../../src/mcp/schemas.js';

const MOCK_AEROAPI_RESPONSE = {
  flights: [
    {
      ident: 'UA123',
      operator: 'UAL',
      operator_iata: 'UA',
      flight_number: '123',
      status: 'En Route / On Time',
      scheduled_out: '2025-01-15T08:00:00Z',
      actual_out: '2025-01-15T08:05:00Z',
      scheduled_in: '2025-01-15T16:30:00Z',
      estimated_in: '2025-01-15T16:35:00Z',
      origin: {
        code: 'KSFO',
        code_iata: 'SFO',
        name: 'San Francisco Intl',
      },
      destination: {
        code: 'KJFK',
        code_iata: 'JFK',
        name: 'John F Kennedy Intl',
      },
      arrival_delay: 300,
    },
  ],
};

function createSuccessFetch(): typeof fetch {
  return async (): Promise<Response> => {
    return new Response(JSON.stringify(MOCK_AEROAPI_RESPONSE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function createEmptyFetch(): typeof fetch {
  return async (): Promise<Response> => {
    return new Response(JSON.stringify({ flights: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function createFailingFetch(status: number): typeof fetch {
  return async (): Promise<Response> => {
    return new Response(JSON.stringify({ title: 'Error', detail: 'Service unavailable' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

describe('FlightAwareProvider', () => {
  it('returns flight data for a valid flight number', async () => {
    const provider = createFlightAwareProvider({
      apiKey: 'test-key',
      fetchFn: createSuccessFetch(),
      retryOptions: { maxRetries: 0 },
    });

    const result = await provider.getFlightStatus({ flight_number: 'UA123' });

    expect(result.flight_number).toBe('UA123');
    expect(result.status).toBe('in_air');
    expect(result.departure.airport).toBe('SFO');
    expect(result.arrival.airport).toBe('JFK');
    expect(result.delay_minutes).toBe(5);
    expect(result.timestamp).toBeDefined();
  });

  it('returns valid FlightOutput shape', async () => {
    const provider = createFlightAwareProvider({
      apiKey: 'test-key',
      fetchFn: createSuccessFetch(),
      retryOptions: { maxRetries: 0 },
    });

    const result: FlightOutput = await provider.getFlightStatus({
      flight_number: 'UA123',
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

  it('throws ApiError when flight is not found', async () => {
    const provider = createFlightAwareProvider({
      apiKey: 'test-key',
      fetchFn: createEmptyFetch(),
      retryOptions: { maxRetries: 0 },
    });

    await expect(
      provider.getFlightStatus({ flight_number: 'INVALID999' }),
    ).rejects.toThrow('Flight not found: INVALID999');
  });

  it('throws ApiError when API returns error status', async () => {
    const provider = createFlightAwareProvider({
      apiKey: 'test-key',
      fetchFn: createFailingFetch(500),
      retryOptions: { maxRetries: 0 },
    });

    await expect(
      provider.getFlightStatus({ flight_number: 'UA123' }),
    ).rejects.toThrow();
  });

  it('sends x-apikey header in request', async () => {
    let capturedHeaders: Headers | undefined;

    const capturingFetch: typeof fetch = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify(MOCK_AEROAPI_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const provider = createFlightAwareProvider({
      apiKey: 'my-secret-key',
      fetchFn: capturingFetch,
      retryOptions: { maxRetries: 0 },
    });

    await provider.getFlightStatus({ flight_number: 'UA123' });

    expect(capturedHeaders?.get('x-apikey')).toBe('my-secret-key');
  });

  it('constructs correct API URL with flight number', async () => {
    let capturedUrl: string | undefined;

    const capturingFetch: typeof fetch = async (
      input: string | URL | Request,
    ): Promise<Response> => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return new Response(JSON.stringify(MOCK_AEROAPI_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const provider = createFlightAwareProvider({
      apiKey: 'test-key',
      fetchFn: capturingFetch,
      retryOptions: { maxRetries: 0 },
    });

    await provider.getFlightStatus({ flight_number: 'UA123' });

    expect(capturedUrl).toContain('/flights/UA123');
  });
});
