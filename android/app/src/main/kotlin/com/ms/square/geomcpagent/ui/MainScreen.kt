package com.ms.square.geomcpagent.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.ms.square.geomcpagent.ServiceState

@Composable
internal fun MainScreen(
  permissionsGranted: Boolean,
  mockLocationAppSelected: Boolean,
  serviceState: ServiceState,
  bound: Boolean,
  onStartService: () -> Unit,
  onStopService: () -> Unit,
  onOpenDevOptions: () -> Unit,
) {
  Scaffold { innerPadding ->
    Column(
      modifier = Modifier
        .fillMaxSize()
        .padding(innerPadding)
        .padding(16.dp)
        .verticalScroll(rememberScrollState()),
      horizontalAlignment = Alignment.CenterHorizontally
    ) {
      Text(
        text = "GeoMCP Agent",
        fontSize = 32.sp,
        fontWeight = FontWeight.Bold,
        color = MaterialTheme.colorScheme.primary
      )
      Spacer(modifier = Modifier.height(32.dp))
      StatusIndicatorCard(bound = bound)
      Spacer(modifier = Modifier.height(16.dp))
      CurrentLocationCard(serviceState = serviceState)
      Spacer(modifier = Modifier.height(16.dp))
      if (!permissionsGranted) {
        PermissionDeniedBanner()
        Spacer(modifier = Modifier.height(16.dp))
      }
      if (!mockLocationAppSelected) {
        MockLocationAppBanner()
        Spacer(modifier = Modifier.height(16.dp))
      }
      Spacer(modifier = Modifier.height(8.dp))
      ServiceControlButtons(
        bound = bound,
        enabled = permissionsGranted && mockLocationAppSelected,
        onStartService = onStartService,
        onStopService = onStopService,
        onOpenDevOptions = onOpenDevOptions
      )
      Spacer(modifier = Modifier.height(32.dp))
      SetupInstructionsCard()
      Spacer(modifier = Modifier.height(16.dp))
    }
  }
}

@Composable
private fun StatusIndicatorCard(bound: Boolean) {
  Card(
    modifier = Modifier.fillMaxWidth(),
    colors = CardDefaults.cardColors(
      containerColor = MaterialTheme.colorScheme.surfaceVariant
    )
  ) {
    Row(
      modifier = Modifier
        .fillMaxWidth()
        .padding(16.dp),
      verticalAlignment = Alignment.CenterVertically
    ) {
      Box(
        modifier = Modifier
          .size(16.dp)
          .background(
            color = if (bound) Color.Green else Color.Red,
            shape = CircleShape
          )
          .semantics {
            contentDescription = if (bound) "Service is running" else "Service is stopped"
          }
      )
      Spacer(modifier = Modifier.width(12.dp))
      Text(
        text = if (bound) "Running" else "Stopped",
        fontSize = 20.sp,
        fontWeight = FontWeight.SemiBold
      )
    }
  }
}

@Composable
private fun CurrentLocationCard(serviceState: ServiceState) {
  Card(
    modifier = Modifier.fillMaxWidth(),
    colors = CardDefaults.cardColors(
      containerColor = MaterialTheme.colorScheme.surfaceVariant
    )
  ) {
    Column(
      modifier = Modifier
        .fillMaxWidth()
        .padding(16.dp)
    ) {
      Text(
        text = "Current Location",
        fontSize = 16.sp,
        fontWeight = FontWeight.SemiBold
      )
      Spacer(modifier = Modifier.height(8.dp))
      if (serviceState.isMocking) {
        Text(
          text = "Lat: %.6f".format(serviceState.lat),
          fontSize = 14.sp,
          fontFamily = FontFamily.Monospace
        )
        Text(
          text = "Lng: %.6f".format(serviceState.lng),
          fontSize = 14.sp,
          fontFamily = FontFamily.Monospace
        )
      } else {
        Text(
          text = "No location set",
          fontSize = 14.sp,
          color = MaterialTheme.colorScheme.onSurfaceVariant
        )
      }
    }
  }
}

@Composable
private fun PermissionDeniedBanner() {
  Card(
    modifier = Modifier.fillMaxWidth(),
    colors = CardDefaults.cardColors(
      containerColor = MaterialTheme.colorScheme.errorContainer
    )
  ) {
    Text(
      text = "Location permissions are required to mock device location. Please grant permissions to continue.",
      fontSize = 14.sp,
      color = MaterialTheme.colorScheme.onErrorContainer,
      modifier = Modifier.padding(16.dp)
    )
  }
}

@Composable
private fun MockLocationAppBanner() {
  Card(
    modifier = Modifier.fillMaxWidth(),
    colors = CardDefaults.cardColors(
      containerColor = MaterialTheme.colorScheme.tertiaryContainer
    )
  ) {
    Text(
      text = "Make sure this app is selected as mock location app in Developer Options.",
      fontSize = 14.sp,
      color = MaterialTheme.colorScheme.onTertiaryContainer,
      modifier = Modifier.padding(16.dp)
    )
  }
}

@Composable
private fun ServiceControlButtons(
  bound: Boolean,
  enabled: Boolean,
  onStartService: () -> Unit,
  onStopService: () -> Unit,
  onOpenDevOptions: () -> Unit,
) {
  Button(
    onClick = { if (bound) onStopService() else onStartService() },
    modifier = Modifier
      .fillMaxWidth()
      .height(56.dp),
    enabled = enabled,
    colors = ButtonDefaults.buttonColors(
      containerColor = if (bound) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    )
  ) {
    Text(
      text = if (bound) "Stop Service" else "Start Service",
      fontSize = 18.sp,
      fontWeight = FontWeight.SemiBold
    )
  }
  Spacer(modifier = Modifier.height(12.dp))
  OutlinedButton(
    onClick = onOpenDevOptions,
    modifier = Modifier
      .fillMaxWidth()
      .height(56.dp)
  ) {
    Text(
      text = "Open Developer Options",
      fontSize = 16.sp
    )
  }
}

@Composable
private fun SetupInstructionsCard() {
  Card(
    modifier = Modifier.fillMaxWidth(),
    colors = CardDefaults.cardColors(
      containerColor = MaterialTheme.colorScheme.surfaceVariant
    )
  ) {
    Column(
      modifier = Modifier
        .fillMaxWidth()
        .padding(16.dp)
    ) {
      Text(
        text = "Setup Instructions",
        fontSize = 18.sp,
        fontWeight = FontWeight.Bold
      )
      Spacer(modifier = Modifier.height(12.dp))
      Text(text = "1. Enable Developer Options on your device", fontSize = 14.sp)
      Text(text = "2. Select this app as mock location app", fontSize = 14.sp)
      Text(text = "3. Start the service using the button above", fontSize = 14.sp)
      Text(
        text = "4. Run: adb forward tcp:5005 tcp:5005",
        fontSize = 14.sp,
        fontFamily = FontFamily.Monospace
      )
    }
  }
}
