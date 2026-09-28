package io.github.theosylvestre.preflight

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Rules of the JetBrains Marketplace on plugin.xml, checked before an upload fails. */
class PluginDescriptorTest {
    private val descriptor = javaClass.getResourceAsStream("/META-INF/plugin.xml")!!.use { it.readBytes().toString(Charsets.UTF_8) }

    @Test
    fun `name only uses the characters the Marketplace accepts`() {
        val name = Regex("<name>(.*)</name>").find(descriptor)?.groupValues?.get(1)
        assertNotNull(name)
        // Letters, digits, spaces and .,+_-/:()#'&[]| (no em dash, no quotes…).
        assertTrue("Invalid Marketplace name: $name", Regex("""[\p{L}\p{N} .,+_\-/:()#'&\[\]|]+""").matches(name!!))
    }
}
