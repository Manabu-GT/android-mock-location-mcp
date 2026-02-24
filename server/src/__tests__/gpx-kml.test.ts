import { describe, test, expect } from "vitest";
import { parseGpxKml } from "../gpx-kml.js";

// ── GPX Parsing ──────────────────────────────────────────────────────────────

describe("parseGpxKml — GPX", () => {
  test("parses GPX with timestamps (time-based mode)", () => {
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test">
  <metadata><name>Morning Run</name></metadata>
  <trk>
    <trkseg>
      <trkpt lat="47.644548" lon="-122.326897">
        <ele>4.46</ele>
        <time>2024-10-17T18:37:26Z</time>
      </trkpt>
      <trkpt lat="47.645038" lon="-122.326477">
        <ele>5.12</ele>
        <time>2024-10-17T18:37:31Z</time>
      </trkpt>
      <trkpt lat="47.645554" lon="-122.326012">
        <ele>6.00</ele>
        <time>2024-10-17T18:37:36Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const result = parseGpxKml(gpx);
    expect(result.format).toBe("gpx");
    expect(result.hasTimestamps).toBe(true);
    expect(result.name).toBe("Morning Run");
    expect(result.points).toHaveLength(3);
    expect(result.points[0]!.lat).toBeCloseTo(47.644548, 5);
    expect(result.points[0]!.lng).toBeCloseTo(-122.326897, 5);
    expect(result.points[0]!.elevation).toBeCloseTo(4.46, 1);
    expect(result.points[0]!.timestamp).toBeInstanceOf(Date);
    expect(result.points[0]!.timestamp!.toISOString()).toBe("2024-10-17T18:37:26.000Z");
  });

  test("parses GPX without timestamps (distance-based mode)", () => {
    const gpx = `<?xml version="1.0"?>
<gpx version="1.1">
  <trk><trkseg>
    <trkpt lat="40.7128" lon="-74.0060"/>
    <trkpt lat="40.7138" lon="-74.0050"/>
    <trkpt lat="40.7148" lon="-74.0040"/>
  </trkseg></trk>
</gpx>`;

    const result = parseGpxKml(gpx);
    expect(result.format).toBe("gpx");
    expect(result.hasTimestamps).toBe(false);
    expect(result.points).toHaveLength(3);
    expect(result.points[0]!.timestamp).toBeUndefined();
  });

  test("concatenates multiple track segments", () => {
    const gpx = `<?xml version="1.0"?>
<gpx version="1.1">
  <trk>
    <trkseg>
      <trkpt lat="1.0" lon="2.0"/>
      <trkpt lat="3.0" lon="4.0"/>
    </trkseg>
    <trkseg>
      <trkpt lat="5.0" lon="6.0"/>
    </trkseg>
  </trk>
</gpx>`;

    const result = parseGpxKml(gpx);
    expect(result.points).toHaveLength(3);
    expect(result.points[2]!.lat).toBeCloseTo(5.0);
    expect(result.points[2]!.lng).toBeCloseTo(6.0);
  });

  test("concatenates multiple tracks", () => {
    const gpx = `<?xml version="1.0"?>
<gpx version="1.1">
  <trk><trkseg><trkpt lat="1.0" lon="2.0"/></trkseg></trk>
  <trk><trkseg><trkpt lat="3.0" lon="4.0"/></trkseg></trk>
</gpx>`;

    const result = parseGpxKml(gpx);
    expect(result.points).toHaveLength(2);
  });

  test("hasTimestamps threshold — 80% rule", () => {
    // 4 out of 5 points have timestamps = 80% → true
    const gpx = `<?xml version="1.0"?>
<gpx version="1.1">
  <trk><trkseg>
    <trkpt lat="1.0" lon="1.0"><time>2024-01-01T00:00:00Z</time></trkpt>
    <trkpt lat="2.0" lon="2.0"><time>2024-01-01T00:00:01Z</time></trkpt>
    <trkpt lat="3.0" lon="3.0"><time>2024-01-01T00:00:02Z</time></trkpt>
    <trkpt lat="4.0" lon="4.0"><time>2024-01-01T00:00:03Z</time></trkpt>
    <trkpt lat="5.0" lon="5.0"/>
  </trkseg></trk>
</gpx>`;

    const result = parseGpxKml(gpx);
    expect(result.hasTimestamps).toBe(true);
  });

  test("hasTimestamps below threshold", () => {
    // 1 out of 5 = 20% → false
    const gpx = `<?xml version="1.0"?>
<gpx version="1.1">
  <trk><trkseg>
    <trkpt lat="1.0" lon="1.0"><time>2024-01-01T00:00:00Z</time></trkpt>
    <trkpt lat="2.0" lon="2.0"/>
    <trkpt lat="3.0" lon="3.0"/>
    <trkpt lat="4.0" lon="4.0"/>
    <trkpt lat="5.0" lon="5.0"/>
  </trkseg></trk>
</gpx>`;

    const result = parseGpxKml(gpx);
    expect(result.hasTimestamps).toBe(false);
  });

  test("sorts points by timestamp when time-based", () => {
    const gpx = `<?xml version="1.0"?>
<gpx version="1.1">
  <trk><trkseg>
    <trkpt lat="3.0" lon="3.0"><time>2024-01-01T00:00:02Z</time></trkpt>
    <trkpt lat="1.0" lon="1.0"><time>2024-01-01T00:00:00Z</time></trkpt>
    <trkpt lat="2.0" lon="2.0"><time>2024-01-01T00:00:01Z</time></trkpt>
  </trkseg></trk>
</gpx>`;

    const result = parseGpxKml(gpx);
    expect(result.hasTimestamps).toBe(true);
    expect(result.points[0]!.lat).toBeCloseTo(1.0);
    expect(result.points[1]!.lat).toBeCloseTo(2.0);
    expect(result.points[2]!.lat).toBeCloseTo(3.0);
  });

  test("throws on GPX with no trackpoints", () => {
    const gpx = `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg></trkseg></trk></gpx>`;
    expect(() => parseGpxKml(gpx)).toThrow("no trackpoints");
  });
});

