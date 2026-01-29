// ── ADB + socket communication with Android agent ───────────────────────────

import * as net from "node:net";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { startTracking, stopTracking, getKnownDeviceState } from "./adb-tracker.js";
import type { DeviceEvent } from "./adb-tracker.js";

const execFileAsync = promisify(execFile);

// ── Constants ────────────────────────────────────────────────────────────────

const AGENT_PORT = 5005;
const CONNECT_TIMEOUT_MS = 10_000;
const ADB_FORWARD_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 5_000;

// ── State ────────────────────────────────────────────────────────────────────

type ConnectionState = "disconnected" | "connecting" | "connected" | "waiting_for_device";

let state: ConnectionState = "disconnected";
let socket: net.Socket | null = null;
let connectedDeviceId: string | null = null;
let targetDeviceId: string | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let trackerReconnectTimer: ReturnType<typeof setTimeout> | null = null;

const pendingRequests = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

let disconnectCallback: (() => void) | null = null;

// ── Public API ───────────────────────────────────────────────────────────────

/** Register a callback invoked when the device socket disconnects. */
export function onDisconnect(cb: () => void): void {
  disconnectCallback = cb;
}

export function getConnectedDeviceId(): string | null {
  return connectedDeviceId;
}

export function isConnected(): boolean {
  return state === "connected" && socket !== null && !socket.destroyed;
}

/** List connected ADB devices. Returns raw `adb devices -l` output. */
export async function listDevices(): Promise<string> {
  const { stdout } = await execFileAsync("adb", ["devices", "-l"], {
    encoding: "utf-8",
    timeout: ADB_FORWARD_TIMEOUT_MS,
  });
  return stdout;
}

