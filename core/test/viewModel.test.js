const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildViewModel, moduleSources } = require('../src/viewModel');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

suite('viewModel', () => {
	const icons = new Map([['Amazon-EC2', 'aws-icons/P/Arch_Compute/64/Arch_Amazon-EC2_64.svg']]);
	const categoryIcons = new Map([['Compute', 'aws-icons/C/Arch-Category_64/Arch-Category_Compute_64.svg']]);
	const iconUri = (rel) => 'media://' + rel;

	test('resources carry their service and icon URI', () => {
		const model = buildViewModel(fixture('mixed-plan.json'), { icons, categoryIcons, iconUri });
		const ec2 = model.resources.find((r) => r.type === 'aws_instance');
		assert.strictEqual(ec2.service, 'Amazon-EC2');
		assert.strictEqual(ec2.icon, 'media://' + icons.get('Amazon-EC2'));
		const rds = model.resources.find((r) => r.type === 'aws_db_instance');
		assert.strictEqual(rds.service, 'Amazon-RDS');
		assert.strictEqual(rds.icon, null, 'no icon indexed for this service');
	});

	test('graph nodes are grouped by AWS category, module and origin', () => {
		const lambda = new Map([['AWS-Lambda', 'aws-icons/P/Arch_Compute/64/Arch_AWS-Lambda_64.svg']]);
		const model = buildViewModel(fixture('sample.tfstate'), { icons: lambda, categoryIcons, iconUri });
		const fn = model.graph.nodes.find((n) => n.id === 'module.api.aws_lambda_function.fn[0]');
		assert.strictEqual(fn.category, 'Compute');
		assert.strictEqual(fn.categoryIcon, 'media://' + categoryIcons.get('Compute'));
		assert.strictEqual(fn.moduleGroup.category, 'Module:module.api');
		const role = model.graph.nodes.find((n) => n.id === 'aws_iam_role.app');
		assert.deepStrictEqual([role.category, role.moduleGroup], ['Other', null]);
		const svc = model.graph.nodes.find((n) => n.id === 'ext:svc:lambda.amazonaws.com');
		assert.strictEqual(svc.category, 'AWS-Services');
	});

	test('module sources are completed by modules.json', () => {
		const modulesJson = JSON.stringify({ Modules: [
			{ Key: '', Source: '', Dir: '.' },
			{ Key: 'net', Source: 'git::https://github.com/acme/net.git?ref=v1', Dir: '.terraform/modules/net' },
			{ Key: 'net.sub', Source: 'terraform-aws-modules/vpc/aws', Version: '5.0.0', Dir: '.terraform/modules/net.sub' },
			{ Key: 'app', Source: 'ignored', Dir: '.terraform/modules/app' }
		] });
		const out = moduleSources({ 'module.app': { source: './app', version: null } }, modulesJson);
		assert.deepStrictEqual(out['module.net'], { source: 'git::https://github.com/acme/net.git?ref=v1', version: null });
		assert.deepStrictEqual(out['module.net.module.sub'], { source: 'terraform-aws-modules/vpc/aws', version: '5.0.0' });
		assert.deepStrictEqual(out['module.app'], { source: './app', version: null }, 'the plan wins');
		assert.ok(!('module.' in out));
	});

	test('invalid or missing modules.json is ignored', () => {
		assert.deepStrictEqual(moduleSources({}, '{ not json'), {});
		assert.deepStrictEqual(moduleSources({}, null), {});
	});
});
