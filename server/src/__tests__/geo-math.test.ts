import { describe, test, expect } from "vitest";
import { haversineDistance, computeBearing } from "../geo-math.js";
import { expectCloseTo } from "./test-utils.js";

// ── haversineDistance ────────────────────────────────────────────────────────

describe("haversineDistance", () => {
  test("same point returns 0", () => {
    expect(haversineDistance(0, 0, 0, 0)).toBe(0);
  });

  test("NYC to London ~5,570 km", () => {
    const d = haversineDistance(40.7128, -74.006, 51.5074, -0.1278);
    expectCloseTo(d, 5_570_000, 5_000);
  });

  test("equator 1 degree longitude ~111,195 m", () => {
    const d = haversineDistance(0, 0, 0, 1);
    expectCloseTo(d, 111_195, 50);
  });

  test("pole to pole ~20,015 km", () => {
    const d = haversineDistance(90, 0, -90, 0);
    expectCloseTo(d, 20_015_000, 10_000);
  });

  test("antipodal points ~20,015 km", () => {
    const d = haversineDistance(0, 0, 0, 180);
    expectCloseTo(d, 20_015_000, 10_000);
  });

  test("negative coords: Buenos Aires to Sydney ~11,800 km", () => {
    const d = haversineDistance(-34.6, -58.4, -33.9, 151.2);
    expectCloseTo(d, 11_800_000, 50_000);
  });

  test("small distance ~14 m", () => {
    const d = haversineDistance(35.6812, 139.7671, 35.6813, 139.7672);
    expectCloseTo(d, 14, 2);
  });

  test("symmetric: d(A,B) === d(B,A)", () => {
    const d1 = haversineDistance(40.7128, -74.006, 51.5074, -0.1278);
    const d2 = haversineDistance(51.5074, -0.1278, 40.7128, -74.006);
    expect(d1).toBe(d2);
  });
});

// ── computeBearing ──────────────────────────────────────────────────────────

describe("computeBearing", () => {
  test("due north ~0 degrees", () => {
    const b = computeBearing(0, 0, 1, 0);
    expectCloseTo(b, 0, 0.5);
  });

  test("due east ~90 degrees", () => {
    const b = computeBearing(0, 0, 0, 1);
    expectCloseTo(b, 90, 0.5);
  });

  test("due south ~180 degrees", () => {
    const b = computeBearing(1, 0, 0, 0);
    expectCloseTo(b, 180, 0.5);
  });

  test("due west ~270 degrees", () => {
    const b = computeBearing(0, 1, 0, 0);
    expectCloseTo(b, 270, 0.5);
  });

  test("northeast ~44.5 degrees", () => {
    const b = computeBearing(0, 0, 1, 1);
    expectCloseTo(b, 44.5, 1.0);
  });

  test("same point returns 0", () => {
    const b = computeBearing(0, 0, 0, 0);
    expect(b).toBe(0);
  });

  test("same point at pole returns 0", () => {
    const b = computeBearing(90, 0, 90, 0);
    expect(b).toBe(0);
  });

  test("southwest ~225 degrees", () => {
    const b = computeBearing(1, 1, 0, 0);
    expectCloseTo(b, 225, 1.0);
  });
});
