// ── Routing ──────────────────────────────────────────────────────────────────
//
// Provides street-level routing for route simulation. The active provider is
// selected via the PROVIDER environment variable (shared with geocoding):
//
//   PROVIDER=osm      (default, free, no API key — Nominatim + OSRM)
//   PROVIDER=google   (requires GOOGLE_API_KEY)
//   PROVIDER=mapbox   (requires MAPBOX_ACCESS_TOKEN)
//
// NOTE: The OSRM public demo server (router.project-osrm.org) only supports
// the "car" profile. Requesting "foot" or "bike" silently returns a driving
// route. For proper walking/cycling routing, use Google or Mapbox providers,
// or self-host OSRM with foot/bike profiles loaded.
//
// To add a new provider, implement the RoutingProvider signature and add a
// case to selectProvider().

import { haversineDistance, computeBearing } from "./geo-math.js";
import { fetchWithTimeout } from "./fetch-utils.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RoutePoint {
  lat: number;
  lng: number;
}

export interface RouteResult {
  /** Ordered polyline coordinates along the road. */
  points: RoutePoint[];
  /** Total route distance in meters (along the road). */
  distanceMeters: number;
  /** Cumulative distance from points[0] to points[i]. cumulativeDistances[0] = 0. */
  cumulativeDistances: number[];
  /** Which provider produced this route. */
  source: string;
}

export type RoutingProfile = "car" | "foot" | "bike";

/**
 * A routing provider fetches a street-level route between two coordinates.
 * Returns null on failure (network error, no route found, etc.).
 */
export type RoutingProvider = (
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  profile: RoutingProfile,
) => Promise<RouteResult | null>;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** @internal */
export function buildCumulativeDistances(points: RoutePoint[]): number[] {
  const dists = [0];
  for (let i = 1; i < points.length; i++) {
    dists.push(dists[i - 1]! + haversineDistance(points[i - 1]!.lat, points[i - 1]!.lng, points[i]!.lat, points[i]!.lng));
  }
  return dists;
}

/** @internal */
export function buildStraightLineRoute(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): RouteResult {
  const points: RoutePoint[] = [
    { lat: fromLat, lng: fromLng },
    { lat: toLat, lng: toLng },
  ];
  const dist = haversineDistance(fromLat, fromLng, toLat, toLng);
  return {
    points,
    distanceMeters: dist,
    cumulativeDistances: [0, dist],
    source: "straight-line",
  };
}

// ── OSRM Provider ────────────────────────────────────────────────────────────

const OSRM_PROFILES: Record<RoutingProfile, string> = {
  car: "car",
  foot: "foot",
  bike: "bicycle",
};

const osrmRouting: RoutingProvider = async (fromLat, fromLng, toLat, toLng, profile) => {
  const osrmProfile = OSRM_PROFILES[profile];
  const url =
    `https://router.project-osrm.org/route/v1/${osrmProfile}/` +
    `${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`;

  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": "android-mock-location-mcp/0.1.0" },
  }, 10_000);
  if (!res.ok) return null;

  const data = (await res.json()) as {
    code: string;
    routes: Array<{
      geometry: { coordinates: Array<[number, number]> };
      distance: number;
      duration: number;
    }>;
  };

  if (data.code !== "Ok" || !data.routes?.length) return null;
  const route = data.routes[0]!;
  const coords = route.geometry.coordinates;
  if (!coords.length) return null;

  // OSRM returns [lng, lat] (GeoJSON standard) — swap to {lat, lng}
  const points: RoutePoint[] = coords.map(([lng, lat]) => ({ lat, lng }));
  const cumulativeDistances = buildCumulativeDistances(points);

  return {
    points,
    distanceMeters: cumulativeDistances[cumulativeDistances.length - 1]!,
    cumulativeDistances,
    source: "osrm",
  };
};

// ── Google Routes Provider ───────────────────────────────────────────────────

const GOOGLE_TRAVEL_MODES: Record<RoutingProfile, string> = {
  car: "DRIVE",
  foot: "WALK",
  bike: "BICYCLE",
};

/** @internal */
export function decodeGooglePolyline(encoded: string): RoutePoint[] {
  const points: RoutePoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      if (index >= encoded.length) return points; // truncated input
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      if (index >= encoded.length) return points; // truncated input
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

const googleRouting: RoutingProvider = async (fromLat, fromLng, toLat, toLng, profile) => {
  const apiKey = process.env.GOOGLE_API_KEY!; // Validated by selectProvider()

  const body = {
    origin: { location: { latLng: { latitude: fromLat, longitude: fromLng } } },
    destination: { location: { latLng: { latitude: toLat, longitude: toLng } } },
    travelMode: GOOGLE_TRAVEL_MODES[profile],
  };

  const res = await fetchWithTimeout(
    "https://routes.googleapis.com/directions/v2:computeRoutes",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.polyline.encodedPolyline",
      },
      body: JSON.stringify(body),
    },
    10_000,
  );
  if (!res.ok) return null;

  const data = (await res.json()) as {
    routes?: Array<{
      distanceMeters?: number;
      polyline?: { encodedPolyline?: string };
    }>;
  };

  const route = data.routes?.[0];
  const encoded = route?.polyline?.encodedPolyline;
  if (!encoded) return null;

  const points = decodeGooglePolyline(encoded);
  if (points.length < 2) return null;

  const cumulativeDistances = buildCumulativeDistances(points);
  return {
    points,
    distanceMeters: cumulativeDistances[cumulativeDistances.length - 1]!,
    cumulativeDistances,
    source: "google",
  };
};

