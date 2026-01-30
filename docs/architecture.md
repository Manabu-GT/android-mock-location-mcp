# Device Connection Architecture

How the MCP server connects to the Android agent and handles disconnects/reconnects.

## Overall Architecture

```
 MCP Client (e.g. Claude Desktop)
      |
      |  stdio (stdin/stdout pipes, JSON-RPC)
      v
 +---------------------------------------------+
 |  index.ts  -- MCP Server                    |
 |  8 geo_* tools (Zod schemas)                |
 |  Simulation timer (setInterval)             |
 +------+--------------------------------------+
        |  connectToDevice() / sendCommand()
        v
 +---------------------------------------------+
 |  device.ts  -- Connection State Machine     |
 |  TCP socket to agent on localhost:5005      |
 |  Pending request map (UUID -> Promise)      |
 +------+-------------------+------------------+
        |                   |
        | TCP socket        | event callbacks
        v                   v
 +--------------+   +--------------------------+
 | adb forward  |   |  adb-tracker.ts          |
 | tcp:5005     |   |  ADB track-devices       |
 | tcp:5005     |   |  on port 5037            |
 +--------------+   +--------------------------+
        |                   |
        v                   v
 +---------------------------------------------+
 |  Android Device (via USB/WiFi ADB)          |
 |  GeoMCP Agent app -- TCP server on :5005    |
 +---------------------------------------------+
```

The MCP client spawns the server as a child process and communicates over
stdin/stdout pipes (not TCP). The server then uses `adb forward` to tunnel
a TCP connection through USB to the Android agent's socket server.

## State Machine

`device.ts` manages a 4-state connection state machine:

```
                    connectToDevice(id)
                    (user-initiated)
                          |
                          v
  +--------------+   +-----------+     TCP handshake     +-----------+
  | disconnected |-->|connecting | ---- succeeds ------->| connected |
  +--------------+   +-----------+                       +-----------+
        ^                 |                                    |
        |                 | socket close                       | socket close
        |                 | (before connect)                   | (after connect)
        |                 v                                    v
        |            +--------------------+             +--------------------+
        |            | waiting_for_device |             | waiting_for_device |
        |            | (no retry timer)   |             | (retry in 1s +     |
        |            +--------+-----------+             |  tracker check)    |
        |                     |                         +--------+-----------+
        |                     |                                  |
        |                     +----------+-----------------------+
        |                                |
        |                                v
        |                      +-------------------+
        |                      | retry timer fires |
        |                      | OR tracker sees   |--> transitionToConnecting()
        |                      | device available  |         |
        |                      +-------------------+         v
        |                                             back to "connecting"
        |
        +---- shutdownDevice() from any state
```

### State Invariants

| State               | `socket`           | `connectedDeviceId` | `targetDeviceId` |
|---------------------|--------------------|---------------------|------------------|
| `disconnected`      | null               | null                | null             |
| `connecting`        | exists (not null)  | null                | set              |
| `connected`         | live, not destroyed| set                 | set              |
| `waiting_for_device`| null               | null                | set              |

Key rule: `connecting` **always** has a socket. Socket close transitions to
`waiting_for_device` (never directly to `connecting`), so there is no window
where `state === "connecting"` with no socket.

## Connection Flow (Happy Path)

```
  index.ts                    device.ts                    Android Device
     |                            |                             |
     |  await connectToDevice()   |                             |
     |--------------------------->|                             |
     |                            |                             |
     |                   clearAllTimers()                       |
     |                   initDevice() (start tracker)           |
     |                            |                             |
     |                   transitionToConnecting():              |
     |                     1. destroyExistingSocket()           |
     |                     2. execFileSync("adb forward ...")   |
     |                     3. socket = new Socket()             |
     |                     4. state = "connecting"              |
     |                     5. sock.connect(localhost:5005)      |
     |                            |                             |
     |                            |-------- TCP SYN ---------->|
     |                            |<------- TCP SYN-ACK -------|
     |                            |                             |
     |                   on("connect"):                         |
     |                     state = "connected"                  |
     |                     connectedDeviceId = deviceId         |
     |                            |                             |
     |  Promise resolves          |                             |
     |<---------------------------|                             |
     |                            |                             |
     |  await sendCommand(...)    |                             |
     |--------------------------->|                             |
     |                   write JSON + "\n"                      |
     |                            |----- {"id":"uuid",...} ---->|
     |                            |<---- {"id":"uuid",...} -----|
     |                   on("data"):                            |
     |                     match id -> resolve pending          |
     |  Promise resolves          |                             |
     |<---------------------------|                             |
```

## Auto-Reconnect Flow (USB Disconnect/Reconnect)

Two independent mechanisms cooperate to restore the connection:

1. **Retry timer** (1s) -- one-shot quick retry after a connected socket closes
2. **ADB tracker** -- event-driven, fires when ADB server reports device state change

