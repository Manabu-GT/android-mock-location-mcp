#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# test-route.sh
#
# Demo script for testing the Android mock location agent directly over TCP
# using adb port forwarding and netcat. No MCP server required.
#
# Prerequisites:
#   1. Android device/emulator connected via adb
#   2. GeoMCP Agent app installed and foreground service running
#   3. Device selected as mock location app in Developer Options
#   4. bc (arbitrary-precision calculator) installed
#
# Note: This script opens a new TCP connection per command (netcat limitation).
# A production client would hold a single persistent connection instead.
# The agent must re-accept between each command, so rapid-fire sequences may
# miss responses if the agent's accept loop is slow.
#
# Usage:
#   ./examples/test-route.sh
# =============================================================================

echo "=== Android Mock Location Agent - Direct Test ==="
echo ""

# --- Set up adb port forwarding ---
echo "Setting up adb port forwarding (tcp:5005 -> tcp:5005)..."
adb forward tcp:5005 tcp:5005
echo "Port forwarding established."
echo ""

# --- Command counter for request IDs ---
CMD_ID=0

# --- Helper: send a JSON command to the agent and print the response ---
send_command() {
  local json="$1"
  CMD_ID=$((CMD_ID + 1))

  # Inject the "id" field into the JSON payload.
  # We insert it right after the opening brace.
  local payload
  payload=$(echo "$json" | sed "s/^{/{\"id\":\"test-${CMD_ID}\",/")

  echo "  -> Sending: $payload"
  local response
  response=$(echo "$payload" | nc -w 2 localhost 5005 2>/dev/null || true)
  if [ -z "$response" ]; then
    echo "  <- (no response or connection failed)"
  else
    echo "  <- Response: $response"
  fi
  echo ""
}

# =====================
# Demo Sequence
# =====================

# 1. Check agent status
echo "[Step 1] Checking agent status..."
send_command '{"type":"status"}'

# 2. Set location to Uber HQ
echo "[Step 2] Setting location to Uber HQ (37.7749, -122.4194)..."
send_command '{"type":"set_location","lat":37.7749,"lng":-122.4194,"accuracy":3.0}'

sleep 2

# 3. Check status after setting location
echo "[Step 3] Checking status after location set..."
send_command '{"type":"status"}'

# 4. Simulate a short walking route heading north from Uber HQ
#    5 waypoints, ~0.001 lat increment per step (~111 meters),
#    walking pace ~3.0 m/s, bearing ~0 degrees (north)
echo "[Step 4] Simulating walking route (5 steps heading north)..."
echo "  Route: 37.7749 -> 37.7789 latitude, longitude fixed at -122.4194"
echo "  Pace:  ~3.0 m/s (walking), bearing ~0 degrees (north)"
echo ""

BASE_LAT=37.7749
LNG=-122.4194
STEP=0.001

for i in 1 2 3 4 5; do
  # Compute current latitude: base + (step * i)
  CURRENT_LAT=$(echo "$BASE_LAT + $STEP * $i" | bc -l)

  echo "  [Waypoint $i/5] lat=${CURRENT_LAT}, lng=${LNG}"
  send_command "{\"type\":\"set_location\",\"lat\":${CURRENT_LAT},\"lng\":${LNG},\"accuracy\":3.0,\"speed\":3.0,\"bearing\":0}"

  if [ "$i" -lt 5 ]; then
    sleep 1
  fi
done

# 5. Check final status
echo "[Step 5] Checking final status..."
send_command '{"type":"status"}'

# 6. Stop mock location
echo "[Step 6] Stopping mock location..."
send_command '{"type":"stop"}'

echo "=== Test complete ==="
