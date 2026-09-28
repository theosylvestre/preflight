const vscode = require('vscode');
const { PlanEditorProvider, VIEW_TYPE, pickAndOpen, pickAndOpenState } = require('./src/planEditor');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	const provider = new PlanEditorProvider(context);
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
			webviewOptions: { retainContextWhenHidden: true },
			supportsMultipleEditorsPerDocument: true
		}),

		// Opens a JSON plan in the viewer: the targeted file (explorer / tab),
		// else the active editor if it is a .json, else a file picker.
		vscode.commands.registerCommand('preflight.openPlan', async (/** @type {vscode.Uri | undefined} */ uri) => {
			let target = uri instanceof vscode.Uri ? uri : undefined;
			if (!target) {
				const active = vscode.window.activeTextEditor?.document.uri;
				if (active && active.path.endsWith('.json')) target = active;
			}
			if (!target) return pickAndOpen();
			await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
		}),

		// Opens a state in the viewer: the targeted file, else the active .tfstate editor,
		// else a quick pick (workspace states, browse, `terraform show -json`).
		vscode.commands.registerCommand('preflight.openState', async (/** @type {vscode.Uri | undefined} */ uri) => {
			let target = uri instanceof vscode.Uri ? uri : undefined;
			if (!target) {
				const active = vscode.window.activeTextEditor?.document.uri;
				if (active && /\.tfstate(\.backup)?$/.test(active.path)) target = active;
			}
			if (!target) return pickAndOpenState(context);
			await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
		})
	);
	// For the integration tests.
	return { layoutCacheDir: provider.layouts.dir };
}

function deactivate() {}

module.exports = {
	activate,
	deactivate
};