// ── KML Parsing ──────────────────────────────────────────────────────────────

describe("parseGpxKml — KML", () => {
  test("parses KML LineString coordinates (lng,lat,ele)", () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Test Route</name>
    <Placemark>
      <LineString>
        <coordinates>-122.326897,47.644548,4.46 -122.326477,47.645038,5.12 -122.326012,47.645554,6.00</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;

    const result = parseGpxKml(kml);
    expect(result.format).toBe("kml");
    expect(result.hasTimestamps).toBe(false);
    expect(result.name).toBe("Test Route");
    expect(result.points).toHaveLength(3);
    // KML is lng,lat — verify correct ordering
    expect(result.points[0]!.lat).toBeCloseTo(47.644548, 5);
    expect(result.points[0]!.lng).toBeCloseTo(-122.326897, 5);
    expect(result.points[0]!.elevation).toBeCloseTo(4.46, 1);
  });

  test("parses KML coordinates without elevation", () => {
    const kml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document><Placemark><LineString>
    <coordinates>-74.0060,40.7128 -74.0050,40.7138</coordinates>
  </LineString></Placemark></Document>
</kml>`;

    const result = parseGpxKml(kml);
    expect(result.points).toHaveLength(2);
    expect(result.points[0]!.elevation).toBeUndefined();
  });

  test("handles multiline coordinates", () => {
    const kml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document><Placemark><LineString>
    <coordinates>
      1.0,10.0,0
      2.0,20.0,0
      3.0,30.0,0
    </coordinates>
  </LineString></Placemark></Document>
</kml>`;

    const result = parseGpxKml(kml);
    expect(result.points).toHaveLength(3);
    expect(result.points[0]!.lng).toBeCloseTo(1.0);
    expect(result.points[0]!.lat).toBeCloseTo(10.0);
  });

  test("selects first LineString with >1 coordinate", () => {
    const kml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark><LineString><coordinates>1.0,1.0</coordinates></LineString></Placemark>
    <Placemark><LineString><coordinates>2.0,2.0 3.0,3.0</coordinates></LineString></Placemark>
  </Document>
</kml>`;

    const result = parseGpxKml(kml);
    expect(result.points).toHaveLength(2);
    expect(result.points[0]!.lng).toBeCloseTo(2.0);
  });

  test("falls back to single-point LineString if no multi-point found", () => {
    const kml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document><Placemark><LineString>
    <coordinates>-74.0060,40.7128,0</coordinates>
  </LineString></Placemark></Document>
</kml>`;

    const result = parseGpxKml(kml);
    expect(result.points).toHaveLength(1);
  });

  test("throws on KML with no LineString", () => {
    const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document></Document></kml>`;
    expect(() => parseGpxKml(kml)).toThrow("no <LineString>");
  });

  test("finds LineString inside MultiGeometry", () => {
    const kml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document><Placemark><MultiGeometry>
    <LineString><coordinates>1.0,10.0 2.0,20.0 3.0,30.0</coordinates></LineString>
  </MultiGeometry></Placemark></Document>
</kml>`;

    const result = parseGpxKml(kml);
    expect(result.points).toHaveLength(3);
    expect(result.points[0]!.lng).toBeCloseTo(1.0);
    expect(result.points[0]!.lat).toBeCloseTo(10.0);
  });
});

// ── Format detection & error handling ────────────────────────────────────────

describe("parseGpxKml — format detection", () => {
  test("detects GPX format", () => {
    const gpx = `<?xml version="1.0"?><gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`;
    expect(parseGpxKml(gpx).format).toBe("gpx");
  });

  test("detects KML format", () => {
    const kml = `<?xml version="1.0"?><kml><Document><Placemark><LineString><coordinates>1,2 3,4</coordinates></LineString></Placemark></Document></kml>`;
    expect(parseGpxKml(kml).format).toBe("kml");
  });

  test("throws on empty content", () => {
    expect(() => parseGpxKml("")).toThrow("Empty file");
  });

  test("throws on whitespace-only content", () => {
    expect(() => parseGpxKml("   \n  ")).toThrow("Empty file");
  });

  test("throws on unrecognized XML format", () => {
    expect(() => parseGpxKml(`<?xml version="1.0"?><svg></svg>`)).toThrow("Unrecognized file format");
  });

  test("throws on invalid XML", () => {
    expect(() => parseGpxKml("not xml at all <><>")).toThrow();
  });
});
