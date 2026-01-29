package com.ms.square.geomcpagent

import com.ms.square.geomcpagent.model.AgentRequest
import com.ms.square.geomcpagent.model.AgentResponse
import com.ms.square.geomcpagent.util.Logger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket

internal class AgentSocketServer(
  private val port: Int,
  private val scope: CoroutineScope,
  private val commandHandler: (AgentRequest) -> AgentResponse,
) {

  private val json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = false
  }

  private val _connected = MutableStateFlow(false)
  val connected: StateFlow<Boolean> = _connected.asStateFlow()

  @Volatile private var serverSocket: ServerSocket? = null

  @Volatile private var clientSocket: Socket? = null

  fun start() {
    scope.launch {
      try {
        serverSocket = ServerSocket().apply {
          reuseAddress = true
          bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 1)
        }

        while (true) {
          val socket = serverSocket?.accept() ?: break
          handleClient(socket)
        }
      } catch (e: IOException) {
        Logger.w("Socket server error", e)
      }
    }
  }

  fun stop() {
    try {
      clientSocket?.close()
    } catch (e: IOException) {
      Logger.w("Failed to close client socket", e)
    }
    clientSocket = null
    try {
      serverSocket?.close()
    } catch (e: IOException) {
      Logger.w("Failed to close server socket", e)
    }
    serverSocket = null
    _connected.value = false
  }

  private fun handleClient(socket: Socket) {
    try {
      clientSocket = socket
      _connected.value = true

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
      Logger.w("Client handler error", e)
    } finally {
      _connected.value = false
      clientSocket = null
    }
  }

  @Suppress("TooGenericExceptionCaught") // Intentional fault boundary to keep connection alive
  private fun processCommand(jsonLine: String): String = try {
    val request = json.decodeFromString<AgentRequest>(jsonLine)
    val response = try {
      commandHandler(request)
    } catch (e: RuntimeException) {
      Logger.w("Failed to handle request", e)
      AgentResponse(id = request.id, success = false, error = "Failed to handle request: ${e.message}")
    }
    json.encodeToString(response)
  } catch (e: SerializationException) {
    Logger.w("Failed to parse request", e)
    json.encodeToString(
      AgentResponse(id = null, success = false, error = "Failed to parse request: ${e.message}")
    )
  }
}
