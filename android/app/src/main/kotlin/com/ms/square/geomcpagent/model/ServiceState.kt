package com.ms.square.geomcpagent.model

internal data class ServiceState(
  val isRunning: Boolean = false,
  val isMocking: Boolean = false,
  val lat: Double = 0.0,
  val lng: Double = 0.0,
)
