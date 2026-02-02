import { describe, test, expect } from "vitest";
import { haversineDistance } from "../geo-math.js";
import {
  buildCumulativeDistances,
  buildStraightLineRoute,
  decodeGooglePolyline,
  interpolateAlongRoute,
  bearingAlongRoute,
} from "../routing.js";
import type { RoutePoint, RouteResult } from "../routing.js";
import { expectCloseTo } from "./test-utils.js";

/** Build a RouteResult from an array of points for testing. */
function makeRoute(points: RoutePoint[]): RouteResult {
  const cumulativeDistances = buildCumulativeDistances(points);
  return {
    points,
    distanceMeters: cumulativeDistances[cumulativeDistances.length - 1]!,
    cumulativeDistances,
    source: "test",
  };
}

// ── decodeGooglePolyline ────────────────────────────────────────────────────

describe("decodeGooglePolyline", () => {
  test("empty string returns empty array", () => {
    expect(decodeGooglePolyline("")).toEqual([]);
  });

  test("Google reference polyline decodes to 3 points", () => {
    // Reference from Google's polyline algorithm documentation
    const points = decodeGooglePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(points).toHaveLength(3);
    expectCloseTo(points[0]!.lat, 38.5, 0.01);
    expectCloseTo(points[0]!.lng, -120.2, 0.01);
    expectCloseTo(points[1]!.lat, 40.7, 0.01);
    expectCloseTo(points[1]!.lng, -120.95, 0.01);
    expectCloseTo(points[2]!.lat, 43.252, 0.01);
    expectCloseTo(points[2]!.lng, -126.453, 0.01);
  });

  test("single point polyline decodes correctly", () => {
    // Encode (0, 0): lat delta=0 -> "?" , lng delta=0 -> "?"
    const points = decodeGooglePolyline("??");
    expect(points).toHaveLength(1);
    expect(points[0]!.lat).toBe(0);
    expect(points[0]!.lng).toBe(0);
  });

  test("truncated input returns partial valid array without throwing", () => {
    // Take the reference string and truncate it mid-way through second point
    const full = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
    const truncated = full.slice(0, 15);
    const points = decodeGooglePolyline(truncated);
    // Should have at least the first point and not throw
    expect(points.length).toBeGreaterThanOrEqual(1);
    expectCloseTo(points[0]!.lat, 38.5, 0.01);
  });
});

// ── buildCumulativeDistances ────────────────────────────────────────────────

describe("buildCumulativeDistances", () => {
  test("empty array returns [0]", () => {
    expect(buildCumulativeDistances([])).toEqual([0]);
  });

  test("single point returns [0]", () => {
    expect(buildCumulativeDistances([{ lat: 0, lng: 0 }])).toEqual([0]);
  });

  test("two points returns [0, d(A,B)]", () => {
    const A = { lat: 0, lng: 0 };
    const B = { lat: 0, lng: 1 };
    const dists = buildCumulativeDistances([A, B]);
    expect(dists).toHaveLength(2);
    expect(dists[0]).toBe(0);
    expectCloseTo(dists[1]!, haversineDistance(0, 0, 0, 1), 1);
  });

  test("three points returns cumulative distances", () => {
    const A = { lat: 0, lng: 0 };
    const B = { lat: 0, lng: 1 };
    const C = { lat: 0, lng: 2 };
    const dists = buildCumulativeDistances([A, B, C]);
    expect(dists).toHaveLength(3);
    expect(dists[0]).toBe(0);
    const dAB = haversineDistance(0, 0, 0, 1);
    const dBC = haversineDistance(0, 1, 0, 2);
    expectCloseTo(dists[1]!, dAB, 1);
    expectCloseTo(dists[2]!, dAB + dBC, 1);
  });

  test("monotonically increasing", () => {
    const points: RoutePoint[] = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
      { lat: 0, lng: 2 },
      { lat: 1, lng: 2 },
    ];
    const dists = buildCumulativeDistances(points);
    for (let i = 1; i < dists.length; i++) {
      expect(dists[i]!).toBeGreaterThanOrEqual(dists[i - 1]!);
    }
  });

  test("duplicate points produce zero-length segments", () => {
    const A = { lat: 0, lng: 0 };
    const B = { lat: 0, lng: 1 };
    const dists = buildCumulativeDistances([A, A, B]);
    expect(dists).toHaveLength(3);
    expect(dists[0]).toBe(0);
    expect(dists[1]).toBe(0);
    expectCloseTo(dists[2]!, haversineDistance(0, 0, 0, 1), 1);
  });
});

// ── buildStraightLineRoute ──────────────────────────────────────────────────

describe("buildStraightLineRoute", () => {
  test("returns exactly 2 points", () => {
    const route = buildStraightLineRoute(0, 0, 1, 1);
    expect(route.points).toHaveLength(2);
  });

  test("points match input coordinates", () => {
    const route = buildStraightLineRoute(10, 20, 30, 40);
    expect(route.points[0]).toEqual({ lat: 10, lng: 20 });
    expect(route.points[1]).toEqual({ lat: 30, lng: 40 });
  });

  test('source is "straight-line"', () => {
    const route = buildStraightLineRoute(0, 0, 1, 1);
    expect(route.source).toBe("straight-line");
  });

  test("distanceMeters matches haversine", () => {
    const route = buildStraightLineRoute(0, 0, 1, 1);
    const expected = haversineDistance(0, 0, 1, 1);
    expect(route.distanceMeters).toBe(expected);
  });

  test("same start/end returns ~0 distance", () => {
    const route = buildStraightLineRoute(5, 10, 5, 10);
    expect(route.distanceMeters).toBe(0);
  });
});

// ── interpolateAlongRoute ───────────────────────────────────────────────────

