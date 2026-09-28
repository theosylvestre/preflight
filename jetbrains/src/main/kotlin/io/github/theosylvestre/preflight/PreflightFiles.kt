package io.github.theosylvestre.preflight

import com.intellij.openapi.vfs.VirtualFile
import java.io.IOException

/** Recognises the files Preflight can display. */
object PreflightFiles {
    private const val SNIFF_BYTES = 4096

    /** `terraform.tfstate`, `*.tfstate.backup`. */
    fun isStateName(name: String): Boolean = name.endsWith(".tfstate") || name.endsWith(".tfstate.backup")

    fun isJsonName(name: String): Boolean = name.endsWith(".json", ignoreCase = true)

    /**
     * Output of `terraform show -json` (plan or state: `format_version` then `terraform_version`)
     * or raw state (`terraform_version` and `lineage`), recognised from the first bytes.
     */
    fun looksLikeTerraformJson(head: CharSequence): Boolean {
        val trimmed = head.trimStart()
        if (!trimmed.startsWith("{") || !head.contains("\"terraform_version\"")) return false
        return head.contains("\"format_version\"") || head.contains("\"lineage\"")
    }

    /** Files opened in Preflight without being asked: states, and JSON files that look like a plan / state. */
    fun isPreflightFile(file: VirtualFile): Boolean {
        if (file.isDirectory) return false
        if (isStateName(file.name)) return true
        return isJsonName(file.name) && looksLikeTerraformJson(head(file))
    }

    private fun head(file: VirtualFile): String = try {
        file.inputStream.use { String(it.readNBytes(SNIFF_BYTES), Charsets.UTF_8) }
    } catch (_: IOException) {
        ""
    }
}
