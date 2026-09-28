package io.github.theosylvestre.preflight.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.project.DumbAwareAction
import io.github.theosylvestre.preflight.PreflightEditorProvider
import io.github.theosylvestre.preflight.PreflightFiles

/**
 * "View as Terraform Plan": opens the selected JSON file in Preflight. In context menus, only
 * shown on JSON files; elsewhere (Tools menu, Find Action) asks for a file when none is selected.
 */
class OpenPlanAction : DumbAwareAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
        val isJson = file != null && !file.isDirectory && PreflightFiles.isJsonName(file.name)
        e.presentation.isEnabledAndVisible = e.project != null && (isJson || !e.isFromContextMenu)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val selected = e.getData(CommonDataKeys.VIRTUAL_FILE)?.takeIf { !it.isDirectory && PreflightFiles.isJsonName(it.name) }
        val file = selected ?: FileChooser.chooseFile(
            FileChooserDescriptorFactory.createSingleFileDescriptor("json").withTitle("Open Terraform Plan (JSON)"),
            project,
            null,
        ) ?: return
        PreflightEditorProvider.open(project, file)
    }
}
