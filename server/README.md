# MCP Server — android-mock-location-mcp

MCP server that exposes 9 tools for controlling Android device GPS location. Connects to an Android agent app over TCP (via ADB port forwarding) and supports geocoding and street-level routing through configurable providers.

See the [root README](../README.md) for project overview and quick start.

## Installation

**npx (no install):**
```bash
npx android-mock-location-mcp
```

**Global install:**
```bash
npm install -g android-mock-location-mcp
android-mock-location-mcp
```

**Build from source:**
```bash
cd server
npm install
npm run build
npm start
```

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PROVIDER` | Provider for geocoding + routing: `osm` (default), `google`, `mapbox` | No (defaults to `osm`) |
| `GOOGLE_API_KEY` | Google Places + Routes API key | When `PROVIDER=google` |
| `MAPBOX_ACCESS_TOKEN` | Mapbox Geocoding + Directions access token | When `PROVIDER=mapbox` |

Set environment variables in your MCP client configuration:

<details>
<summary><b>Claude Desktop (default OSM provider)</b></summary>

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "android-mock-location-mcp": {
      "command": "npx",
      "args": ["-y", "android-mock-location-mcp"]
    }
  }
}
```

No API key required. Uses free Nominatim geocoding and OSRM routing (car profile only).
</details>

<details>
<summary><b>Claude Desktop with Google provider</b></summary>

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "android-mock-location-mcp": {
      "command": "npx",
      "args": ["-y", "android-mock-location-mcp"],
      "env": {
        "PROVIDER": "google",
        "GOOGLE_API_KEY": "your-google-api-key"
      }
    }
  }
}
```

**Prerequisites:** Enable both the [Places API (New)](https://console.cloud.google.com/apis/library/places.googleapis.com) and [Routes API](https://console.cloud.google.com/apis/library/routes.googleapis.com) in your Google Cloud project.
</details>

<details>
<summary><b>Claude Desktop with Mapbox provider</b></summary>

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "android-mock-location-mcp": {
      "command": "npx",
      "args": ["-y", "android-mock-location-mcp"],
      "env": {
        "PROVIDER": "mapbox",
        "MAPBOX_ACCESS_TOKEN": "your-mapbox-access-token"
      }
    }
  }
}
```
</details>

After editing the config, restart the MCP server and Claude Desktop for changes to take effect.

<details>
<summary><b>Claude Code (default OSM provider)</b></summary>

```bash
claude mcp add android-mock-location-mcp -- npx -y android-mock-location-mcp
```

No API key required. Uses free Nominatim geocoding and OSRM routing (car profile only).
</details>

<details>
<summary><b>Claude Code with Google provider</b></summary>

```bash
GOOGLE_API_KEY=your-google-api-key
claude mcp add android-mock-location-mcp \
  -e PROVIDER=google \
  -e GOOGLE_API_KEY=$GOOGLE_API_KEY \
  -- npx -y android-mock-location-mcp
```

