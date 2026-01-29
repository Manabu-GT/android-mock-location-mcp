package com.ms.square.geomcpagent.util

import android.util.Log

internal object Logger {

  private const val TAG = "[GeoMCP]"

  fun e(message: String, throwable: Throwable) {
    Log.e(TAG, message, throwable)
  }

  fun w(message: String, throwable: Throwable? = null) {
    Log.w(TAG, message, throwable)
  }

  fun i(message: String) {
    Log.i(TAG, message)
  }

  fun d(message: String) {
    Log.d(TAG, message)
  }
}
