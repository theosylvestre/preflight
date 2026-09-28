package io.github.theosylvestre.preflight.actions

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.ActionUiKind
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/** Where the actions show up: in context menus only on matching files, always in the Tools menu. */
class ActionsTest : BasePlatformTestCase() {
    private fun presentation(id: String, file: VirtualFile?, contextMenu: Boolean): Pair<Boolean, Boolean> {
        val action: AnAction = ActionManager.getInstance().getAction(id)
        val context = SimpleDataContext.builder()
            .add(CommonDataKeys.PROJECT, project)
            .apply { if (file != null) add(CommonDataKeys.VIRTUAL_FILE, file) }
            .build()
        val event = if (contextMenu) {
            AnActionEvent.createEvent(context, action.templatePresentation.clone(), ActionPlaces.PROJECT_VIEW_POPUP, ActionUiKind.POPUP, null)
        } else {
            AnActionEvent.createEvent(context, action.templatePresentation.clone(), ActionPlaces.MAIN_MENU, ActionUiKind.MAIN_MENU, null)
        }
        action.update(event)
        return event.presentation.isVisible to event.presentation.isEnabled
    }

    fun `test actions are registered`() {
        assertNotNull(ActionManager.getInstance().getAction("Preflight.OpenPlan"))
        assertNotNull(ActionManager.getInstance().getAction("Preflight.OpenState"))
    }

    fun `test plan action in context menus of JSON files only`() {
        val json = myFixture.addFileToProject("tfplan.json", "{}").virtualFile
        val state = myFixture.addFileToProject("terraform.tfstate", "{}").virtualFile
        assertEquals(true to true, presentation("Preflight.OpenPlan", json, contextMenu = true))
        assertEquals(false to false, presentation("Preflight.OpenPlan", state, contextMenu = true))
        assertEquals(true to true, presentation("Preflight.OpenPlan", null, contextMenu = false))
    }

    fun `test state action in context menus of state files only`() {
        val json = myFixture.addFileToProject("tfplan.json", "{}").virtualFile
        val backup = myFixture.addFileToProject("terraform.tfstate.backup", "{}").virtualFile
        assertEquals(true to true, presentation("Preflight.OpenState", backup, contextMenu = true))
        assertEquals(false to false, presentation("Preflight.OpenState", json, contextMenu = true))
        assertEquals(true to true, presentation("Preflight.OpenState", json, contextMenu = false))
    }
}
