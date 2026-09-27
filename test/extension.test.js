const assert = require('assert');
const path = require('path');
const vscode = require('vscode');

suite('Extension', () => {
	const plan = vscode.Uri.file(path.join(__dirname, 'fixtures', 'mixed-plan.json'));

	test('command and editor are registered', async () => {
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'preflight');
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
		const state = vscode.Uri.file(path.join(__dirname, 'fixtures', 'sample.tfstate'));
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await vscode.commands.executeCommand('preflight.openState', state);
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		assert.ok(tab && tab.input instanceof vscode.TabInputCustom, 'custom editor tab expected');
		assert.strictEqual(tab.input.viewType, 'preflight.planViewer');
		assert.strictEqual(tab.input.uri.fsPath, state.fsPath);
	});
});
