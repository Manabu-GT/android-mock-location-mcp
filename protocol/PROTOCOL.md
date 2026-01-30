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

## Implementation Notes

- The Android agent sets mock locations via `LocationManager.setTestProviderLocation()`. The device must have **Developer Options** enabled and the agent selected as the **mock location app**.
- All optional location fields (`altitude`, `speed`, `bearing`) are passed through to the Android `Location` object so that downstream apps receive realistic GPS traces.
- The server should implement a reasonable read timeout (e.g., 5 seconds) per request. If no response arrives, it should treat the request as failed and log an error.
