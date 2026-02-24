#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { geocodePlace } from "./geocode.js";
import { haversineDistance } from "./geo-math.js";
import { getRoute, interpolateAlongRoute, bearingAlongRoute } from "./routing.js";
import { createRequire } from "node:module";
import {
  setLocation,
  connectEmulator,
  getConnectedDeviceId,
  isConnected,
  onDisconnect,
  initEmulator,
  shutdownEmulator,
} from "./emulator.js";
import { listDevices, isEmulator } from "./adb.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

// ── Simulation State ─────────────────────────────────────────────────────────

let simulationTimer: ReturnType<typeof setInterval> | null = null;
let lastLocation: Readonly<{ lat: number; lng: number }> | null = null;

function stopSimulation(): void {
  if (simulationTimer !== null) {
    clearInterval(simulationTimer);
    simulationTimer = null;
  }
}

// Stop any running simulation when the emulator disconnects.
onDisconnect(() => stopSimulation());

function text(msg: string) {
  return { content: [{ type: "text" as const, text: msg }] };
}

const isOsmProvider = !process.env.PROVIDER || ["osm", "osrm"].includes(process.env.PROVIDER.toLowerCase());
const geocodeHint = isOsmProvider
  ? " Prefer resolving place names to lat/lng coordinates yourself and passing them directly, as the default geocoder (Nominatim) is rate-limited. To resolve a place name: use WebSearch with `site:google.com/maps/place <place name>` to find an indexed Google Maps listing, then extract coordinates from the result URL — look for the `!3d<lat>!4d<lng>` parameters (e.g. `!3d40.0080766!4d-105.2342995`), or the `@lat,lng` segment (e.g. `@40.008,-105.234`). If no Maps result is found, pass the place name or address directly to the tool and let the server geocode it. If the server geocoder also fails, do ONE targeted web search for the address/place coordinates — do not perform multiple rounds of searching."
  : "";

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "android-mock-location-mcp",
  version,
});

// 1. geo_list_devices
server.registerTool("geo_list_devices", { description: "List connected Android emulators via ADB" }, async () => {
  try {
    const raw = await listDevices();
    const lines = raw.split("\n").slice(1).filter((l) => l.trim());
    if (lines.length === 0) return text("No devices found. Start an Android emulator first.");
    const devices = lines.map((l) => {
      const parts = l.split(/\s+/);
      const serial = parts[0]!;
      const info = parts.slice(1).join(" ");
      const supported = isEmulator(serial) ? "" : " (not supported — emulators only)";
      return `  ${serial}  ${info}${supported}`;
    });
    return text(`Devices:\n${devices.join("\n")}`);
  } catch {
    return text("Error: adb not found. Install Android SDK Platform Tools and ensure adb is on PATH.");
  }
});

