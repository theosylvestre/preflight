package io.github.theosylvestre.preflight

import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Files
import java.nio.file.attribute.FileTime

class LayoutCacheTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun cache(max: Int = 200) = LayoutCache(tmp.root.toPath().resolve("layouts"), max)

    @Test
    fun `saved layouts are loaded back by key, as one JSON object`() {
        val c = cache()
        c.save("vertical-v1-abc-12\n{\"xy\":[[\"a\",{\"x\":1}]],\"clusters\":[],\"routes\":[]}")
        assertEquals("""{"vertical-v1-abc-12":{"xy":[["a",{"x":1}]],"clusters":[],"routes":[]}}""", c.load("vertical-v1-abc-12,force-v1-missing-1"))
        assertEquals("{}", c.load(""))
    }

    @Test
    fun `keys that are not file-name safe and non-object payloads are ignored`() {
        val c = cache()
        c.save("../escape\n{}")
        c.save("UPPER\n{}")
        c.save("ok-1\nnot json")
        c.save("no-line-break")
        assertEquals(emptyList<String>(), c.fileNames())
        assertEquals("{}", c.load("../escape,../../etc/passwd"))
    }

    @Test
    fun `a truncated file is skipped`() {
        val c = cache()
        c.save("a-1\n{}")
        Files.writeString(tmp.root.toPath().resolve("layouts/a-1.json"), "{ trunc")
        assertEquals("{}", c.load("a-1"))
    }

    @Test
    fun `the least recently used layouts go beyond the limit`() {
        val c = cache(max = 2)
        val dir = tmp.root.toPath().resolve("layouts")
        listOf("a-1", "b-1", "c-1").forEachIndexed { i, key ->
            c.save("$key\n{\"i\":$i}")
            Files.setLastModifiedTime(dir.resolve("$key.json"), FileTime.fromMillis(System.currentTimeMillis() - (10 - i) * 60_000L))
        }
        c.load("a-1") // used: now the most recent
        c.prune()
        assertEquals(listOf("a-1.json", "c-1.json"), c.fileNames())
    }
}
