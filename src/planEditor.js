const vscode = require('vscode');
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const { parsePlan } = require('./planParser');
const fs = require('fs');
const { indexIcons, indexCategoryIcons, categoryOf, categoryLabel, serviceFor } = require('./awsIcons');
const { describeSource, sourceText } = require('./moduleSource');

const VIEW_TYPE = 'preflight.planViewer';
const SETTINGS_KEY = 'preflight.settings';

/**
 * Read-only custom editor for the JSON output of `terraform show -json`.
 * Backed by a TextDocument, so the view refreshes when the file changes on disk.
 * @implements {vscode.CustomTextEditorProvider}
 */
class PlanEditorProvider {
	/** @param {vscode.ExtensionContext} context */
	constructor(context) {
		this.context = context;
		/** @type {Set<vscode.WebviewPanel>} */
		this.panels = new Set();
		this.icons = indexIcons(vscode.Uri.joinPath(context.extensionUri, 'media').fsPath);
		this.categoryIcons = indexCategoryIcons(vscode.Uri.joinPath(context.extensionUri, 'media').fsPath);
	}

	/**
	 * @param {vscode.TextDocument} document
	 * @param {vscode.WebviewPanel} panel
	 */
	resolveCustomTextEditor(document, panel) {
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
		panel.webview.html = this.html(panel.webview, media);
		panel.title = 'Preflight - ' + path.basename(document.uri.path);
		panel.iconPath = { light: vscode.Uri.joinPath(media, 'logo-light.svg'), dark: vscode.Uri.joinPath(media, 'logo-dark.svg') };

		const send = () => {
			const path = breadcrumb(document.uri);
			try {
				const model = parsePlan(document.getText());
				const uriOf = (rel) => rel ? panel.webview.asWebviewUri(vscode.Uri.joinPath(media, ...rel.split('/'))).toString() : null;
				const iconOf = (type) => {
					const service = serviceFor(type);
					const rel = service && this.icons.get(service);
					return { service, icon: uriOf(rel), category: categoryOf(rel) };
				};
				for (const r of model.resources) {
					const { service, icon } = iconOf(r.type);
					Object.assign(r, { service, icon });
				}
				// Graph nodes are grouped by AWS console category; resources of a module also carry
				// their module group (with its source repository), used when the viewer groups by
				// module. AWS service principals and the rest of what lives outside the project get
				// their own groups.
				const modules = moduleSources(document.uri, model.graph.modules || {});
				for (const n of model.graph.nodes) {
					const i = n.iconType ? iconOf(n.iconType) : { icon: null, category: null };
					n.icon = i.icon;
					Object.assign(n, groupOf(n, i.category), { moduleGroup: moduleGroupOf(n, modules) });
					n.categoryIcon = uriOf(this.categoryIcons.get(n.category));
				}
				panel.webview.postMessage({ type: 'plan', model, path, settings: this.settings() });
			} catch (e) {
				panel.webview.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e), path, settings: this.settings() });
			}
		};

		const subs = [
			panel.webview.onDidReceiveMessage((msg) => {
				if (msg.type === 'ready') send();
				else if (msg.type === 'settings') this.saveSettings(msg.settings, panel);
				else if (msg.type === 'openExternal' && /^https:\/\//.test(msg.url)) vscode.env.openExternal(vscode.Uri.parse(msg.url));
			}),
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (e.document.uri.toString() === document.uri.toString()) send();
			})
		];
		this.panels.add(panel);
		panel.onDidDispose(() => {
			this.panels.delete(panel);
			subs.forEach((s) => s.dispose());
		});
	}

	/** Viewer settings, shared by every plan / state view. */
	settings() {
		return this.context.globalState.get(SETTINGS_KEY, {});
	}

	/**
	 * @param {object} settings
	 * @param {vscode.WebviewPanel} from
	 */
	saveSettings(settings, from) {
		this.context.globalState.update(SETTINGS_KEY, settings);
		for (const p of this.panels) if (p !== from) p.webview.postMessage({ type: 'settings', settings });
	}

	/**
	 * @param {vscode.Webview} webview
	 * @param {vscode.Uri} media
	 */
	html(webview, media) {
		const nonce = crypto.randomBytes(16).toString('base64');
		const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css'));
		const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.js'));
		const graphJs = webview.asWebviewUri(vscode.Uri.joinPath(media, 'graph.js'));
		const logo = webview.asWebviewUri(vscode.Uri.joinPath(media, 'logo-dark.svg'));
		const csp = [
			"default-src 'none'",
			`style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
			`font-src ${webview.cspSource} https://fonts.gstatic.com`,
			`img-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="${css}">
<title>Preflight</title>
</head>
<body>
<div class="app">
	<header class="top">
		<div class="brand">
			<img class="logo" src="${logo}" width="26" height="26" alt="">
			<span>Preflight</span>
			<span class="scope" title="Built for the AWS provider: icons, names and IAM analysis are AWS-specific">for AWS</span>
		</div>
		<span class="vsep"></span>
		<nav id="crumbs" class="crumbs" aria-label="File"></nav>
		<div class="grow"></div>
		<span id="gen" class="gen"></span>
		<span id="ver" class="ver" hidden></span>
	</header>

	<div id="state" class="state"></div>

	<div id="body" class="body" hidden>
		<aside class="side">
			<section class="summary">
				<div class="eyebrow" id="sum-title">Plan summary</div>
				<div class="nums">
					<div class="num"><b id="sum-add" style="color:#56d364">0</b><span id="sum-add-l">to add</span></div>
					<div class="num"><b id="sum-change" style="color:#e3b341">0</b><span id="sum-change-l">to change</span></div>
					<div class="num"><b id="sum-destroy" style="color:#ff7b72">0</b><span id="sum-destroy-l">to destroy</span></div>
				</div>
				<div id="segs" class="segs" aria-hidden="true"></div>
			</section>
			<div class="filters">
				<label class="search">
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8b94a7" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.5" y2="16.5"></line></svg>
					<span class="sr-only">Filter resources</span>
					<input id="q" type="text" placeholder="Filter by address…" spellcheck="false">
				</label>
				<div id="chips" class="chips"></div>
			</div>
			<div class="list-head"><span>Resources</span><span id="list-count" class="mono"></span></div>
			<div id="list" class="list"></div>
		</aside>
		<main id="main" class="main"></main>
	</div>

	<div id="graph" class="graph" role="tabpanel" aria-labelledby="tab-graph" hidden></div>

	<nav class="dock" role="tablist" aria-label="View" hidden>
		<button type="button" role="tab" id="tab-plan" data-tab="plan" aria-selected="true" aria-label="Plan" title="Plan">
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="2.5"></rect><path d="M7.5 8.5h3M9 7v3"></path><path d="M13.5 8.5h3"></path><path d="M7.5 13h9M7.5 16.5h6"></path></svg>
		</button>
		<button type="button" role="tab" id="tab-graph" data-tab="graph" aria-selected="false" aria-label="Graph" title="Graph">
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5.5" cy="6" r="2.5"></circle><circle cx="18.5" cy="6" r="2.5"></circle><circle cx="12" cy="18" r="2.5"></circle><path d="M8 6h8M7 8.2l3.6 7.6M17 8.2l-3.6 7.6"></path></svg>
		</button>
		<span class="dock-sep" aria-hidden="true"></span>
		<button type="button" id="open-settings" aria-label="Settings" title="Settings" aria-haspopup="dialog">
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
		</button>
	</nav>

	<div id="settings" class="modal" hidden>
		<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
			<header class="modal-head">
				<h2 id="settings-title">Settings</h2>
				<button type="button" class="modal-close" data-close aria-label="Close">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
				</button>
			</header>
			<div id="settings-body" class="modal-body"></div>
		</div>
	</div>

	<footer class="foot">
		<span id="foot-status" class="led"><i></i>Loading…</span>
		<span hidden id="total"></span>
		<div class="grow"></div>
		<span class="legend">
			<span><b style="color:#56d364">+</b> create</span>
			<span><b style="color:#e3b341">~</b> update</span>
			<span><b style="color:#c297ff">±</b> replace</span>
			<span><b style="color:#ff7b72">−</b> destroy</span>
			<span><b style="color:#8b94a7">=</b> no-op</span>
		</span>
	</footer>
</div>
<script nonce="${nonce}" src="${graphJs}"></script>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
	}
}

/** Asks the user for a JSON plan and opens it in the viewer. */
async function pickAndOpen() {
	const picked = await vscode.window.showOpenDialog({
		canSelectMany: false,
		openLabel: 'Open plan',
		filters: { 'Terraform plan (JSON)': ['json'] }
	});
	if (picked?.[0]) await vscode.commands.executeCommand('vscode.openWith', picked[0], VIEW_TYPE);
}

/**
 * Opens a Terraform state in the viewer: a local state file from the workspace, any file
 * picked from disk, or the output of `terraform show -json` (for remote backends).
 * @param {vscode.ExtensionContext} context
 */
async function pickAndOpenState(context) {
	const files = await vscode.workspace.findFiles('**/*.{tfstate,tfstate.backup}', '**/{.terraform,node_modules,.vscode-test}/**', 100);
	/** @type {(vscode.QuickPickItem & { uri?: vscode.Uri, action?: string })[]} */
	const items = files
		.sort((a, b) => a.fsPath.localeCompare(b.fsPath))
		.map((uri) => ({ label: '$(database) ' + path.basename(uri.fsPath), description: vscode.workspace.asRelativePath(uri), uri }));
	if (items.length) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
	items.push(
		{ label: '$(folder-opened) Browse…', description: 'Pick a state file from disk', action: 'browse' },
		{ label: '$(terminal) Read with terraform show -json…', description: 'Current state of a Terraform folder (works with remote backends)', action: 'show' }
	);
	const choice = await vscode.window.showQuickPick(items, { title: 'View as Terraform State', placeHolder: 'Select a state' });
	if (!choice) return;
	if (choice.uri) return openInViewer(choice.uri);
	if (choice.action === 'browse') {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: false,
			openLabel: 'Open state',
			filters: { 'Terraform state': ['tfstate', 'backup', 'json'], 'All files': ['*'] }
		});
		if (picked?.[0]) await openInViewer(picked[0]);
		return;
	}
	const dir = await pickTerraformDir();
	if (!dir) return;
	const json = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'terraform show -json in ' + vscode.workspace.asRelativePath(dir) },
		() => terraformShow(dir.fsPath)
	).catch((e) => {
		vscode.window.showErrorMessage('terraform show -json failed: ' + (e instanceof Error ? e.message : String(e)));
		return null;
	});
	if (!json) return;
	const out = vscode.Uri.joinPath(context.globalStorageUri, 'state', path.basename(dir.fsPath) + '.state.json');
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(out, '..'));
	await vscode.workspace.fs.writeFile(out, Buffer.from(json, 'utf8'));
	await openInViewer(out);
}

/** Workspace folders containing .tf files (asks when there are several). */
async function pickTerraformDir() {
	const tf = await vscode.workspace.findFiles('**/*.tf', '**/{.terraform,node_modules,.vscode-test}/**', 500);
	const dirs = [...new Set(tf.map((u) => path.dirname(u.fsPath)))].sort().map((d) => vscode.Uri.file(d));
	if (dirs.length === 1) return dirs[0];
	if (dirs.length === 0) {
		const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use folder' });
		return picked?.[0];
	}
	const choice = await vscode.window.showQuickPick(
		dirs.map((uri) => ({ label: '$(folder) ' + vscode.workspace.asRelativePath(uri), uri })),
		{ title: 'terraform show -json', placeHolder: 'Terraform folder to read the state from' }
	);
	return choice?.uri;
}

/** @param {string} cwd */
function terraformShow(cwd) {
	return new Promise((resolve, reject) => {
		execFile('terraform', ['show', '-json', '-no-color'], { cwd, maxBuffer: 512 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ')));
			else resolve(stdout);
		});
	});
}

/** @param {vscode.Uri} uri */
function openInViewer(uri) {
	return vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
}

/** Breadcrumb path: workspace folder + relative path. */
/**
 * Graph group of a node by resource type: AWS services, external, or AWS console category.
 * @param {any} n graph node
 * @param {string | null} category AWS category of its icon
 */
function groupOf(n, category) {
	if (n.kind === 'external' && n.type === 'service') return { category: 'AWS-Services', categoryLabel: 'AWS service principals' };
	// Inline and resource policies are declared in the project, next to their owner.
	if (n.kind === 'external' && n.type !== 'inline-policy' && n.type !== 'resource-policy') return { category: 'External', categoryLabel: 'External to project' };
	const c = category || 'Other';
	return { category: c, categoryLabel: c === 'Other' ? 'Other' : categoryLabel(c) };
}

/**
 * Module group of a resource declared in a module (null at the root).
 * @param {any} n graph node
 * @param {Record<string, { source: string | null, version: string | null }>} modules
 */
function moduleGroupOf(n, modules) {
	if (n.kind !== 'resource' || !n.module || n.module === 'root') return null;
	const key = n.module.replace(/\[[^\]]*\]/g, '');
	const m = modules[key];
	const d = m ? describeSource(m.source, m.version) : null;
	return {
		category: 'Module:' + key,
		categoryLabel: 'Module ' + key.replace(/^module\./, '').split('.module.').join(' › '),
		categorySub: d ? sourceText(d) : null,
		categoryUrl: d ? d.url : null,
		categoryIcon: null
	};
}

/**
 * Module sources from the plan, completed by `.terraform/modules/modules.json` next to the
 * file (the only place a state records nothing about its modules).
 * @param {vscode.Uri} uri
 * @param {Record<string, { source: string | null, version: string | null }>} fromPlan
 */
function moduleSources(uri, fromPlan) {
	const out = Object.assign({}, fromPlan);
	if (uri.scheme !== 'file') return out;
	try {
		const file = path.join(path.dirname(uri.fsPath), '.terraform', 'modules', 'modules.json');
		for (const m of JSON.parse(fs.readFileSync(file, 'utf8')).Modules || []) {
			if (!m.Key || !m.Source) continue;
			const key = m.Key.split('.').map((k) => 'module.' + k).join('.');
			if (!out[key]) out[key] = { source: m.Source, version: m.Version || null };
		}
	} catch {
		/* no modules.json */
	}
	return out;
}

function breadcrumb(uri) {
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	if (!folder) return uri.path.split('/').filter(Boolean).slice(-3);
	const rel = vscode.workspace.asRelativePath(uri, false);
	return [folder.name].concat(rel.split('/'));
}

module.exports = { PlanEditorProvider, VIEW_TYPE, pickAndOpen, pickAndOpenState };
