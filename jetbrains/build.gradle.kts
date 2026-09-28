import org.jetbrains.changelog.Changelog
import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.4.20"
    id("org.jetbrains.intellij.platform") version "2.19.0"
    id("org.jetbrains.changelog") version "2.5.0"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

val core = layout.projectDirectory.dir("../core")
// Sandbox IDEs open the sample Terraform project on its plan (tf-test/plan.json, modules…).
val sampleProject = layout.projectDirectory.dir("../tf-test").asFile.absolutePath
val sampleArgs = listOf(sampleProject, "$sampleProject/plan.json")
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
        testFramework(TestFrameworkType.Platform)
    }
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.opentest4j:opentest4j:1.3.0")
}

// The changelog shared with the VS Code extension: the section of this version (or the
// unreleased one) becomes the change notes of the plugin.
changelog {
    path = layout.projectDirectory.file("../CHANGELOG.md").asFile.absolutePath
    repositoryUrl = "https://github.com/theosylvestre/preflight"
}

intellijPlatform {
    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")
        val notes = changelog // captured alone (not the project), for the configuration cache
        changeNotes = providers.gradleProperty("pluginVersion").map { v ->
            notes.renderItem((notes.getOrNull(v) ?: notes.getUnreleased()).withHeader(false).withEmptySections(false), Changelog.OutputType.HTML)
        }
        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = provider { null }
        }
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

// --- Tests and sandbox IDEs -------------------------------------------------------------------

val testWebHost by tasks.registering(Exec::class) {
    description = "Tests jetbrains-host.js, the page side of the bridge, with the Node.js test runner."
    group = LifecycleBasePlugin.VERIFICATION_GROUP
    dependsOn(buildCoreBundle)
    commandLine(node, "--test", "src/test/js/jetbrains-host.test.mjs")
    inputs.file("src/main/resources/preflight-web/jetbrains-host.js")
    inputs.file("src/test/js/jetbrains-host.test.mjs")
    inputs.file(core.file("dist/preflight-core.js"))
    outputs.upToDateWhen { true }
}

tasks.test {
    // No embedded browser in tests: the editor shows its fallback, and no cef_server process
    // outlives the test JVM (the page is tested by testWebHost).
    systemProperty("ide.browser.jcef.enabled", "false")
}

tasks.check {
    dependsOn(testWebHost)
}

tasks.runIde {
    args(sampleArgs)
    systemProperty("idea.trust.all.projects", "true")
    systemProperty("ide.show.tips.on.startup.default.value", "false")
}

intellijPlatformTesting {
    runIde {
        // Same, in PyCharm.
        register("runPyCharm") {
            type = IntelliJPlatformType.PyCharmCommunity
            version = providers.gradleProperty("pycharmVersion")
            task {
                args(sampleArgs)
                systemProperty("idea.trust.all.projects", "true")
                systemProperty("ide.show.tips.on.startup.default.value", "false")
            }
        }
        // Same, in an IDE installed on this machine (-PlocalIde=/Applications/IntelliJ IDEA.app).
        providers.gradleProperty("localIde").orNull?.let { path ->
            register("runLocalIde") {
                localPath = file(path)
                task {
                    args(sampleArgs)
                    systemProperty("idea.trust.all.projects", "true")
                    systemProperty("ide.show.tips.on.startup.default.value", "false")
                }
            }
        }
    }
}
