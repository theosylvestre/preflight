const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parsePlan, UNKNOWN, SENSITIVE } = require('../src/planParser');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const byAddr = (model, addr) => model.resources.find((r) => r.addr === addr);
const line = (r, key) => r.lines.find((l) => l[2] === key);

suite('planParser', () => {
	const model = parsePlan(fixture('mixed-plan.json'));

	test('reads plan metadata', () => {
		assert.strictEqual(model.terraformVersion, '1.9.5');
		assert.strictEqual(model.timestamp, '2026-09-26T12:02:00Z');
		assert.strictEqual(model.resources.length, 5);
	});

	test('maps Terraform actions', () => {
		assert.deepStrictEqual(model.resources.map((r) => r.action), ['update', 'replace', 'delete', 'update', 'noop']);
	});

	test('diffs scalars and maps', () => {
		const r = byAddr(model, 'aws_instance.web');
		assert.deepStrictEqual(line(r, 'ami'), ['c', 0, 'ami', '"ami-0c55b159cbfafe1f0"']);
		assert.deepStrictEqual(line(r, 'instance_type'), ['m', 0, 'instance_type', ['"t3.micro"', '"t3.small"']]);
		assert.deepStrictEqual(line(r, '"Environment"'), ['m', 1, '"Environment"', ['"staging"', '"production"']]);
		assert.deepStrictEqual(line(r, '"Owner"'), ['a', 1, '"Owner"', '"platform-team"']);
		assert.deepStrictEqual(line(r, '"Temp"'), ['d', 1, '"Temp"', '"true"']);
	});

	test('lists of objects become blocks', () => {
		const r = byAddr(model, 'aws_instance.web');
		assert.deepStrictEqual(line(r, '@root_block_device'), ['c', 0, '@root_block_device', '{']);
		assert.deepStrictEqual(line(r, 'volume_size'), ['m', 1, 'volume_size', ['20', '40']]);
	});

	test('masks sensitive values and flags forced replacement', () => {
		const r = byAddr(model, 'aws_db_instance.main');
		assert.deepStrictEqual(line(r, 'password'), ['c', 0, 'password', SENSITIVE]);
		assert.deepStrictEqual(line(r, 'id'), ['m', 0, 'id', ['"db-7XKQ2M4N5P6R8S"', UNKNOWN], null, true]);
		assert.deepStrictEqual(line(r, 'storage_encrypted'), ['m', 0, 'storage_encrypted', ['false', 'true'], 'forces replacement']);
		assert.strictEqual(r.force, 'storage_encrypted');
		assert.strictEqual(r.reason, 'a change forces replacement');
	});

	test('destroy inside a module', () => {
		const r = byAddr(model, 'module.net.aws_security_group.legacy');
		assert.strictEqual(r.module, 'module.net');
		assert.ok(r.lines.every((l) => l[0] === 'd'));
		assert.deepStrictEqual(r.lines.map((l) => l[3]), ['[', '"0.0.0.0/0"', ']', '"sg-1"']);
	});

	test('lists of scalars: set-based diff', () => {
		const r = byAddr(model, 'aws_route53_record.api');
		const inner = r.lines.filter((l) => l[1] === 1).map((l) => l[0] + l[3]);
		assert.deepStrictEqual(inner, ['d"lb-old"', 'c"keep"', 'a"lb-new"']);
	});

	test('no-op: unchanged lines only', () => {
		const r = byAddr(model, 'aws_iam_role.lambda_exec');
		assert.ok(r.lines.every((l) => l[0] === 'c'));
	});

	test('read data source: neutral lines', () => {
		const r = parsePlan(JSON.stringify({
			format_version: '1.2',
			terraform_version: '1.9.5',
			resource_changes: [{
				address: 'data.aws_iam_policy_document.x',
				mode: 'data',
				type: 'aws_iam_policy_document',
				change: {
					actions: ['read'],
					before: null,
					after: { statement: [{ actions: ['s3:GetObject'] }] },
					after_unknown: { id: true, json: true }
				}
			}]
		})).resources[0];
		assert.strictEqual(r.action, 'read');
		assert.ok(r.lines.length > 0);
		assert.ok(r.lines.every((l) => l[0] === 'c'));
		assert.deepStrictEqual(line(r, 'id'), ['c', 0, 'id', UNKNOWN]);
	});

	test('JSON strings (policies) are expanded and diffed key by key', () => {
		const pol = (actions) => JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: actions }] });
		const r = parsePlan(JSON.stringify({
			format_version: '1.2',
			terraform_version: '1.9.5',
			resource_changes: [{
				address: 'aws_iam_policy.p',
				change: {
					actions: ['update'],
					before: { policy: pol(['s3:GetObject']), name: '{not json' },
					after: { policy: pol(['s3:GetObject', 's3:PutObject']), name: '{not json' },
					after_unknown: {}
				}
			}]
		})).resources[0];
		assert.deepStrictEqual(r.lines[0], ['c', 0, 'name', '"{not json"']);
		assert.deepStrictEqual(r.lines[1], ['c', 0, 'policy', 'jsonencode(']);
		assert.deepStrictEqual(r.lines[r.lines.length - 1], ['c', 0, '', ')']);
		assert.deepStrictEqual(line(r, 'Effect'), ['c', 4, 'Effect', '"Allow"']);
		const changed = r.lines.filter((l) => l[0] !== 'c');
		assert.deepStrictEqual(changed, [['a', 5, '', '"s3:PutObject"']]);
	});

	test('AWS name of resources (name, bucket, S3 object key…)', () => {
		assert.strictEqual(byAddr(model, 'aws_iam_role.lambda_exec').cloudName, 'lambda-exec');
		assert.strictEqual(byAddr(model, 'aws_db_instance.main').cloudName, null);
		const { cloudNameOf } = require('../src/planParser');
		assert.strictEqual(cloudNameOf({ bucket: 'b', key: 'scripts/job.py' }, 'aws_s3_object'), 'scripts/job.py');
		assert.strictEqual(cloudNameOf({ bucket: 'my-bucket' }, 'aws_s3_bucket'), 'my-bucket');
	});

	test('rejects JSON that is not a plan', () => {
		assert.throws(() => parsePlan('{"foo": 1}'), /neither a Terraform plan/);
		assert.throws(() => parsePlan('not json'), /Invalid JSON/);
	});
});
