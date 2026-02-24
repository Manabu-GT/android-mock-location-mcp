#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { geocodePlace } from "./geocode.js";
import { haversineDistance, computeBearing } from "./geo-math.js";
import { getRoute, interpolateAlongRoute, bearingAlongRoute, buildCumulativeDistances } from "./routing.js";
import type { RouteResult, RoutePoint } from "./routing.js";
import { parseGpxKml } from "./gpx-kml.js";
import { createRequire } from "node:module";
import {
  setLocation,
  getLocation,
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

// ── Shared Helpers ──────────────────────────────────────────────────────────

/** Resolve a place name or lat/lng pair to coordinates. */
async function resolveEndpoint(
  name?: string,
  lat?: number,
  lng?: number,
  label?: string,
): Promise<{ lat: number; lng: number } | { error: string }> {
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
}

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
      "If 'from' is omitted, automatically uses the current mock location, " +
      "or the emulator's current GPS position, or asks the user for their starting location." + geocodeHint,
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
    // Resolve start: explicit args → last mock position → emulator GPS → error
    let start: { lat: number; lng: number } | { error: string };
    if (from || (fromLat !== undefined && fromLng !== undefined)) {
      start = await resolveEndpoint(from, fromLat, fromLng, "from");
    } else if (lastLocation !== null) {
      start = { lat: lastLocation.lat, lng: lastLocation.lng };
    } else if (isConnected()) {
      try {
        const loc = getLocation();
        if (loc) {
          start = { lat: loc.lat, lng: loc.lng };
        } else {
          start = {
            error:
              "No starting location available. The emulator has no recent GPS fix. " +
              "Ask the user for their starting location, or provide 'from' or fromLat/fromLng.",
          };
        }
      } catch {
        start = {
          error:
            "No starting location available. " +
            "Provide 'from' or fromLat/fromLng, or set a location first with geo_set_location.",
        };
      }
    } else {
      start = {
        error:
          "No starting location provided and no emulator connected. " +
          "Provide 'from' or fromLat/fromLng, or connect an emulator first.",
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
          lastLocation = { lat: endPoint.lat, lng: endPoint.lng };
        } catch {
          // ignore — emulator may have disconnected
        }
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
        lastLocation = { lat: pos.lat, lng: pos.lng };
      } catch {
        // ignore — emulator may have disconnected
      }
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

// 5. geo_simulate_multi_stop
server.registerTool(
  "geo_simulate_multi_stop",
  {
    description:
      "Simulate movement along a multi-stop route (e.g. delivery route, rideshare pickups). " +
      "Routes between consecutive waypoints follow real streets. Each waypoint can have a dwell time " +
      "(time spent stationary at the stop before continuing). Runs as one continuous 1 Hz simulation " +
      "with no gaps between legs. " +
      "If the first waypoint is omitted (no lat/lng/place), automatically uses the current mock location." + geocodeHint,
    inputSchema: {
      waypoints: z
        .array(
          z.object({
            lat: z.number().optional().describe("Waypoint latitude"),
            lng: z.number().optional().describe("Waypoint longitude"),
            place: z.string().optional().describe("Waypoint place name or address"),
            dwellSeconds: z.number().default(0).describe("Time to stay at this waypoint before continuing (seconds)"),
          }),
        )
        .min(2)
        .describe("Ordered list of waypoints (min 2). Provide either 'place' or both 'lat'/'lng' per waypoint."),
      speedKmh: z.number().default(60).describe("Travel speed in km/h between waypoints"),
      trafficMultiplier: z.number().default(1.0).describe("Traffic slowdown factor (e.g. 1.5 = 50% slower)"),
      profile: z
        .enum(["car", "foot", "bike"])
        .default("car")
        .describe("Routing profile. Use 'foot' for walking, 'bike' for cycling, 'car' for driving."),
    },
  },
  async ({ waypoints, speedKmh, trafficMultiplier, profile }) => {
    // ── Validate parameters ────────────────────────────────────────────────
    if (speedKmh <= 0) return text("speedKmh must be greater than 0.");
    if (trafficMultiplier <= 0) return text("trafficMultiplier must be greater than 0.");
    for (let i = 0; i < waypoints.length; i++) {
      if (waypoints[i]!.dwellSeconds < 0) {
        return text(`dwellSeconds must be >= 0 (waypoint[${i}]).`);
      }
    }

    // ── Resolve all waypoints ──────────────────────────────────────────────
    const resolved: { lat: number; lng: number }[] = [];

    for (let i = 0; i < waypoints.length; i++) {
      const wp = waypoints[i]!;
      const hasExplicit = wp.place || (wp.lat !== undefined && wp.lng !== undefined);

      if (i === 0 && !hasExplicit) {
        // First waypoint: auto-resolve from lastLocation / emulator GPS
        if (lastLocation !== null) {
          resolved.push({ lat: lastLocation.lat, lng: lastLocation.lng });
        } else if (isConnected()) {
          try {
            const loc = getLocation();
            if (loc) {
              resolved.push({ lat: loc.lat, lng: loc.lng });
            } else {
              return text(
                "No starting location available. The emulator has no recent GPS fix. " +
                  "Provide lat/lng or place for the first waypoint, or set a location first with geo_set_location.",
              );
            }
          } catch {
            return text(
              "No starting location available. " +
                "Provide lat/lng or place for the first waypoint, or set a location first with geo_set_location.",
            );
          }
        } else {
          return text(
            "No starting location provided and no emulator connected. " +
              "Provide lat/lng or place for the first waypoint, or connect an emulator first.",
          );
        }
        continue;
      }

      const result = await resolveEndpoint(wp.place, wp.lat, wp.lng, `waypoint[${i}]`);
      if ("error" in result) return text(result.error);
      resolved.push(result);
    }

    // ── Fetch routes for each leg ──────────────────────────────────────────
    const effectiveSpeedMs = (speedKmh / trafficMultiplier) * (1000 / 3600);
    const legs: { route: RouteResult; durationSec: number }[] = [];

    for (let i = 0; i < resolved.length - 1; i++) {
      const from = resolved[i]!;
      const to = resolved[i + 1]!;
      const route = await getRoute(from.lat, from.lng, to.lat, to.lng, profile);
      const durationSec = Math.max(1, Math.round(route.distanceMeters / effectiveSpeedMs));
      legs.push({ route, durationSec });
    }

    // ── Build phase plan ───────────────────────────────────────────────────
    type Phase =
      | { type: "move"; route: RouteResult; startTick: number; endTick: number }
      | { type: "dwell"; position: RoutePoint; startTick: number; endTick: number };

    const phases: Phase[] = [];
    let tick = 0;

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i]!;

      // Move phase
      phases.push({
        type: "move",
        route: leg.route,
        startTick: tick,
        endTick: tick + leg.durationSec,
      });
      tick += leg.durationSec;

      // Dwell phase at destination (waypoints[i+1])
      const dwellSec = waypoints[i + 1]!.dwellSeconds;
      if (dwellSec > 0) {
        const endPoint = leg.route.points[leg.route.points.length - 1]!;
        phases.push({
          type: "dwell",
          position: endPoint,
          startTick: tick,
          endTick: tick + dwellSec,
        });
        tick += dwellSec;
      }
    }

    const totalTicks = tick;

    // ── Start simulation ───────────────────────────────────────────────────
    stopSimulation();
    let currentTick = 0;
    let phaseIdx = 0;

    // Send starting position immediately
    const firstPoint = legs[0]!.route.points[0]!;
    try {
      setLocation({
        lat: firstPoint.lat,
        lng: firstPoint.lng,
        accuracy: 3,
        altitude: 0,
        speed: 0,
        bearing: bearingAlongRoute(legs[0]!.route, 0),
      });
    } catch {
      // Continue — simulation interval will retry
    }
    lastLocation = { lat: firstPoint.lat, lng: firstPoint.lng };

    simulationTimer = setInterval(() => {
      currentTick++;
      if (currentTick >= totalTicks) {
        // Send final position
        const lastLeg = legs[legs.length - 1]!;
        const finalPoint = lastLeg.route.points[lastLeg.route.points.length - 1]!;
        try {
          setLocation({
            lat: finalPoint.lat,
            lng: finalPoint.lng,
            accuracy: 3,
            altitude: 0,
            speed: 0,
            bearing: 0,
          });
          lastLocation = { lat: finalPoint.lat, lng: finalPoint.lng };
        } catch {
          // ignore
        }
        stopSimulation();
        return;
      }

      // Advance phase index if needed (O(1) amortized)
      while (phaseIdx < phases.length - 1 && currentTick >= phases[phaseIdx]!.endTick) {
        phaseIdx++;
      }
      const phase = phases[phaseIdx];
      if (!phase || currentTick < phase.startTick || currentTick >= phase.endTick) return;

      try {
        if (phase.type === "move") {
          const phaseDuration = phase.endTick - phase.startTick;
          const frac = (currentTick - phase.startTick) / phaseDuration;
          const pos = interpolateAlongRoute(phase.route, frac);
          const bearing = bearingAlongRoute(phase.route, frac);
          setLocation({
            lat: pos.lat,
            lng: pos.lng,
            accuracy: 3,
            altitude: 0,
            speed: effectiveSpeedMs,
            bearing,
          });
          lastLocation = { lat: pos.lat, lng: pos.lng };
        } else {
          // dwell
          setLocation({
            lat: phase.position.lat,
            lng: phase.position.lng,
            accuracy: 3,
            altitude: 0,
            speed: 0,
            bearing: 0,
          });
          lastLocation = { lat: phase.position.lat, lng: phase.position.lng };
        }
      } catch {
        // ignore — emulator may have disconnected
      }
    }, 1000);

    // ── Return summary ─────────────────────────────────────────────────────
    let totalDistM = 0;
    const legSummaries: string[] = [];
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i]!;
      totalDistM += leg.route.distanceMeters;
      const distKm = (leg.route.distanceMeters / 1000).toFixed(1);
      const etaMin = (leg.durationSec / 60).toFixed(1);
      const dwellSec = waypoints[i + 1]!.dwellSeconds;
      const dwellStr = dwellSec > 0 ? ` + ${dwellSec}s dwell` : "";
      legSummaries.push(`  Leg ${i + 1}: ${distKm} km, ${etaMin} min${dwellStr}`);
    }

    const routeSource = legs[0]!.route.source === "straight-line"
      ? "straight-line (fallback)"
      : `${legs[0]!.route.source}, profile: ${profile}`;

    return text(
      `Multi-stop simulation started.\n` +
        `  Waypoints: ${resolved.length} (${legs.length} legs)\n` +
        `  Routing: ${routeSource}\n` +
        legSummaries.join("\n") + "\n" +
        `  Total: ${(totalDistM / 1000).toFixed(1)} km, ${(totalTicks / 60).toFixed(1)} min (${totalTicks} steps at 1 Hz)`,
    );
  },
);

