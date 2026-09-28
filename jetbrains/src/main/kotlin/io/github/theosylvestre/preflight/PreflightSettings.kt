package io.github.theosylvestre.preflight

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import java.util.concurrent.CopyOnWriteArraySet

/** Viewer settings (JSON written by the page), shared by every Preflight view of the IDE. */
@Service(Service.Level.APP)
class PreflightSettings {
    private val views = CopyOnWriteArraySet<PreflightView>()

    val json: String
        get() = PropertiesComponent.getInstance().getValue(KEY) ?: "{}"

    /** Saves the settings of [from] and applies them to the other open views. */
    fun save(json: String, from: PreflightView?) {
        if (!json.trimStart().startsWith("{")) return
        PropertiesComponent.getInstance().setValue(KEY, json)
        for (v in views) if (v !== from) v.applySettings(json)
    }

    internal fun register(view: PreflightView) {
        views.add(view)
    }

    internal fun unregister(view: PreflightView) {
        views.remove(view)
    }

    companion object {
        private const val KEY = "preflight.settings"

        fun getInstance(): PreflightSettings = service()
    }
}
