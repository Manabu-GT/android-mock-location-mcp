// ── Geocoding ────────────────────────────────────────────────────────────────

export interface GeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
}

export type GeocodeProvider = (place: string) => Promise<GeocodeResult | null>;

export const nominatimGeocode: GeocodeProvider = async (place) => {
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
    q: place,
    format: "json",
    limit: "1",
  })}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "android-mock-location-mcp/0.1.0" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  if (data.length === 0) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), displayName: data[0].display_name };
};

// To switch providers, replace this with e.g. googlePlacesGeocode or mapboxGeocode.
const activeProvider: GeocodeProvider = nominatimGeocode;

export async function geocodePlace(place: string): Promise<GeocodeResult | null> {
  try {
    return await activeProvider(place);
  } catch {
    return null;
  }
}
