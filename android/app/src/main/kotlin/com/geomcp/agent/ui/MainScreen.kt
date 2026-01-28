package com.geomcp.agent.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.geomcp.agent.ServiceState

@Composable
internal fun MainScreen(
    permissionsGranted: Boolean,
    mockLocationAppSelected: Boolean,
    serviceState: ServiceState,
    bound: Boolean,
    onStartService: () -> Unit,
    onStopService: () -> Unit,
    onOpenDevOptions: () -> Unit
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
            // Title
            Text(
                text = "GeoMCP Agent",
                fontSize = 32.sp,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary
            )

            Spacer(modifier = Modifier.height(32.dp))

            // Status Indicator
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

            Spacer(modifier = Modifier.height(16.dp))

            // Current Coordinates
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

            Spacer(modifier = Modifier.height(16.dp))

            // Permission denied message
            if (!permissionsGranted) {
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

                Spacer(modifier = Modifier.height(16.dp))
            }

            // Informational banner — hide once app is selected as mock location provider
            if (!mockLocationAppSelected) {
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

                Spacer(modifier = Modifier.height(16.dp))
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Control Buttons
            Button(
                onClick = { if (bound) onStopService() else onStartService() },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
                enabled = permissionsGranted && mockLocationAppSelected,
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

            Spacer(modifier = Modifier.height(32.dp))

            // Setup Instructions
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

            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}
