import type { FlightInput, FlightOutput } from './schemas.js';

export interface FlightProvider {
  getFlightStatus: (input: FlightInput) => Promise<FlightOutput>;
}
