package io.github.theosylvestre.preflight

import com.intellij.openapi.application.PathManager
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.FileTime
import java.util.concurrent.atomic.AtomicInteger
import kotlin.io.path.extension
import kotlin.io.path.listDirectoryEntries
import kotlin.io.path.name

/**
 * Graph layouts computed by the viewer, kept between sessions so that the graph of a plan
 * already seen shows at once: one JSON file per layout (the page's own JSON, stored as is),
 * the least recently used removed beyond [maxFiles].
 */
class LayoutCache(private val dir: Path, private val maxFiles: Int = 200) {
    private val saves = AtomicInteger()

    /** Layouts found among the comma-separated [keys], as a JSON object by key. */
    fun load(keys: String): String {
        val entries = keys.split(',').filter { KEY.matches(it) }.distinct().mapNotNull { key ->
            val file = dir.resolve("$key.json")
            try {
                val json = Files.readString(file).trim()
                if (!json.startsWith("{") || !json.endsWith("}")) return@mapNotNull null
                Files.setLastModifiedTime(file, FileTime.fromMillis(System.currentTimeMillis()))
                Json.string(key) + ":" + json
            } catch (_: IOException) {
                null
            }
        }
        return entries.joinToString(",", "{", "}")
    }

    /** [payload]: the key, a line break, then the layout's JSON. */
    fun save(payload: String) {
        val key = payload.substringBefore('\n')
        val json = payload.substringAfter('\n', "").trim()
        if (!KEY.matches(key) || !json.startsWith("{") || !json.endsWith("}")) return
        try {
            Files.createDirectories(dir)
            val tmp = Files.createTempFile(dir, key, ".tmp")
            Files.writeString(tmp, json)
            Files.move(tmp, dir.resolve("$key.json"), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
            if (saves.incrementAndGet() % 10 == 1) prune()
        } catch (_: IOException) {
            // The cache is only a shortcut.
        }
    }

    /** Removes the least recently used layouts beyond [maxFiles]. */
    fun prune() {
        val files = try {
            dir.listDirectoryEntries().filter { it.extension == "json" }
        } catch (_: IOException) {
            return
        }
        if (files.size <= maxFiles) return
        files.sortedByDescending { runCatching { Files.getLastModifiedTime(it).toMillis() }.getOrDefault(0L) }
            .drop(maxFiles)
            .forEach { runCatching { Files.deleteIfExists(it) } }
    }

    internal fun fileNames(): List<String> = runCatching { dir.listDirectoryEntries().map { it.name }.sorted() }.getOrDefault(emptyList())

    companion object {
        // Keys come from the page (graphLayout.js layoutKey): checked before being used as file names.
        private val KEY = Regex("[a-z0-9-]{1,120}")

        /** The cache of the IDE, in its system directory. */
        val shared: LayoutCache by lazy { LayoutCache(Path.of(PathManager.getSystemPath(), "preflight", "layouts")) }
    }
}
