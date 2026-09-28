package io.github.theosylvestre.preflight

/** JSON literals written into the scripts run in the page. */
internal object Json {
    fun string(s: String?): String {
        if (s == null) return "null"
        val out = StringBuilder(s.length + 2).append('"')
        for (c in s) {
            when (c) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                // Valid in JSON but not in every JS string, and "</script>" stays harmless.
                ' ', ' ', '<' -> out.append("\\u%04x".format(c.code))
                else -> if (c < ' ') out.append("\\u%04x".format(c.code)) else out.append(c)
            }
        }
        return out.append('"').toString()
    }

    fun array(items: List<String>): String = items.joinToString(",", "[", "]") { string(it) }

    fun obj(vararg entries: Pair<String, String>): String =
        entries.joinToString(",", "{", "}") { (k, v) -> string(k) + ":" + v }
}
