const assert = require('assert');
const path = require('path');
const vscode = require('vscode');

suite('Extension', () => {
	const plan = vscode.Uri.file(path.join(__dirname, '..', '..', 'core', 'test', 'fixtures', 'mixed-plan.json'));

	test('command and editor are registered', async () => {
		const ext = vscode.extensions.getExtension('theosylvestre.preflight-tf-aws');
		assert.ok(ext, 'extension not found');
		await vscode.commands.executeCommand('preflight.openPlan', plan);
		assert.ok(ext.isActive, 'extension not activated');
		const cmds = await vscode.commands.getCommands(true);
		assert.ok(cmds.includes('preflight.openPlan'));
	});

	test('opens the plan in the Preflight viewer', async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await vscode.commands.executeCommand('preflight.openPlan', plan);
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		assert.ok(tab && tab.input instanceof vscode.TabInputCustom, 'custom editor tab expected');
		assert.strictEqual(tab.input.viewType, 'preflight.planViewer');
		assert.strictEqual(tab.input.uri.fsPath, plan.fsPath);
	});

	test('opens a state file in the Preflight viewer', async () => {
		const state = vscode.Uri.file(path.join(__dirname, '..', '..', 'core', 'test', 'fixtures', 'sample.tfstate'));
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await vscode.commands.executeCommand('preflight.openState', state);
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		assert.ok(tab && tab.input instanceof vscode.TabInputCustom, 'custom editor tab expected');
		assert.strictEqual(tab.input.viewType, 'preflight.planViewer');
		assert.strictEqual(tab.input.uri.fsPath, state.fsPath);
	});

	test('graph layouts are computed in the background and kept', async function () {
		this.timeout(60000);
		const fs = require('fs');
		const ext = vscode.extensions.getExtension('theosylvestre.preflight-tf-aws');
		const dir = (await ext.activate()).layoutCacheDir;
		fs.rmSync(dir, { recursive: true, force: true });
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		// A plan with an IAM graph: the webview's worker lays out every variant once loaded.
		const state = vscode.Uri.file(path.join(__dirname, '..', '..', 'core', 'test', 'fixtures', 'sample.tfstate'));
		await vscode.commands.executeCommand('preflight.openState', state);
		const deadline = Date.now() + 50000;
		let files = [];
		while (Date.now() < deadline && files.length < 5) {
			await new Promise((r) => setTimeout(r, 250));
			files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
		}
		assert.deepStrictEqual(files.map((f) => f.split('-')[0]).sort(), ['force', 'horizontal', 'horizontal', 'vertical', 'vertical']);
	});
});
