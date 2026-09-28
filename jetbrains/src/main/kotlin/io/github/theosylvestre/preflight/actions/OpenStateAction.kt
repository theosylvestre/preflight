package io.github.theosylvestre.preflight.actions

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.search.FilenameIndex
import com.intellij.psi.search.GlobalSearchScope
import io.github.theosylvestre.preflight.PreflightEditorProvider
import io.github.theosylvestre.preflight.PreflightFiles
import io.github.theosylvestre.preflight.TerraformShow
import javax.swing.Icon

/**
 * "View as Terraform State": opens the selected state file in Preflight. Without a state
 * selected, offers the states of the project, a file from disk, or the output of
 * `terraform show -json` in a Terraform folder (works with remote backends).
 */
class OpenStateAction : DumbAwareAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
        val isState = file != null && !file.isDirectory && PreflightFiles.isStateName(file.name)
        e.presentation.isEnabledAndVisible = e.project != null && (isState || !e.isFromContextMenu)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val selected = e.getData(CommonDataKeys.VIRTUAL_FILE)
        if (selected != null && !selected.isDirectory && PreflightFiles.isStateName(selected.name)) {
            PreflightEditorProvider.open(project, selected)
            return
        }
        val choices = stateFiles(project).map { Choice(displayPath(project, it), AllIcons.Nodes.DataTables) { PreflightEditorProvider.open(project, it) } } +
            Choice("Browse…", AllIcons.Actions.MenuOpen) { browse(project) } +
            Choice("Read with terraform show -json…", AllIcons.Debugger.Console) { TerraformShow.pickFolderAndOpen(project) }
        JBPopupFactory.getInstance().createListPopup(ChoiceStep("View as Terraform State", choices)).showCenteredInCurrentWindow(project)
    }

    private fun browse(project: Project) {
        val descriptor = FileChooserDescriptorFactory.createSingleFileNoJarsDescriptor().withTitle("Open Terraform State")
        FileChooser.chooseFile(descriptor, project, null)?.let { PreflightEditorProvider.open(project, it) }
    }

    /** `*.tfstate` and `*.tfstate.backup` files of the project (none while indexing). */
    private fun stateFiles(project: Project): List<VirtualFile> {
        if (DumbService.isDumb(project)) return emptyList()
        return ReadAction.compute<List<VirtualFile>, RuntimeException> {
            val scope = GlobalSearchScope.projectScope(project)
            (FilenameIndex.getAllFilesByExt(project, "tfstate", scope) + FilenameIndex.getAllFilesByExt(project, "backup", scope))
                .filter { PreflightFiles.isStateName(it.name) && "/.terraform/" !in it.path }
                .sortedBy { it.path }
                .take(100)
        }
    }

    private fun displayPath(project: Project, file: VirtualFile): String =
        project.guessProjectDir()?.let { VfsUtilCore.getRelativePath(file, it) } ?: file.path

    private class Choice(val text: String, val icon: Icon, val run: () -> Unit)

    private class ChoiceStep(title: String, choices: List<Choice>) : BaseListPopupStep<Choice>(title, choices) {
        override fun getTextFor(value: Choice) = value.text

        override fun getIconFor(value: Choice) = value.icon

        override fun isSpeedSearchEnabled() = true

        override fun onChosen(selectedValue: Choice, finalChoice: Boolean): PopupStep<*>? = doFinalStep(selectedValue.run)
    }
}
