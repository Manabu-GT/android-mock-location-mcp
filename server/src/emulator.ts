// ── Emulator location control via NMEA sentences ─────────────────────────────
//
// Replaces the TCP socket communication with the Android agent.
// Sets mock locations on the emulator using `adb emu geo nmea` commands
// with GPGGA (position/altitude/accuracy) and GPRMC (speed/bearing) sentences.

import { adbDevice, isExecError } from "./adb.js";
import { buildGpgga, buildGprmc } from "./nmea.js";
import type { NmeaLocationParams } from "./nmea.js";

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
 * Validates the emulator is reachable by sending a test NMEA sentence.
 */
export function connectEmulator(deviceId: string): void {
  // Verify the emulator accepts geo nmea commands by sending a minimal GPGGA
  try {
    const testSentence = buildGpgga({ lat: 0, lng: 0 });
    adbDevice(deviceId, ["emu", "geo", "nmea", testSentence]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = isExecError(err) ? err.stderr?.trim() : undefined;
    throw new Error(
      `Failed to send geo nmea to ${deviceId}: ${msg}${stderr ? ` (${stderr})` : ""}\n` +
        "Ensure the emulator is running and ADB is connected.",
    );
  }
  connectedDeviceId = deviceId;
}

/** Disconnect from the current emulator. */
export function disconnectEmulator(): void {
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

/**
 * Set mock location on the connected emulator via NMEA sentences.
 * Sends GPGGA (position + altitude + accuracy) then GPRMC (speed + bearing).
 */
export function setLocation(params: NmeaLocationParams): void {
  if (!connectedDeviceId) {
    throw new Error(
      "Not connected to an emulator. Call geo_connect_device first with an emulator serial (e.g. emulator-5554).",
    );
  }

  const gpgga = buildGpgga(params);
  const gprmc = buildGprmc(params);

  try {
    adbDevice(connectedDeviceId, ["emu", "geo", "nmea", gpgga]);
    adbDevice(connectedDeviceId, ["emu", "geo", "nmea", gprmc]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // If ADB fails, the emulator may have been closed
    disconnectEmulator();
    throw new Error(`Failed to set location: ${msg}`);
  }
}

/** Initialize emulator module. No-op — no background connections needed. */
export function initEmulator(): void {
  // Nothing to do
}

/** Shut down emulator module — clean up state. */
export function shutdownEmulator(): void {
  disconnectEmulator();
}
