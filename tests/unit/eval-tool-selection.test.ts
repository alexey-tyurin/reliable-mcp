import { describe, it, expect } from 'vitest';
import { evaluateToolSelection } from '../eval/evaluators/tool-selection.js';

describe('Tool Selection Evaluator', () => {
  it('returns score 1.0 for exact tool match', () => {
    const result = evaluateToolSelection(
      ['get_weather'],
      ['get_weather'],
    );

    expect(result.score).toBe(1.0);
    expect(result.reason).toContain('exact match');
  });

  it('returns score 1.0 for exact match with multiple tools', () => {
    const result = evaluateToolSelection(
      ['get_weather', 'get_flight_status'],
      ['get_weather', 'get_flight_status'],
    );

    expect(result.score).toBe(1.0);
  });

  it('returns score 1.0 when tools match regardless of order', () => {
    const result = evaluateToolSelection(
      ['get_flight_status', 'get_weather'],
      ['get_weather', 'get_flight_status'],
    );

    expect(result.score).toBe(1.0);
  });

  it('returns score 0.5 when correct tools called but extra tools too', () => {
    const result = evaluateToolSelection(
      ['get_weather', 'get_flight_status'],
      ['get_weather'],
    );

    expect(result.score).toBe(0.5);
    expect(result.reason).toContain('extra');
  });

  it('returns score 0.0 when expected tool is missing', () => {
    const result = evaluateToolSelection(
      ['get_flight_status'],
      ['get_weather'],
    );

    expect(result.score).toBe(0.0);
    expect(result.reason).toContain('missing');
  });

  it('returns score 0.0 when wrong tool called', () => {
    const result = evaluateToolSelection(
      ['get_weather'],
      ['get_flight_status'],
    );

    expect(result.score).toBe(0.0);
  });

  it('returns score 1.0 when both expected and actual are empty', () => {
    const result = evaluateToolSelection([], []);

    expect(result.score).toBe(1.0);
  });

  it('returns score 0.0 when tools called but none expected', () => {
    const result = evaluateToolSelection(
      ['get_weather'],
      [],
    );

    expect(result.score).toBe(0.0);
  });

  it('returns score 0.0 when no tools called but some expected', () => {
    const result = evaluateToolSelection(
      [],
      ['get_weather'],
    );

    expect(result.score).toBe(0.0);
    expect(result.reason).toContain('missing');
  });
});
