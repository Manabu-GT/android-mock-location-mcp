package com.ms.square.geomcpagent

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Criteria
import android.location.Location
import android.location.LocationManager
import android.location.provider.ProviderProperties
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import com.ms.square.geomcpagent.model.AgentRequest
import com.ms.square.geomcpagent.model.AgentResponse
import com.ms.square.geomcpagent.model.MockLocation
import com.ms.square.geomcpagent.model.ServiceState
import com.ms.square.geomcpagent.util.Logger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException

private const val NOTIFICATION_ID = 1
private const val CHANNEL_ID = "geo_mcp_channel"
private const val CHANNEL_NAME = "GeoMCP Agent"
private const val PROVIDER_NAME = LocationManager.GPS_PROVIDER
private const val PORT = 5005
private const val MIN_LATITUDE = -90.0
private const val MAX_LATITUDE = 90.0
private const val MIN_LONGITUDE = -180.0
private const val MAX_LONGITUDE = 180.0
private const val LOCATION_UPDATE_INTERVAL_MS = 1_000L

class MockLocationService : Service() {

  inner class LocalBinder : Binder() {
    // Return this instance of MockLocationService so clients can call public/internal methods
    val service: MockLocationService get() = this@MockLocationService
  }

  private val binder = LocalBinder()
  private val _state = MutableStateFlow(ServiceState())

  internal val state: StateFlow<ServiceState> = _state.asStateFlow()

  private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
  private lateinit var socketServer: AgentSocketServer
  private lateinit var locationManager: LocationManager
  private lateinit var notificationManager: NotificationManager

  private var locationEmitJob: Job? = null

  override fun onCreate() {
    locationManager = getSystemService(LocationManager::class.java)
    notificationManager = getSystemService(NotificationManager::class.java)

    createNotificationChannel()
    setupMockLocationProvider()

    socketServer = AgentSocketServer(
      port = PORT,
      scope = serviceScope,
      commandHandler = ::processCommand
    )
    socketServer.start()

    socketServer.connected.onEach { connected ->
      updateNotification(
        when {
          connected -> "Client connected"
          _state.value.isMocking ->
            "Location: %.6f, %.6f".format(_state.value.lat, _state.value.lng)

          else -> "Waiting for connection"
        }
      )
    }.launchIn(serviceScope)

    _state.update { it.copy(isRunning = true) }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = buildNotification("Waiting for connection")

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }

    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder = binder

  override fun onDestroy() {
    _state.update { ServiceState() }
    socketServer.stop()
    serviceScope.cancel()
    removeMockLocationProvider()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        CHANNEL_NAME,
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "GeoMCP Agent Service"
      }
      notificationManager.createNotificationChannel(channel)
    }
  }

  private fun buildNotification(text: String): Notification = NotificationCompat.Builder(this, CHANNEL_ID)
    .setContentTitle("GeoMCP Agent")
    .setContentText(text)
    .setSmallIcon(android.R.drawable.ic_menu_mylocation)
    .setPriority(NotificationCompat.PRIORITY_LOW)
    .build()

  private fun updateNotification(text: String) {
    val notification = buildNotification(text)
    notificationManager.notify(NOTIFICATION_ID, notification)
  }

  private fun setupMockLocationProvider() {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        locationManager.addTestProvider(
          PROVIDER_NAME,
          ProviderProperties.Builder()
            .setHasAltitudeSupport(true)
            .setHasSpeedSupport(true)
            .setHasBearingSupport(true)
            .setPowerUsage(ProviderProperties.POWER_USAGE_LOW)
            .setAccuracy(ProviderProperties.ACCURACY_FINE)
            .build()
        )
      } else {
        @SuppressLint("WrongConstant")
        @Suppress("DEPRECATION")
        locationManager.addTestProvider(
          PROVIDER_NAME,
          false,
          false,
          false,
          false,
          true,
          true,
          true,
          Criteria.POWER_LOW,
          Criteria.ACCURACY_FINE
        )
      }
    } catch (e: IllegalArgumentException) {
      Logger.w("Mock location provider already exists", e)
    }

    try {
      locationManager.setTestProviderEnabled(PROVIDER_NAME, true)
    } catch (e: SecurityException) {
      Logger.w("Failed to enable test provider", e)
    } catch (e: IllegalArgumentException) {
      Logger.w("Failed to enable test provider", e)
    }
  }

  private fun removeMockLocationProvider() {
    try {
      locationManager.removeTestProvider(PROVIDER_NAME)
    } catch (e: SecurityException) {
      Logger.w("Failed to remove test provider", e)
    } catch (e: IllegalArgumentException) {
      Logger.w("Failed to remove test provider", e)
    }
  }

  private fun processCommand(request: AgentRequest): AgentResponse = when (request.type) {
    "set_location" -> handleSetLocation(request)
    "stop" -> handleStop(request)
    "status" -> handleStatus(request)
    else -> AgentResponse(
      id = request.id,
      success = false,
      error = "unknown command type: ${request.type}"
    )
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

      _state.update { it.copy(isMocking = true, lat = request.lat, lng = request.lng) }
      updateNotification("Location: %.6f, %.6f".format(request.lat, request.lng))

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
    locationEmitJob?.cancel()
    locationEmitJob = serviceScope.launch {
      try {
        while (true) {
          delay(LOCATION_UPDATE_INTERVAL_MS)
          emitMockLocation(mock)
        }
      } catch (e: CancellationException) {
        throw e
      } catch (e: SecurityException) {
        Logger.e("Location emit loop failed", e)
        _state.update { it.copy(isMocking = false, lat = 0.0, lng = 0.0) }
        updateNotification("Mock location error")
      }
    }
  }

  private fun handleStop(request: AgentRequest): AgentResponse = try {
    locationEmitJob?.cancel()
    locationEmitJob = null

    _state.update { it.copy(isMocking = false, lat = 0.0, lng = 0.0) }

    removeMockLocationProvider()
    setupMockLocationProvider()

    updateNotification("Waiting for connection")

    AgentResponse(id = request.id, success = true)
  } catch (e: SecurityException) {
    Logger.w("Failed to stop", e)
    AgentResponse(id = request.id, success = false, error = "Failed to stop: ${e.message}")
  } catch (e: IllegalArgumentException) {
    Logger.w("Failed to stop", e)
    AgentResponse(id = request.id, success = false, error = "Failed to stop: ${e.message}")
  }

  private fun handleStatus(request: AgentRequest): AgentResponse {
    val current = _state.value
    return AgentResponse(
      id = request.id,
      success = true,
      active = current.isMocking,
      lat = if (current.isMocking) current.lat else null,
      lng = if (current.isMocking) current.lng else null
    )
  }
}
