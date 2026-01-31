// ── ADB command execution ────────────────────────────────────────────────────

import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Constants ────────────────────────────────────────────────────────────────

export const AGENT_PACKAGE = "com.ms.square.geomcpagent";
export const AGENT_PORT = 5005;
const ADB_TIMEOUT_MS = 10_000;
// Covers emulator serials, USB serials, IPv4:port, and bracketed IPv6:port (e.g. [::1]:5555)
const DEVICE_ID_PATTERN = /^(\[[a-fA-F0-9.:]+\](:\d+)?|[a-zA-Z0-9._:\-]+)$/;

// ── Error Typing ─────────────────────────────────────────────────────────────

interface ExecError extends Error {
  stderr?: string;
  status?: number | null;
}

function isExecError(err: unknown): err is ExecError {
  return err instanceof Error && "stderr" in err;
}

// ── Validation ───────────────────────────────────────────────────────────────

function validateDeviceId(deviceId: string): void {
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new Error(`Invalid device ID: ${deviceId}`);
  }
}

// ── Primitives ───────────────────────────────────────────────────────────────

/** Device-scoped synchronous ADB command. Always validates deviceId and applies timeout. */
export function adbDevice(deviceId: string, args: string[], timeoutMs = ADB_TIMEOUT_MS): string {
  validateDeviceId(deviceId);
  return execFileSync("adb", ["-s", deviceId, ...args], {
    encoding: "utf-8",
    timeout: timeoutMs,
  });
}

/** Global asynchronous ADB command (no -s flag). */
export async function adb(args: string[], timeoutMs = ADB_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync("adb", args, {
    encoding: "utf-8",
    timeout: timeoutMs,
  });
  return stdout;
}

// ── Operations ───────────────────────────────────────────────────────────────

/** List connected ADB devices. Returns raw `adb devices -l` output. */
export async function listDevices(): Promise<string> {
  return adb(["devices", "-l"]);
}

/**
 * Check whether the agent APK is installed on the device.
 * Returns true if installed, false if not installed.
 * Throws if the ADB command fails for other reasons (device offline, unauthorized, etc.).
 */
export function isAgentInstalled(deviceId: string): boolean {
  try {
    const output = adbDevice(deviceId, ["shell", "pm", "path", AGENT_PACKAGE]);
    return output.includes("package:");
  } catch (err) {
    // `pm path` exits with code 1 and empty stderr when the package is not found.
    // ADB-level failures (device offline, unauthorized) also exit with code 1 but
    // include an error message on stderr — those should propagate.
    if (isExecError(err) && err.status === 1 && !err.stderr?.trim()) {
      return false;
    }
    throw err;
  }
}

/**
 * Ensure the device is set up for mock location: grant location permissions
 * and set this app as the mock location provider via AppOps.
 * All commands are idempotent — safe to call on every connection attempt.
 */
export function ensureDeviceSetup(deviceId: string): void {
  adbDevice(deviceId, ["shell", "pm", "grant", AGENT_PACKAGE, "android.permission.ACCESS_FINE_LOCATION"]);
  adbDevice(deviceId, ["shell", "pm", "grant", AGENT_PACKAGE, "android.permission.ACCESS_COARSE_LOCATION"]);
  adbDevice(deviceId, ["shell", "appops", "set", AGENT_PACKAGE, "android:mock_location", "allow"]);
}

/**
 * Start the MockLocationService directly via ADB.
 * The service is exported, so it can be started without launching the Activity.
 */
export function startAgentService(deviceId: string): void {
  adbDevice(deviceId, [
    "shell",
    "am",
    "start-foreground-service",
    "-n",
    `${AGENT_PACKAGE}/.MockLocationService`,
  ]);
}

/**
 * Set up ADB port forwarding for the agent TCP socket.
 * Synchronous — throws on failure with stderr context.
 */
export function adbForward(deviceId: string): void {
  try {
    adbDevice(deviceId, ["forward", `tcp:${AGENT_PORT}`, `tcp:${AGENT_PORT}`]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = isExecError(err) ? err.stderr?.trim() : undefined;
    throw new Error(
      `Failed to set up adb port forwarding for ${deviceId}: ${msg}${stderr ? ` (${stderr})` : ""}`,
    );
  }
}