describe("interpolateAlongRoute", () => {
  // Equal-segment equator route: (0,0) -> (0,1) -> (0,2)
  const equalRoute = makeRoute([
    { lat: 0, lng: 0 },
    { lat: 0, lng: 1 },
    { lat: 0, lng: 2 },
  ]);

  // Unequal-segment route: (0,0) -> (0,1) -> (0,3)  (2nd segment is 2x first)
  const unequalRoute = makeRoute([
    { lat: 0, lng: 0 },
    { lat: 0, lng: 1 },
    { lat: 0, lng: 3 },
  ]);

  test("fraction = 0 returns first point", () => {
    const p = interpolateAlongRoute(equalRoute, 0);
    expect(p).toEqual({ lat: 0, lng: 0 });
  });

  test("fraction = 1 returns last point", () => {
    const p = interpolateAlongRoute(equalRoute, 1);
    expect(p).toEqual({ lat: 0, lng: 2 });
  });

  test("fraction = 0.5 on equal route returns middle point", () => {
    const p = interpolateAlongRoute(equalRoute, 0.5);
    expectCloseTo(p.lat, 0, 0.001);
    expectCloseTo(p.lng, 1, 0.001);
  });

  test("fraction = 0.25 on equal route returns ~(0, 0.5)", () => {
    const p = interpolateAlongRoute(equalRoute, 0.25);
    expectCloseTo(p.lat, 0, 0.001);
    expectCloseTo(p.lng, 0.5, 0.001);
  });

  test("fraction < 0 clamps to first point", () => {
    const p = interpolateAlongRoute(equalRoute, -1);
    expect(p).toEqual({ lat: 0, lng: 0 });
  });

  test("fraction > 1 clamps to last point", () => {
    const p = interpolateAlongRoute(equalRoute, 2);
    expect(p).toEqual({ lat: 0, lng: 2 });
  });

  test("midpoint in 2nd segment of unequal route ~(0, 1.5)", () => {
    // Total distance: d(0,0->0,1) + d(0,1->0,3) = 1x + 2x = 3x
    // fraction=0.5 means 1.5x distance -> midpoint of 2nd segment
    const p = interpolateAlongRoute(unequalRoute, 0.5);
    expectCloseTo(p.lat, 0, 0.001);
    expectCloseTo(p.lng, 1.5, 0.02);
  });

  test("fraction=0.75 on unequal route ~(0, 2.25)", () => {
    // fraction=0.75 means 2.25x distance -> 3/4 through 2nd segment
    const p = interpolateAlongRoute(unequalRoute, 0.75);
    expectCloseTo(p.lat, 0, 0.001);
    expectCloseTo(p.lng, 2.25, 0.02);
  });

  test("single-point route returns that point", () => {
    const route = makeRoute([{ lat: 5, lng: 10 }]);
    const p = interpolateAlongRoute(route, 0.5);
    expect(p).toEqual({ lat: 5, lng: 10 });
  });

  test("fraction = 0.5 with hardcoded distances returns midpoint", () => {
    // Hardcoded RouteResult to verify interpolation independently of buildCumulativeDistances
    const route: RouteResult = {
      points: [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 0, lng: 2 }],
      distanceMeters: 200,
      cumulativeDistances: [0, 100, 200],
      source: "test",
    };
    const p = interpolateAlongRoute(route, 0.5);
    expect(p).toEqual({ lat: 0, lng: 1 });
  });

  test("zero-length route [A,A] returns A with no NaN", () => {
    const route = makeRoute([
      { lat: 5, lng: 10 },
      { lat: 5, lng: 10 },
    ]);
    const p = interpolateAlongRoute(route, 0.5);
    expect(p.lat).toBe(5);
    expect(p.lng).toBe(10);
    expect(Number.isNaN(p.lat)).toBe(false);
    expect(Number.isNaN(p.lng)).toBe(false);
  });
});

// ── bearingAlongRoute ───────────────────────────────────────────────────────

describe("bearingAlongRoute", () => {
  test("single point route returns 0", () => {
    const route = makeRoute([{ lat: 5, lng: 10 }]);
    expect(bearingAlongRoute(route, 0.5)).toBe(0);
  });

  test("east-bound at fraction=0 returns ~90 degrees", () => {
    const route = makeRoute([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
    ]);
    expectCloseTo(bearingAlongRoute(route, 0), 90, 0.5);
  });

  test("east-bound at fraction=1 returns ~90 degrees", () => {
    const route = makeRoute([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
    ]);
    expectCloseTo(bearingAlongRoute(route, 1), 90, 0.5);
  });

  test("L-shaped route first half returns ~90 degrees (east)", () => {
    // East then north: (0,0) -> (0,1) -> (1,1)
    const route = makeRoute([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
      { lat: 1, lng: 1 },
    ]);
    expectCloseTo(bearingAlongRoute(route, 0.25), 90, 0.5);
  });

  test("L-shaped route second half returns ~0 degrees (north)", () => {
    // East then north: (0,0) -> (0,1) -> (1,1)
    const route = makeRoute([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
      { lat: 1, lng: 1 },
    ]);
    expectCloseTo(bearingAlongRoute(route, 0.75), 0, 0.5);
  });

  test("fraction < 0 clamps to first segment bearing", () => {
    const route = makeRoute([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
      { lat: 1, lng: 1 },
    ]);
    expectCloseTo(bearingAlongRoute(route, -1), 90, 0.5);
  });

  test("fraction > 1 clamps to last segment bearing", () => {
    const route = makeRoute([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
      { lat: 1, lng: 1 },
    ]);
    expectCloseTo(bearingAlongRoute(route, 2), 0, 0.5);
  });
});
