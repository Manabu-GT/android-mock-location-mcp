package com.ms.square.geomcpagent

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.location.Criteria
import android.location.LocationManager
import android.location.provider.ProviderProperties
import android.os.Binder
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.ms.square.geomcpagent.model.ServiceState
import com.ms.square.geomcpagent.util.Logger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.update

private const val NOTIFICATION_ID = 1
private const val CHANNEL_ID = "geo_mcp_channel"
private const val CHANNEL_NAME = "GeoMCP Agent"
private const val PROVIDER_NAME = LocationManager.GPS_PROVIDER
private const val PORT = 5005
private const val ACTION_STOP_MOCKING = "com.ms.square.geomcpagent.STOP_MOCKING"

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
  private lateinit var commandHandler: MockLocationCommandHandler

  /** Handles the "Stop Mocking" notification action. */
  private val stopMockingReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.action == ACTION_STOP_MOCKING) {
        Logger.i("Stop mocking requested via notification action")
        commandHandler.stopMocking()
        // Close the client connection so the MCP server's simulation timer is also stopped.
        // The server will auto-reconnect, but the simulation won't resume.
        socketServer.disconnectClient()
      }
    }
  }

  override fun onCreate() {
    locationManager = getSystemService(LocationManager::class.java)
    notificationManager = getSystemService(NotificationManager::class.java)

    createNotificationChannel()
    setupMockLocationProvider()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(stopMockingReceiver, IntentFilter(ACTION_STOP_MOCKING), RECEIVER_NOT_EXPORTED)
    } else {
      registerReceiver(stopMockingReceiver, IntentFilter(ACTION_STOP_MOCKING))
    }

    commandHandler = MockLocationCommandHandler(
      context = this,
      locationManager = locationManager,
      state = _state,
      scope = serviceScope,
      onNotificationUpdate = ::updateNotification,
      onResetMockProvider = {
        removeMockLocationProvider()
        setupMockLocationProvider()
      }
    )

    socketServer = AgentSocketServer(
      port = PORT,
      scope = serviceScope,
      commandHandler = commandHandler::processCommand
    )
    socketServer.start()

    socketServer.connected.onEach { connected ->
      if (!connected && _state.value.isMocking) {
        Logger.i("Client disconnected, stopping mock location")
        commandHandler.stopMocking()
      }
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
    try {
      unregisterReceiver(stopMockingReceiver)
    } catch (_: IllegalArgumentException) {
      // if the receiver was not previously registered or already unregistered.
    }
    socketServer.stop()
    commandHandler.cancelEmitLoop()
    serviceScope.cancel()
    removeMockLocationProvider()
  }

  private fun createNotificationChannel() {
    val channel = NotificationChannel(
      CHANNEL_ID,
      CHANNEL_NAME,
      NotificationManager.IMPORTANCE_LOW
    ).apply {
      description = "GeoMCP Agent Service"
    }
    notificationManager.createNotificationChannel(channel)
  }

  private fun buildNotification(text: String, showStopAction: Boolean = false): Notification {
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("GeoMCP Agent")
      .setContentText(text)
      .setSmallIcon(android.R.drawable.ic_menu_mylocation)
      .setPriority(NotificationCompat.PRIORITY_LOW)

    if (showStopAction) {
      val stopIntent = PendingIntent.getBroadcast(
        this, 0,
        Intent(ACTION_STOP_MOCKING).setPackage(packageName),
        PendingIntent.FLAG_IMMUTABLE
      )
      builder.addAction(
        android.R.drawable.ic_media_pause,
        "Stop Mocking",
        stopIntent
      )
    }

    return builder.build()
  }

  private fun updateNotification(text: String) {
    val isMocking = _state.value.isMocking
    val notification = buildNotification(text, showStopAction = isMocking)
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
    } catch (e: SecurityException) {
      Logger.w("MOCK_LOCATION permission is not granted", e)
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
}