**Prerequisites:** Enable both the [Places API (New)](https://console.cloud.google.com/apis/library/places.googleapis.com) and [Routes API](https://console.cloud.google.com/apis/library/routes.googleapis.com) in your Google Cloud project.
</details>

<details>
<summary><b>Claude Code with Mapbox provider</b></summary>

```bash
MAPBOX_ACCESS_TOKEN=your-mapbox-access-token
claude mcp add android-mock-location-mcp \
  -e PROVIDER=mapbox \
  -e MAPBOX_ACCESS_TOKEN=$MAPBOX_ACCESS_TOKEN \
  -- npx -y android-mock-location-mcp
```
</details>

<details>
<summary><b>Claude Code — switching providers</b></summary>

To switch from one provider to another (e.g. `osm` → `google`), remove and re-add the server with new env vars, then restart the server and Claude Code:

```bash
# 1. Remove existing server
claude mcp remove android-mock-location-mcp

# 2. Re-add with new provider
GOOGLE_API_KEY=your-google-api-key
claude mcp add android-mock-location-mcp \
  -e PROVIDER=google \
  -e GOOGLE_API_KEY=$GOOGLE_API_KEY \
  -- npx -y android-mock-location-mcp

# 3. Restart the MCP server and Claude Code
```

Environment variables are baked into the MCP server config at initialization time. Changing providers requires restarting the server.
</details>

### Providers

Google and Mapbox providers produce better results than the default OSM provider — more accurate geocoding, full routing profile support (car/foot/bike), and higher rate limits. Both offer free tiers.

| `PROVIDER`    | Geocoding Service           | Routing Service | Profiles Supported | API Key                | Cost                 |
| ------------- | --------------------------- | --------------- | ------------------ | ---------------------- | -------------------- |
| `osm` (default) | Nominatim (OpenStreetMap) | OSRM            | `car` only*        | None                   | Free (rate-limited)  |
| `google` | Google Places API | Google Routes API | `car`, `foot`, `bike` | `GOOGLE_API_KEY` | Paid ([free tier](https://developers.google.com/maps/get-started)) |
| `mapbox` | Mapbox Geocoding | Mapbox Directions | `car`, `foot`, `bike` | `MAPBOX_ACCESS_TOKEN` | Paid ([free tier](https://account.mapbox.com/access-tokens/)) |

**\*OSRM limitation:** The public OSRM demo server (`router.project-osrm.org`) only supports the `car` profile. Requesting `foot` or `bike` silently returns a driving route. For walking/cycling routing, use `google` or `mapbox`.

**Nominatim rate limit:** The OSM Nominatim API is rate-limited to 1 request per second. When using the `osm` provider, the server hints the AI to resolve place names to coordinates itself and pass `lat`/`lng` directly.

## Tool Reference

### `geo_list_devices`

List connected Android devices via ADB.

No parameters.

---

### `geo_connect_device`

Connect to an Android device for mock location control. Automatically grants permissions, selects the app as mock location provider, starts the agent service, sets up ADB port forwarding, and opens a TCP socket.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `deviceId` | string | yes | Device serial from `geo_list_devices`, e.g. `emulator-5554` |

---

### `geo_set_location`

Set device GPS to coordinates or any place name/address. Geocodes place names via the configured provider.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `lat` | number | no | — | Latitude (-90 to 90) |
| `lng` | number | no | — | Longitude (-180 to 180) |
| `place` | string | no | — | Place name or address, e.g. `'Times Square'`, `'Tokyo Station'` |
| `accuracy` | number | no | `3` | GPS accuracy in meters |

Provide either `place` or both `lat`/`lng`.

---

### `geo_simulate_route`

Simulate movement along a route between two points at a given speed. Routes follow real streets via the configured routing provider. Falls back to straight-line if the provider fails.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `from` | string | no | — | Starting place name or address |
| `to` | string | no | — | Destination place name or address |
| `fromLat` | number | no | — | Starting latitude |
| `fromLng` | number | no | — | Starting longitude |
| `toLat` | number | no | — | Destination latitude |
| `toLng` | number | no | — | Destination longitude |
| `speedKmh` | number | no | `60` | Speed in km/h |
| `trafficMultiplier` | number | no | `1.0` | Traffic slowdown factor (e.g. `1.5` = 50% slower) |
| `profile` | enum | no | `car` | Routing profile: `car`, `foot`, or `bike` |

Provide either `from`/`to` (place names) or `fromLat`/`fromLng`/`toLat`/`toLng` (coordinates) for each endpoint.

**Starting location auto-resolve:** If no `from`/`fromLat`/`fromLng` is provided, the tool automatically tries (in order): the last mock location, the device's real GPS position via `geo_get_location`, or returns an error asking the user for their starting location.

#### Routing Profiles

| Profile | Use for | Routes on |
|---------|---------|-----------|
| `car` (default) | Driving simulation | Roads, highways |
| `foot` | Walking simulation | Sidewalks, pedestrian paths |
| `bike` | Cycling simulation | Bike lanes, roads |

The AI should select `profile` based on user intent (e.g. "walk to" → `foot`, "drive to" → `car`).

---

### `geo_simulate_jitter`

Simulate GPS noise/jitter at a location for testing accuracy handling.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `lat` | number | no | — | Center latitude |
| `lng` | number | no | — | Center longitude |
| `place` | string | no | — | Center place name or address |
| `radiusMeters` | number | no | `10` | Jitter radius in meters |
| `pattern` | enum | no | `random` | Jitter pattern: `random`, `drift`, `urban_canyon` |
| `durationSeconds` | number | no | `30` | Duration in seconds |

Provide either `place` or both `lat`/`lng`.

#### Jitter Patterns

| Pattern | Behavior |
|---------|----------|
| `random` | Uniform random distribution within radius |
| `drift` | Gradual movement in one direction |
| `urban_canyon` | Alternating accurate (3m) and inaccurate (50-80m) fixes, simulating tall buildings |

---

### `geo_test_geofence`

Test geofence enter/exit/bounce behavior at a location.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `lat` | number | no | — | Geofence center latitude |
| `lng` | number | no | — | Geofence center longitude |
| `place` | string | no | — | Geofence center place name or address |
| `radiusMeters` | number | no | `100` | Geofence radius in meters |
| `action` | enum | no | `enter` | Geofence action: `enter`, `exit`, `bounce` |
| `bounceCount` | number | no | `3` | Number of boundary crossings (for `bounce` action) |

Provide either `place` or both `lat`/`lng`.

#### Geofence Actions

| Action | Behavior |
|--------|----------|
| `enter` | Move from outside to inside the geofence |
| `exit` | Move from inside to outside the geofence |
| `bounce` | Cross the boundary `bounceCount` times |

---

### `geo_stop`

Stop any active location simulation.

No parameters.

---

### `geo_get_status`

Get current connection and simulation status.

No parameters.

---

### `geo_get_location`

Get the device's current real GPS location (last known position from the device's location sensors). Use this to determine where the device physically is before simulating a route.

No parameters.

Returns the device's latitude and longitude if a recent GPS fix is available, along with `accuracy` (horizontal accuracy in meters) and `ageMs` (milliseconds since the fix was obtained) when provided by the device. If the device has no location fix, the tool returns an error message — in that case, ask the user for their current location.

## Source Structure

| File | Purpose |
|------|---------|
| `src/index.ts` | MCP server setup, all 9 tool definitions with Zod schemas |
| `src/adb.ts` | ADB command execution with timeouts, device setup, agent install check |
| `src/device.ts` | TCP socket to agent, connection state machine, request/response matching |
| `src/geocode.ts` | Geocoding providers: Nominatim, Google, Mapbox |
| `src/routing.ts` | Routing providers: OSRM, Google Routes API, Mapbox Directions |
| `src/geo-math.ts` | Haversine distance, forward bearing calculation |
| `src/fetch-utils.ts` | Shared `fetchWithTimeout` helper |

## Development

```bash
npm install       # Install dependencies
npm run build     # Compile TypeScript
npm run dev       # Watch mode (recompile on change)
npm start         # Run the server
```

The server communicates via stdio (MCP protocol). To test interactively, use the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector).

## Known Limitations

- **Single device only.** The server connects to one Android device at a time. Calling `geo_connect_device` with a different serial disconnects the previous device and stops any active simulation. Controlling multiple devices simultaneously is not supported.
- **Single simulation.** Only one simulation (route, jitter, or geofence) runs at a time. Starting a new one stops the previous.

See also: provider-specific limitations in the [Providers](#providers) table above.

## Adding a New Provider

Both `src/geocode.ts` and `src/routing.ts` use the same pattern:

1. Implement the `GeocodeProvider` type (in `geocode.ts`) and/or `RoutingProvider` type (in `routing.ts`)
2. Add a case to `selectProvider()` in the respective file
3. Validate required env vars in the `selectProvider()` switch case
4. Document the new env var in this README and in `CLAUDE.md`
