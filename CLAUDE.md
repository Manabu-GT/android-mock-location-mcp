# CLAUDE.md

## Project Overview

MCP server for controlling Android emulator GPS location during QA testing. Sets mock locations via `adb emu geo fix`.

Communication: MCP client ←MCP (stdio)→ Server ←`adb emu geo fix`→ Android Emulator

## Key Commands

```bash
# Server
cd server && npm install && npm run build && npm start

# Test connection (after emulator started)
adb devices  # should show emulator-5554 or similar
```

## Project Structure

```
server/src/
  index.ts          # MCP server, all 11 tool definitions (Zod schemas)
  emulator.ts       # Emulator connection management, location setting via `geo fix`
  adb.ts            # ADB command execution with timeouts, emulator validation
  geocode.ts        # Geocoding providers (Nominatim/Google/Mapbox)
  routing.ts        # Routing providers (OSRM/Google/Mapbox)
  gpx-kml.ts        # GPX/KML file parsing for track replay
  geo-math.ts       # Haversine distance calculation
  fetch-utils.ts    # Shared fetch with timeout helper
```

## Provider Configuration

Set `PROVIDER` env var in MCP client config: `osm` (default), `google`, `mapbox`.

- `osm` — Nominatim geocoding + OSRM routing. Free, no API key. Rate-limited (1 req/sec).
- `google` — Requires `GOOGLE_API_KEY`. Full profile support (car/foot/bike).
- `mapbox` — Requires `MAPBOX_ACCESS_TOKEN`. Full profile support.

See [server/README.md](server/README.md) for full provider reference and env var table.

## Gotchas and Failure Modes

- **Emulators only**: Only Android emulators are supported. Physical devices are not supported since mock location is set via `adb emu geo fix` which is an emulator-specific command.
- **OSRM car-only**: Public OSRM server only supports `car` profile. `foot`/`bike` silently return car routes. Use `google` or `mapbox` for walking/cycling.
- **Nominatim rate limit**: 1 req/sec. Server hints AI to pass lat/lng directly when using OSM provider.
- **Single simulation**: Only one simulation runs at a time. Starting a new one stops the previous.

## Coding Conventions

- TypeScript strict mode, ES modules (`"type": "module"` in package.json)
- Zod for MCP tool input validation (schemas in `index.ts`)
- Provider pattern: implement `GeocodeProvider` or `RoutingProvider` type, add case to `selectProvider()` in respective file
- Tool parameter names/types are defined in `index.ts` Zod schemas — keep `server/README.md` in sync when changing
