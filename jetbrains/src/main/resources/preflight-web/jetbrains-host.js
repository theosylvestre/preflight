// @ts-nocheck
// JetBrains side of the viewer ↔ IDE bridge, loaded before viewer.js. Gives the viewer the
// API of the VS Code webview (postMessage / getState / setState) on top of the JBCefJSQuery
// functions the plugin installs with _connect(), and builds the model in the page with the
// core bundle (PreflightCore), since the IDE has no Node runtime.
(function () {
	const ORIGIN = location.origin;
	let bridge = null;
	let state = null;
	let loads = 0;
	const queue = [];

	function send(msg) {
		if (!bridge) return void queue.push(msg);
		if (msg.type === 'ready') bridge.ready();
		else if (msg.type === 'settings') bridge.settings(JSON.stringify(msg.settings || {}));
		else if (msg.type === 'openExternal') bridge.openExternal(String(msg.url));
	}

	function parseSettings(json) {
		try {
			const v = JSON.parse(json);
			return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
		} catch {
			return {};
		}
	}

	const post = (msg) => window.postMessage(msg, '*');

	window.PreflightHost = {
		postMessage: send,
		// Per-view state: lives as long as the editor (the browser is kept while it is open).
		getState: () => state,
		setState: (s) => { state = s; },

		/** Called by the plugin once the page is loaded: { ready(), settings(json), openExternal(url) }. */
		_connect(b) {
			bridge = b;
			queue.splice(0).forEach(send);
		},

		/**
		 * (Re)loads the file: the plugin gives its metadata, the text is fetched from the
		 * plugin's resource handler (no size limit, no escaping into a script).
		 * @param {{ path: string[], modulesJson: string | null, settings: string, fontFamily?: string }} meta
		 */
		_load(meta) {
			const id = ++loads;
			const settings = parseSettings(meta.settings);
			if (meta.fontFamily) document.documentElement.style.setProperty('--vscode-editor-font-family', meta.fontFamily);
			fetch(ORIGIN + '/__source?n=' + id)
				.then((r) => {
					if (!r.ok) throw new Error('Unable to read the file (HTTP ' + r.status + ')');
					return r.text();
				})
				.then((text) => {
					if (id !== loads) return;
					const model = window.PreflightCore.buildViewModel(text, {
						iconUri: (rel) => ORIGIN + '/media/' + rel,
						modulesJson: meta.modulesJson
					});
					post({ type: 'plan', model, path: meta.path, settings });
				})
				.catch((e) => {
					if (id === loads) post({ type: 'error', message: e instanceof Error ? e.message : String(e), path: meta.path, settings });
				});
		},

		/** Settings changed in another Preflight view. */
		_settings(json) {
			post({ type: 'settings', settings: parseSettings(json) });
		}
	};
})();
