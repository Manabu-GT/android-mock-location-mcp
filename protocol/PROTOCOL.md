# JSON Protocol Specification

Communication protocol between the MCP server (Node.js, developer machine) and the Android agent app (Android device/emulator).

---

## Transport

- **Layer**: TCP socket
- **Port**: 5005
- **Forwarding**: `adb forward tcp:5005 tcp:5005` bridges the developer machine to the Android device
- **Bind address**: The Android agent binds to `127.0.0.1` (loopback only)
- **Framing**: Newline-delimited JSON. Each message is a single JSON object terminated by `\n`

## Request/Response Matching

Every request includes an `"id"` field containing a UUID v4 string. Every response echoes back the same `"id"`. This prevents mismatched replies when the server sends rapid `set_location` commands during active simulations (e.g., route playback at 1 Hz). The server maintains a pending-request map keyed by `id`.

## Connection Model

- The agent accepts **one client connection** at a time
- Commands are processed **sequentially** per connection
- If the TCP connection drops, the agent stops any active mock location and returns to listening

---

## Commands

### 1. `set_location`

Set the device mock GPS to the given coordinates.

**Request**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "set_location",
  "lat": 37.7749,
  "lng": -122.4194,
  "accuracy": 3.0,
  "altitude": 0.0,
  "speed": 0.0,
  "bearing": 0.0
}
```

| Field      | Type   | Required | Default | Description                        |
|------------|--------|----------|---------|------------------------------------|
| `id`       | string | yes      | --      | UUID v4 for request/response match |
| `type`     | string | yes      | --      | Must be `"set_location"`           |
| `lat`      | number | yes      | --      | Latitude in decimal degrees        |
| `lng`      | number | yes      | --      | Longitude in decimal degrees       |
| `accuracy` | number | no       | 3.0     | Horizontal accuracy in meters      |
| `altitude` | number | no       | 0.0     | Altitude in meters above WGS 84   |
| `speed`    | number | no       | 0.0     | Speed in meters per second         |
| `bearing`  | number | no       | 0.0     | Bearing in degrees (0 to 360)      |

**Response**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "success": true,
  "lat": 37.7749,
  "lng": -122.4194
}
```

---

### 2. `stop`

Stop any active mock location.

**Request**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "stop"
}
```

| Field  | Type   | Required | Description                        |
|--------|--------|----------|------------------------------------|
| `id`   | string | yes      | UUID v4 for request/response match |
| `type` | string | yes      | Must be `"stop"`                   |

**Response**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "success": true
}
```

---

### 3. `status`

Query the current state of the agent.

**Request**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "status"
}
```

| Field  | Type   | Required | Description                        |
|--------|--------|----------|------------------------------------|
| `id`   | string | yes      | UUID v4 for request/response match |
| `type` | string | yes      | Must be `"status"`                 |

**Response**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "success": true,
  "active": true,
  "lat": 37.7749,
  "lng": -122.4194
}
```

| Field    | Type    | Present           | Description                              |
|----------|---------|-------------------|------------------------------------------|
| `id`     | string  | always            | Echoed request ID                        |
| `success`| boolean | always            | `true` if the query succeeded            |
| `active` | boolean | on success        | Whether a mock location is currently set |
| `lat`    | number  | when `active=true` | Current mock latitude                    |
| `lng`    | number  | when `active=true` | Current mock longitude                   |

---

### 4. `get_location`

Get the device's real GPS location (last known position from Android's location providers). Tries GPS first, then falls back to the network provider. Returns an error if mock location is currently active, since `getLastKnownLocation()` would return the injected mock fix rather than the real position.

**Request**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "get_location"
}
```

| Field  | Type   | Required | Description                        |
|--------|--------|----------|------------------------------------|
| `id`   | string | yes      | UUID v4 for request/response match |
| `type` | string | yes      | Must be `"get_location"`           |

**Response (success)**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "success": true,
  "lat": 40.0005,
  "lng": -105.235,
  "accuracy": 12.3,
  "ageMs": 4520
}
```

