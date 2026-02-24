import { describe, test, expect } from "vitest";

// We can't import getLocation() directly since it depends on ADB,
// but we can test the parsing logic by extracting it.
// For now, test the parseLocationLine regex logic inline.

/** Parse a Location line from `dumpsys location` output (same logic as emulator.ts). */
function parseLocationLine(line: string): { lat: number; lng: number; accuracy?: number } | null {
  const coordMatch = line.match(/Location\[\S+\s+(-?[\d.]+),(-?[\d.]+)/);
  if (!coordMatch) return null;

  const lat = parseFloat(coordMatch[1]!);
  const lng = parseFloat(coordMatch[2]!);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const accMatch = line.match(/(?:hAcc|acc)=([\d.]+)/);
  const accuracy = accMatch ? parseFloat(accMatch[1]!) : undefined;

  return { lat, lng, accuracy };
}

describe("parseLocationLine", () => {
  test("parses GPS location with hAcc", () => {
    const line = "  gps: Location[gps 37.421998,-122.084000 hAcc=20.0 et=+1h2m3s456ms alt=0.0 vel=0.0 bear=0.0 mock]";
    const loc = parseLocationLine(line);
    expect(loc).not.toBeNull();
    expect(loc!.lat).toBeCloseTo(37.421998, 5);
    expect(loc!.lng).toBeCloseTo(-122.084, 5);
    expect(loc!.accuracy).toBe(20.0);
  });

  test("parses fused location with acc", () => {
    const line = "  fused: Location[fused 37.422000,-122.084100 acc=5.0 et=+1h2m3s]";
    const loc = parseLocationLine(line);
    expect(loc).not.toBeNull();
    expect(loc!.lat).toBeCloseTo(37.422, 5);
    expect(loc!.lng).toBeCloseTo(-122.0841, 5);
    expect(loc!.accuracy).toBe(5.0);
  });

  test("parses negative coordinates (southern/western hemisphere)", () => {
    const line = "  gps: Location[gps -33.868820,151.209290 hAcc=10.0]";
    const loc = parseLocationLine(line);
    expect(loc).not.toBeNull();
    expect(loc!.lat).toBeCloseTo(-33.86882, 5);
    expect(loc!.lng).toBeCloseTo(151.20929, 5);
  });

  test("handles missing accuracy field", () => {
    const line = "  gps: Location[gps 37.421998,-122.084000 et=+1h2m3s]";
    const loc = parseLocationLine(line);
    expect(loc).not.toBeNull();
    expect(loc!.lat).toBeCloseTo(37.421998, 5);
    expect(loc!.accuracy).toBeUndefined();
  });

  test("returns null for non-location line", () => {
    const line = "  Last Known Locations:";
    expect(parseLocationLine(line)).toBeNull();
  });

  test("returns null for empty line", () => {
    expect(parseLocationLine("")).toBeNull();
  });

  test("returns null for malformed coordinates", () => {
    const line = "  gps: Location[gps abc,def hAcc=10.0]";
    expect(parseLocationLine(line)).toBeNull();
  });

  test("parses location at origin (0,0)", () => {
    const line = "  gps: Location[gps 0.000000,0.000000 hAcc=1.0]";
    const loc = parseLocationLine(line);
    expect(loc).not.toBeNull();
    expect(loc!.lat).toBe(0);
    expect(loc!.lng).toBe(0);
    expect(loc!.accuracy).toBe(1.0);
  });
});