/** Send a JSON command to the agent and await the response. */
export function sendCommand(command: Record<string, unknown>): Promise<unknown> {
  const sock = socket;
  if (sock === null || sock.destroyed || state !== "connected") {
    return Promise.reject(
      new Error(
        "Not connected to device. Troubleshooting: " +
          "(1) Call geo_connect_device with the device serial from geo_list_devices. " +
          "(2) Verify the GeoMCP Agent service is running in the app (green indicator). " +
          "(3) Check adb port forwarding: run `adb forward tcp:5005 tcp:5005`.",
      ),
    );
  }
  const id = randomUUID();
  const msg = { ...command, id };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(
        new Error(
          "Command timed out. Troubleshooting: " +
            "(1) Verify the GeoMCP Agent service is running in the app (green indicator). " +
            "(2) Restart adb port forwarding: `adb forward tcp:5005 tcp:5005`. " +
            "(3) Check agent logs: `adb logcat -s GeoMCP`.",
        ),
      );
    }, COMMAND_TIMEOUT_MS);
    pendingRequests.set(id, { resolve, reject, timer });
    try {
      sock.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Set up ADB port forwarding and open a TCP socket to the agent.
 * Resolves when the socket connects; rejects on failure or timeout.
 */
export function connectToDevice(deviceId: string): Promise<void> {
  clearAllTimers();

  // Skip if already connected to this exact device.
  if (state === "connected" && connectedDeviceId === deviceId && socket && !socket.destroyed) {
    return Promise.resolve();
  }

  // Notify disconnect callback when switching away from a live connection
  // (the stale-socket guard in the close handler will suppress its callback).
  if (state === "connected") {
    try {
      disconnectCallback?.();
    } catch (err) {
      console.error("Disconnect callback error:", err instanceof Error ? err.message : err);
    }
  }

  // Ensure the ADB tracker is running (safe to call repeatedly).
  initDevice();

  targetDeviceId = deviceId;
  try {
    transitionToConnecting(deviceId);
  } catch (err) {
    // Set a safe state so tracker-based reconnect can still kick in.
    state = "waiting_for_device";
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }

  // transitionToConnecting succeeded — socket exists, TCP handshake in progress.
  // Return a promise that settles when the socket connects or closes.
  const sock = socket!; // safe: transitionToConnecting sets socket on success path
  return new Promise<void>((resolve, reject) => {
    const onConnect = () => {
      sock.removeListener("close", onClose);
      resolve();
    };
    const onClose = () => {
      sock.removeListener("connect", onConnect);
      reject(new Error(`Connection to ${deviceId} failed or was superseded`));
    };
    sock.once("connect", onConnect);
    sock.once("close", onClose);
  });
}

/** Initialize device module — start the ADB tracker. */
export function initDevice(): void {
  startTracking(handleTrackerEvent);
}

/** Shut down device module — clean up all resources. */
export function shutdownDevice(): void {
  clearAllTimers();

  // Null the reference before destroying to prevent the close handler from
  // running cleanup (it will see socket !== sock via the stale-socket guard).
  const oldSocket = socket;
  socket = null;
  if (oldSocket && !oldSocket.destroyed) oldSocket.destroy();

  // Reject pending requests
  for (const [id, entry] of pendingRequests) {
    clearTimeout(entry.timer);
    entry.reject(new Error("Device module shutting down."));
    pendingRequests.delete(id);
  }

  // Reset state
  connectedDeviceId = null;
  targetDeviceId = null;
  state = "disconnected";

  // Stop tracker
  stopTracking();
}

// ── Internal: Helpers ────────────────────────────────────────────────────────

function clearAllTimers(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (trackerReconnectTimer !== null) {
    clearTimeout(trackerReconnectTimer);
    trackerReconnectTimer = null;
  }
}

// ── Internal: State Machine ──────────────────────────────────────────────────

/**
 * Core connection logic. Sets up ADB port forwarding (sync), creates a socket,
 * and connects. Sets state = "connecting" only on success path.
 * Throws on failure — callers decide the failure state.
 */
function transitionToConnecting(deviceId: string): void {
  if (!/^[a-zA-Z0-9._:\-]+$/.test(deviceId)) {
    throw new Error(`Invalid device ID: ${deviceId}`);
  }

  // Cancel both timers so a concurrent timer can't fire while we're connecting.
  clearAllTimers();

  // Null the reference before destroying to prevent the close handler from
  // running cleanup on the old socket (stale-socket guard: socket !== sock).
  const oldSocket = socket;
  socket = null;
  connectedDeviceId = null;
  if (oldSocket && !oldSocket.destroyed) {
    oldSocket.destroy();
  }

  // Set up ADB port forwarding (sync with timeout to prevent indefinite hang).
  try {
    execFileSync("adb", ["-s", deviceId, "forward", `tcp:${AGENT_PORT}`, `tcp:${AGENT_PORT}`], {
      encoding: "utf-8",
      timeout: ADB_FORWARD_TIMEOUT_MS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string }).stderr;
    throw new Error(
      `Failed to set up adb port forwarding for ${deviceId}: ${msg}${stderr ? ` (${stderr.trim()})` : ""}`,
    );
  }

  // Success path: create socket first, then set state — ensures the
  // invariant that "connecting" always has a live socket reference.
  const sock = new net.Socket();
  socket = sock;
  state = "connecting";

  setupSocketHandlers(sock, deviceId);
  sock.connect({ host: "127.0.0.1", port: AGENT_PORT });
}

/**
 * Wire up all event handlers for a socket instance.
 * Uses closure-scoped flags and buffer (per-socket, not module-level).
 */
function setupSocketHandlers(sock: net.Socket, deviceId: string): void {
  let cleanupCalled = false;
  let socketBuffer = "";

  // Explicit connect timer — fires if TCP handshake does not complete in time.
  // Unlike sock.setTimeout (idle timeout), this is guaranteed to cover the
  // connection phase regardless of OS-level SYN retransmission behavior.
  const connectTimer = setTimeout(() => {
    sock.destroy(new Error("Connect timeout"));
  }, CONNECT_TIMEOUT_MS);

  sock.on("connect", () => {
    clearTimeout(connectTimer);
    if (socket !== sock) return; // stale socket guard
    state = "connected";
    connectedDeviceId = deviceId;
  });

  sock.on("data", (data) => {
    socketBuffer += data.toString();
    const lines = socketBuffer.split("\n");
    socketBuffer = lines.pop()!; // safe: split() always returns at least one element
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const id = parsed.id as string | undefined;
        if (id && pendingRequests.has(id)) {
          const entry = pendingRequests.get(id)!;
          clearTimeout(entry.timer);
          entry.resolve(parsed);
          pendingRequests.delete(id);
        }
      } catch {
        // ignore unparseable lines
      }
    }
  });

  sock.on("error", (err) => {
    console.error(`Socket error: ${err.message}`);
    sock.destroy(); // guarantee close fires
  });

  sock.on("close", () => {
    clearTimeout(connectTimer);
    if (cleanupCalled) return;
    cleanupCalled = true;
    if (socket !== sock) return; // stale socket guard

    // Reject pending requests
    for (const [id, entry] of pendingRequests) {
      clearTimeout(entry.timer);
      entry.reject(
        new Error(
          "Socket closed. The device may have disconnected. " +
            "Reconnection will be attempted automatically when the device is available.",
        ),
      );
      pendingRequests.delete(id);
    }

    const wasConnected = state === "connected";
    socket = null;
    connectedDeviceId = null;

    // Notify disconnect callback only if a connection was actually established.
    if (wasConnected) {
      try {
        disconnectCallback?.();
      } catch (err) {
        console.error("Disconnect callback error:", err instanceof Error ? err.message : err);
      }
    }

    if (!targetDeviceId) {
      state = "disconnected";
      return;
    }

    // Always go to waiting_for_device — "connecting" must always have a socket.
    state = "waiting_for_device";

    if (wasConnected) {
      // Schedule one quick retry for transient TCP failures.
      scheduleRetry(deviceId);
    }

    // Check if device is already known to tracker (prevents stuck-state where
    // the tracker event was consumed before we entered waiting_for_device).
    checkTrackerForDevice();
  });
}

