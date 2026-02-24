# Plan: Multi-Stop Routes + GPX/KML Replay

## Why build them together

Multi-stop routes require: waypoint iteration, route concatenation, dwell-time pauses, and a phase-aware simulation loop. GPX/KML replay requires: file parsing, coordinate iteration, and a time-aware simulation loop. They share the same core problem — "walk through a sequence of timed positions at 1 Hz" — so building multi-stop first creates the simulation infrastructure that GPX replay reuses.

## Why the AI can't just chain `geo_simulate_route`

It technically can, but three things break:

1. **Dead gaps** — Between segments the AI polls `geo_get_status`, thinks, calls the next tool. 1-3 seconds of emulator silence per waypoint. The app under test sees the user freeze mid-road.
2. **Dwell time** — "Wait 30s at stop B" requires the AI to sleep/poll, burning tokens on nothing.
3. **Atomicity** — A single `geo_stop` can't cancel a multi-step AI orchestration cleanly.

The server-side value: one continuous 1 Hz loop with zero gaps at transitions.

---

## Tool 1: `geo_simulate_multi_stop`

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `waypoints` | array | yes | — | Ordered list of waypoints (min 2). Each: `{ lat?, lng?, place?, dwellSeconds? }` |
| `speedKmh` | number | no | `60` | Travel speed between waypoints |
| `trafficMultiplier` | number | no | `1.0` | Traffic slowdown factor |
| `profile` | enum | no | `car` | Routing profile: `car`, `foot`, `bike` |

Each waypoint object:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `lat` | number | no | — | Latitude |
| `lng` | number | no | — | Longitude |
| `place` | string | no | — | Place name (geocoded) |
| `dwellSeconds` | number | no | `0` | Time to stay at this waypoint before continuing |

Provide either `place` or both `lat`/`lng` per waypoint. First waypoint auto-resolves from current position (same logic as `geo_simulate_route`).

### Behavior

1. Resolve all waypoints (geocode places)
2. Fetch routes between consecutive pairs (N-1 route fetches for N waypoints)
3. Build a **phase plan** — alternating `move` and `dwell` phases
4. Run one continuous 1 Hz simulation loop through all phases
5. Return summary: total distance, total time, leg breakdown

### Phase plan architecture

The simulation is a sequence of phases:

```
[move A→B] → [dwell at B for 30s] → [move B→C] → [dwell at C for 0s] → [move C→D] → stop
```

Each phase:
```typescript
interface SimulationPhase {
  type: 'move' | 'dwell';
  startTick: number;  // inclusive (seconds from simulation start)
  endTick: number;    // exclusive
  route?: RouteResult;     // for 'move': the route polyline
  speedMs?: number;        // for 'move': speed in m/s (for NMEA)
  position?: RoutePoint;   // for 'dwell': the stationary position
}
```

Loop logic (1 Hz):
```
tick++
find current phase where startTick <= tick < endTick
if (move):
  fraction = (tick - phase.startTick) / (phase.endTick - phase.startTick)
  pos = interpolateAlongRoute(phase.route, fraction)
  bearing = bearingAlongRoute(phase.route, fraction)
  setLocation({ pos, speed: phase.speedMs, bearing })
if (dwell):
  setLocation({ phase.position, speed: 0, bearing: 0 })
if (tick >= totalTicks):
  send final position with speed: 0
  stop
```

No pre-computation of all positions — just phase boundary timestamps. Memory-efficient for long routes.

### Response format

```
Multi-stop simulation started.
  Waypoints: 4 (3 legs)
  Routing: osrm, profile: car
  Leg 1: Warehouse → Stop A — 5.2 km, 5.2 min + 30s dwell
  Leg 2: Stop A → Stop B — 8.1 km, 8.1 min + 30s dwell
  Leg 3: Stop B → Depot — 3.4 km, 3.4 min
  Total: 16.7 km, 17.7 min (1062 steps at 1 Hz)
```

---

## Tool 2: `geo_replay_gpx_kml`

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `fileContent` | string | no* | — | Raw GPX or KML file content (XML string) |
| `filePath` | string | no* | — | Absolute path to a GPX or KML file on the host |
| `speedMultiplier` | number | no | `1.0` | Playback speed multiplier (2.0 = 2x faster) |
| `speedKmh` | number | no | `60` | Fallback speed when file has no timestamps |

*Provide either `fileContent` or `filePath`.

### File format detection

Auto-detect from content: `<gpx` → GPX, `<kml` → KML. No `format` parameter needed — the XML root element is definitive.

### GPX parsing

Extract `<trkpt>` elements from `<trk>/<trkseg>`:
```xml
<trkpt lat="47.644" lon="-122.326">
  <ele>4.46</ele>
  <time>2009-10-17T18:37:26Z</time>
</trkpt>
```

Output: array of `{ lat, lng, elevation?, timestamp? }`

Multiple `<trk>` or `<trkseg>` → concatenated in document order.

### KML parsing

Extract `<coordinates>` from `<LineString>` elements:
```xml
<coordinates>-122.326,47.644,4.46 -122.327,47.645,4.47</coordinates>
```

Output: array of `{ lat, lng, elevation? }` (KML LineStrings have no timestamps).

Multiple `<LineString>` → use the first one with >1 coordinate.

