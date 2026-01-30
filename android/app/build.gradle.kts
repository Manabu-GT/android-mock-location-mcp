plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.compose)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "com.ms.square.geomcpagent"
  compileSdk = libs.versions.androidCompileSdk.get().toInt()

  defaultConfig {
    applicationId = "com.ms.square.geomcpagent"
    minSdk = libs.versions.androidMinSdk.get().toInt()
    targetSdk = libs.versions.androidTargetSdk.get().toInt()
    versionName = "0.1.0"
    // Derives versionCode from versionName: major*10000 + minor*100 + patch
    // Assumes minor and patch stay below 100; pre-release suffixes are stripped
    versionCode = versionName?.let { name ->
      val parts = name.substringBefore("-").split(".")
      require(parts.size == 3) { "versionName must be X.Y.Z format, got: $name" }
      (parts[0].toInt() * 10000 + parts[1].toInt() * 100 + parts[2].toInt()).coerceAtLeast(1)
    } ?: error("versionName must be set")
  }

  signingConfigs {
    val keystorePath = System.getenv("SIGNING_KEYSTORE_PATH")
    if (keystorePath != null) {
      create("release") {
        storeFile = file(keystorePath)
        storePassword = System.getenv("SIGNING_KEYSTORE_PASSWORD")
        keyAlias = System.getenv("SIGNING_KEY_ALIAS")
        keyPassword = System.getenv("SIGNING_KEY_PASSWORD")
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      proguardFiles(
        getDefaultProguardFile("proguard-android-optimize.txt"),
        "proguard-rules.pro"
      )
      signingConfigs.findByName("release")?.let { signingConfig = it }
    }
  }

  buildFeatures {
    compose = true
  }

  kotlin {
    jvmToolchain(21)
  }
}

dependencies {
  implementation(platform(libs.androidx.compose.bom))
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.material3)
  implementation(libs.androidx.compose.ui.tooling.preview)
  implementation(libs.material)
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.kotlinx.coroutines.android)
  implementation(libs.kotlinx.serialization.json)
  debugImplementation(libs.androidx.compose.ui.tooling)
}
