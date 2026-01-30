package com.ms.square.geomcpagent

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.SystemClock
import androidx.core.content.ContextCompat
import com.ms.square.geomcpagent.model.AgentRequest
import com.ms.square.geomcpagent.model.AgentResponse
import com.ms.square.geomcpagent.model.MockLocation
import com.ms.square.geomcpagent.model.ServiceState
import com.ms.square.geomcpagent.util.Logger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit
import kotlin.coroutines.cancellation.CancellationException

private const val PROVIDER_NAME = LocationManager.GPS_PROVIDER
private const val MIN_LATITUDE = -90.0
private const val MAX_LATITUDE = 90.0
private const val MIN_LONGITUDE = -180.0
private const val MAX_LONGITUDE = 180.0
private const val LOCATION_UPDATE_INTERVAL_MS = 1_000L
private const val IDLE_TIMEOUT_MS = 10 * 60 * 1_000L // 10 minutes

internal class MockLocationCommandHandler(
  private val context: Context,
  private val locationManager: LocationManager,
  private val state: MutableStateFlow<ServiceState>,
  private val scope: CoroutineScope,
  private val onNotificationUpdate: (String) -> Unit,
  private val onResetMockProvider: () -> Unit,
) {

  private var locationEmitJob: Job? = null
  @Volatile private var lastCommandReceivedAt: Long = SystemClock.elapsedRealtime()

  fun processCommand(request: AgentRequest): AgentResponse {
    lastCommandReceivedAt = SystemClock.elapsedRealtime()
    return dispatchCommand(request)
  }

  private fun dispatchCommand(request: AgentRequest): AgentResponse = when (request.type) {
    "set_location" -> handleSetLocation(request)
    "stop" -> handleStop(request)
    "status" -> handleStatus(request)
    "get_location" -> handleGetLocation(request)
    else -> AgentResponse(
      id = request.id,
      success = false,
      error = "unknown command type: ${request.type}"
    )
  }

  fun cancelEmitLoop() {
    locationEmitJob?.cancel()
    locationEmitJob = null
  }

  /** Stop mocking (called from notification action or idle timeout). */
  fun stopMocking() {
    try {
      cancelEmitLoop()
      state.update { it.copy(isMocking = false, lat = 0.0, lng = 0.0) }
      onResetMockProvider()
      onNotificationUpdate("Waiting for connection")
    } catch (e: Exception) {
      Logger.w("Failed to stop mocking", e)
    }
  }

  private fun handleSetLocation(request: AgentRequest): AgentResponse {
    return try {
      if (request.lat !in MIN_LATITUDE..MAX_LATITUDE) {
        return AgentResponse(
          id = request.id,
          success = false,
          error = "Invalid latitude: ${request.lat}. Must be between $MIN_LATITUDE and $MAX_LATITUDE."
        )
      }

      if (request.lng !in MIN_LONGITUDE..MAX_LONGITUDE) {
        return AgentResponse(
          id = request.id,
          success = false,
          error = "Invalid longitude: ${request.lng}. Must be between $MIN_LONGITUDE and $MAX_LONGITUDE."
        )
      }

      val mockLocation = MockLocation(
        lat = request.lat,
        lng = request.lng,
        accuracy = request.accuracy,
        altitude = request.altitude,
        speed = request.speed,
        bearing = request.bearing
      )

      emitMockLocation(mockLocation)

      state.update { it.copy(isMocking = true, lat = request.lat, lng = request.lng) }
      onNotificationUpdate("Location: %.6f, %.6f".format(request.lat, request.lng))

      startLocationEmitLoop(mockLocation)

      AgentResponse(
        id = request.id,
        success = true,
        lat = request.lat,
        lng = request.lng
      )
    } catch (e: SecurityException) {
      Logger.w("Failed to set location", e)
      AgentResponse(id = request.id, success = false, error = "Failed to set location: ${e.message}")
    } catch (e: IllegalArgumentException) {
      Logger.w("Failed to set location", e)
      AgentResponse(id = request.id, success = false, error = "Failed to set location: ${e.message}")
    }
  }

  private fun emitMockLocation(mock: MockLocation) {
    val location = Location(PROVIDER_NAME).apply {
      latitude = mock.lat
      longitude = mock.lng
      accuracy = mock.accuracy.toFloat()
      altitude = mock.altitude
      speed = mock.speed.toFloat()
      bearing = mock.bearing.toFloat()
      time = System.currentTimeMillis()
      elapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
    }
    locationManager.setTestProviderLocation(PROVIDER_NAME, location)
  }

  private fun startLocationEmitLoop(mock: MockLocation) {
    cancelEmitLoop()
    locationEmitJob = scope.launch {
      try {
        while (true) {
          delay(LOCATION_UPDATE_INTERVAL_MS)
          // Auto-stop if no command received within idle timeout
          if (SystemClock.elapsedRealtime() - lastCommandReceivedAt > IDLE_TIMEOUT_MS) {
            Logger.i("Idle timeout reached (${IDLE_TIMEOUT_MS / 1000}s), auto-stopping mock location")
            stopMocking()
            return@launch
          }
          emitMockLocation(mock)
        }
      } catch (e: CancellationException) {
        throw e
      } catch (e: SecurityException) {
        Logger.e("Location emit loop failed", e)
        state.update { it.copy(isMocking = false, lat = 0.0, lng = 0.0) }
        onNotificationUpdate("Mock location error")
      } catch (e: IllegalArgumentException) {
        Logger.e("Location emit loop failed", e)
        state.update { it.copy(isMocking = false, lat = 0.0, lng = 0.0) }
        onNotificationUpdate("Mock location error")
      }
    }
  }

  private fun handleStop(request: AgentRequest): AgentResponse = try {
    cancelEmitLoop()

    state.update { it.copy(isMocking = false, lat = 0.0, lng = 0.0) }

    onResetMockProvider()

    onNotificationUpdate("Waiting for connection")

    AgentResponse(id = request.id, success = true)
  } catch (e: SecurityException) {
    Logger.w("Failed to stop", e)
    AgentResponse(id = request.id, success = false, error = "Failed to stop: ${e.message}")
  } catch (e: IllegalArgumentException) {
    Logger.w("Failed to stop", e)
    AgentResponse(id = request.id, success = false, error = "Failed to stop: ${e.message}")
  }

  private fun handleStatus(request: AgentRequest): AgentResponse {
    val current = state.value
    return AgentResponse(
      id = request.id,
      success = true,
      active = current.isMocking,
      lat = if (current.isMocking) current.lat else null,
      lng = if (current.isMocking) current.lng else null
    )
  }

  private fun handleGetLocation(request: AgentRequest): AgentResponse {
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
      != PackageManager.PERMISSION_GRANTED
    ) {
      return AgentResponse(
        id = request.id,
        success = false,
        error = "Location permission (ACCESS_FINE_LOCATION) not granted."
      )
    }

    // When mocking is active, getLastKnownLocation returns the injected mock fix,
    // not the device's real position. Refuse the request so callers don't mistake
    // mocked coordinates for the real GPS location.
    if (state.value.isMocking) {
      return AgentResponse(
        id = request.id,
        success = false,
        error = "Cannot get real location while mock location is active. " +
          "Call stop first, or use the current mock position from the status command."
      )
    }
    return try {
      // Try GPS provider first, then network provider as fallback
      val location =
        locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER)
          ?: locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)

      if (location != null) {
        val ageMs =
          maxOf(0L, TimeUnit.NANOSECONDS.toMillis(SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos))
        AgentResponse(
          id = request.id,
          success = true,
          lat = location.latitude,
          lng = location.longitude,
          accuracy = if (location.hasAccuracy()) location.accuracy else null,
          ageMs = ageMs
        )
      } else {
        AgentResponse(
          id = request.id,
          success = false,
          error = "No location available. The device may not have a recent GPS fix. " +
            "Open Google Maps or another location app to establish a fix, then retry."
        )
      }
    } catch (e: SecurityException) {
      Logger.w("Failed to get location", e)
      AgentResponse(
        id = request.id,
        success = false,
        error = "Location permission not granted: ${e.message}"
      )
    }
  }
}
