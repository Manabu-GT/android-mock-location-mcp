import { expect } from "vitest";

/** Assert that `actual` is within `±tolerance` of `expected`. */
export function expectCloseTo(actual: number, expected: number, tolerance: number) {
  expect(actual).toBeGreaterThanOrEqual(expected - tolerance);
  expect(actual).toBeLessThanOrEqual(expected + tolerance);
}
