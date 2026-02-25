// ── Emulator location control via `geo fix` ──────────────────────────────────
//
// Sets mock locations on the emulator using `adb emu geo fix` which updates
// the emulator's stored GPS state.  Unlike `geo nmea`, `geo fix` survives the
// emulator's 1 Hz PassiveGpsUpdater loop that re-sends from stored state.
//
// Format: geo fix <longitude> <latitude> [<altitude> [<satellites> [<velocity>]]]
//   - longitude/latitude in decimal degrees (longitude FIRST)
//   - altitude in meters
//   - satellites count (integer)
//   - velocity in knots

import { adbDevice, isExecError } from "./adb.js";

// ── State ────────────────────────────────────────────────────────────────────

let connectedDeviceId: string | null = null;
let disconnectCallback: (() => void) | null = null;

// ── Public API ───────────────────────────────────────────────────────────────

/** Register a callback invoked when the emulator disconnects. */
export function onDisconnect(cb: () => void): void {
  disconnectCallback = cb;
}

export function getConnectedDeviceId(): string | null {
  return connectedDeviceId;
}

export function isConnected(): boolean {
  return connectedDeviceId !== null;
}

/**
 * Connect to an emulator by device ID.
 * Validates the emulator is reachable via ADB.
 */
export function connectEmulator(deviceId: string): void {
  // Disconnect any previously connected emulator first
  if (connectedDeviceId !== null && connectedDeviceId !== deviceId) {
    disconnectEmulator();
  }

  // Verify the emulator is reachable without side-effects (no location change).
  // ro.kernel.qemu is "1" on emulators — this confirms ADB connectivity.
  try {
    adbDevice(deviceId, ["shell", "getprop", "ro.kernel.qemu"]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = isExecError(err) ? err.stderr?.trim() : undefined;
    throw new Error(
      `Failed to reach emulator ${deviceId}: ${msg}${stderr ? ` (${stderr})` : ""}\n` +
        "Ensure the emulator is running and ADB is connected.",
    );
  }
  connectedDeviceId = deviceId;
}

/** Disconnect from the current emulator. */
function disconnectEmulator(): void {
  const wasConnected = connectedDeviceId !== null;
  connectedDeviceId = null;
  if (wasConnected) {
    try {
      disconnectCallback?.();
    } catch {
      // Ignore callback errors
    }
  }
}

export interface LocationParams {
  lat: number;
  lng: number;
  altitude?: number;
  /** Speed in meters per second. Converted to knots for `geo fix`. */
  speed?: number;
}

const MS_TO_KNOTS = 1.94384;

/**
 * Set mock location on the connected emulator via `geo fix`.
 *
 * `geo fix` updates the emulator's stored GPS state, so the 1 Hz
 * PassiveGpsUpdater loop keeps broadcasting the new position.
 */
export function setLocation(params: LocationParams): void {
  if (!connectedDeviceId) {
    throw new Error(
      "Not connected to an emulator. Call geo_connect_device first with an emulator serial (e.g. emulator-5554).",
    );
  }

  // geo fix <longitude> <latitude> [<altitude> [<satellites> [<velocity>]]]
  const args: string[] = [
    "emu", "geo", "fix",
    params.lng.toFixed(6),
    params.lat.toFixed(6),
  ];

  const altitude = params.altitude ?? 0;
  const satellites = 8;
  args.push(altitude.toFixed(1));
  args.push(satellites.toString());

  if (params.speed != null && params.speed > 0) {
    args.push((params.speed * MS_TO_KNOTS).toFixed(1));
  }

  try {
    adbDevice(connectedDeviceId, args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // If ADB fails, the emulator may have been closed
    disconnectEmulator();
    throw new Error(`Failed to set location: ${msg}`);
  }
}

// ── Location Query ───────────────────────────────────────────────────────────

export interface EmulatorLocation {
  lat: number;
  lng: number;
  accuracy?: number;
}

/**
 * Parse a Location line from `dumpsys location` output.
 *
 * Android's Location.toString() format (API 26+):
 *   Location[gps 37.421998,-122.084000 hAcc=20.0 ...]
 *   Location[fused 37.421998,-122.084000 acc=5.0 ...]
 *
 * We extract lat, lng and optional accuracy (hAcc= or acc=).
 */
export function parseLocationLine(line: string): EmulatorLocation | null {
  // Match "Location[<provider> <lat>,<lng>" pattern
  const coordMatch = line.match(/Location\[\S+\s+(-?[\d.]+),(-?[\d.]+)/);
  if (!coordMatch) return null;

  const lat = parseFloat(coordMatch[1]!);
  const lng = parseFloat(coordMatch[2]!);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

  // Try to extract accuracy (hAcc= in newer Android, acc= in older)
  const accMatch = line.match(/(?:hAcc|acc)=([\d.]+)/);
  const accuracy = accMatch ? parseFloat(accMatch[1]!) : undefined;

  return { lat, lng, accuracy };
}

/**
 * Get the emulator's current GPS location via `adb shell dumpsys location`.
 *
 * Parses the "Last Known Locations" section from the location service dump
 * and returns the GPS provider's last fix. Falls back to the fused provider
 * if GPS is not available.
 *
 * Returns null if no location is available.
 */
export function getLocation(): EmulatorLocation | null {
  if (!connectedDeviceId) {
    throw new Error(
      "Not connected to an emulator. Call geo_connect_device first.",
    );
  }

  let output: string;
  try {
    output = adbDevice(connectedDeviceId, ["shell", "dumpsys", "location"]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to query emulator location: ${msg}`);
  }

  // Look for "Last Known Locations:" section and parse GPS/fused provider lines
  const lines = output.split("\n");
  let inLastKnown = false;
  let gpsLocation: EmulatorLocation | null = null;
  let fusedLocation: EmulatorLocation | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("Last Known Locations:")) {
      inLastKnown = true;
      continue;
    }

    // End of section: blank line or new non-indented section header
    if (inLastKnown && (trimmed === "" || (trimmed !== "" && !line.startsWith(" ") && !line.startsWith("\t")))) {
      break;
    }

    if (inLastKnown) {
      if (trimmed.startsWith("gps:") || trimmed.includes("Location[gps")) {
        gpsLocation = parseLocationLine(trimmed);
      } else if (trimmed.startsWith("fused:") || trimmed.includes("Location[fused")) {
        fusedLocation = parseLocationLine(trimmed);
      }
    }
  }

  // Prefer GPS, fall back to fused
  return gpsLocation ?? fusedLocation ?? null;
}

/** Initialize emulator module. No-op — no background connections needed. */
export function initEmulator(): void {
  // Nothing to do
}

/** Shut down emulator module — clean up state. */
export function shutdownEmulator(): void {
  disconnectEmulator();
}
