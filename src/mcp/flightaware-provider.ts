import { z } from 'zod';
import { FlightOutputSchema } from './schemas.js';
import type { FlightInput, FlightOutput } from './schemas.js';
import type { FlightProvider } from './flight-provider.js';
import { createCircuitBreaker } from '../resilience/circuit-breaker.js';
import { withRetry } from '../resilience/retry.js';
import { withTimeout } from '../resilience/timeout.js';
import { ApiError } from '../utils/errors.js';
import { createLogger } from '../observability/logger.js';

const AEROAPI_BASE_URL = 'https://aeroapi.flightaware.com/aeroapi';

const AeroApiAirportSchema = z.object({
  code_iata: z.string(),
});

const AeroApiFlightSchema = z.object({
  ident: z.string(),
  status: z.string(),
  scheduled_out: z.string().datetime(),
  actual_out: z.string().datetime().nullable(),
  scheduled_in: z.string().datetime(),
  estimated_in: z.string().datetime().nullable(),
  origin: AeroApiAirportSchema,
  destination: AeroApiAirportSchema,
  arrival_delay: z.number().nullable(),
});

const AeroApiResponseSchema = z.object({
  flights: z.array(AeroApiFlightSchema),
});

type AeroApiFlight = z.infer<typeof AeroApiFlightSchema>;

const STATUS_MAPPING: Record<string, FlightOutput['status']> = {
  'en route': 'in_air',
  'scheduled': 'scheduled',
  'landed': 'landed',
  'cancelled': 'cancelled',
  'delayed': 'delayed',
};

function mapFlightStatus(rawStatus: string): FlightOutput['status'] {
  const normalized = rawStatus.toLowerCase();

  for (const [key, value] of Object.entries(STATUS_MAPPING)) {
    if (normalized.includes(key)) {
      return value;
    }
  }

  return 'scheduled';
}

function mapToFlightOutput(
  flightNumber: string,
  flight: AeroApiFlight,
): FlightOutput {
  const delaySeconds = flight.arrival_delay ?? 0;
  const delayMinutes = Math.max(0, Math.round(delaySeconds / 60));

  return FlightOutputSchema.parse({
    flight_number: flightNumber,
    airline: flight.ident.replace(/\d+$/, ''),
    status: mapFlightStatus(flight.status),
    departure: {
      airport: flight.origin.code_iata,
      scheduled: flight.scheduled_out,
      actual: flight.actual_out,
      estimated: flight.actual_out,
    },
    arrival: {
      airport: flight.destination.code_iata,
      scheduled: flight.scheduled_in,
      actual: null,
      estimated: flight.estimated_in,
    },
    delay_minutes: delayMinutes,
    timestamp: new Date().toISOString(),
  });
}

export interface FlightAwareConfig {
  apiKey: string;
  fetchFn?: typeof fetch;
  retryOptions?: { maxRetries: number };
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

async function resolveFlightFetch(config: FlightAwareConfig): Promise<typeof fetch> {
  const baseFetch = config.fetchFn ?? globalThis.fetch;
  if (process.env['CHAOS_ENABLED'] === 'true') {
    const { createChaosAwareFetch } = await import('../chaos/interceptors/http-interceptor.js');
    return createChaosAwareFetch('flight-api', baseFetch);
  }
  return baseFetch;
}

export async function createFlightAwareProvider(
  config: FlightAwareConfig,
): Promise<FlightProvider> {
  const fetchFn = await resolveFlightFetch(config);
  const logger = createLogger('flightaware-provider');

  const innerFn = async (input: FlightInput): Promise<FlightOutput> => {
    const url = `${AEROAPI_BASE_URL}/flights/${encodeURIComponent(input.flight_number)}`;

    const fetchOptions: RequestInit = {
      headers: { 'x-apikey': config.apiKey },
    };

    if (config.abortSignal) {
      fetchOptions.signal = config.abortSignal;
    }

    const response = await fetchFn(url, fetchOptions);

    if (!response.ok) {
      throw new ApiError(
        `FlightAware API returned ${String(response.status)}`,
        response.status,
      );
    }

    const rawData: unknown = await response.json();
    const apiResponse = AeroApiResponseSchema.parse(rawData);

    const flight = apiResponse.flights[0];
    if (!flight) {
      throw new ApiError(`Flight not found: ${input.flight_number}`, 404);
    }

    return mapToFlightOutput(input.flight_number, flight);
  };

  const retryOn = (error: unknown): boolean => {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      return false;
    }
    return true;
  };

  const withTimeoutFn = withTimeout(
    innerFn,
    config.timeoutMs ?? 5000,
    'flightaware-api',
  );

  const withRetryFn = withRetry(withTimeoutFn, {
    maxRetries: config.retryOptions?.maxRetries ?? 2,
    retryOn,
  });

  const withCircuitBreakerFn = createCircuitBreaker(withRetryFn, {
    name: 'flightaware-api',
  });

  return {
    async getFlightStatus(input: FlightInput): Promise<FlightOutput> {
      try {
        return await withCircuitBreakerFn(input);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          { error: message, flightNumber: input.flight_number },
          'FlightAware API call failed',
        );
        throw error;
      }
    },
  };
}
