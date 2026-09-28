const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parsePlan, SENSITIVE } = require('../src/planParser');

const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.tfstate'), 'utf8');
const byAddr = (m, a) => m.resources.find((r) => r.addr === a);
const edge = (m, kind, from, to) => m.graph.edges.find((e) => e.kind === kind && e.from === from && e.to === to);

suite('stateParser', () => {
	const m = parsePlan(text);

	test('reads a raw tfstate as a state model', () => {
		assert.strictEqual(m.kind, 'state');
		assert.deepStrictEqual(m.state, { serial: 7, lineage: '00000000-0000-0000-0000-000000000000', format: 'tfstate v4', outputs: 1 });
		assert.deepStrictEqual(m.resources.map((r) => r.addr).sort(), [
			'aws_iam_role.app', 'aws_iam_role_policy.data', 'aws_s3_bucket.data', 'aws_s3_bucket_versioning.data', 'module.api.aws_lambda_function.fn[0]'
		]);
		assert.ok(m.resources.every((r) => r.action === 'noop' && r.lines.every((l) => l[0] === 'c')));
	});

	test('module instances, tainted status and sensitive values', () => {
		const fn = byAddr(m, 'module.api.aws_lambda_function.fn[0]');
		assert.strictEqual(fn.module, 'module.api');
		assert.strictEqual(fn.reason, 'tainted');
		assert.ok(fn.lines.some((l) => l[2] === '"API_KEY"' && l[3] === SENSITIVE));
		assert.ok(!JSON.stringify(fn.lines).includes('s3cr3t'));
	});

	test('execution role and policy use inferred from values', () => {
		assert.deepStrictEqual(edge(m, 'runs-as', 'module.api.aws_lambda_function.fn[0]', 'aws_iam_role.app').labels, ['role']);
		assert.ok(edge(m, 'attach', 'aws_iam_role.app', 'aws_iam_role_policy.data'));
	});

	test('permissions and trust from policies stored in the state', () => {
		assert.deepStrictEqual(edge(m, 'perm', 'aws_iam_role_policy.data', 'aws_s3_bucket.data').actions, ['s3:GetObject', 's3:PutObject']);
		assert.ok(edge(m, 'trust', 'ext:svc:lambda.amazonaws.com', 'aws_iam_role.app'));
		assert.ok(!m.graph.nodes.some((n) => n.id === 'aws_s3_bucket_versioning.data'), 'resources outside IAM relationships are left out');
	});

	test('reads the terraform show -json state format', () => {
		const show = {
			format_version: '1.0',
			terraform_version: '1.9.5',
			values: {
				root_module: {
					resources: [{ address: 'aws_s3_bucket.b', mode: 'managed', type: 'aws_s3_bucket', name: 'b', provider_name: 'registry.terraform.io/hashicorp/aws', values: { bucket: 'bbbbbb', arn: 'arn:aws:s3:::bbbbbb' }, sensitive_values: {} }],
					child_modules: [{
						address: 'module.m',
						resources: [{ address: 'module.m.aws_s3_object.o', mode: 'managed', type: 'aws_s3_object', name: 'o', provider_name: 'registry.terraform.io/hashicorp/aws', values: { bucket: 'bbbbbb', key: 'k' }, sensitive_values: {} }]
					}]
				}
			}
		};
		const s = parsePlan(JSON.stringify(show));
		assert.strictEqual(s.kind, 'state');
		assert.strictEqual(s.state.format, 'terraform show -json');
		assert.deepStrictEqual(s.resources.map((r) => r.addr), ['aws_s3_bucket.b', 'module.m.aws_s3_object.o']);
		assert.strictEqual(s.resources[1].module, 'module.m');
	});
});
