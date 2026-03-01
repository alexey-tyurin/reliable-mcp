import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FlightFixtureSchema, FlightOutputSchema } from './schemas.js';
import type { FlightInput, FlightOutput } from './schemas.js';
import type { FlightProvider } from './flight-provider.js';
import { ApiError } from '../utils/errors.js';

const FLIGHT_NUMBER_TO_FIXTURE: Record<string, string> = {
  TEST001: 'on-time.json',
  TEST002: 'delayed.json',
  TEST003: 'cancelled.json',
  TEST004: 'in-air.json',
};

export function createMockFlightProvider(fixturesDir: string): FlightProvider {
  return {
    async getFlightStatus(input: FlightInput): Promise<FlightOutput> {
      const fixtureFile = FLIGHT_NUMBER_TO_FIXTURE[input.flight_number];

      if (!fixtureFile) {
        throw new ApiError(`Flight not found: ${input.flight_number}`, 404);
      }

      const filePath = path.join(fixturesDir, fixtureFile);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixtureFile is from a hardcoded allowlist, not user input
      const raw = await readFile(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      const fixture = FlightFixtureSchema.parse(parsed);

      return FlightOutputSchema.parse({
        flight_number: fixture.flight_number,
        airline: fixture.airline,
        status: fixture.status,
        departure: {
          airport: fixture.departure.airport,
          scheduled: fixture.departure.scheduled,
          actual: fixture.departure.actual,
          estimated: fixture.departure.actual,
        },
        arrival: {
          airport: fixture.arrival.airport,
          scheduled: fixture.arrival.scheduled,
          actual: null,
          estimated: fixture.arrival.estimated,
        },
        delay_minutes: fixture.delay_minutes,
        timestamp: new Date().toISOString(),
      });
    },
  };
}
