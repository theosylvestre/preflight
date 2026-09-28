const vscode = require('vscode');
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');
const { indexIcons, indexCategoryIcons } = require('../../core/src/awsIcons');
const { buildViewModel } = require('../../core/src/viewModel');

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
				const model = buildViewModel(document.getText(), {
					icons: this.icons,
					categoryIcons: this.categoryIcons,
					iconUri: (rel) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, ...rel.split('/'))).toString(),
					modulesJson: readModulesJson(document.uri)
				});
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
		const csp = [
			"default-src 'none'",
			`style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
			`font-src ${webview.cspSource} https://fonts.gstatic.com`,
			`img-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`,
			// Graph layouts are computed in a Web Worker created from a blob (see graph.js).
			'worker-src blob:'
		].join('; ');
		const vars = { csp, nonce, media: webview.asWebviewUri(media).toString(), scripts: '' };
		const template = fs.readFileSync(path.join(media.fsPath, 'viewer.html'), 'utf8');
		return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]);
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

/**
 * `.terraform/modules/modules.json` next to the file, or null.
 * @param {vscode.Uri} uri
 */
function readModulesJson(uri) {
	if (uri.scheme !== 'file') return null;
	try {
		return fs.readFileSync(path.join(path.dirname(uri.fsPath), '.terraform', 'modules', 'modules.json'), 'utf8');
	} catch {
		return null;
	}
}

/** Breadcrumb path: workspace folder + relative path. */
function breadcrumb(uri) {
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	if (!folder) return uri.path.split('/').filter(Boolean).slice(-3);
	const rel = vscode.workspace.asRelativePath(uri, false);
	return [folder.name].concat(rel.split('/'));
}

module.exports = { PlanEditorProvider, VIEW_TYPE, pickAndOpen, pickAndOpenState };