### Two replay modes

**Time-based** (GPX with `<time>` on all trackpoints):
- Compute elapsed time from first trackpoint for each point
- Apply `speedMultiplier`: tick N corresponds to original time `N * speedMultiplier` seconds
- At each 1 Hz tick, find the two surrounding trackpoints by time, linearly interpolate
- Speed derived from distance/time between surrounding points (preserves acceleration/braking)
- Bearing computed from surrounding points

**Distance-based** (KML, or GPX without timestamps):
- Build a `RouteResult` from parsed points (using `buildCumulativeDistances`)
- Simulate at constant `speedKmh`, identical to `geo_simulate_route`
- Uses existing `interpolateAlongRoute` / `bearingAlongRoute`

### Response format

```
GPX replay started.
  File: 847 trackpoints, 12.3 km
  Mode: time-based (timestamps found)
  Original duration: 23.5 min
  Playback: 2.0x speed → 11.8 min (706 steps at 1 Hz)
```

or

```
KML replay started.
  File: 234 points, 8.7 km
  Mode: distance-based (no timestamps)
  Speed: 60.0 km/h → 8.7 min (522 steps at 1 Hz)
```

---

## Implementation plan

### New file: `server/src/gpx-kml.ts`

GPX/KML parsing module. Exports:

```typescript
interface TrackPoint {
  lat: number;
  lng: number;
  elevation?: number;
  timestamp?: Date;
}

interface ParsedTrack {
  points: TrackPoint[];
  format: 'gpx' | 'kml';
  hasTimestamps: boolean;
  name?: string;
}

function parseGpxKml(content: string): ParsedTrack
```

**XML parsing:** Use `fast-xml-parser` (lightweight, zero transitive deps, handles namespace/CDATA edge cases). QA teams will have GPX files from various tools (Strava, Google Earth, field recorders) with varying XML quirks — a proper parser is worth the one dependency.

### New file: `server/src/simulation.ts`

Shared simulation runner. Reduces duplication across existing tools and the two new ones.

Exports:

```typescript
interface SimulationCallbacks {
  /** Return position for this tick, or null to end simulation. */
  getPosition(tick: number): NmeaLocationParams | null;
}

function startSimulation(callbacks: SimulationCallbacks, intervalMs?: number): void
```

Internally manages `simulationTimer`, `lastLocation`, and the `setInterval` lifecycle.

### Modified: `server/src/index.ts`

1. Add `geo_simulate_multi_stop` tool (tool #10)
2. Add `geo_replay_gpx_kml` tool (tool #11)
3. Import `startSimulation` from `simulation.ts`
4. Migrate existing simulation tools to use `startSimulation()` — keeps diff clean and verifies the abstraction works

### Modified: `server/src/routing.ts`

No changes needed. Multi-stop uses individual leg routes within the phase plan, and existing `interpolateAlongRoute` / `bearingAlongRoute` already work per-leg.

### Modified: `server/README.md`

Add tool reference sections for both new tools.

### Modified: `CLAUDE.md`

Update tool count (9 → 11), add new files to project structure.

### Modified: `server/package.json`

Add `fast-xml-parser` production dependency.

---

## Implementation order

1. **`fast-xml-parser`** — `npm install fast-xml-parser`
2. **`gpx-kml.ts`** — File parsing, standalone module
3. **`simulation.ts`** — Extract shared simulation runner from existing inline loops
4. **Migrate existing tools** — Refactor `geo_simulate_route`, `geo_simulate_jitter`, `geo_test_geofence` to use `startSimulation()`
5. **`geo_simulate_multi_stop`** — New tool using phase plan + simulation runner
6. **`geo_replay_gpx_kml`** — New tool using gpx-kml parser + simulation runner
7. **`README.md` + `CLAUDE.md`** — Documentation
8. **`npm run build`** — Verify everything compiles

---

## Edge cases

### Multi-stop
- **< 2 waypoints** → Error: need at least 2
- **Geocoding failure** → Report which waypoint failed by index, don't start simulation
- **Route fetch failure** → Straight-line fallback for that leg (existing behavior)
- **Zero dwell** → Skip dwell phase, transition immediately to next leg
- **First waypoint auto-resolve** → last mock position → emulator GPS → error (same as `geo_simulate_route`)

### GPX/KML replay
- **Empty file / no trackpoints** → Error with descriptive message
- **Single trackpoint** → Set as static location, no simulation
- **Duplicate consecutive timestamps** → Skip zero-duration segments
- **Timestamps out of order** → Sort by timestamp before replay
- **Mixed timestamps** (some points have `<time>`, some don't) → Time-based if ≥80% have timestamps, else distance-based
- **File read failure** (`filePath`) → Error with path and OS error message
- **Invalid XML** → Error with parser message
- **Elevation data** → Pass as `altitude` in NMEA when available (currently hardcoded to 0)

---

## What this does NOT include

- **Loop/repeat** — "Replay this GPX forever." Adds state complexity. Defer.
- **Pause/resume** — "Pause at waypoint 3." Requires new interaction pattern. Defer.
- **Per-leg speed** — Different speeds per leg. Could extend waypoint schema later.
- **Route waypoints** (via-points) — "Route through this point but don't stop." Different from dwell=0 because it affects routing. Defer.
