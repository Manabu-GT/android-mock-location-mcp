# Android Agent — GeoMCP Agent

Android app that receives mock location commands from the MCP server and sets them on the device via `LocationManager.setTestProviderLocation()`. Runs as a foreground service with a socket server on port 5005.

See the [root README](../README.md) for project overview and quick start.

## Requirements

- Android device or emulator (minSdk 24 / Android 7.0+)
- compileSdk 36, targetSdk 36
- JVM 21 (Gradle toolchain)

## Build and Install

**Build from source (builds + installs in one step):**
```bash
cd android
./gradlew installDebug
```

**Or build only (APK at `app/build/outputs/apk/debug/app-debug.apk`):**
```bash
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

**Prebuilt APK:** Download from [Releases](https://github.com/user/android-mock-location-mcp/releases) and install with `adb install -r <apk>`.

## Device Setup

1. **Enable Developer Options** — Go to Settings → About Phone → tap "Build Number" 7 times
2. **Select mock location app** — Settings → Developer Options → "Select mock location app" → choose **GeoMCP Agent**
3. **Grant permissions** — Open the app, grant location permissions when prompted
4. **Start the service** — Tap "Start Service" in the app

The app must be running with the service active before connecting from the MCP server.

## ADB Port Forwarding

The MCP server communicates with the agent over TCP port 5005. ADB forwards this port from your machine to the device:

```bash
adb forward tcp:5005 tcp:5005
```

> **Note:** The `geo_connect_device` MCP tool runs this command automatically. You only need to run it manually for direct testing.

**Manual test:**
```bash
echo '{"id":"test","type":"status"}' | nc localhost 5005
```

Expected response: `{"id":"test","success":true,"active":false}`

## Architecture

| Component | File | Purpose |
|-----------|------|---------|
| `MainActivity` | `MainActivity.kt` | Entry point, runtime permission requests |
| `MockLocationService` | `MockLocationService.kt` | Foreground service, TCP socket server, mock location provider |
| `MainScreen` | `ui/MainScreen.kt` | Compose UI with start/stop controls and status display |

### Permissions

| Permission | Purpose |
|------------|---------|
| `ACCESS_FINE_LOCATION` | Required for mock location provider |
| `ACCESS_COARSE_LOCATION` | Required for mock location provider |
| `ACCESS_MOCK_LOCATION` | Allows setting mock locations (requires Developer Options) |
| `FOREGROUND_SERVICE` | Required for foreground service |
| `FOREGROUND_SERVICE_LOCATION` | Location-type foreground service |
| `INTERNET` | TCP socket communication |
| `POST_NOTIFICATIONS` | Foreground service notification (Android 13+) |

## Protocol

The agent accepts newline-delimited JSON commands over TCP:

| Command | Description |
|---------|-------------|
| `set_location` | Set mock GPS to given coordinates |
| `stop` | Stop active mock location |
| `status` | Query current state |

Every request includes an `id` field (UUID); responses echo it back for matching.

Full specification: [protocol/PROTOCOL.md](../protocol/PROTOCOL.md)

## Troubleshooting

**"Mock location not enabled"**
- Go to Settings → Developer Options → "Select mock location app" → choose GeoMCP Agent.
- Developer Options must be enabled first (tap Build Number 7 times in About Phone).

**Location permissions denied**
- Uninstall and reinstall the app, then grant "Allow all the time" when prompted.
- On Android 12+, you may need to grant permissions in Settings → Apps → GeoMCP Agent → Permissions.

**Can't connect from MCP server**
- Ensure the service is running (green status in the app).
- Run `adb forward tcp:5005 tcp:5005` manually.
- Check `adb devices` shows your device.
- Only one TCP client can connect at a time.

**Connection drops during simulation**
- The agent stops mock locations when the TCP connection closes.
- The MCP server auto-reconnects once. If it fails, call `geo_connect_device` again.

**Location not picked up by other apps**
- Verify GeoMCP Agent is selected as mock location app (not just installed).
- Some apps (e.g. Google Maps) may require a restart to pick up mock locations.
- Check that location services are enabled on the device.

**JVM version error during build**
- The project requires JVM 21. Ensure `JAVA_HOME` points to a JDK 21+ installation.
- Android Studio Ladybug+ bundles JDK 21.
