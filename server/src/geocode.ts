// ── Geocoding ────────────────────────────────────────────────────────────────
//
// The active geocoding provider is selected via the PROVIDER environment variable:
//
// All providers use a 10-second fetch timeout to prevent indefinite hangs.
//
//   PROVIDER=osm      → Nominatim (default, free, no API key)
//   PROVIDER=google   → Google Geocoding API (requires GOOGLE_API_KEY)
//   PROVIDER=mapbox   → Mapbox Geocoding (requires MAPBOX_ACCESS_TOKEN)
//
// To add a new provider, implement the GeocodeProvider signature and add a
// case to selectProvider().

import { fetchWithTimeout } from "./fetch-utils.js";

export interface GeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
}

export type GeocodeProvider = (place: string) => Promise<GeocodeResult | null>;

// ── Nominatim (OpenStreetMap) ────────────────────────────────────────────────

const nominatimGeocode: GeocodeProvider = async (place) => {
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
    q: place,
    format: "json",
    limit: "1",
  })}`;
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": "android-mock-location-mcp/0.1.0" },
  }, 10_000);
  if (!res.ok) return null;
  const data = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  if (data.length === 0) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), displayName: data[0].display_name };
};

// ── Google Geocoding API ─────────────────────────────────────────────────────

const googleGeocode: GeocodeProvider = async (place) => {
  const apiKey = process.env.GOOGLE_API_KEY!; // Validated by selectProvider()

  const url = `https://maps.googleapis.com/maps/api/geocode/json?${new URLSearchParams({
    address: place,
    key: apiKey,
  })}`;
  const res = await fetchWithTimeout(url, {}, 10_000);
  if (!res.ok) return null;

  const data = (await res.json()) as {
    status: string;
    results: Array<{
      geometry: { location: { lat: number; lng: number } };
      formatted_address: string;
    }>;
  };

  if (data.status !== "OK" || !data.results?.length) return null;
  const result = data.results[0]!;
  return {
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    displayName: result.formatted_address,
  };
};

// ── Mapbox Geocoding API ─────────────────────────────────────────────────────

const mapboxGeocode: GeocodeProvider = async (place) => {
  const token = process.env.MAPBOX_ACCESS_TOKEN!; // Validated by selectProvider()

  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(place)}.json?` +
    new URLSearchParams({ access_token: token, limit: "1" });
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": "android-mock-location-mcp/0.1.0" },
  }, 10_000);
  if (!res.ok) return null;

  const data = (await res.json()) as {
    features: Array<{
      center: [number, number]; // [lng, lat]
      place_name: string;
    }>;
  };

  if (!data.features?.length) return null;
  const feature = data.features[0]!;
  return {
    lat: feature.center[1],
    lng: feature.center[0],
    displayName: feature.place_name,
  };
};

// ── Provider Selection ───────────────────────────────────────────────────────
// To switch providers, set PROVIDER env var to "osm", "google", or "mapbox".

function selectProvider(): GeocodeProvider {
  const name = (process.env.PROVIDER ?? "osm").toLowerCase();
  switch (name) {
    case "google": {
      if (!process.env.GOOGLE_API_KEY) {
        throw new Error("PROVIDER=google requires GOOGLE_API_KEY environment variable");
      }
      return googleGeocode;
    }
    case "mapbox": {
      if (!process.env.MAPBOX_ACCESS_TOKEN) {
        throw new Error("PROVIDER=mapbox requires MAPBOX_ACCESS_TOKEN environment variable");
      }
      return mapboxGeocode;
    }
    default:
      return nominatimGeocode;
  }
}

const activeProvider: GeocodeProvider = selectProvider();

export async function geocodePlace(place: string): Promise<GeocodeResult | null> {
  try {
    return await activeProvider(place);
  } catch {
    return null;
  }
}
