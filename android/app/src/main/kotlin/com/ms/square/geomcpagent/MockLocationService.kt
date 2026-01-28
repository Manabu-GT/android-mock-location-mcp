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
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.coroutines.cancellation.CancellationException

@Serializable
internal data class AgentRequest(
  val id: String? = null,
  val type: String,
  val lat: Double = 0.0,
  val lng: Double = 0.0,
  val accuracy: Double = 3.0,
  val altitude: Double = 0.0,
  val speed: Double = 0.0,
  val bearing: Double = 0.0,
)

@Serializable
internal data class AgentResponse(
  val id: String?,
  val success: Boolean,
  val lat: Double? = null,
  val lng: Double? = null,
  val active: Boolean? = null,
  val error: String? = null,
)

internal data class ServiceState(
  val isRunning: Boolean = false,
  val isMocking: Boolean = false,
  val lat: Double = 0.0,
  val lng: Double = 0.0,
)

private data class MockLocation(
  val lat: Double,
  val lng: Double,
  val accuracy: Double,
  val altitude: Double,
  val speed: Double,
  val bearing: Double,
)

class MockLocationService : Service() {

  inner class LocalBinder : Binder() {
    val service: MockLocationService get() = this@MockLocationService
  }

  companion object {
    private const val TAG = "MockLocationService"
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
  }

  private val binder = LocalBinder()
  private val _state = MutableStateFlow(ServiceState())

  internal val state: StateFlow<ServiceState> = _state.asStateFlow()

