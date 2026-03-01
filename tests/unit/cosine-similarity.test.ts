import { describe, it, expect } from 'vitest';
import { cosineSimilarity } from '../../src/utils/cosine-similarity.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0, 10);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0, 10);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0, 10);
  });

  it('is magnitude-independent', () => {
    expect(cosineSimilarity([3, 4], [6, 8])).toBeCloseTo(1.0, 10);
  });

  it('computes correct similarity for non-trivial vectors', () => {
    // cos(45°) = 1/√2 ≈ 0.7071
    expect(cosineSimilarity([1, 0], [1, 1])).toBeCloseTo(1 / Math.sqrt(2), 10);
  });

  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it('returns 0 when one vector is zero', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('handles high-dimensional vectors', () => {
    const a = Array.from({ length: 1536 }, (_, i) => Math.sin(i));
    const b = [...a];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 10);
  });

  it('handles vectors with negative components', () => {
    expect(cosineSimilarity([-1, -1], [-1, -1])).toBeCloseTo(1.0, 10);
    expect(cosineSimilarity([-1, -1], [1, 1])).toBeCloseTo(-1.0, 10);
  });
});
