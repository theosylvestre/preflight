package io.github.theosylvestre.preflight

import java.security.SecureRandom
import java.util.Base64

/**
 * Files of the page, packaged under `/preflight-web` in the plugin jar and served to the
 * browser at [ORIGIN]:
 * - `media/…`: core/media (viewer.html, viewer.js, graph.js, viewer.css, AWS icons…);
 * - `preflight-core.js`: parsers and view model bundled for the browser (core/dist);
 * - `jetbrains-host.js`: bridge between the viewer and the plugin.
 */
object PreflightWeb {
    const val ORIGIN = "https://preflight.local"
    const val PAGE_URL = "$ORIGIN/index.html"
    const val SOURCE_PATH = "__source"
    private const val ROOT = "/preflight-web/"

    private val MIME = mapOf(
        "html" to "text/html",
        "js" to "text/javascript",
        "css" to "text/css",
        "svg" to "image/svg+xml",
        "png" to "image/png",
        "json" to "application/json",
    )

    /** Path of a URL of the page (`https://preflight.local/media/x.svg?n=1` → `media/x.svg`), or null for other origins. */
    fun pathOf(url: String): String? {
        if (!url.startsWith("$ORIGIN/")) return null
        return url.substring(ORIGIN.length + 1).substringBefore('?').substringBefore('#')
    }

    fun mimeOf(path: String): String = MIME[path.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"

    /** A packaged file, or null when missing or outside the web root. */
    fun resource(path: String): ByteArray? {
        if (path.isEmpty() || path.split('/').any { it == ".." || it == "." || it.isEmpty() }) return null
        return PreflightWeb::class.java.getResourceAsStream(ROOT + path)?.use { it.readBytes() }
    }

    /** The page: core/media/viewer.html with the plugin's scripts and content security policy. */
    fun page(nonce: String = nonce()): String {
        val template = resource("media/viewer.html")?.toString(Charsets.UTF_8)
            ?: error("Preflight web resources are missing from the plugin")
        val csp = listOf(
            "default-src 'none'",
            "style-src $ORIGIN 'unsafe-inline' https://fonts.googleapis.com",
            "font-src $ORIGIN https://fonts.gstatic.com",
            "img-src $ORIGIN",
            "connect-src $ORIGIN",
            "script-src 'nonce-$nonce'",
            // Graph layouts are computed in a Web Worker created from a blob (see graph.js).
            "worker-src blob:",
        ).joinToString("; ")
        val scripts = listOf("preflight-core.js", "jetbrains-host.js")
            .joinToString("\n") { """<script nonce="$nonce" src="$ORIGIN/$it"></script>""" }
        val vars = mapOf("csp" to csp, "nonce" to nonce, "media" to "$ORIGIN/media", "scripts" to scripts)
        return Regex("""\{\{(\w+)\}\}""").replace(template) { vars[it.groupValues[1]] ?: it.value }
    }

    private fun nonce(): String = ByteArray(16).also { SecureRandom().nextBytes(it) }.let { Base64.getEncoder().encodeToString(it) }
}