  private val json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = false
  }
  private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

  private fun errorResponse(id: String?, message: String, e: Throwable): String {
    Log.w(TAG, message, e)
    return json.encodeToString(
      AgentResponse(id = id, success = false, error = "$message: ${e.message}")
    )
  }

  @Volatile private var serverSocket: ServerSocket? = null

  @Volatile private var clientSocket: Socket? = null
  private var locationEmitJob: Job? = null
  private lateinit var locationManager: LocationManager
  private lateinit var notificationManager: NotificationManager

  override fun onCreate() {
    super.onCreate()

    locationManager = getSystemService(LocationManager::class.java)
    notificationManager = getSystemService(NotificationManager::class.java)

    createNotificationChannel()
    setupMockLocationProvider()
    startSocketServer()

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
    super.onDestroy()

    _state.update { ServiceState() }

    // Cancel coroutines first to avoid exception noise from closed sockets
    serviceScope.cancel()
    clientSocket?.close()
    serverSocket?.close()
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
      // Provider already exists, that's fine
      Log.w(TAG, "Mock location provider already exists", e)
    }

    try {
      locationManager.setTestProviderEnabled(PROVIDER_NAME, true)
    } catch (e: SecurityException) {
      Log.w(TAG, "Failed to enable test provider", e)
    } catch (e: IllegalArgumentException) {
      Log.w(TAG, "Failed to enable test provider", e)
    }
  }

  private fun removeMockLocationProvider() {
    try {
      locationManager.removeTestProvider(PROVIDER_NAME)
    } catch (e: SecurityException) {
      Log.w(TAG, "Failed to remove test provider", e)
    } catch (e: IllegalArgumentException) {
      // Provider might not exist, that's fine
      Log.w(TAG, "Failed to remove test provider", e)
    }
  }

  private fun startSocketServer() {
    serviceScope.launch {
      try {
        serverSocket = ServerSocket(PORT, 1, InetAddress.getByName("127.0.0.1"))

        while (true) {
          val socket = serverSocket?.accept() ?: break
          handleClient(socket)
        }
      } catch (e: IOException) {
        // Server socket closed or error, service is likely stopping
        Log.w(TAG, "Socket server error", e)
      }
    }
  }

  private fun handleClient(socket: Socket) {
    try {
      clientSocket = socket
      socket.soTimeout = 0 // No timeout — MCP server may be idle between commands

      socket.use { client ->
        val reader = BufferedReader(InputStreamReader(client.getInputStream()))
        val writer = BufferedWriter(OutputStreamWriter(client.getOutputStream()))

        while (true) {
          val line = reader.readLine() ?: break

          val response = processCommand(line)
          writer.write(response)
          writer.newLine()
          writer.flush()
        }
      }
    } catch (e: IOException) {
      // Client disconnected or error
      Log.w(TAG, "Client handler error", e)
    } finally {
      // Client disconnected — mock location remains active in LocationManager
      updateNotification(
        if (_state.value.isMocking) {
          "Location: %.6f, %.6f".format(_state.value.lat, _state.value.lng)
        } else {
          "Waiting for connection"
        }
      )
      clientSocket = null
    }
  }

  private fun processCommand(jsonLine: String): String = try {
    val request = json.decodeFromString<AgentRequest>(jsonLine)

    when (request.type) {
      "set_location" -> handleSetLocation(request)
      "stop" -> handleStop(request)
      "status" -> handleStatus(request)
      else -> json.encodeToString(
        AgentResponse(
          id = request.id,
          success = false,
          error = "unknown command type: ${request.type}"
        )
      )
    }
  } catch (e: SerializationException) {
    errorResponse(null, "Failed to parse request", e)
  }

  private fun handleSetLocation(request: AgentRequest): String {
    return try {
      // Validate coordinates
      if (request.lat < MIN_LATITUDE || request.lat > MAX_LATITUDE) {
        return json.encodeToString(
          AgentResponse(
            id = request.id,
            success = false,
            error = "Invalid latitude: ${request.lat}. Must be between $MIN_LATITUDE and $MAX_LATITUDE."
          )
        )
      }

      if (request.lng < MIN_LONGITUDE || request.lng > MAX_LONGITUDE) {
        return json.encodeToString(
          AgentResponse(
            id = request.id,
            success = false,
            error = "Invalid longitude: ${request.lng}. Must be between $MIN_LONGITUDE and $MAX_LONGITUDE."
          )
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

      // Set location once immediately
      emitMockLocation(mockLocation)

      _state.update { it.copy(isMocking = true, lat = request.lat, lng = request.lng) }
      updateNotification("Location: %.6f, %.6f".format(request.lat, request.lng))

      // Start continuous emission so Fused Location Provider picks it up
      startLocationEmitLoop(mockLocation)

      json.encodeToString(
        AgentResponse(
          id = request.id,
          success = true,
          lat = request.lat,
          lng = request.lng
        )
      )
    } catch (e: SecurityException) {
      errorResponse(request.id, "Failed to set location", e)
    } catch (e: IllegalArgumentException) {
      errorResponse(request.id, "Failed to set location", e)
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
        Log.e(TAG, "Location emit loop failed", e)
        _state.update { it.copy(isMocking = false, lat = 0.0, lng = 0.0) }
        updateNotification("Mock location error")
      }
    }
  }

  private fun handleStop(request: AgentRequest): String {
    try {
      locationEmitJob?.cancel()
      locationEmitJob = null

      _state.update { it.copy(isMocking = false, lat = 0.0, lng = 0.0) }

      // Remove and re-setup provider to stop emitting mock locations
      removeMockLocationProvider()
      setupMockLocationProvider()

      updateNotification("Waiting for connection")

      return json.encodeToString(
        AgentResponse(
          id = request.id,
          success = true
        )
      )
    } catch (e: SecurityException) {
      return errorResponse(request.id, "Failed to stop", e)
    } catch (e: IllegalArgumentException) {
      return errorResponse(request.id, "Failed to stop", e)
    }
  }

  private fun handleStatus(request: AgentRequest): String {
    val current = _state.value
    return json.encodeToString(
      AgentResponse(
        id = request.id,
        success = true,
        active = current.isMocking,
        lat = if (current.isMocking) current.lat else null,
        lng = if (current.isMocking) current.lng else null
      )
    )
  }
}
