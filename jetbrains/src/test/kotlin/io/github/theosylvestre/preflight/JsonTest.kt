package io.github.theosylvestre.preflight

import org.junit.Assert.assertEquals
import org.junit.Test

class JsonTest {
    @Test
    fun `strings are escaped for a script`() {
        assertEquals("\"a\\\"b\\\\c\\nd\\te\"", Json.string("a\"b\\c\nd\te"))
        assertEquals("\"\\u003c/script>\"", Json.string("</script>"))
        assertEquals("\"\\u2028\\u0001\"", Json.string("\u2028\u0001"))
        assertEquals("\"é ✓\"", Json.string("é ✓"))
        assertEquals("null", Json.string(null))
    }

    @Test
    fun `arrays and objects`() {
        assertEquals("""["a","b"]""", Json.array(listOf("a", "b")))
        assertEquals("[]", Json.array(emptyList()))
        assertEquals("""{"path":["x"],"n":null}""", Json.obj("path" to Json.array(listOf("x")), "n" to Json.string(null)))
    }
}
