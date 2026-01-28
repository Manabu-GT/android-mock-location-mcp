package com.ms.square.geomcpagent

import android.Manifest
import android.app.AppOpsManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Process
import android.provider.Settings
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ms.square.geomcpagent.ui.MainScreen

private const val LOGTAG = "MainActivity"

class MainActivity : ComponentActivity() {

  private var permissionsGranted by mutableStateOf(false)
  private var mockLocationAppSelected by mutableStateOf(false)
  private var service: MockLocationService? by mutableStateOf(null)
  private var bound by mutableStateOf(false)

  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName, binder: IBinder) {
      service = (binder as MockLocationService.LocalBinder).service
      bound = true
    }

    override fun onServiceDisconnected(name: ComponentName) {
      service = null
      bound = false
    }
  }

  private val locationPermissions = setOf(
    Manifest.permission.ACCESS_FINE_LOCATION,
    Manifest.permission.ACCESS_COARSE_LOCATION
  )

  private val permissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestMultiplePermissions()
  ) { permissions ->
    // Only location permissions are required; notifications are optional
    permissionsGranted = locationPermissions.all { permissions[it] == true }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()

    checkPermissions()
    if (!permissionsGranted) {
      requestPermissions()
    }

    setContent {
      val serviceState by service?.state?.collectAsStateWithLifecycle()
        ?: remember { mutableStateOf(ServiceState()) }

      MaterialTheme {
        Surface(
          modifier = Modifier.fillMaxSize(),
          color = MaterialTheme.colorScheme.background
        ) {
          MainScreen(
            permissionsGranted = permissionsGranted,
            mockLocationAppSelected = mockLocationAppSelected,
            serviceState = serviceState,
            bound = bound,
            onStartService = { startMockService() },
            onStopService = { stopMockService() },
            onOpenDevOptions = { openDeveloperOptions() }
          )
        }
      }
    }
  }

  override fun onStart() {
    super.onStart()
    // Re-check in case user granted via Settings or selected mock location app
    checkPermissions()
    checkMockLocationAppSelected()
    // Try to bind — succeeds only if service is already running (flag 0 = don't auto-create)
    bindService(Intent(this, MockLocationService::class.java), connection, 0)
  }

  override fun onStop() {
    super.onStop()
    if (bound) {
      unbindService(connection)
      service = null
      bound = false
    }
  }

  private fun checkPermissions() {
    permissionsGranted = locationPermissions.all {
      ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
    }
  }

  private fun checkMockLocationAppSelected() {
    val appOps = getSystemService(AppOpsManager::class.java)
    val mode = appOps.checkOpNoThrow(
      AppOpsManager.OPSTR_MOCK_LOCATION,
      Process.myUid(),
      packageName
    )
    mockLocationAppSelected = mode == AppOpsManager.MODE_ALLOWED
  }

  private fun requestPermissions() {
    val permissions = buildList {
      add(Manifest.permission.ACCESS_FINE_LOCATION)
      add(Manifest.permission.ACCESS_COARSE_LOCATION)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        add(Manifest.permission.POST_NOTIFICATIONS)
      }
    }
    permissionLauncher.launch(permissions.toTypedArray())
  }

  private fun startMockService() {
    if (!permissionsGranted) return

    val intent = Intent(this, MockLocationService::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      startForegroundService(intent)
    } else {
      startService(intent)
    }
    // Bind to get the service reference
    bindService(intent, connection, Context.BIND_AUTO_CREATE)
  }

  private fun stopMockService() {
    if (bound) {
      unbindService(connection)
      service = null
      bound = false
    }
    stopService(Intent(this, MockLocationService::class.java))
  }

  private fun openDeveloperOptions() {
    try {
      startActivity(Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS))
    } catch (_: ActivityNotFoundException) {
      try {
        startActivity(Intent(Settings.ACTION_SETTINGS))
      } catch (ex: ActivityNotFoundException) {
        // Device doesn't support settings intent
        Log.e(LOGTAG, "Device doesn't support settings intent", ex)
      }
    }
  }
}
