const assert = require('assert');
const { buildGraph } = require('../src/planGraph');

const json = (o) => JSON.stringify(o);
const rc = (address, type, after, unknown = {}) => ({
	address, type, mode: 'managed', provider_name: 'registry.terraform.io/hashicorp/aws',
	change: { actions: ['create'], before: null, after, after_unknown: unknown }
});
const cfg = (address, type, expressions) => ({ address, type, mode: 'managed', expressions });
const refs = (...r) => ({ references: r.flatMap((x) => [x + '.arn', x]) });

const plan = {
	format_version: '1.2',
	terraform_version: '1.9.5',
	resource_changes: [
		rc('aws_iam_role.app', 'aws_iam_role', {
			name: 'app',
			assume_role_policy: json({ Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'lambda.amazonaws.com' } }] })
		}),
		rc('aws_lambda_function.fn', 'aws_lambda_function', { function_name: 'fn' }, { role: true }),
		rc('aws_iam_policy.p', 'aws_iam_policy', {
			policy: json({
				Statement: [
					{ Sid: 'ReadLogs', Effect: 'Allow', Action: ['s3:GetObject'], Resource: 'arn:aws:s3:::logs-bucket/*' },
					{ Effect: 'Deny', Action: 's3:DeleteObject', Resource: 'arn:aws:s3:::logs-bucket/*' },
					{ Effect: 'Allow', Action: 'dynamodb:*', Resource: '*' }
				]
			})
		}),
		rc('aws_iam_role_policy_attachment.a', 'aws_iam_role_policy_attachment', {}),
		rc('aws_s3_bucket.logs', 'aws_s3_bucket', { bucket: 'logs-bucket' }),
		rc('aws_s3_bucket_policy.bp', 'aws_s3_bucket_policy', {
			policy: json({ Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::logs-bucket/*' }] })
		}),
		rc('aws_lambda_permission.api', 'aws_lambda_permission', { principal: 'apigateway.amazonaws.com', action: 'lambda:InvokeFunction' })
	],
	configuration: {
		root_module: {
			resources: [
				cfg('aws_iam_role.app', 'aws_iam_role', {}),
				cfg('aws_lambda_function.fn', 'aws_lambda_function', { role: refs('aws_iam_role.app') }),
				cfg('aws_iam_policy.p', 'aws_iam_policy', {}),
				cfg('aws_iam_role_policy_attachment.a', 'aws_iam_role_policy_attachment', {
					role: { references: ['aws_iam_role.app.name', 'aws_iam_role.app'] },
					policy_arn: refs('aws_iam_policy.p')
				}),
				cfg('aws_s3_bucket.logs', 'aws_s3_bucket', {}),
				cfg('aws_s3_bucket_policy.bp', 'aws_s3_bucket_policy', { bucket: { references: ['aws_s3_bucket.logs.id', 'aws_s3_bucket.logs'] } }),
				cfg('aws_lambda_permission.api', 'aws_lambda_permission', { function_name: { references: ['aws_lambda_function.fn.function_name', 'aws_lambda_function.fn'] } })
			]
		}
	}
};

suite('planGraph', () => {
	const g = buildGraph(plan);
	const find = (kind, from, to, effect = null) => g.edges.find((e) => e.kind === kind && e.from === from && e.to === to && e.effect === effect);

	test('execution role from configuration references', () => {
		assert.ok(find('runs-as', 'aws_lambda_function.fn', 'aws_iam_role.app'));
	});

	test('trust from a JSON assume-role policy', () => {
		const e = find('trust', 'ext:svc:lambda.amazonaws.com', 'aws_iam_role.app');
		assert.ok(e);
		assert.deepStrictEqual(e.actions, ['sts:AssumeRole']);
	});

	test('role uses the attached policy, which allows actions on matched ARNs', () => {
		assert.ok(find('attach', 'aws_iam_role.app', 'aws_iam_policy.p'));
		assert.deepStrictEqual(find('perm', 'aws_iam_policy.p', 'aws_s3_bucket.logs').actions, ['s3:GetObject']);
		assert.deepStrictEqual(find('perm', 'aws_iam_policy.p', 'aws_s3_bucket.logs', 'Deny').actions, ['s3:DeleteObject']);
		assert.deepStrictEqual(find('perm', 'aws_iam_policy.p', 'ext:*').actions, ['dynamodb:*']);
		assert.ok(!g.edges.some((e) => e.kind === 'perm' && e.from === 'aws_iam_role.app'), 'permissions go through the policy node');
	});

	test('perm edges keep the Sid of the statements behind them', () => {
		assert.deepStrictEqual(find('perm', 'aws_iam_policy.p', 'aws_s3_bucket.logs').statements, [{ sid: 'ReadLogs', actions: ['s3:GetObject'], conditions: [] }]);
		assert.deepStrictEqual(find('perm', 'aws_iam_policy.p', 'ext:*').statements, [{ sid: null, actions: ['dynamodb:*'], conditions: [] }]);
	});

	test('resource policies: principals use the policy, which allows on the resource', () => {
		assert.ok(find('attach', 'ext:anyone', 'aws_s3_bucket_policy.bp'));
		assert.deepStrictEqual(find('perm', 'aws_s3_bucket_policy.bp', 'aws_s3_bucket.logs').actions, ['s3:GetObject']);
		assert.ok(find('attach', 'ext:svc:apigateway.amazonaws.com', 'aws_lambda_permission.api'));
		assert.deepStrictEqual(find('perm', 'aws_lambda_permission.api', 'aws_lambda_function.fn').actions, ['lambda:InvokeFunction']);
	});

	test('EC2 instance runs as the role of its instance profile', () => {
		const ec2 = buildGraph({
			format_version: '1.2',
			terraform_version: '1.9.5',
			resource_changes: [rc('aws_iam_role.web', 'aws_iam_role', {}), rc('aws_iam_instance_profile.web', 'aws_iam_instance_profile', {}), rc('aws_instance.web', 'aws_instance', {})],
			configuration: {
				root_module: {
					resources: [
						cfg('aws_iam_role.web', 'aws_iam_role', {}),
						cfg('aws_iam_instance_profile.web', 'aws_iam_instance_profile', { role: { references: ['aws_iam_role.web.name', 'aws_iam_role.web'] } }),
						cfg('aws_instance.web', 'aws_instance', { iam_instance_profile: { references: ['aws_iam_instance_profile.web.name', 'aws_iam_instance_profile.web'] } })
					]
				}
			}
		});
		const e = ec2.edges.find((x) => x.kind === 'runs-as' && x.from === 'aws_instance.web');
		assert.strictEqual(e && e.to, 'aws_iam_role.web');
	});

	test('only IAM relationships are kept', () => {
		assert.deepStrictEqual([...new Set(g.edges.map((e) => e.kind))].sort(), ['attach', 'perm', 'runs-as', 'trust']);
		const ext = g.nodes.filter((n) => n.kind === 'external').map((n) => n.id).sort();
		assert.deepStrictEqual(ext, ['ext:*', 'ext:anyone', 'ext:svc:apigateway.amazonaws.com', 'ext:svc:lambda.amazonaws.com']);
		assert.ok(!g.nodes.some((n) => n.id === 'aws_iam_role_policy_attachment.a'), 'attachments are links, not nodes');
	});
});

suite('planGraph — external resources, modules, wildcards, groups', () => {
	const ext = (r) => ({ references: [r + '.arn', r] });
	const plan = {
		format_version: '1.2',
		terraform_version: '1.9.5',
		resource_changes: [
			rc('aws_iam_role.app', 'aws_iam_role', { name: 'app', permissions_boundary: 'arn:aws:iam::111122223333:policy/boundary' }),
			rc('module.app.aws_lambda_function.fn', 'aws_lambda_function', {}, { role: true }),
			rc('aws_lambda_function.legacy', 'aws_lambda_function', { role: 'arn:aws:iam::111122223333:role/service/legacy-role' }),
			rc('aws_s3_bucket.logs_a', 'aws_s3_bucket', { bucket: 'logs-a' }),
			rc('aws_s3_bucket.logs_b', 'aws_s3_bucket', { bucket: 'logs-b' }),
			rc('aws_s3_bucket.data', 'aws_s3_bucket', { bucket: 'data-x' }),
			rc('aws_iam_policy.wild', 'aws_iam_policy', {
				policy: JSON.stringify({
					Statement: [
						{ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::logs-*/*', Condition: { Bool: { 'aws:SecureTransport': 'true' } } },
						{ Effect: 'Allow', Action: 'dynamodb:Query', Resource: 'arn:aws:dynamodb:eu-west-1:111122223333:table/orders' }
					]
				})
			}),
			rc('aws_iam_user.alice', 'aws_iam_user', { name: 'alice' }),
			rc('aws_iam_group.devs', 'aws_iam_group', { name: 'devs' }),
			rc('aws_iam_user_group_membership.alice', 'aws_iam_user_group_membership', {}),
			rc('aws_iam_group_policy_attachment.devs', 'aws_iam_group_policy_attachment', {}),
			rc('aws_api_gateway_rest_api.api', 'aws_api_gateway_rest_api', { id: 'abc123' }),
			rc('aws_api_gateway_rest_api_policy.api', 'aws_api_gateway_rest_api_policy', {
				rest_api_id: 'abc123',
				policy: JSON.stringify({ Statement: [{ Effect: 'Allow', Principal: '*', Action: 'execute-api:Invoke', Resource: '*' }] })
			})
		],
		configuration: {
			root_module: {
				resources: [
					cfg('aws_iam_role.app', 'aws_iam_role', {}),
					cfg('aws_lambda_function.legacy', 'aws_lambda_function', {}),
					cfg('aws_s3_bucket.logs_a', 'aws_s3_bucket', {}),
					cfg('aws_s3_bucket.logs_b', 'aws_s3_bucket', {}),
					cfg('aws_s3_bucket.data', 'aws_s3_bucket', {}),
					cfg('aws_iam_policy.wild', 'aws_iam_policy', {}),
					cfg('aws_iam_user.alice', 'aws_iam_user', {}),
					cfg('aws_iam_group.devs', 'aws_iam_group', {}),
					cfg('aws_iam_user_group_membership.alice', 'aws_iam_user_group_membership', {
						user: { references: ['aws_iam_user.alice.name', 'aws_iam_user.alice'] },
						groups: { references: ['aws_iam_group.devs.name', 'aws_iam_group.devs'] }
					}),
					cfg('aws_iam_group_policy_attachment.devs', 'aws_iam_group_policy_attachment', {
						group: { references: ['aws_iam_group.devs.name', 'aws_iam_group.devs'] },
						policy_arn: ext('aws_iam_policy.wild')
					}),
					cfg('aws_api_gateway_rest_api.api', 'aws_api_gateway_rest_api', {}),
					cfg('aws_api_gateway_rest_api_policy.api', 'aws_api_gateway_rest_api_policy', {})
				],
				module_calls: {
					app: {
						source: 'git::https://github.com/acme/terraform-aws-app.git?ref=v2',
						expressions: { role_arn: ext('aws_iam_role.app') },
						module: { resources: [cfg('aws_lambda_function.fn', 'aws_lambda_function', { role: { references: ['var.role_arn'] } })] }
					}
				}
			}
		}
	};
	const g = buildGraph(plan);
	const find = (kind, from, to) => g.edges.find((e) => e.kind === kind && e.from === from && e.to === to);
	const node = (id) => g.nodes.find((n) => n.id === id);

	test('references through module variables', () => {
		assert.ok(find('runs-as', 'module.app.aws_lambda_function.fn', 'aws_iam_role.app'));
	});

	test('module calls are listed with their source', () => {
		assert.deepStrictEqual(g.modules, { 'module.app': { source: 'git::https://github.com/acme/terraform-aws-app.git?ref=v2', version: null } });
	});

	test('resources outside the project are recognised from their ARN', () => {
		const role = 'ext:arn:aws:iam::111122223333:role/service/legacy-role';
		assert.ok(find('runs-as', 'aws_lambda_function.legacy', role));
		assert.deepStrictEqual([node(role).kind, node(role).label, node(role).detail], ['external', 'legacy-role', 'IAM role · 111122223333']);
		const table = node('ext:arn:aws:dynamodb:eu-west-1:111122223333:table/orders');
		assert.deepStrictEqual([table.label, table.detail, table.iconType], ['orders', 'DynamoDB table · 111122223333', 'aws_dynamodb']);
	});

	test('wildcard ARNs match every resource of the project, conditions are kept', () => {
		for (const b of ['aws_s3_bucket.logs_a', 'aws_s3_bucket.logs_b']) {
			const e = find('perm', 'aws_iam_policy.wild', b);
			assert.deepStrictEqual(e.conditions, ['Bool aws:SecureTransport = true']);
		}
		assert.ok(!find('perm', 'aws_iam_policy.wild', 'aws_s3_bucket.data'));
	});

	test('users inherit the policies of their groups', () => {
		assert.ok(find('member', 'aws_iam_user.alice', 'aws_iam_group.devs'));
		assert.ok(find('attach', 'aws_iam_group.devs', 'aws_iam_policy.wild'));
	});

	test('permissions boundary and extended resource policies', () => {
		const b = find('boundary', 'aws_iam_role.app', 'ext:arn:aws:iam::111122223333:policy/boundary');
		assert.deepStrictEqual(b.labels, ['permissions boundary']);
		assert.ok(find('attach', 'ext:anyone', 'aws_api_gateway_rest_api_policy.api'));
		assert.deepStrictEqual(find('perm', 'aws_api_gateway_rest_api_policy.api', 'aws_api_gateway_rest_api.api').actions, ['execute-api:Invoke']);
	});

	test('log group ARN with the log-stream suffix (:*) matches the project log group', () => {
		const arn = 'arn:aws:logs:eu-west-3:111122223333:log-group:/aws/stepfunctions/app';
		const g = buildGraph({
			format_version: '1.2',
			resource_changes: [
				rc('aws_cloudwatch_log_group.sfn', 'aws_cloudwatch_log_group', { arn, name: '/aws/stepfunctions/app' }),
				rc('aws_iam_policy.logs', 'aws_iam_policy', {
					policy: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: 'logs:PutLogEvents', Resource: arn + ':*' }] })
				})
			],
			configuration: { root_module: { resources: [
				cfg('aws_cloudwatch_log_group.sfn', 'aws_cloudwatch_log_group', {}),
				cfg('aws_iam_policy.logs', 'aws_iam_policy', {})
			] } }
		});
		assert.ok(g.edges.some((e) => e.kind === 'perm' && e.from === 'aws_iam_policy.logs' && e.to === 'aws_cloudwatch_log_group.sfn'));
		assert.ok(!g.nodes.some((n) => n.kind === 'external' && n.id.includes('log-group')));
	});
});
