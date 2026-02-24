// ── ADB command execution (emulator-only) ────────────────────────────────────

import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Constants ────────────────────────────────────────────────────────────────

const ADB_TIMEOUT_MS = 10_000;
/** Only emulator serials are accepted (e.g. emulator-5554). */
const EMULATOR_ID_PATTERN = /^emulator-\d+$/;

// ── Error Typing ─────────────────────────────────────────────────────────────

interface ExecError extends Error {
  stderr?: string;
  status?: number | null;
}

export function isExecError(err: unknown): err is ExecError {
  return err instanceof Error && "stderr" in err;
}

// ── Validation ───────────────────────────────────────────────────────────────

function validateDeviceId(deviceId: string): void {
  if (!EMULATOR_ID_PATTERN.test(deviceId)) {
    throw new Error(
      `Invalid emulator ID: ${deviceId}. Only Android emulators are supported (e.g. emulator-5554).`,
    );
  }
}

/** Check if a device ID matches the emulator serial pattern. */
export function isEmulator(deviceId: string): boolean {
  return EMULATOR_ID_PATTERN.test(deviceId);
}

// ── Primitives ───────────────────────────────────────────────────────────────

/** Emulator-scoped synchronous ADB command. Validates deviceId and applies timeout. */
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
