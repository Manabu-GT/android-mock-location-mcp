package com.ms.square.geomcpagent.model

import kotlinx.serialization.Serializable

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
  val accuracy: Float? = null,
  val ageMs: Long? = null,
  val active: Boolean? = null,
  val error: String? = null,
)
