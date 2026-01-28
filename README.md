# android-mock-location-mcp

[![Server CI](https://github.com/Manabu-GT/android-mock-location-mcp/actions/workflows/server-ci.yml/badge.svg)](https://github.com/user/android-mock-location-mcp/actions/workflows/server-ci.yml)
[![Android CI](https://github.com/Manabu-GT/android-mock-location-mcp/actions/workflows/android-ci.yml/badge.svg)](https://github.com/user/android-mock-location-mcp/actions/workflows/android-ci.yml)
[![npm version](https://badge.fury.io/js/android-mock-location-mcp.svg)](https://www.npmjs.com/package/android-mock-location-mcp)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**Mock Android device GPS from any MCP client.** Control your test device's location for QA testing with built-in geocoding and street-level routing.

```
"Drive from downtown Denver to the airport with rush hour traffic"
"Simulate bad GPS signal for 30 seconds"
"Test the geofence at Whole Foods - bounce in and out 3 times"
```

## Why android-mock-location-mcp?

Testing location-aware apps is painful. You either:
- Physically walk around with a device
- Write complex ADB scripts with hardcoded coordinates
- Use clunky GUI mock location apps

This MCP server lets you control device location from your IDE. Say "drive to the airport" instead of copy-pasting coordinates.

## How It Differs from Other Geo MCPs

| Server | Purpose | Example |
|--------|---------|---------|
| [MCP-Geo](https://github.com/webcoderz/MCP-Geo) | Geocoding (address → coords) | "What's the lat/lng of Tokyo Station?" |
| [gis-mcp](https://github.com/mahdin75/gis-mcp) | GIS operations (buffer, intersect) | "Buffer this polygon by 500m" |
| **android-mock-location-mcp** | **Device GPS control** | "Move my test phone to Times Square" |

This server **controls your Android device's GPS** with built-in geocoding and street-level routing. No extra tools needed.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Developer Machine                                      │
│  ┌───────────────┐      ┌─────────────────────────────┐ │
│  │ Claude/Cursor │ ←──→ │ MCP Server                  │ │
│  │ or any MCP    │      │ • Geocoding + routing       │ │
│  │ client        │      │ • Route interpolation       │ │
│  └───────────────┘      └──────────┬──────────────────┘ │
└────────────────────────────────────┼────────────────────┘
                                     │ adb forward tcp:5005
                                     ▼
┌─────────────────────────────────────────────────────────┐
│  Android Device / Emulator                              │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Mock Location Agent                             │    │
│  │ • Mock location provider                        │    │
│  │ • Socket listener (port 5005)                   │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Install the MCP Server

```bash
npx android-mock-location-mcp
```

Or install globally:
```bash
npm install -g android-mock-location-mcp
```

### 2. Configure Your MCP Client

<details>
<summary><b>Claude Desktop</b></summary>

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

To use a different provider (see [Provider Configuration](#provider-configuration)):

```json
{
  "mcpServers": {
    "android-mock-location-mcp": {
      "command": "npx",
      "args": ["-y", "android-mock-location-mcp"],
      "env": {
        "PROVIDER": "google",
        "GOOGLE_API_KEY": "AIza..."
      }
    }
  }
}
```
</details>

<details>
<summary><b>Cursor</b></summary>

Go to Settings → MCP → Add Server:

```json
{
  "command": "npx",
  "args": ["-y", "android-mock-location-mcp"]
}
```
</details>

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add android-mock-location-mcp -- npx -y android-mock-location-mcp
```
</details>

### 3. Install the Android Agent

**Option A: Download APK** (easiest)

Download the latest APK from [Releases](https://github.com/user/android-mock-location-mcp/releases) and install:
```bash
adb install -r android-mock-location-mcp-agent.apk
```

**Option B: Build from source**

```bash
cd android
./gradlew installDebug
```

### 4. Enable Mock Location

1. Enable **Developer Options** on your device (tap Build Number 7 times)
2. Go to **Settings → Developer Options → Select mock location app**
3. Choose **GeoMCP Agent**
4. Open the app and tap **Start Service**

See [android/README.md](android/README.md) for detailed setup and troubleshooting.

### 5. Use It

In your MCP client:

```
> List Android devices
> Connect to emulator-5554
> Set location to Times Square New York
> Drive from here to SFO airport at 60 km/h
```

## Available Tools

| Tool | Description |
|------|-------------|
| `geo_set_location` | Set to coordinates or place name |
| `geo_simulate_route` | Move along a route at specified speed (supports car/foot/bike profiles) |
| `geo_simulate_jitter` | Simulate GPS noise (urban canyon, drift) |
| `geo_test_geofence` | Test geofence entry/exit/bounce |
| `geo_stop` | Stop any active simulation |
| `geo_get_status` | Current mock location status |
| `geo_list_devices` | List connected Android devices |
| `geo_connect_device` | Connect to specific device |

For full parameter reference, see [server/README.md](server/README.md#tool-reference).

## Provider Configuration

Geocoding and routing use a configurable provider, set via the `PROVIDER` environment variable in your MCP client config.

| `PROVIDER` | Geocoding | Routing | Profiles | API Key | Cost |
|------------|-----------|---------|----------|---------|------|
| `osm` (default) | Nominatim | OSRM | `car` only* | None | Free (rate-limited) |
| `google` | Google Geocoding API | Google Routes API | `car`, `foot`, `bike` | `GOOGLE_API_KEY` | Paid (free tier) |
| `mapbox` | Mapbox Geocoding | Mapbox Directions | `car`, `foot`, `bike` | `MAPBOX_ACCESS_TOKEN` | Paid (free tier) |

**\*OSRM limitation:** The public OSRM server only supports the `car` profile. `foot`/`bike` silently return driving routes. Use `google` or `mapbox` for walking/cycling.

For full provider reference, env var details, and how to add a custom provider, see [server/README.md](server/README.md#configuration).

## Examples

```
# Basic location
"Set location to 37.7749, -122.4194"
"Move to Times Square"

# Route simulation
"Drive from SFO to downtown SF at 40 km/h"
"Walk to Whole Foods"
"Simulate a commute with heavy traffic"

# GPS testing
"Simulate bad GPS for 30 seconds"
"Add urban canyon jitter with 50m radius"

# Geofence testing
"Test entering the Starbucks geofence"
"Bounce in and out of a 100m radius 5 times"
```

## Documentation

| Document | Description |
|----------|-------------|
| [Server README](./server/README.md) | Tool reference, provider configuration, development |
| [Android README](./android/README.md) | Build instructions, device setup, troubleshooting |
| [Protocol Spec](./protocol/PROTOCOL.md) | JSON command format |
| [Publishing](./PUBLISHING.md) | npm publish and release workflow |
| [Contributing](./CONTRIBUTING.md) | Development setup |

## Complementary Tools

This server focuses on device location control. For other needs:
- [mobile-mcp](https://github.com/mobile-next/mobile-mcp) — UI automation (tap, swipe, screenshots)
- [MCP-Geo](https://github.com/webcoderz/MCP-Geo) — Geocoding (address → coordinates)

## License

Apache 2.0 — see [LICENSE](./LICENSE)