**Response (no location available)**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "success": false,
  "error": "No location available. The device may not have a recent GPS fix. Open Google Maps or another location app to establish a fix, then retry."
}
```

| Field      | Type    | Present             | Description                                   |
|------------|---------|---------------------|-----------------------------------------------|
| `id`       | string  | always              | Echoed request ID                             |
| `success`  | boolean | always              | `true` if a location was found                |
| `lat`      | number  | when `success=true` | Device latitude from last known GPS fix       |
| `lng`      | number  | when `success=true` | Device longitude from last known GPS fix      |
| `accuracy` | number  | when `success=true` | Horizontal accuracy in meters (omitted if unavailable) |
| `ageMs`    | number  | when `success=true` | Milliseconds since the fix was obtained       |
| `error`    | string  | when `success=false`| Human-readable reason location is unavailable |

---

## Error Response

Any command may return an error instead of its normal response.

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "success": false,
  "error": "Mock location provider not enabled. Select this app in Developer Options."
}
```

| Field     | Type    | Description                          |
|-----------|---------|--------------------------------------|
| `id`      | string  | Echoed request ID                    |
| `success` | boolean | Always `false` for errors            |
| `error`   | string  | Human-readable description of the failure |

---

## Edge Cases

- **Missing or malformed `id`**: The agent returns an error response with `"id": null` and `"success": false`.
- **Unknown command `type`**: The agent returns an error response with `"success": false` and an `"error"` string describing the unrecognized type.

## Service Auto-Start

The MCP server can automatically start the agent service via ADB when `geo_connect_device` detects that the service is not running. This eliminates the need for the user to manually open the app and tap "Start Service".

**Mechanism**: The server performs three steps via ADB:

1. **Install check** — verifies the app is present:
```
adb -s <deviceId> shell pm path com.ms.square.geomcpagent
```
If not installed, returns an error with install instructions.

2. **Device setup** — grants permissions and sets the mock location app:
```
adb -s <deviceId> shell pm grant com.ms.square.geomcpagent android.permission.ACCESS_FINE_LOCATION
adb -s <deviceId> shell pm grant com.ms.square.geomcpagent android.permission.ACCESS_COARSE_LOCATION
adb -s <deviceId> shell appops set com.ms.square.geomcpagent android:mock_location allow
```

3. **Service launch** — starts the service directly (no Activity UI):
```
adb -s <deviceId> shell am start-foreground-service -n com.ms.square.geomcpagent/.MockLocationService
```

The service is exported and starts without bringing the app to the foreground.

**Prerequisites** (must be completed once, manually):
1. The app must be installed on the device
2. Developer Options must be enabled (Settings > About Phone > tap Build Number 7 times)

Note: Location permissions and mock location app selection are handled automatically via ADB.

**Flow**:
1. `geo_connect_device` first attempts a direct TCP connection (service may already be running)
2. If the connection fails, checks that the app is installed (returns install instructions if not)
3. Runs device setup (permissions + mock location app) via ADB
4. Starts the foreground service directly via ADB
5. Waits 2 seconds for service initialization, then polls up to 5 times (1 second apart)
6. Returns success if connection is established, or a troubleshooting message if not

## Stopping Mock Location

Mock location can be stopped in three ways:
1. **`stop` command** — sent by the MCP server via `geo_stop`
2. **Client disconnect** — if the TCP connection drops, the agent automatically stops mocking
3. **Notification action** — users can tap "Stop Mocking" in the device's notification shade while mock location is active. This also closes the socket connection, which stops any server-side simulation.

## Implementation Notes

- The Android agent sets mock locations via `LocationManager.setTestProviderLocation()`. The device must have **Developer Options** enabled and the agent selected as the **mock location app**.
- All optional location fields (`altitude`, `speed`, `bearing`) are passed through to the Android `Location` object so that downstream apps receive realistic GPS traces.
- The server should implement a reasonable read timeout (e.g., 5 seconds) per request. If no response arrives, it should treat the request as failed and log an error.
