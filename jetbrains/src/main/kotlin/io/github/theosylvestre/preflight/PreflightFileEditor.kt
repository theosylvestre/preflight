package io.github.theosylvestre.preflight

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.components.JBLabel
import com.intellij.ui.jcef.JBCefApp
import com.intellij.util.ui.JBUI
import java.beans.PropertyChangeListener
import javax.swing.JComponent
import javax.swing.SwingConstants

/** "Preflight" tab of a plan / state file, next to the text editor. */
class PreflightFileEditor(project: Project, private val file: VirtualFile) : UserDataHolderBase(), FileEditor {
    /** Null when the IDE runtime has no JCEF (embedded Chromium). */
    val view: PreflightView? = if (JBCefApp.isSupported()) PreflightView(project, file) else null

    private val component: JComponent = view?.component ?: JBLabel(
        "<html><center>Preflight needs JCEF, the embedded browser of the IDE,<br>which is not available in this runtime.</center></html>",
        SwingConstants.CENTER,
    ).apply { border = JBUI.Borders.empty(16) }

    init {
        view?.let { Disposer.register(this, it) }
    }

    override fun getComponent(): JComponent = component

    override fun getPreferredFocusedComponent(): JComponent = component

    override fun getName(): String = "Preflight"

    override fun getFile(): VirtualFile = file

    override fun setState(state: FileEditorState) = Unit

    override fun isModified(): Boolean = false

    override fun isValid(): Boolean = file.isValid

    override fun addPropertyChangeListener(listener: PropertyChangeListener) = Unit

    override fun removePropertyChangeListener(listener: PropertyChangeListener) = Unit

    override fun dispose() = Unit
}
