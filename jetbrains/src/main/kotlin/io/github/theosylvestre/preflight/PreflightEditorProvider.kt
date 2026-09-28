package io.github.theosylvestre.preflight

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.VirtualFile

/**
 * Adds a "Preflight" tab after the text editor of Terraform states and of the JSON files that
 * look like `terraform show -json` output, or of any file opened with [open].
 */
class PreflightEditorProvider : FileEditorProvider, DumbAware {
    override fun accept(project: Project, file: VirtualFile): Boolean =
        file.getUserData(FORCED) == true || PreflightFiles.isPreflightFile(file)

    override fun acceptRequiresReadAction(): Boolean = false

    override fun createEditor(project: Project, file: VirtualFile): FileEditor = PreflightFileEditor(project, file)

    override fun getEditorTypeId(): String = EDITOR_TYPE_ID

    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.PLACE_AFTER_DEFAULT_EDITOR

    companion object {
        const val EDITOR_TYPE_ID = "preflight.planViewer"

        /** Set on a file the user asked to view in Preflight, whatever its content. */
        private val FORCED = Key.create<Boolean>("preflight.forced")

        /** Opens [file] and selects its Preflight tab. */
        fun open(project: Project, file: VirtualFile) {
            val manager = FileEditorManager.getInstance(project)
            if (file.getUserData(FORCED) != true && !PreflightFiles.isPreflightFile(file)) {
                file.putUserData(FORCED, true)
                // Already open without the Preflight tab: reopened so that providers are asked again.
                if (manager.isFileOpen(file)) manager.closeFile(file)
            }
            manager.openFile(file, true)
            manager.setSelectedEditor(file, EDITOR_TYPE_ID)
        }
    }
}