```
  device.ts                adb-tracker.ts            ADB Server (:5037)
     |                          |                         |
  [state=connected]             |                         |
     |                          |                         |
  === USB cable unplugged ===   |                         |
     |                          |                         |
  on("close"):                  |                         |
    rejectAllPending()          |                         |
    notifyDisconnect()          |                         |
    state = "waiting_for_device"|                         |
    scheduleRetry() [1s]        |                         |
    checkTrackerForDevice()     |                         |
     |                          |                         |
     |        [1s retry fires, ADB forward fails]         |
     |        state stays "waiting_for_device"            |
     |        checkTrackerForDevice() -- not "device" yet |
     |                          |                         |
  === USB cable plugged back in ===                       |
     |                          |                         |
     |                          |<-- device list update --|
     |                          |                         |
     |                     processDeviceList():           |
     |                       diff -> "device" (new)       |
     |  handleTrackerEvent()    |                         |
     |<---- event: "device" ----|                         |
     |                          |                         |
  scheduleTrackerReconnect()    |                         |
     | [1s timer]               |                         |
     v                          |                         |
  transitionToConnecting()      |                         |
    adb forward ...             |                         |
    socket.connect()            |                         |
     |                          |                         |
  on("connect"):                |                         |
    state = "connected"         |                         |
     |                          |                         |
  [auto-reconnected!]           |                         |
```

### Timer Deduplication

Both timers compete from `waiting_for_device`. The first to fire wins because
`transitionToConnecting()` synchronously calls `clearAllTimers()`, cancelling
the other:

```
  waiting_for_device
     |
     |--> retryTimer (1s)                trackerReconnectTimer (1s)
     |    One-shot quick retry           Event-driven from ADB server
     |         |                                |
     |         v                                v
     |    transitionToConnecting()         transitionToConnecting()
     |         |                                |
     |         |    (first one wins -- both call clearAllTimers()
     |         |     at the top of transitionToConnecting,
     |         |     cancelling the other)
     |         v
     |    state = "connecting"   <-- synchronous, prevents double-entry
```

## The "Null Before Destroy" Pattern

Prevents the close handler of an old socket from corrupting the state machine:

```
  transitionToConnecting() / destroyExistingSocket():

    socket --> [old Socket A]        state = "connected"
                    |
    Step 1:  socket = null           (break the reference)
    Step 2:  old.destroy()           (triggers close event)
                    |
                    v
    Socket A's close handler fires:
      if (socket !== sock) return    <-- socket is null, sock is A
                                         null !== A -> early return!
                                         (stale socket guard works)

    Step 3:  socket = new Socket B
    Step 4:  state = "connecting"
```

Without null-before-destroy, `socket` would still point to A when A's close
handler fires synchronously from `destroy()`, and the guard `socket !== sock`
would be `A !== A -> false`, letting the old handler corrupt state.

## ADB Tracker (`adb-tracker.ts`)

Maintains a persistent connection to the local ADB server's `track-devices`
protocol to receive real-time device attach/detach notifications:

```
  adb-tracker.ts                              ADB Server (localhost:5037)
       |                                            |
       |---- connect TCP 5037 -------------------->|
       |---- "0012host:track-devices" ------------>|
       |<--- "OKAY" -------------------------------|
       |                                            |
       |<--- "0023emulator-5554\tdevice\n..." ------|  (initial snapshot)
       |                                            |
       |     processDeviceList():                   |
       |       diff old vs new -> emit events       |
       |                                            |
       |<--- "0023emulator-5554\tdevice\n..." ------|  (on any change)
       |                                            |
       |     ... repeats for lifetime ...           |
       |                                            |
       |  [ADB server restarts]                     |
       |<--- close --------------------------------|
       |                                            |
       |  handleGone():                             |
       |    scheduleRetry() -> 5s                   |
       |         |                                  |
       |    [5s later]                              |
       |    connectToAdb():                         |
       |      knownDevices.clear()                  |
       |      connect TCP 5037 ...                  |
```

The tracker silently reconnects on failure and runs for the entire process
lifetime. `device.ts` reads the tracker's known device state via
`getKnownDeviceState()` to prevent stuck-state scenarios where the tracker
event was consumed before the state machine entered `waiting_for_device`.

## Command Protocol

Communication with the Android agent uses newline-delimited JSON with UUID
request/response matching:

```
  Server                              Android Agent
     |                                     |
     |  {"id":"abc-123","type":"set_location","lat":35.6,...}\n
     |---------------------------------------------------->|
     |                                     |
     |  {"id":"abc-123","success":true}\n  |
     |<----------------------------------------------------|
```

Each command gets a `setTimeout` (5s). If the agent doesn't respond in time,
the pending promise rejects. If the socket closes, all pending requests are
bulk-rejected via `rejectAllPending()`.

## Key Internal Helpers

| Helper | Purpose |
|---|---|
| `destroyExistingSocket()` | Null-before-destroy pattern to safely discard old socket |
| `rejectAllPending(reason)` | Bulk-reject all in-flight commands |
| `notifyDisconnect()` | Safely invoke disconnect callback (try/catch) |
| `clearAllTimers()` | Cancel both retry and tracker-reconnect timers |
| `checkTrackerForDevice()` | Prevent stuck-state by querying tracker's known devices |

## Shutdown

`SIGTERM`/`SIGINT` triggers `gracefulShutdown()` in `index.ts`:

```
gracefulShutdown()
  |-> stopSimulation()       -- clear setInterval
  |-> shutdownDevice()       -- clearAllTimers, destroyExistingSocket,
  |                             rejectAllPending, stopTracking
  |-> process.exit(0)
```
