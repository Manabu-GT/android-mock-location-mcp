import io.gitlab.arturbosch.detekt.extensions.DetektExtension

plugins {
  alias(libs.plugins.android.application) apply false
  alias(libs.plugins.kotlin.android) apply false
  alias(libs.plugins.kotlin.compose) apply false
  alias(libs.plugins.kotlin.serialization) apply false
  alias(libs.plugins.detekt) apply false
  alias(libs.plugins.spotless)
}

// Merge all subproject SARIF reports into one file for GitHub Code Scanning
val reportMerge by tasks.registering(io.gitlab.arturbosch.detekt.report.ReportMergeTask::class) {
  output.set(rootProject.layout.buildDirectory.file("reports/detekt/merge.sarif"))
}

subprojects {
  // Apply detekt to any Kotlin module
  plugins.withId("org.jetbrains.kotlin.android") {
    apply(plugin = "io.gitlab.arturbosch.detekt")
  }

  // Configure Detekt where applied
  plugins.withId("io.gitlab.arturbosch.detekt") {
    extensions.configure<DetektExtension> {
      buildUponDefaultConfig = true
      allRules = false
      config.from(rootProject.files("config/detekt/detekt.yml"))
      basePath = rootProject.projectDir.absolutePath
      source.setFrom(files("src/main/java", "src/main/kotlin"))
    }

    tasks.withType<io.gitlab.arturbosch.detekt.Detekt>().configureEach {
      reports {
        xml.required.set(true)
        html.required.set(true)
        txt.required.set(false)
        sarif.required.set(true)
        md.required.set(false)
      }
      reportMerge.configure {
        input.from(sarifReportFile)
        mustRunAfter(this@configureEach)
      }
    }
  }

  // Hook spotlessCheck + detekt into `check` task
  plugins.withId("com.android.application") {
    pluginManager.withPlugin("io.gitlab.arturbosch.detekt") {
      tasks.named("check").configure { dependsOn("detekt") }
    }
    pluginManager.withPlugin("com.diffplug.spotless") {
      tasks.named("check").configure { dependsOn("spotlessCheck") }
    }
  }
}

// Spotless config from external script
apply(from = "$rootDir/gradle/scripts/code-formatting.gradle")