// 6. geo_simulate_jitter
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
        lastLocation = { lat: center.lat + offsetLat, lng: center.lng + offsetLng };
      } catch {
        // ignore — emulator may have disconnected
      }
    }, 1000);

    return text(
      `Jitter simulation started.\n` +
        `  Center: ${center.lat.toFixed(6)}, ${center.lng.toFixed(6)}\n` +
        `  Pattern: ${pattern}, Radius: ${radiusMeters}m\n` +
        `  Duration: ${durationSeconds}s`,
    );
  },
);

// 7. geo_test_geofence
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
        lastLocation = { lat: pos.lat, lng: pos.lng };
      } catch {
        // ignore — emulator may have disconnected
      }
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

// 8. geo_replay_gpx_kml
server.registerTool(
  "geo_replay_gpx_kml",
  {
    description:
      "Replay a GPX or KML track file on the emulator. Supports two modes: " +
      "(1) time-based replay for GPX files with timestamps — preserves the original speed profile, " +
      "adjustable with speedMultiplier; " +
      "(2) distance-based replay at constant speed for KML files or GPX without timestamps. " +
      "Auto-detects format from XML content. Provide either the file content as a string " +
      "or an absolute file path on the host machine.",
    inputSchema: {
      fileContent: z.string().optional().describe("Raw GPX or KML file content (XML string)"),
      filePath: z.string().optional().describe("Absolute path to a GPX or KML file on the host"),
      speedMultiplier: z
        .number()
        .default(1.0)
        .describe("Playback speed multiplier for time-based replay (2.0 = 2x faster). Only used when file has timestamps."),
      speedKmh: z
        .number()
        .default(60)
        .describe("Travel speed for distance-based replay (km/h). Only used when file has no timestamps."),
    },
  },
  async ({ fileContent, filePath, speedMultiplier, speedKmh }) => {
    // ── Validate speed parameters ────────────────────────────────────────
    if (speedMultiplier <= 0) {
      return text("speedMultiplier must be greater than 0.");
    }
    if (speedKmh <= 0) {
      return text("speedKmh must be greater than 0.");
    }

    // ── Read file content ────────────────────────────────────────────────
    let content: string;
    if (fileContent) {
      content = fileContent;
    } else if (filePath) {
      try {
        content = readFileSync(filePath, "utf-8");
      } catch (err) {
        return text(`Failed to read file "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      return text("Provide either 'fileContent' (XML string) or 'filePath' (absolute path to file).");
    }

    // ── Parse ────────────────────────────────────────────────────────────
    let track: ReturnType<typeof parseGpxKml>;
    try {
      track = parseGpxKml(content);
    } catch (err) {
      return text(`Failed to parse file: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Single point: just set location ──────────────────────────────────
    if (track.points.length === 1) {
      const pt = track.points[0]!;
      try {
        setLocation({
          lat: pt.lat,
          lng: pt.lng,
          accuracy: 3,
          altitude: pt.elevation ?? 0,
          speed: 0,
          bearing: 0,
        });
        lastLocation = { lat: pt.lat, lng: pt.lng };
        return text(
          `${track.format.toUpperCase()} file contains 1 point. Location set to ${pt.lat.toFixed(6)}, ${pt.lng.toFixed(6)}.`,
        );
      } catch (err) {
        return text(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── Compute total distance ───────────────────────────────────────────
    let totalDistM = 0;
    for (let i = 1; i < track.points.length; i++) {
      totalDistM += haversineDistance(
        track.points[i - 1]!.lat, track.points[i - 1]!.lng,
        track.points[i]!.lat, track.points[i]!.lng,
      );
    }

    stopSimulation();

    if (track.hasTimestamps) {
      // ── Time-based replay ────────────────────────────────────────────
      // Filter to only points with valid timestamps (hasTimestamps guarantees ≥80%)
      const points = track.points.filter((p) => p.timestamp !== undefined);
      if (points.length < 2) {
        return replayDistanceBased(track, totalDistM, speedKmh);
      }
      const firstTime = points[0]!.timestamp!.getTime();
      const lastTime = points[points.length - 1]!.timestamp!.getTime();
      const originalDurationMs = lastTime - firstTime;

      if (originalDurationMs <= 0) {
        // All timestamps identical — fall through to distance-based
        return replayDistanceBased(track, totalDistM, speedKmh);
      }

      const totalSeconds = Math.max(1, Math.round(originalDurationMs / (1000 * speedMultiplier)));
      let currentTick = 0;

      // Send starting position immediately
      const startPt = points[0]!;
      try {
        setLocation({
          lat: startPt.lat,
          lng: startPt.lng,
          accuracy: 3,
          altitude: startPt.elevation ?? 0,
          speed: 0,
          bearing: points.length >= 2 ? computeBearing(startPt.lat, startPt.lng, points[1]!.lat, points[1]!.lng) : 0,
        });
      } catch {
        // Continue
      }
      lastLocation = { lat: startPt.lat, lng: startPt.lng };

      simulationTimer = setInterval(() => {
        currentTick++;
        if (currentTick >= totalSeconds) {
          const endPt = points[points.length - 1]!;
          try {
            setLocation({
              lat: endPt.lat,
              lng: endPt.lng,
              accuracy: 3,
              altitude: endPt.elevation ?? 0,
              speed: 0,
              bearing: 0,
            });
            lastLocation = { lat: endPt.lat, lng: endPt.lng };
          } catch {
            // ignore
          }
          stopSimulation();
          return;
        }

        // Map current tick to position in original timeline
        const playbackTimeMs = currentTick * 1000 * speedMultiplier;
        const targetTime = firstTime + playbackTimeMs;

        // Binary search for surrounding trackpoints
        let lo = 0;
        let hi = points.length - 1;
        while (lo < hi - 1) {
          const mid = (lo + hi) >> 1;
          if (points[mid]!.timestamp!.getTime() <= targetTime) {
            lo = mid;
          } else {
            hi = mid;
          }
        }

        const p1 = points[lo]!;
        const p2 = points[hi]!;
        const t1 = p1.timestamp!.getTime();
        const t2 = p2.timestamp!.getTime();
        const segDuration = t2 - t1;
        const segFrac = segDuration > 0 ? (targetTime - t1) / segDuration : 0;

        const lat = p1.lat + (p2.lat - p1.lat) * segFrac;
        const lng = p1.lng + (p2.lng - p1.lng) * segFrac;
        const elevation =
          p1.elevation !== undefined && p2.elevation !== undefined
            ? p1.elevation + (p2.elevation - p1.elevation) * segFrac
            : (p1.elevation ?? p2.elevation ?? 0);

        const dist = haversineDistance(p1.lat, p1.lng, p2.lat, p2.lng);
        const speedMs = segDuration > 0 ? (dist / segDuration) * 1000 : 0;
        const bearing = computeBearing(p1.lat, p1.lng, p2.lat, p2.lng);

        try {
          setLocation({
            lat,
            lng,
            accuracy: 3,
            altitude: elevation,
            speed: speedMs,
            bearing,
          });
          lastLocation = { lat, lng };
        } catch {
          // ignore
        }
      }, 1000);

      const origMin = (originalDurationMs / 60_000).toFixed(1);
      const playMin = (totalSeconds / 60).toFixed(1);
      return text(
        `GPX replay started (time-based).\n` +
          `  Track: ${points.length} points, ${(totalDistM / 1000).toFixed(1)} km` +
          (track.name ? ` — "${track.name}"` : "") + "\n" +
          `  Original duration: ${origMin} min\n` +
          `  Playback: ${speedMultiplier}x speed → ${playMin} min (${totalSeconds} steps at 1 Hz)`,
      );
    }

    // ── Distance-based replay (no timestamps) ────────────────────────────
    return replayDistanceBased(track, totalDistM, speedKmh);

    function replayDistanceBased(
      t: ReturnType<typeof parseGpxKml>,
      distM: number,
      speed: number,
    ) {
      const routePoints: RoutePoint[] = t.points.map((p) => ({ lat: p.lat, lng: p.lng }));
      const elevations = t.points.map((p) => p.elevation ?? 0);
      const cumulativeDistances = buildCumulativeDistances(routePoints);
      const route: RouteResult = {
        points: routePoints,
        distanceMeters: cumulativeDistances[cumulativeDistances.length - 1]!,
        cumulativeDistances,
        source: "file",
      };

      const effectiveSpeedMs = speed * (1000 / 3600);
      const totalSeconds = Math.max(1, Math.round(route.distanceMeters / effectiveSpeedMs));
      let step = 0;

      /** Interpolate elevation along the track at the given progress fraction. */
      function elevationAtFraction(frac: number): number {
        if (frac <= 0) return elevations[0]!;
        if (frac >= 1) return elevations[elevations.length - 1]!;
        const targetDist = frac * route.distanceMeters;
        let i = 0;
        while (i < cumulativeDistances.length - 1 && cumulativeDistances[i + 1]! <= targetDist) {
          i++;
        }
        if (i >= elevations.length - 1) return elevations[elevations.length - 1]!;
        const segStart = cumulativeDistances[i]!;
        const segEnd = cumulativeDistances[i + 1]!;
        const segLen = segEnd - segStart;
        if (segLen === 0) return elevations[i]!;
        const segFrac = (targetDist - segStart) / segLen;
        return elevations[i]! + (elevations[i + 1]! - elevations[i]!) * segFrac;
      }

      // Send starting position immediately
      const startPt = route.points[0]!;
      try {
        setLocation({
          lat: startPt.lat,
          lng: startPt.lng,
          accuracy: 3,
          altitude: elevations[0]!,
          speed: 0,
          bearing: bearingAlongRoute(route, 0),
        });
      } catch {
        // Continue
      }
      lastLocation = { lat: startPt.lat, lng: startPt.lng };

      simulationTimer = setInterval(() => {
        step++;
        if (step > totalSeconds) {
          const endPt = route.points[route.points.length - 1]!;
          try {
            setLocation({
              lat: endPt.lat,
              lng: endPt.lng,
              accuracy: 3,
              altitude: elevations[elevations.length - 1]!,
              speed: 0,
              bearing: 0,
            });
            lastLocation = { lat: endPt.lat, lng: endPt.lng };
          } catch {
            // ignore
          }
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
            altitude: elevationAtFraction(frac),
            speed: effectiveSpeedMs,
            bearing,
          });
          lastLocation = { lat: pos.lat, lng: pos.lng };
        } catch {
          // ignore
        }
      }, 1000);

      const mode = t.format === "gpx" ? "distance-based (no timestamps)" : "distance-based";
      return text(
        `${t.format.toUpperCase()} replay started (${mode}).\n` +
          `  Track: ${t.points.length} points, ${(distM / 1000).toFixed(1)} km` +
          (t.name ? ` — "${t.name}"` : "") + "\n" +
          `  Speed: ${speed.toFixed(1)} km/h → ${(totalSeconds / 60).toFixed(1)} min (${totalSeconds} steps at 1 Hz)`,
      );
    }
  },
);

// 9. geo_stop
server.registerTool("geo_stop", { description: "Stop any active location simulation" }, async () => {
  stopSimulation();
  return text("Simulation stopped.");
});

// 10. geo_get_status
server.registerTool("geo_get_status", { description: "Get current connection and simulation status" }, async () => {
  const lines: string[] = [];
  lines.push(`Emulator: ${getConnectedDeviceId() ?? "not connected"}`);
  lines.push(`Simulation: ${simulationTimer ? "active" : "idle"}`);
  if (lastLocation !== null) {
    lines.push(`Last position: ${lastLocation.lat.toFixed(6)}, ${lastLocation.lng.toFixed(6)}`);
  }
  return text(lines.join("\n"));
});

// 11. geo_get_location
server.registerTool(
  "geo_get_location",
  {
    description:
      "Get the emulator's current GPS location (last known position from the emulator's location providers). " +
      "Useful as a starting point for a route when no mock location has been set yet. " +
      "If the emulator has no recent GPS fix, the tool will fail — in that case, ask the user for their current location.",
  },
  async () => {
    if (!isConnected()) {
      return text(
        "Emulator not connected. Call geo_connect_device first.\n" +
          "If you need the starting location for a route, ask the user where they are.",
      );
    }
    try {
      const loc = getLocation();
      if (loc) {
        lastLocation = { lat: loc.lat, lng: loc.lng };
        let msg = `Emulator location: ${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`;
        if (loc.accuracy !== undefined && loc.accuracy > 0) {
          msg += ` (accuracy: ${loc.accuracy.toFixed(1)}m)`;
        }
        return text(msg);
      }
      return text(
        "Could not get emulator location: no recent GPS fix available.\n" +
          "Ask the user for their current location or provide coordinates directly.",
      );
    } catch (err) {
      return text(
        `Failed to get emulator location: ${err instanceof Error ? err.message : String(err)}\n` +
          "Ask the user for their current location or provide coordinates directly.",
      );
    }
  },
);

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
