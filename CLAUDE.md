# CLAUDE.md

## Project Overview

MCP server + Android agent for controlling Android device GPS location during QA testing.

Two components:
- **MCP Server** (`server/`) — TypeScript/Node.js, exposes 8 location tools via MCP protocol
- **Android Agent** (`android/`) — Kotlin/Compose app, foreground service that sets mock locations via `LocationManager`

Communication: MCP client ←MCP (stdio)→ Server ←TCP port 5005 (via `adb forward`)→ Android Agent

## Key Commands

```bash
# Server
cd server && npm install && npm run build && npm start

# Android
cd android && ./gradlew installDebug

# Test connection (after device setup + service started)
adb forward tcp:5005 tcp:5005
echo '{"id":"test","type":"status"}' | nc localhost 5005
```

## Project Structure

```
server/src/
  index.ts          # MCP server, all 8 tool definitions (Zod schemas)
  device.ts         # ADB commands + TCP socket to agent
  geocode.ts        # Geocoding providers (Nominatim/Google/Mapbox)
  routing.ts        # Routing providers (OSRM/Google/Mapbox)
  geo-math.ts       # Haversine distance, bearing calculation
  fetch-utils.ts    # Shared fetch with timeout helper

android/app/src/main/kotlin/com/geomcp/agent/
  MainActivity.kt         # Entry point, permission handling
  MockLocationService.kt  # Foreground service, socket server, mock location API
  ui/MainScreen.kt        # Compose UI
```

## Provider Configuration

Set `PROVIDER` env var in MCP client config: `osm` (default), `google`, `mapbox`.

- `osm` — Nominatim geocoding + OSRM routing. Free, no API key. Rate-limited (1 req/sec).
- `google` — Requires `GOOGLE_API_KEY`. Full profile support (car/foot/bike).
- `mapbox` — Requires `MAPBOX_ACCESS_TOKEN`. Full profile support.

See [server/README.md](server/README.md) for full provider reference and env var table.

## Gotchas and Failure Modes

- **OSRM car-only**: Public OSRM server only supports `car` profile. `foot`/`bike` silently return car routes. Use `google` or `mapbox` for walking/cycling.
- **Nominatim rate limit**: 1 req/sec. Server hints AI to pass lat/lng directly when using OSM provider.
- **Mock location setup**: Device must have Developer Options enabled and this app selected as mock location app. See [android/README.md](android/README.md).
- **ADB port forwarding**: Required before connecting: `adb forward tcp:5005 tcp:5005`. The server runs this automatically via `geo_connect_device`.
- **Single simulation**: Only one simulation runs at a time. Starting a new one stops the previous.
- **Device disconnect**: Socket auto-reconnects once, but if the MCP server restarts, user must call `geo_connect_device` again.
- **Newline-delimited JSON**: Protocol uses `\n`-delimited JSON with UUID `id` fields for request/response matching. See [protocol/PROTOCOL.md](protocol/PROTOCOL.md).

## Coding Conventions

- TypeScript strict mode, ES modules (`"type": "module"` in package.json)
- Zod for MCP tool input validation (schemas in `index.ts`)
- Provider pattern: implement `GeocodeProvider` or `RoutingProvider` type, add case to `selectProvider()` in respective file
- Android: Jetpack Compose UI, kotlinx.serialization for JSON, coroutines for async
- Tool parameter names/types are defined in `index.ts` Zod schemas — keep `server/README.md` in sync when changing
