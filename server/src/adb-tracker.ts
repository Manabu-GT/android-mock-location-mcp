// ── ADB device tracker via track-devices protocol ────────────────────────────
//
// Connects to the ADB server on TCP port 5037 and issues "host:track-devices"
// to receive real-time device attach/detach notifications.  This is used by
// device.ts to automatically reconnect when a previously-paired device comes
// back online (e.g. USB cable re-plugged after a brief disconnect).
//
// The tracker silently reconnects to the ADB server if the connection drops and
// does not throw — it is designed to run for the entire lifetime of the process.

import * as net from "node:net";

const ADB_SERVER_PORT = 5037;
const RETRY_DELAY_MS = 5_000;

export interface DeviceEvent {
  deviceId: string;
  /** Current state: "device", "offline", "unauthorized", etc. */
  state: string;
  /** Previous state, or `null` if the device was not previously tracked. */
  previous: string | null;
}

type DeviceEventListener = (event: DeviceEvent) => void;

// ── Module state ─────────────────────────────────────────────────────────────

let trackerSocket: net.Socket | null = null;
let eventListener: DeviceEventListener | null = null;
let knownDevices = new Map<string, string>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let active = false;

// ── Public API ───────────────────────────────────────────────────────────────

/** Start monitoring ADB device state changes. */
export function startTracking(listener: DeviceEventListener): void {
  active = true;
  eventListener = listener;
  connectToAdb();
}

/** Stop monitoring and release resources. */
export function stopTracking(): void {
  active = false;
  eventListener = null;
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (trackerSocket !== null) {
    trackerSocket.destroy();
    trackerSocket = null;
  }
  knownDevices.clear();
}

// ── ADB server connection ────────────────────────────────────────────────────
//
// Protocol: connect to TCP 5037, send a length-prefixed command, receive OKAY
// followed by a stream of length-prefixed device-list snapshots whenever the
// set of connected devices changes.

function connectToAdb(): void {
  if (!active) return;

  const sock = new net.Socket();
  trackerSocket = sock;

  let buffer = "";
  let receivedOkay = false;
  let expectingLength = true;
  let payloadLength = 0;

  sock.connect({ host: "127.0.0.1", port: ADB_SERVER_PORT }, () => {
    const cmd = "host:track-devices";
    const lengthPrefix = cmd.length.toString(16).padStart(4, "0");
    sock.write(lengthPrefix + cmd);
  });

  sock.on("data", (chunk) => {
    buffer += chunk.toString();

    // Consume the initial OKAY / FAIL response.
    if (!receivedOkay) {
      if (buffer.length < 4) return;
      const status = buffer.slice(0, 4);
      buffer = buffer.slice(4);
      if (status !== "OKAY") {
        console.error(`ADB track-devices rejected (${status})`);
        sock.destroy();
        return;
      }
      receivedOkay = true;
    }

    // Parse length-prefixed device-list messages.
    for (;;) {
      if (expectingLength) {
        if (buffer.length < 4) break;
        payloadLength = parseInt(buffer.slice(0, 4), 16);
        buffer = buffer.slice(4);
        expectingLength = false;
      }
      if (buffer.length < payloadLength) break;

      const payload = buffer.slice(0, payloadLength);
      buffer = buffer.slice(payloadLength);
      expectingLength = true;

      processDeviceList(payload);
    }
  });

  const handleGone = () => {
    if (trackerSocket !== sock) return;
    trackerSocket = null;
    scheduleRetry();
  };

  sock.on("error", () => handleGone());
  sock.on("close", handleGone);
}

function scheduleRetry(): void {
  if (!active || retryTimer !== null) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connectToAdb();
  }, RETRY_DELAY_MS);
}

// ── Device list diffing ─────────────────────────────────────────────────────
//
// Each time the ADB server sends an updated device list we diff it against
// the previously known set and emit events for new, changed, and removed
// devices.

function processDeviceList(payload: string): void {
  const updated = new Map<string, string>();
  for (const line of payload.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tabIndex = trimmed.indexOf("\t");
    if (tabIndex > 0) {
      updated.set(trimmed.slice(0, tabIndex), trimmed.slice(tabIndex + 1));
    }
  }

  if (eventListener) {
    // New or changed devices.
    for (const [id, state] of updated) {
      const previous = knownDevices.get(id) ?? null;
      if (previous !== state) {
        eventListener({ deviceId: id, state, previous });
      }
    }
    // Disappeared devices.
    for (const [id, previousState] of knownDevices) {
      if (!updated.has(id)) {
        eventListener({ deviceId: id, state: "offline", previous: previousState });
      }
    }
  }

  knownDevices = updated;
}