// 2. geo_connect_device
server.registerTool(
  "geo_connect_device",
  {
    description:
      "Connect to an Android emulator for mock location control. " +
      "Only emulators are supported (e.g. emulator-5554). " +
      "Sets location via NMEA sentences — no agent app installation needed.",
    inputSchema: { deviceId: z.string().describe("Emulator serial from geo_list_devices, e.g. emulator-5554") },
  },
  async ({ deviceId }) => {
    if (!isEmulator(deviceId)) {
      return text(
        `"${deviceId}" is not an emulator. Only Android emulators are supported (e.g. emulator-5554).\n` +
          "Start an Android emulator and use its serial from geo_list_devices.",
      );
    }

    try {
      connectEmulator(deviceId);
      return text(`Connected to ${deviceId}. Ready to set mock locations.`);
    } catch (err) {
      return text(`Failed to connect to ${deviceId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

// 3. geo_set_location
server.registerTool(
  "geo_set_location",
  {
    description: "Set emulator GPS to coordinates or any place name/address (geocoded via configured provider)." + geocodeHint,
    inputSchema: {
      lat: z.number().optional().describe("Latitude (-90 to 90)"),
      lng: z.number().optional().describe("Longitude (-180 to 180)"),
      place: z.string().optional().describe("Any place name or address, e.g. 'Uber HQ', 'Tokyo Station', '123 Main St Denver'"),
      accuracy: z.number().default(3.0).describe("GPS accuracy in meters"),
    },
  },
  async ({ lat, lng, place, accuracy }) => {
    let coords: { lat: number; lng: number };
    let resolvedName: string | undefined;

    if (place) {
      const resolved = await geocodePlace(place);
      if (!resolved) {
        return text(`Could not geocode "${place}". Try a more specific name or pass lat/lng directly.`);
      }
      coords = resolved;
      resolvedName = resolved.displayName;
    } else if (lat !== undefined && lng !== undefined) {
      coords = { lat, lng };
    } else {
      return text("Provide either 'place' or both 'lat' and 'lng'.");
    }

    try {
      setLocation({
        lat: coords.lat,
        lng: coords.lng,
        accuracy,
        altitude: 0,
        speed: 0,
        bearing: 0,
      });

      let msg = `Location set to ${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`;
      if (resolvedName) msg += ` (${resolvedName})`;

      if (lastLocation !== null) {
        const dist = haversineDistance(lastLocation.lat, lastLocation.lng, coords.lat, coords.lng);
        if (dist > 100_000) {
          msg += `\n  Warning: Teleported ${(dist / 1000).toFixed(0)} km. Apps may flag this.`;
        }
      }

      lastLocation = { lat: coords.lat, lng: coords.lng };
      return text(msg);
    } catch (err) {
      return text(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

// 4. geo_simulate_route
server.registerTool(
  "geo_simulate_route",
  {
    description:
      "Simulate movement along a route between two points at a given speed. " +
      "Routes follow real streets via a routing provider (configurable via PROVIDER env var). " +
      "Accepts place names (geocoded via configured provider) or lat/lng coordinates. " +
      "If 'from' is omitted, automatically uses the current mock location as the starting point." + geocodeHint,
    inputSchema: {
      from: z.string().optional().describe("Starting place name or address"),
      to: z.string().optional().describe("Destination place name or address"),
      fromLat: z.number().optional().describe("Starting latitude"),
      fromLng: z.number().optional().describe("Starting longitude"),
      toLat: z.number().optional().describe("Destination latitude"),
      toLng: z.number().optional().describe("Destination longitude"),
      speedKmh: z.number().default(60).describe("Speed in km/h"),
      trafficMultiplier: z.number().default(1.0).describe("Traffic slowdown factor (e.g. 1.5 = 50% slower)"),
      profile: z
        .enum(["car", "foot", "bike"])
        .default("car")
        .describe("Routing profile. Use 'foot' for walking, 'bike' for cycling, 'car' for driving. Choose based on the user's intent."),
    },
  },
  async ({ from, to, fromLat, fromLng, toLat, toLng, speedKmh, trafficMultiplier, profile }) => {
    const resolveEndpoint = async (
      name?: string,
      lat?: number,
      lng?: number,
      label?: string,
    ): Promise<{ lat: number; lng: number } | { error: string }> => {
      if (name) {
        const r = await geocodePlace(name);
        if (!r)
          return {
            error: `Could not geocode "${name}" for ${label}. Try a more specific name or use ${label}Lat/${label}Lng.`,
          };
        return { lat: r.lat, lng: r.lng };
      }
      if (lat !== undefined && lng !== undefined) return { lat, lng };
      return { error: `Provide '${label}' place name or ${label}Lat/${label}Lng coordinates` };
    };

    // Resolve start: explicit args → last mock position → error
    let start: { lat: number; lng: number } | { error: string };
    if (from || (fromLat !== undefined && fromLng !== undefined)) {
      start = await resolveEndpoint(from, fromLat, fromLng, "from");
    } else if (lastLocation !== null) {
      start = { lat: lastLocation.lat, lng: lastLocation.lng };
    } else {
      start = {
        error:
          "No starting location available. " +
          "Provide 'from' or fromLat/fromLng, or set a location first with geo_set_location.",
      };
    }

    const end = await resolveEndpoint(to, toLat, toLng, "to");
    if ("error" in start) return text(start.error);
    if ("error" in end) return text(end.error);

    // Fetch street-level route (falls back to straight-line if provider fails)
    const route = await getRoute(start.lat, start.lng, end.lat, end.lng, profile);

    const effectiveSpeed = (speedKmh / trafficMultiplier) * (1000 / 3600); // m/s
    const totalSeconds = Math.max(1, Math.round(route.distanceMeters / effectiveSpeed));

    stopSimulation();
    let step = 0;

    // Send starting position immediately
    const startPoint = route.points[0]!;
    try {
      setLocation({
        lat: startPoint.lat,
        lng: startPoint.lng,
        accuracy: 3,
        altitude: 0,
        speed: 0,
        bearing: bearingAlongRoute(route, 0),
      });
    } catch {
      // Continue — simulation interval will retry
    }
    lastLocation = { lat: startPoint.lat, lng: startPoint.lng };

    simulationTimer = setInterval(() => {
      step++;
      if (step > totalSeconds) {
        const endPoint = route.points[route.points.length - 1]!;
        try {
          setLocation({
            lat: endPoint.lat,
            lng: endPoint.lng,
            accuracy: 3,
            altitude: 0,
            speed: 0,
            bearing: 0,
          });
        } catch {
          // ignore
        }
        lastLocation = { lat: endPoint.lat, lng: endPoint.lng };
        stopSimulation();
        return;
      }
      const frac = step / totalSeconds;
      const pos = interpolateAlongRoute(route, frac);
      const bearing = bearingAlongRoute(route, frac);
      try {
        setLocation({
          lat: pos.lat,
          lng: pos.lng,
          accuracy: 3,
          altitude: 0,
          speed: effectiveSpeed,
          bearing,
        });
      } catch {
        // ignore
      }
      lastLocation = { lat: pos.lat, lng: pos.lng };
    }, 1000);

    const etaMin = (totalSeconds / 60).toFixed(1);
    const routeInfo =
      route.source === "straight-line"
        ? "straight-line (fallback)"
        : `${route.source}, profile: ${profile}, ${route.points.length} waypoints`;
    return text(
      `Route simulation started.\n` +
        `  Routing: ${routeInfo}\n` +
        `  Distance: ${(route.distanceMeters / 1000).toFixed(2)} km\n` +
        `  Speed: ${(effectiveSpeed * 3.6).toFixed(1)} km/h (traffic x${trafficMultiplier})\n` +
        `  ETA: ${etaMin} min (${totalSeconds} steps at 1 Hz)`,
    );
  },
);

// 5. geo_simulate_jitter
server.registerTool(
  "geo_simulate_jitter",
  {
    description: "Simulate GPS noise/jitter at a location for testing accuracy handling. Accepts place names (geocoded via configured provider) or lat/lng coordinates." + geocodeHint,
    inputSchema: {
      lat: z.number().optional().describe("Center latitude"),
      lng: z.number().optional().describe("Center longitude"),
      place: z.string().optional().describe("Center place name or address"),
      radiusMeters: z.number().default(10).describe("Jitter radius in meters"),
      pattern: z.enum(["random", "drift", "urban_canyon"]).default("random"),
      durationSeconds: z.number().default(30).describe("Duration in seconds"),
    },
  },
  async ({ lat, lng, place, radiusMeters, pattern, durationSeconds }) => {
    let center: { lat: number; lng: number };
    if (place) {
      const r = await geocodePlace(place);
      if (!r) return text(`Could not geocode "${place}". Try a more specific name or pass lat/lng directly.`);
      center = r;
    } else if (lat !== undefined && lng !== undefined) {
      center = { lat, lng };
    } else {
      return text("Provide 'place' or both 'lat' and 'lng'.");
    }

    stopSimulation();
    let tick = 0;
    let driftAngle = Math.random() * 2 * Math.PI;
    let canyonBad = false;
    let canyonStreakLeft = 0;

    simulationTimer = setInterval(() => {
      tick++;
      if (tick > durationSeconds) {
        stopSimulation();
        return;
      }

      const mPerDegLat = 111_320;
      const mPerDegLng = 111_320 * Math.cos((center.lat * Math.PI) / 180);
      let offsetLat = 0;
      let offsetLng = 0;
      let acc = radiusMeters;

      if (pattern === "random") {
        const angle = Math.random() * 2 * Math.PI;
        const dist = Math.random() * radiusMeters;
        offsetLat = (Math.sin(angle) * dist) / mPerDegLat;
        offsetLng = (Math.cos(angle) * dist) / mPerDegLng;
        acc = radiusMeters + Math.random() * radiusMeters;
      } else if (pattern === "drift") {
        driftAngle += (Math.random() - 0.5) * 0.3;
        const dist = (radiusMeters * tick) / durationSeconds;
        offsetLat = (Math.sin(driftAngle) * dist) / mPerDegLat;
        offsetLng = (Math.cos(driftAngle) * dist) / mPerDegLng;
        acc = dist + Math.random() * radiusMeters;
      } else {
        // urban_canyon: streaks of good/bad GPS (3-5s each)
        if (canyonStreakLeft <= 0) {
          canyonBad = !canyonBad;
          canyonStreakLeft = 3 + Math.floor(Math.random() * 3); // 3-5 ticks
        }
        canyonStreakLeft--;

        if (!canyonBad) {
          // Good GPS: send center with tight accuracy
          acc = 3 + Math.random() * 2;
          // fall through with offsetLat/offsetLng = 0
        } else {
          acc = radiusMeters + Math.random() * radiusMeters;
          const dist = radiusMeters + Math.random() * 30;
          const angle = Math.random() * 2 * Math.PI;
          offsetLat = (Math.sin(angle) * dist) / mPerDegLat;
          offsetLng = (Math.cos(angle) * dist) / mPerDegLng;
        }
      }

      try {
        setLocation({
          lat: center.lat + offsetLat,
          lng: center.lng + offsetLng,
          accuracy: acc,
          altitude: 0,
          speed: 0,
          bearing: 0,
        });
      } catch {
        // ignore
      }
      lastLocation = { lat: center.lat + offsetLat, lng: center.lng + offsetLng };
    }, 1000);

    return text(
      `Jitter simulation started.\n` +
        `  Center: ${center.lat.toFixed(6)}, ${center.lng.toFixed(6)}\n` +
        `  Pattern: ${pattern}, Radius: ${radiusMeters}m\n` +
        `  Duration: ${durationSeconds}s`,
    );
  },
);

// 6. geo_test_geofence
server.registerTool(
  "geo_test_geofence",
  {
    description: "Test geofence enter/exit/bounce behavior at a location. Accepts place names (geocoded via configured provider) or lat/lng coordinates." + geocodeHint,
    inputSchema: {
      lat: z.number().optional().describe("Geofence center latitude"),
      lng: z.number().optional().describe("Geofence center longitude"),
      place: z.string().optional().describe("Geofence center place name or address"),
      radiusMeters: z.number().default(100).describe("Geofence radius in meters"),
      action: z.enum(["enter", "exit", "bounce"]).default("enter"),
      bounceCount: z.number().default(3).describe("Number of boundary crossings for bounce action"),
    },
  },
  async ({ lat, lng, place, radiusMeters, action, bounceCount }) => {
    let center: { lat: number; lng: number };
    if (place) {
      const r = await geocodePlace(place);
      if (!r) return text(`Could not geocode "${place}". Try a more specific name or pass lat/lng directly.`);
      center = r;
    } else if (lat !== undefined && lng !== undefined) {
      center = { lat, lng };
    } else {
      return text("Provide 'place' or both 'lat' and 'lng'.");
    }

    stopSimulation();

    const outside = 1.5 * radiusMeters;
    const inside = 0.3 * radiusMeters;
    const mPerDegLat = 111_320;
    const offsetDeg = (m: number) => m / mPerDegLat;

    const positions: { lat: number; lng: number }[] = [];
    const steps = 5;

    if (action === "enter") {
      for (let i = 0; i <= steps; i++) {
        const dist = outside - ((outside - inside) * i) / steps;
        positions.push({ lat: center.lat + offsetDeg(dist), lng: center.lng });
      }
    } else if (action === "exit") {
      for (let i = 0; i <= steps; i++) {
        const dist = inside + ((outside - inside) * i) / steps;
        positions.push({ lat: center.lat + offsetDeg(dist), lng: center.lng });
      }
    } else {
      // bounce
      for (let b = 0; b < bounceCount; b++) {
        const goingIn = b % 2 === 0;
        for (let i = 0; i <= steps; i++) {
          const dist = goingIn
            ? outside - ((outside - inside) * i) / steps
            : inside + ((outside - inside) * i) / steps;
          positions.push({ lat: center.lat + offsetDeg(dist), lng: center.lng });
        }
      }
    }

    let idx = 0;
    simulationTimer = setInterval(() => {
      if (idx >= positions.length) {
        stopSimulation();
        return;
      }
      const pos = positions[idx]!;
      try {
        setLocation({
          lat: pos.lat,
          lng: pos.lng,
          accuracy: 3,
          altitude: 0,
          speed: 0,
          bearing: 0,
        });
      } catch {
        // ignore
      }
      lastLocation = { lat: pos.lat, lng: pos.lng };
      idx++;
    }, 2000);

    return text(
      `Geofence test started.\n` +
        `  Center: ${center.lat.toFixed(6)}, ${center.lng.toFixed(6)}\n` +
        `  Radius: ${radiusMeters}m, Action: ${action}\n` +
        `  Steps: ${positions.length} at 2s intervals (${(positions.length * 2)}s total)`,
    );
  },
);

// 7. geo_stop
server.registerTool("geo_stop", { description: "Stop any active location simulation" }, async () => {
  stopSimulation();
  return text("Simulation stopped.");
});

// 8. geo_get_status
server.registerTool("geo_get_status", { description: "Get current connection and simulation status" }, async () => {
  const lines: string[] = [];
  lines.push(`Emulator: ${getConnectedDeviceId() ?? "not connected"}`);
  lines.push(`Simulation: ${simulationTimer ? "active" : "idle"}`);
  if (lastLocation !== null) {
    lines.push(`Last position: ${lastLocation.lat.toFixed(6)}, ${lastLocation.lng.toFixed(6)}`);
  }
  return text(lines.join("\n"));
});

// ── Start ───────────────────────────────────────────────────────────────────

function gracefulShutdown(): void {
  stopSimulation();
  shutdownEmulator();
  process.exit(0);
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

initEmulator();

const transport = new StdioServerTransport();
await server.connect(transport);
