// ── NMEA sentence generation for Android emulator ────────────────────────────
//
// Generates GPGGA and GPRMC sentences for use with the emulator's
// `geo nmea` command.  Together, these two sentence types carry:
//
//   GPGGA → latitude, longitude, altitude, HDOP (used by Android to derive accuracy)
//   GPRMC → latitude, longitude, speed over ground, course/bearing
//
// The Android emulator only accepts $GPGGA and $GPRMC sentence types.

// ── Coordinate Conversion ────────────────────────────────────────────────────

/**
 * Format minutes, handling the edge case where rounding pushes minutes to 60.
 * Returns { degrees adjustment, formatted minutes string }.
 */
function formatMinutes(minutes: number, decimals: number): { overflow: number; formatted: string } {
  const rounded = parseFloat(minutes.toFixed(decimals));
  if (rounded >= 60) {
    return { overflow: 1, formatted: (0).toFixed(decimals) };
  }
  return { overflow: 0, formatted: rounded.toFixed(decimals) };
}

/** Convert decimal-degree latitude to NMEA ddmm.mmmm format + hemisphere. */
function toNmeaLatitude(decimal: number): { value: string; hemisphere: "N" | "S" } {
  const hemisphere = decimal >= 0 ? ("N" as const) : ("S" as const);
  const abs = Math.abs(decimal);
  let degrees = Math.floor(abs);
  const rawMinutes = (abs - degrees) * 60;
  const { overflow, formatted } = formatMinutes(rawMinutes, 4);
  degrees += overflow;
  const value = `${degrees.toString().padStart(2, "0")}${formatted.padStart(7, "0")}`;
  return { value, hemisphere };
}

/** Convert decimal-degree longitude to NMEA dddmm.mmmm format + hemisphere. */
function toNmeaLongitude(decimal: number): { value: string; hemisphere: "E" | "W" } {
  const hemisphere = decimal >= 0 ? ("E" as const) : ("W" as const);
  const abs = Math.abs(decimal);
  let degrees = Math.floor(abs);
  const rawMinutes = (abs - degrees) * 60;
  const { overflow, formatted } = formatMinutes(rawMinutes, 4);
  degrees += overflow;
  const value = `${degrees.toString().padStart(3, "0")}${formatted.padStart(7, "0")}`;
  return { value, hemisphere };
}

// ── Time / Date ──────────────────────────────────────────────────────────────

/** Current UTC time as NMEA hhmmss string (no fractional seconds — the Android emulator's GNSS HAL parses the time field with %06d, which rejects decimals). */
function nmeaTime(): string {
  const now = new Date();
  const h = now.getUTCHours().toString().padStart(2, "0");
  const m = now.getUTCMinutes().toString().padStart(2, "0");
  const s = now.getUTCSeconds().toString().padStart(2, "0");
  return `${h}${m}${s}`;
}

/** Current UTC date as NMEA ddmmyy string. */
function nmeaDate(): string {
  const now = new Date();
  const d = now.getUTCDate().toString().padStart(2, "0");
  const m = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const y = (now.getUTCFullYear() % 100).toString().padStart(2, "0");
  return `${d}${m}${y}`;
}

// ── Checksum ─────────────────────────────────────────────────────────────────

/** XOR checksum of all characters between '$' and '*' (exclusive). */
function nmeaChecksum(body: string): string {
  let cs = 0;
  for (let i = 0; i < body.length; i++) {
    cs ^= body.charCodeAt(i);
  }
  return cs.toString(16).toUpperCase().padStart(2, "0");
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface NmeaLocationParams {
  lat: number;
  lng: number;
  altitude?: number;
  /** Speed in meters per second. */
  speed?: number;
  /** Bearing / course over ground in degrees (0–360). */
  bearing?: number;
  /** Desired GPS accuracy in meters (approximated via HDOP). */
  accuracy?: number;
}

/**
 * Build a $GPGGA sentence (position, altitude, accuracy via HDOP).
 *
 * HDOP is derived from accuracy: `HDOP ≈ accuracy / 4`.
 * Android typically derives accuracy as `HDOP × baseAccuracy` where
 * baseAccuracy ≈ 4 m for consumer-grade GPS.
 */
export function buildGpgga(params: NmeaLocationParams): string {
  const time = nmeaTime();
  const lat = toNmeaLatitude(params.lat);
  const lng = toNmeaLongitude(params.lng);
  const altitude = (params.altitude ?? 0).toFixed(1);
  const hdop = Math.max(0.5, (params.accuracy ?? 3) / 4).toFixed(1);

  const body =
    `GPGGA,${time},${lat.value},${lat.hemisphere},${lng.value},${lng.hemisphere}` +
    `,1,08,${hdop},${altitude},M,0.0,M,,`;
  return `$${body}*${nmeaChecksum(body)}`;
}

/**
 * Build a $GPRMC sentence (position, speed, bearing).
 *
 * Speed is converted from m/s to knots (1 m/s ≈ 1.94384 knots).
 */
export function buildGprmc(params: NmeaLocationParams): string {
  const time = nmeaTime();
  const date = nmeaDate();
  const lat = toNmeaLatitude(params.lat);
  const lng = toNmeaLongitude(params.lng);
  const speedKnots = ((params.speed ?? 0) * 1.94384).toFixed(1);
  const bearing = (params.bearing ?? 0).toFixed(1);

  const body =
    `GPRMC,${time},A,${lat.value},${lat.hemisphere},${lng.value},${lng.hemisphere}` +
    `,${speedKnots},${bearing},${date},0.0,E`;
  return `$${body}*${nmeaChecksum(body)}`;
}
