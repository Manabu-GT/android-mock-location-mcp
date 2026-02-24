import { describe, test, expect } from "vitest";
import { buildGpgga, buildGprmc } from "../nmea.js";

// ── Checksum Validation ──────────────────────────────────────────────────────

/** Verify NMEA checksum: XOR all chars between $ and * */
function verifyChecksum(sentence: string): boolean {
  const dollarIdx = sentence.indexOf("$");
  const starIdx = sentence.indexOf("*");
  if (dollarIdx < 0 || starIdx < 0) return false;
  const body = sentence.slice(dollarIdx + 1, starIdx);
  let cs = 0;
  for (let i = 0; i < body.length; i++) {
    cs ^= body.charCodeAt(i);
  }
  const expected = cs.toString(16).toUpperCase().padStart(2, "0");
  const actual = sentence.slice(starIdx + 1);
  return expected === actual;
}

// ── buildGpgga ───────────────────────────────────────────────────────────────

describe("buildGpgga", () => {
  test("starts with $GPGGA", () => {
    const sentence = buildGpgga({ lat: 37.7749, lng: -122.4194 });
    expect(sentence.startsWith("$GPGGA,")).toBe(true);
  });

  test("has valid checksum", () => {
    const sentence = buildGpgga({ lat: 37.7749, lng: -122.4194 });
    expect(verifyChecksum(sentence)).toBe(true);
  });

  test("contains correct latitude direction (N for positive)", () => {
    const sentence = buildGpgga({ lat: 37.7749, lng: -122.4194 });
    // Lat should contain N
    expect(sentence).toContain(",N,");
  });

  test("contains correct latitude direction (S for negative)", () => {
    const sentence = buildGpgga({ lat: -33.8688, lng: 151.2093 });
    expect(sentence).toContain(",S,");
  });

  test("contains correct longitude direction (W for negative)", () => {
    const sentence = buildGpgga({ lat: 37.7749, lng: -122.4194 });
    expect(sentence).toContain(",W,");
  });

  test("contains correct longitude direction (E for positive)", () => {
    const sentence = buildGpgga({ lat: -33.8688, lng: 151.2093 });
    expect(sentence).toContain(",E,");
  });

  test("contains altitude value", () => {
    const sentence = buildGpgga({ lat: 0, lng: 0, altitude: 150.5 });
    expect(sentence).toContain(",150.5,M,");
  });

  test("HDOP derived from accuracy (3m -> ~0.8)", () => {
    const sentence = buildGpgga({ lat: 0, lng: 0, accuracy: 3 });
    // accuracy / 4 = 0.75, but min is 0.5
    expect(sentence).toContain(",0.8,");
  });

  test("HDOP floors to 0.5 for very small accuracy", () => {
    const sentence = buildGpgga({ lat: 0, lng: 0, accuracy: 0.5 });
    expect(sentence).toContain(",0.5,");
  });

  test("GPS fix quality is 1", () => {
    const sentence = buildGpgga({ lat: 0, lng: 0 });
    // After longitude direction, quality indicator should be 1
    const fields = sentence.split(",");
    expect(fields[6]).toBe("1");
  });

  test("number of satellites is 08", () => {
    const sentence = buildGpgga({ lat: 0, lng: 0 });
    const fields = sentence.split(",");
    expect(fields[7]).toBe("08");
  });
});

// ── buildGprmc ───────────────────────────────────────────────────────────────

describe("buildGprmc", () => {
  test("starts with $GPRMC", () => {
    const sentence = buildGprmc({ lat: 37.7749, lng: -122.4194 });
    expect(sentence.startsWith("$GPRMC,")).toBe(true);
  });

  test("has valid checksum", () => {
    const sentence = buildGprmc({ lat: 37.7749, lng: -122.4194 });
    expect(verifyChecksum(sentence)).toBe(true);
  });

  test("status is A (active)", () => {
    const sentence = buildGprmc({ lat: 0, lng: 0 });
    const fields = sentence.split(",");
    expect(fields[2]).toBe("A");
  });

  test("speed converted from m/s to knots", () => {
    // 10 m/s = 19.4384 knots
    const sentence = buildGprmc({ lat: 0, lng: 0, speed: 10 });
    expect(sentence).toContain(",19.4,");
  });

  test("zero speed", () => {
    const sentence = buildGprmc({ lat: 0, lng: 0, speed: 0 });
    expect(sentence).toContain(",0.0,");
  });

  test("bearing included", () => {
    const sentence = buildGprmc({ lat: 0, lng: 0, bearing: 270 });
    expect(sentence).toContain(",270.0,");
  });

  test("latitude/longitude directions match GPGGA", () => {
    const params = { lat: -34.6037, lng: -58.3816 };
    const gpgga = buildGpgga(params);
    const gprmc = buildGprmc(params);
    // Both should have S and W
    expect(gpgga).toContain(",S,");
    expect(gpgga).toContain(",W,");
    expect(gprmc).toContain(",S,");
    expect(gprmc).toContain(",W,");
  });
});

// ── Coordinate Conversion ────────────────────────────────────────────────────

describe("coordinate conversion", () => {
  test("equator/prime meridian produces 0000.0000 values", () => {
    const sentence = buildGpgga({ lat: 0, lng: 0 });
    const fields = sentence.split(",");
    expect(fields[2]).toBe("0000.0000"); // lat
    expect(fields[4]).toBe("00000.0000"); // lng
  });

  test("SF coordinates convert correctly", () => {
    // 37.7749° = 37° 46.494'
    const sentence = buildGpgga({ lat: 37.7749, lng: -122.4194 });
    const fields = sentence.split(",");
    // Lat: 37 degrees, 46.494 minutes
    expect(fields[2]).toBe("3746.4940");
    expect(fields[3]).toBe("N");
    // Lng: 122 degrees, 25.164 minutes
    expect(fields[4]).toBe("12225.1640");
    expect(fields[5]).toBe("W");
  });
});