// ── Internal: Retry & Reconnect Helpers ──────────────────────────────────────

/** Schedule a retry timer from waiting_for_device state. */
function scheduleRetry(deviceId: string): void {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (state !== "waiting_for_device") return;
    if (targetDeviceId !== deviceId) return;
    try {
      transitionToConnecting(deviceId);
    } catch {
      // Stay in waiting_for_device — check if device is already known to
      // the tracker so we don't get stuck when ADB forward fails transiently.
      state = "waiting_for_device";
      checkTrackerForDevice();
    }
  }, 1_000);
}

/**
 * Check if the target device is already known to the tracker.
 * Prevents the stuck-state where the tracker event was already consumed
 * before we entered waiting_for_device.
 */
function checkTrackerForDevice(): void {
  if (state !== "waiting_for_device" || !targetDeviceId) return;
  const trackerState = getKnownDeviceState(targetDeviceId);
  if (trackerState === "device") {
    scheduleTrackerReconnect(targetDeviceId);
  }
}

/** Handle device events from the ADB tracker. */
function handleTrackerEvent(event: DeviceEvent): void {
  if (
    event.state === "device" &&
    event.deviceId === targetDeviceId &&
    state === "waiting_for_device"
  ) {
    scheduleTrackerReconnect(event.deviceId);
  }
}

/** Schedule a tracker-initiated reconnect from waiting_for_device. */
function scheduleTrackerReconnect(deviceId: string): void {
  if (trackerReconnectTimer !== null) {
    clearTimeout(trackerReconnectTimer);
  }
  trackerReconnectTimer = setTimeout(() => {
    trackerReconnectTimer = null;
    if (state !== "waiting_for_device") return;
    if (targetDeviceId !== deviceId) return;
    try {
      transitionToConnecting(deviceId);
    } catch (err) {
      console.error(
        `ADB tracker: reconnect failed for ${deviceId}:`,
        err instanceof Error ? err.message : err,
      );
      // Ensure state is safe — transitionToConnecting may have set "connecting"
      // before throwing (e.g. socket allocation failure after state was set).
      state = "waiting_for_device";
    }
  }, 1_000);
}
