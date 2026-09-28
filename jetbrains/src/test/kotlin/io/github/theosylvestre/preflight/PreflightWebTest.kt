package io.github.theosylvestre.preflight

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The page packaged from ../core (webResources task) and how it is served. */
class PreflightWebTest {
    @Test
    fun `shared page, scripts and icons are packaged`() {
        for (path in listOf("media/viewer.html", "media/viewer.js", "media/graphLayout.js", "media/graph.js", "media/viewer.css", "media/logo-dark.svg", "preflight-core.js", "jetbrains-host.js")) {
            assertNotNull("$path missing", PreflightWeb.resource(path))
        }
        val core = PreflightWeb.resource("preflight-core.js")!!.toString(Charsets.UTF_8)
        val icon = Regex("aws-icons/[^\"]+/Arch_AWS-Lambda_64\\.svg").find(core)?.value
        assertNotNull("icon index missing from the core bundle", icon)
        assertNotNull("$icon missing", PreflightWeb.resource("media/$icon"))
    }

    @Test
    fun `plugin icon is packaged`() {
        val icon = javaClass.getResourceAsStream("/META-INF/pluginIcon.svg")?.use { it.readBytes().toString(Charsets.UTF_8) }
        assertNotNull(icon)
        assertTrue(icon!!.contains("""width="40" height="40""""))
    }

    @Test
    fun `page loads the bridge before the viewer, under a nonce CSP`() {
        val page = PreflightWeb.page(nonce = "N0nce")
        assertFalse("unfilled placeholder", page.contains("{{"))
        assertTrue(page.contains("script-src 'nonce-N0nce'"))
        assertTrue(page.contains("connect-src ${PreflightWeb.ORIGIN}"))
        val order = listOf("preflight-core.js", "jetbrains-host.js", "media/graphLayout.js", "media/graph.js", "media/viewer.js").map { page.indexOf("${PreflightWeb.ORIGIN}/$it") }
        assertTrue("scripts out of order: $order", order.all { it >= 0 } && order == order.sorted())
        assertEquals(5, Regex("""<script nonce="N0nce" src=""").findAll(page).count())
    }

    @Test
    fun `urls map to packaged paths only`() {
        assertEquals("media/viewer.css", PreflightWeb.pathOf("${PreflightWeb.ORIGIN}/media/viewer.css?v=1"))
        assertEquals(PreflightWeb.SOURCE_PATH, PreflightWeb.pathOf("${PreflightWeb.ORIGIN}/__source?n=3"))
        assertNull(PreflightWeb.pathOf("https://example.com/media/viewer.css"))
        assertNull(PreflightWeb.resource("../META-INF/plugin.xml"))
        assertNull(PreflightWeb.resource("media/../../META-INF/plugin.xml"))
        assertNull(PreflightWeb.resource(""))
        assertNull(PreflightWeb.resource("media/missing.js"))
    }

    @Test
    fun `mime types`() {
        assertEquals("text/javascript", PreflightWeb.mimeOf("media/viewer.js"))
        assertEquals("image/svg+xml", PreflightWeb.mimeOf("media/aws-icons/a/b.SVG"))
        assertEquals("application/octet-stream", PreflightWeb.mimeOf("__source"))
    }
}
