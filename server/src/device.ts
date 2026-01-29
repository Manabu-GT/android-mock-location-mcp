// ── ADB + socket communication with Android agent ───────────────────────────

import * as net from "node:net";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// ── State ────────────────────────────────────────────────────────────────────

let socket: net.Socket | null = null;
let connectedDeviceId: string | null = null;
let socketBuffer = "";

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
  return socket !== null && !socket.destroyed;
}

/** List connected ADB devices. Returns raw `adb devices -l` output. */
export function listDevices(): string {
  return execFileSync("adb", ["devices", "-l"], { encoding: "utf-8" });
}

/** Send a JSON command to the agent and await the response (5s timeout). */
export function sendCommand(command: Record<string, unknown>): Promise<unknown> {
  const sock = socket;
  if (!sock || sock.destroyed) {
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
          "Command timed out (5s). Troubleshooting: " +
            "(1) Verify the GeoMCP Agent service is running in the app (green indicator). " +
            "(2) Restart adb port forwarding: `adb forward tcp:5005 tcp:5005`. " +
            "(3) Check agent logs: `adb logcat -s GeoMCP`.",
        ),
      );
    }, 5000);
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

/** Set up ADB port forwarding and open a TCP socket to the agent. */
export function connectToDevice(deviceId: string): void {
  if (!/^[a-zA-Z0-9._:\-]+$/.test(deviceId)) {
    throw new Error(`Invalid device ID: ${deviceId}`);
  }
  try {
    execFileSync("adb", ["-s", deviceId, "forward", "tcp:5005", "tcp:5005"], { encoding: "utf-8" });
  } catch (err) {
    throw new Error(`Failed to set up adb port forwarding for ${deviceId}: ${(err as Error).message}`);
  }

  if (socket && !socket.destroyed) {
    socket.destroy();
  }

  const sock = new net.Socket();
  socket = sock;
  connectedDeviceId = deviceId;
  setupSocketHandlers(sock);
  sock.connect({ host: "127.0.0.1", port: 5005 });
}

// ── Internal ─────────────────────────────────────────────────────────────────

function setupSocketHandlers(sock: net.Socket): void {
  socketBuffer = "";

  sock.on("data", (data) => {
    socketBuffer += data.toString();
    const lines = socketBuffer.split("\n");
    socketBuffer = lines.pop()!; // keep incomplete last chunk
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

  const cleanup = () => {
    if (socket === null) return; // idempotent guard (error + close both fire)
    const previousDeviceId = connectedDeviceId;
    for (const [id, entry] of pendingRequests) {
      clearTimeout(entry.timer);
      entry.reject(
        new Error(
          "Socket closed. The device may have disconnected. " +
            "Auto-reconnect will be attempted. If it fails, call geo_connect_device again.",
        ),
      );
      pendingRequests.delete(id);
    }
    socket = null;
    connectedDeviceId = null;

    disconnectCallback?.();

    // Auto-reconnect attempt
    if (previousDeviceId) {
      setTimeout(() => {
        try {
          connectToDevice(previousDeviceId);
        } catch {
          // Reconnection failed — user must call geo_connect_device manually
        }
      }, 1000);
    }
  };

  sock.on("error", cleanup);
  sock.on("close", cleanup);
}
