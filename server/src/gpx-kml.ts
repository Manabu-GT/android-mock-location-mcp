// ── GPX / KML file parsing ────────────────────────────────────────────────────
//
// Parses GPX and KML XML files into a common TrackPoint array.
// Auto-detects format from the XML root element.
//
// GPX: Extracts <trkpt> elements from <trk>/<trkseg> with optional
//      <ele> (elevation) and <time> (timestamp) children.
//
// KML: Extracts <coordinates> from <LineString> elements.
//      Format is "lng,lat,ele" tuples separated by whitespace.
//      KML LineStrings have no per-point timestamps.

import { XMLParser } from "fast-xml-parser";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TrackPoint {
  lat: number;
  lng: number;
  elevation?: number;
  timestamp?: Date;
}

export interface ParsedTrack {
  /** Ordered trackpoints. */
  points: TrackPoint[];
  /** Detected file format. */
  format: "gpx" | "kml";
  /** True if ≥80% of points have valid timestamps (enables time-based replay). */
  hasTimestamps: boolean;
  /** Track name from the file, if present. */
  name?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Wrap a value in an array if it isn't one already (handles single-element XML). */
function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Parse an ISO 8601 date string. Returns undefined for invalid/missing values. */
function parseTimestamp(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const d = new Date(value.trim());
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Parse a numeric value. Returns undefined for non-finite results. */
function parseNum(value: unknown): number | undefined {
  if (value == null) return undefined;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : undefined;
}

// ── GPX Parsing ──────────────────────────────────────────────────────────────

function parseGpx(xml: Record<string, unknown>): ParsedTrack {
  const gpx = xml["gpx"] as Record<string, unknown> | undefined;
  if (!gpx) throw new Error("Invalid GPX: missing <gpx> root element");

  const name = typeof gpx["metadata"] === "object" && gpx["metadata"] !== null
    ? ((gpx["metadata"] as Record<string, unknown>)["name"] as string | undefined)
    : undefined;

  const points: TrackPoint[] = [];

  for (const trk of asArray(gpx["trk"])) {
    const trkObj = trk as Record<string, unknown>;
    for (const trkseg of asArray(trkObj["trkseg"])) {
      const segObj = trkseg as Record<string, unknown>;
      for (const trkpt of asArray(segObj["trkpt"])) {
        const pt = trkpt as Record<string, unknown>;
        const lat = parseNum(pt["@_lat"]);
        const lng = parseNum(pt["@_lon"]);
        if (lat === undefined || lng === undefined) continue;

        points.push({
          lat,
          lng,
          elevation: parseNum(pt["ele"]),
          timestamp: parseTimestamp(pt["time"]),
        });
      }
    }
  }

  if (points.length === 0) {
    throw new Error("GPX file contains no trackpoints. Expected <trkpt> elements inside <trk>/<trkseg>.");
  }

  const withTs = points.filter((p) => p.timestamp !== undefined).length;
  const hasTimestamps = withTs / points.length >= 0.8;

  // Sort by timestamp if time-based
  if (hasTimestamps) {
    points.sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0));
  }

  return {
    points,
    format: "gpx",
    hasTimestamps,
    name: typeof name === "string" ? name : undefined,
  };
}

// ── KML Parsing ──────────────────────────────────────────────────────────────

interface KmlNode {
  [key: string]: unknown;
}

/** Recursively find all <LineString> nodes in the KML document tree. */
function findLineStrings(node: unknown): KmlNode[] {
  const results: KmlNode[] = [];
  if (node == null || typeof node !== "object") return results;

  const obj = node as KmlNode;
  if ("LineString" in obj) {
    for (const ls of asArray(obj["LineString"])) {
      if (ls != null && typeof ls === "object") results.push(ls as KmlNode);
    }
  }
  // Recurse into known container elements
  for (const key of ["Document", "Folder", "Placemark"]) {
    if (key in obj) {
      for (const child of asArray(obj[key])) {
        results.push(...findLineStrings(child));
      }
    }
  }
  return results;
}

function parseKml(xml: Record<string, unknown>): ParsedTrack {
  const kml = xml["kml"] as Record<string, unknown> | undefined;
  if (!kml) throw new Error("Invalid KML: missing <kml> root element");

  // Try to find a name from the first Document or Placemark
  let name: string | undefined;
  const doc = kml["Document"] as Record<string, unknown> | undefined;
  if (doc && typeof doc["name"] === "string") {
    name = doc["name"];
  }

  const lineStrings = findLineStrings(kml);
  if (lineStrings.length === 0) {
    throw new Error("KML file contains no <LineString> elements.");
  }

  // Use the first LineString with >1 coordinate
  let points: TrackPoint[] = [];
  for (const ls of lineStrings) {
    const coordStr = ls["coordinates"];
    if (typeof coordStr !== "string") continue;

    const parsed = parseKmlCoordinates(coordStr);
    if (parsed.length > 1) {
      points = parsed;
      break;
    }
    // Keep single-point as fallback
    if (points.length === 0 && parsed.length > 0) {
      points = parsed;
    }
  }

  if (points.length === 0) {
    throw new Error("KML file contains no valid coordinates in <LineString> elements.");
  }

  return {
    points,
    format: "kml",
    hasTimestamps: false,
    name,
  };
}

/** Parse KML coordinate string: "lng,lat,ele lng,lat,ele ..." */
function parseKmlCoordinates(coordStr: string): TrackPoint[] {
  const points: TrackPoint[] = [];
  const tuples = coordStr.trim().split(/\s+/);

  for (const tuple of tuples) {
    const parts = tuple.split(",");
    if (parts.length < 2) continue;

    const lng = parseFloat(parts[0]!);
    const lat = parseFloat(parts[1]!);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const elevation = parts.length >= 3 ? parseFloat(parts[2]!) : undefined;
    points.push({
      lat,
      lng,
      elevation: Number.isFinite(elevation) ? elevation : undefined,
    });
  }

  return points;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse GPX or KML file content into a common track format.
 * Auto-detects format from the XML root element.
 *
 * @throws {Error} on invalid XML, unrecognized format, or no trackpoints found
 */
export function parseGpxKml(content: string): ParsedTrack {
  if (!content || content.trim() === "") {
    throw new Error("Empty file content. Provide a valid GPX or KML file.");
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    // Preserve text content in elements like <coordinates>
    trimValues: true,
    // Parse numeric attribute values (lat, lon)
    parseAttributeValue: true,
    // Don't auto-parse tag text to numbers (preserves timestamps, coordinate strings)
    parseTagValue: false,
    // Remove namespace prefixes for consistent element access
    removeNSPrefix: true,
  });

  let xml: Record<string, unknown>;
  try {
    xml = parser.parse(content) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Invalid XML: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Auto-detect format from root element
  if ("gpx" in xml) {
    return parseGpx(xml);
  }
  if ("kml" in xml) {
    return parseKml(xml);
  }

  throw new Error(
    "Unrecognized file format. Expected a GPX (<gpx> root) or KML (<kml> root) file.",
  );
}
