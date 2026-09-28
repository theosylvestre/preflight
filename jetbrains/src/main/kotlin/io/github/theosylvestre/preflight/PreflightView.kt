package io.github.theosylvestre.preflight

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.Alarm
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.handler.CefResourceHandler
import org.cef.handler.CefResourceRequestHandler
import org.cef.handler.CefResourceRequestHandlerAdapter
import org.cef.misc.BoolRef
import org.cef.network.CefRequest
import java.nio.file.Files
import java.nio.file.Path
import javax.swing.JComponent

/**
 * The viewer in an embedded browser (JCEF), on one file. The page is served from the plugin
 * resources; it asks for the file text on load and is told to reload it when it changes.
 */
class PreflightView(private val project: Project, private val file: VirtualFile) : Disposable {
    private val browser = JBCefBrowser()
    private val ready = JBCefJSQuery.create(browser as JBCefBrowserBase)
    private val saveSettings = JBCefJSQuery.create(browser as JBCefBrowserBase)
    private val openExternal = JBCefJSQuery.create(browser as JBCefBrowserBase)
    private val reload = Alarm(Alarm.ThreadToUse.POOLED_THREAD, this)

    val component: JComponent get() = browser.component

    init {
        Disposer.register(this, browser)
        listOf(ready, saveSettings, openExternal).forEach { Disposer.register(this, it) }

        ready.addHandler { push(); null }
        saveSettings.addHandler { json -> PreflightSettings.getInstance().save(json, this); null }
        openExternal.addHandler { url -> if (url.startsWith("https://")) BrowserUtil.browse(url); null }

        browser.jbCefClient.addRequestHandler(RequestHandler(), browser.cefBrowser)
        browser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadEnd(cefBrowser: CefBrowser, frame: CefFrame, httpStatusCode: Int) {
                if (frame.isMain) run(connectScript())
            }
        }, browser.cefBrowser)

        FileDocumentManager.getInstance().getDocument(file)?.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) = scheduleReload()
        }, this)
        project.messageBus.connect(this).subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: List<VFileEvent>) {
                if (events.any { it.file == file }) scheduleReload()
            }
        })

        PreflightSettings.getInstance().register(this)
        browser.loadURL(PreflightWeb.PAGE_URL)
    }

    /** Settings changed in another view. */
    fun applySettings(json: String) = run("window.PreflightHost._settings(${Json.string(json)})")

    override fun dispose() {
        PreflightSettings.getInstance().unregister(this)
    }

    private fun scheduleReload() {
        reload.cancelAllRequests()
        reload.addRequest(::push, RELOAD_DELAY_MS)
    }

    /** Tells the page to (re)load the file, with what the page cannot find by itself. */
    private fun push() {
        if (!file.isValid) return
        val meta = Json.obj(
            "path" to Json.array(breadcrumb()),
            "modulesJson" to Json.string(modulesJson()),
            "settings" to Json.string(PreflightSettings.getInstance().json),
            "fontFamily" to Json.string(EditorColorsManager.getInstance().globalScheme.editorFontName),
        )
        run("window.PreflightHost._load($meta)")
    }

    private fun connectScript() = """
        window.PreflightHost._connect({
            ready: function () { ${ready.inject("''")} },
            settings: function (json) { ${saveSettings.inject("json")} },
            openExternal: function (url) { ${openExternal.inject("url")} }
        });
    """.trimIndent()

    private fun run(script: String) = browser.cefBrowser.executeJavaScript(script, PreflightWeb.PAGE_URL, 0)

    /** Content root + relative path, or the last segments of the path outside the project. */
    private fun breadcrumb(): List<String> = ReadAction.compute<List<String>, RuntimeException> {
        val root = ProjectFileIndex.getInstance(project).getContentRootForFile(file)
        val rel = root?.let { VfsUtilCore.getRelativePath(file, it) }
        if (root != null && rel != null) listOf(root.name) + rel.split('/')
        else file.path.split('/').filter { it.isNotEmpty() }.takeLast(3)
    }

    /** `.terraform/modules/modules.json` next to the file (module sources of a state). */
    private fun modulesJson(): String? {
        if (!file.isInLocalFileSystem) return null
        val path = Path.of(file.path).resolveSibling(".terraform").resolve("modules").resolve("modules.json")
        return runCatching { Files.readString(path) }.getOrNull()
    }

    private fun sourceText(): String = ReadAction.compute<String, RuntimeException> {
        FileDocumentManager.getInstance().getDocument(file)?.text ?: VfsUtilCore.loadText(file)
    }

    /** Serves the page from the plugin resources and keeps the browser on it. */
    private inner class RequestHandler : CefRequestHandlerAdapter() {
        private val resources = object : CefResourceRequestHandlerAdapter() {
            override fun getResourceHandler(browser: CefBrowser?, frame: CefFrame?, request: CefRequest): CefResourceHandler {
                val path = PreflightWeb.pathOf(request.url)
                return when (path) {
                    "index.html" -> BytesResourceHandler(PreflightWeb.page().toByteArray(), "text/html")
                    PreflightWeb.SOURCE_PATH -> BytesResourceHandler(runCatching { sourceText().toByteArray() }.getOrNull(), "text/plain")
                    null -> BytesResourceHandler(null, "text/plain")
                    else -> BytesResourceHandler(PreflightWeb.resource(path), PreflightWeb.mimeOf(path))
                }
            }
        }

        override fun getResourceRequestHandler(
            browser: CefBrowser?, frame: CefFrame?, request: CefRequest,
            isNavigation: Boolean, isDownload: Boolean, requestInitiator: String?, disableDefaultHandling: BoolRef?,
        ): CefResourceRequestHandler? = if (request.url.startsWith(PreflightWeb.ORIGIN + "/")) resources else null

        override fun onBeforeBrowse(browser: CefBrowser?, frame: CefFrame?, request: CefRequest, userGesture: Boolean, isRedirect: Boolean): Boolean {
            if (request.url.startsWith(PreflightWeb.ORIGIN + "/")) return false
            if (userGesture && request.url.startsWith("https://")) BrowserUtil.browse(request.url)
            return true
        }
    }

    private companion object {
        const val RELOAD_DELAY_MS = 200
    }
}
