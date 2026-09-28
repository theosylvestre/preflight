import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.4.20"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

val core = layout.projectDirectory.dir("../core")
val node = providers.gradleProperty("nodeExecutable").get()

kotlin {
    jvmToolchain(21)
    compilerOptions {
        // Kotlin bundled with the oldest supported IDE (2025.1).
        apiVersion = KotlinVersion.KOTLIN_2_1
        languageVersion = KotlinVersion.KOTLIN_2_1
    }
}

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity(providers.gradleProperty("platformVersion"))
    }
}

intellijPlatform {
    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = provider { null }
        }
    }
    signing {
        certificateChain = providers.environmentVariable("CERTIFICATE_CHAIN")
        privateKey = providers.environmentVariable("PRIVATE_KEY")
        password = providers.environmentVariable("PRIVATE_KEY_PASSWORD")
    }
    publishing {
        token = providers.environmentVariable("PUBLISH_TOKEN")
    }
    pluginVerification {
        ides {
            recommended()
        }
    }
}

// --- Viewer page, shared with the VS Code extension (../core) ---------------------------------

val buildCoreBundle by tasks.registering(Exec::class) {
    description = "Builds ../core/dist/preflight-core.js: parsers and view model bundled for the webview."
    workingDir(core)
    commandLine(node, "scripts/build.mjs", "--production")
    inputs.dir(core.dir("src"))
    inputs.dir(core.dir("media/aws-icons"))
    inputs.file(core.file("scripts/build.mjs"))
    outputs.file(core.file("dist/preflight-core.js"))
}

val webResources by tasks.registering(Sync::class) {
    description = "Collects the viewer page of ../core into the plugin resources (/preflight-web)."
    into(layout.buildDirectory.dir("generated/web"))
    into("preflight-web") {
        from(buildCoreBundle)
        into("media") {
            from(core.dir("media")) { exclude("icon.png", "icon.svg") }
        }
    }
    into("META-INF") {
        from(core.file("media/icon.svg")) {
            rename { "pluginIcon.svg" }
            filter { it.replace("""width="256" height="256"""", """width="40" height="40"""") }
        }
    }
}

sourceSets.main {
    resources.srcDir(webResources)
}
