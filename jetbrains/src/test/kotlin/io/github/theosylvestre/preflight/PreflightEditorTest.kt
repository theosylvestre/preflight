package io.github.theosylvestre.preflight

import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.fileEditor.ex.FileEditorProviderManager
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.File

/** Editor provider, in a light IDE (JCEF disabled in tests: the editor shows its fallback). */
class PreflightEditorTest : BasePlatformTestCase() {
    private val provider get() = FileEditorProvider.EP_FILE_EDITOR_PROVIDER.findExtensionOrFail(PreflightEditorProvider::class.java)

    override fun getTestDataPath() = File("../core/test/fixtures").absolutePath

    fun `test provider is registered`() {
        val file = myFixture.copyFileToProject("mixed-plan.json")
        val ids = FileEditorProviderManager.getInstance().getProviderList(project, file).map { it.editorTypeId }
        assertContainsElements(ids, PreflightEditorProvider.EDITOR_TYPE_ID)
    }

    fun `test accepts plans and states, not other JSON files`() {
        assertTrue(provider.accept(project, myFixture.copyFileToProject("mixed-plan.json")))
        assertTrue(provider.accept(project, myFixture.copyFileToProject("sample.tfstate")))
        assertTrue(provider.accept(project, myFixture.addFileToProject("terraform.tfstate.backup", "{}").virtualFile))
        assertFalse(provider.accept(project, myFixture.addFileToProject("package.json", """{"name":"x"}""").virtualFile))
        assertFalse(provider.accept(project, myFixture.addFileToProject("main.tf", "").virtualFile))
    }

    fun `test editor without JCEF shows a message`() {
        val editor = provider.createEditor(project, myFixture.copyFileToProject("mixed-plan.json")) as PreflightFileEditor
        try {
            assertNull(editor.view)
            assertTrue(editor.component.toString().contains("JCEF"))
            assertTrue(editor.isValid)
            assertFalse(editor.isModified)
        } finally {
            Disposer.dispose(editor)
        }
    }
}
