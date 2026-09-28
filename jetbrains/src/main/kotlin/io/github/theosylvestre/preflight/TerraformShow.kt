package io.github.theosylvestre.preflight

import com.intellij.execution.ExecutionException
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.CapturingProcessHandler
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.search.FilenameIndex
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.icons.AllIcons
import java.nio.file.Files
import java.nio.file.Path

/** Current state of a Terraform folder through `terraform show -json` (works with remote backends). */
object TerraformShow {
    /** Asks for the Terraform folder (the one of the project when there is only one), then opens its state. */
    fun pickFolderAndOpen(project: Project) {
        val dirs = terraformDirs(project)
        when (dirs.size) {
            0 -> FileChooser.chooseFile(
                FileChooserDescriptorFactory.createSingleFolderDescriptor().withTitle("Terraform Folder"), project, null,
            )?.let { run(project, it) }
            1 -> run(project, dirs.single())
            else -> {
                val base = project.guessProjectDir()
                val step = object : BaseListPopupStep<VirtualFile>("terraform show -json", dirs) {
                    override fun getTextFor(value: VirtualFile) = base?.let { VfsUtilCore.getRelativePath(value, it) }?.ifEmpty { "." } ?: value.path

                    override fun getIconFor(value: VirtualFile) = AllIcons.Nodes.Folder

                    override fun isSpeedSearchEnabled() = true

                    override fun onChosen(selectedValue: VirtualFile, finalChoice: Boolean): PopupStep<*>? =
                        doFinalStep { run(project, selectedValue) }
                }
                JBPopupFactory.getInstance().createListPopup(step).showCenteredInCurrentWindow(project)
            }
        }
    }

    /** Runs `terraform show -json` in [dir] in the background, saves the output and opens it. */
    fun run(project: Project, dir: VirtualFile) {
        object : Task.Backgroundable(project, "terraform show -json in ${dir.name}", true) {
            override fun run(indicator: ProgressIndicator) {
                val command = GeneralCommandLine("terraform", "show", "-json", "-no-color")
                    .withWorkDirectory(dir.path)
                    .withCharset(Charsets.UTF_8)
                val output = try {
                    CapturingProcessHandler(command).runProcessWithProgressIndicator(indicator)
                } catch (e: ExecutionException) {
                    return fail(project, e.message ?: "terraform not found")
                }
                if (output.isCancelled) return
                if (output.exitCode != 0) {
                    return fail(project, (output.stderr.ifBlank { output.stdout }).trim().lines().takeLast(3).joinToString(" "))
                }
                val target = Path.of(PathManager.getSystemPath(), "preflight", "state", dir.name + ".state.json")
                Files.createDirectories(target.parent)
                Files.writeString(target, output.stdout)
                val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(target) ?: return
                ApplicationManager.getApplication().invokeLater({ PreflightEditorProvider.open(project, file) }, project.disposed)
            }
        }.queue()
    }

    /** Folders of the project containing `.tf` files (none while indexing). */
    private fun terraformDirs(project: Project): List<VirtualFile> {
        if (DumbService.isDumb(project)) return emptyList()
        return ReadAction.compute<List<VirtualFile>, RuntimeException> {
            FilenameIndex.getAllFilesByExt(project, "tf", GlobalSearchScope.projectScope(project))
                .mapNotNull { it.parent }
                .filter { "/.terraform/" !in it.path + "/" }
                .distinct()
                .sortedBy { it.path }
        }
    }

    private fun fail(project: Project, message: String) {
        NotificationGroupManager.getInstance().getNotificationGroup("Preflight")
            .createNotification("terraform show -json failed", message, NotificationType.ERROR)
            .notify(project)
    }
}
