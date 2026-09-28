const assert = require('assert');
const { describeSource, sourceText } = require('../src/moduleSource');

suite('moduleSource', () => {
	const d = (source, version) => {
		const r = describeSource(source, version);
		return r && [r.kind, sourceText(r), r.url];
	};

	test('git sources: forced getter, scp-like, ssh, shorthand', () => {
		assert.deepStrictEqual(d('git::https://git.example.com/org/shared/terraform-aws-kms?ref=3.0.3'),
			['git', 'git.example.com/org/shared/terraform-aws-kms @ 3.0.3', 'https://git.example.com/org/shared/terraform-aws-kms']);
		assert.deepStrictEqual(d('git@github.com:org/repo.git?ref=v1'), ['git', 'github.com/org/repo @ v1', 'https://github.com/org/repo']);
		assert.deepStrictEqual(d('git::ssh://git@gitlab.com:22/org/repo.git//modules/x?ref=main'),
			['git', 'gitlab.com/org/repo//modules/x @ main', 'https://gitlab.com/org/repo']);
		assert.deepStrictEqual(d('github.com/hashicorp/example'), ['git', 'github.com/hashicorp/example', 'https://github.com/hashicorp/example']);
	});

	test('registry sources keep the version constraint', () => {
		assert.deepStrictEqual(d('terraform-aws-modules/vpc/aws', '~> 5.0'),
			['registry', 'terraform-aws-modules/vpc/aws @ ~> 5.0', 'https://registry.terraform.io/modules/terraform-aws-modules/vpc/aws']);
		assert.deepStrictEqual(d('app.terraform.io/acme/vpc/aws', '1.0'), ['registry', 'app.terraform.io/acme/vpc/aws @ 1.0', null]);
	});

	test('local and missing sources', () => {
		assert.deepStrictEqual(d('./modules/net'), ['local', './modules/net', null]);
		assert.strictEqual(describeSource(null), null);
	});
});
