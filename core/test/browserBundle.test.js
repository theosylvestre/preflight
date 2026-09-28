// dist/preflight-core.js (built by `pnpm build`, run before the tests) in a bare browser-like
// context: no require, no Node globals.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

suite('browser bundle', () => {
	/** @type {any} */
	let core;

	suiteSetup(() => {
		const bundle = path.join(root, 'dist', 'preflight-core.js');
		assert.ok(fs.existsSync(bundle), 'run `pnpm --filter @preflight/core build` first');
		const context = vm.createContext({});
		vm.runInContext(fs.readFileSync(bundle, 'utf8'), context, { filename: bundle });
		core = context.PreflightCore;
	});

	test('exposes buildViewModel on the global object', () => {
		assert.strictEqual(typeof core.buildViewModel, 'function');
	});

	test('icons come from the embedded index and exist in media/', () => {
		const model = core.buildViewModel(fixture('mixed-plan.json'), { iconUri: (rel) => 'https://preflight.local/media/' + rel });
		const ec2 = model.resources.find((r) => r.type === 'aws_instance');
		assert.match(ec2.icon, /^https:\/\/preflight\.local\/media\/aws-icons\/.+\/Arch_Amazon-EC2_64\.svg$/);
		const rel = ec2.icon.slice('https://preflight.local/media/'.length);
		assert.ok(fs.existsSync(path.join(root, 'media', rel)), rel + ' missing');
	});

	test('category icons and modules.json are used for the graph', () => {
		const modulesJson = JSON.stringify({ Modules: [{ Key: 'api', Source: 'git::https://github.com/acme/api.git', Dir: '.terraform/modules/api' }] });
		const model = core.buildViewModel(fixture('sample.tfstate'), { iconUri: (rel) => rel, modulesJson });
		const fn = model.graph.nodes.find((n) => n.id === 'module.api.aws_lambda_function.fn[0]');
		assert.strictEqual(fn.category, 'Compute');
		assert.ok(fs.existsSync(path.join(root, 'media', fn.categoryIcon)), fn.categoryIcon + ' missing');
		assert.strictEqual(fn.moduleGroup.categoryUrl, 'https://github.com/acme/api');
	});

	test('invalid JSON is reported as an error', () => {
		assert.throws(() => core.buildViewModel('{ nope', { iconUri: String }));
	});
});