// ── Mapbox Directions Provider ───────────────────────────────────────────────

const MAPBOX_PROFILES: Record<RoutingProfile, string> = {
  car: "driving",
  foot: "walking",
  bike: "cycling",
};

const mapboxRouting: RoutingProvider = async (fromLat, fromLng, toLat, toLng, profile) => {
  const token = process.env.MAPBOX_ACCESS_TOKEN!; // Validated by selectProvider()

  const mapboxProfile = MAPBOX_PROFILES[profile];
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/${mapboxProfile}/` +
    `${fromLng},${fromLat};${toLng},${toLat}?geometries=geojson&overview=full&access_token=${token}`;

  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": "android-mock-location-mcp/0.1.0" },
  }, 10_000);
  if (!res.ok) return null;

  const data = (await res.json()) as {
    code: string;
    routes: Array<{
      geometry: { coordinates: Array<[number, number]> };
      distance: number;
      duration: number;
    }>;
  };

  if (data.code !== "Ok" || !data.routes?.length) return null;
  const route = data.routes[0]!;
  const coords = route.geometry.coordinates;
  if (!coords.length) return null;

  // Mapbox returns [lng, lat] (GeoJSON standard)
  const points: RoutePoint[] = coords.map(([lng, lat]) => ({ lat, lng }));
  const cumulativeDistances = buildCumulativeDistances(points);

  return {
    points,
    distanceMeters: cumulativeDistances[cumulativeDistances.length - 1]!,
    cumulativeDistances,
    source: "mapbox",
  };
};

// ── Provider Selection ───────────────────────────────────────────────────────
// To switch providers, set PROVIDER env var to "osm", "google", or "mapbox".

function selectProvider(): RoutingProvider {
  const name = (process.env.PROVIDER ?? "osm").toLowerCase();
  switch (name) {
    case "google": {
      if (!process.env.GOOGLE_API_KEY) {
        throw new Error("PROVIDER=google requires GOOGLE_API_KEY environment variable");
      }
      return googleRouting;
    }
    case "mapbox": {
      if (!process.env.MAPBOX_ACCESS_TOKEN) {
        throw new Error("PROVIDER=mapbox requires MAPBOX_ACCESS_TOKEN environment variable");
      }
      return mapboxRouting;
    }
    default:
      return osrmRouting;
  }
}

const activeProvider: RoutingProvider = selectProvider();

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch a street-level route. Falls back to straight-line if the provider fails.
 */
export async function getRoute(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  profile: RoutingProfile,
): Promise<RouteResult> {
  try {
    const result = await activeProvider(fromLat, fromLng, toLat, toLng, profile);
    if (result) return result;
  } catch {
    // Provider failed — fall through to straight-line
  }
  return buildStraightLineRoute(fromLat, fromLng, toLat, toLng);
}

/**
 * Interpolate a position along a route polyline at the given progress fraction (0–1).
 */
export function interpolateAlongRoute(route: RouteResult, fraction: number): RoutePoint {
  if (fraction <= 0) return route.points[0]!;
  if (fraction >= 1) return route.points[route.points.length - 1]!;

  const targetDist = fraction * route.distanceMeters;
  const cumDists = route.cumulativeDistances;

  // Find the segment containing targetDist
  let i = 0;
  while (i < cumDists.length - 1 && cumDists[i + 1]! <= targetDist) {
    i++;
  }

  // Edge case: at or past the last point
  if (i >= route.points.length - 1) return route.points[route.points.length - 1]!;

  const segStart = cumDists[i]!;
  const segEnd = cumDists[i + 1]!;
  const segLen = segEnd - segStart;

  if (segLen === 0) return route.points[i]!;

  const segFrac = (targetDist - segStart) / segLen;
  const p1 = route.points[i]!;
  const p2 = route.points[i + 1]!;

  return {
    lat: p1.lat + (p2.lat - p1.lat) * segFrac,
    lng: p1.lng + (p2.lng - p1.lng) * segFrac,
  };
}

/**
 * Compute bearing along the route polyline at the given progress fraction.
 */
export function bearingAlongRoute(route: RouteResult, fraction: number): number {
  if (route.points.length < 2) return 0;

  const clampedFrac = Math.max(0, Math.min(1, fraction));
  const targetDist = clampedFrac * route.distanceMeters;
  const cumDists = route.cumulativeDistances;

  let i = 0;
  while (i < cumDists.length - 1 && cumDists[i + 1]! <= targetDist) {
    i++;
  }

  if (i >= route.points.length - 1) i = route.points.length - 2;

  const p1 = route.points[i]!;
  const p2 = route.points[i + 1]!;
  return computeBearing(p1.lat, p1.lng, p2.lat, p2.lng);
}
