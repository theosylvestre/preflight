// Builds the IAM graph of a Terraform JSON plan, following how AWS models access:
//
//   resource ──runs-as──▶ role ──attach──▶ policy ──perm (actions)──▶ resource
//   principal ──trust──▶ role              (assume-role / trust policy)
//   user ──member──▶ group ──attach──▶ policy
//   principal ──boundary──▶ policy         (permissions boundary / SCP: limits, not grants)
//
// Policies are nodes: customer policies (aws_iam_policy), inline policies
// (aws_iam_role_policy…, inline_policy blocks), AWS managed policies, resource policies
// (bucket policy, KMS key policy, aws_lambda_permission…) whose principals "use" them.
//
// Anything only referenced (an ARN, a role / user / group name) becomes an "external" node,
// recognised from its ARN (service, type, account), and gets the same treatment. References
// passed through module variables and outputs are followed.
//
// Output: { nodes, edges }
//   node: { id, label, type, kind: 'resource' | 'external', action, module, iconType, detail? }
//   modules: { 'module.a.module.b': { source, version } }
//   edge: { from, to, kind, labels[], actions[], via[], conditions[], effect, statements[] }
//   statement: { sid, actions[], conditions[] } — the policy statements behind a perm / trust edge
//   kind: 'runs-as' | 'trust' | 'attach' | 'perm' | 'member' | 'boundary'

function isObj(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function arr(v) {
	if (v === undefined || v === null) return [];
	return Array.isArray(v) ? v : [v];
}

function stripIdx(a) {
	return a.replace(/\[[^\]]*\]/g, '');
}

function constOf(e) {
	return isObj(e) && 'constant_value' in e ? e.constant_value : undefined;
}

function actionOf(actions) {
	const a = (actions || []).join(',');
	if (a === 'create' || a === 'update' || a === 'delete' || a === 'read' || a === 'forget') return a;
	if (a === 'no-op') return 'noop';
	if (a.includes('create') && (a.includes('delete') || a.includes('forget'))) return 'replace';
	return 'noop';
}

// Every resource declared in the configuration (root + nested modules), plus the module
// calls (variable expressions) and outputs needed to follow references across modules.
function collectConfig(plan) {
	const configs = [], calls = new Map(), outputs = new Map();
	(function walk(mod, prefix, parent, expressions, source) {
		if (!mod) return;
		if (prefix) calls.set(prefix, { parent, expressions: expressions || {}, source });
		outputs.set(prefix, mod.outputs || {});
		for (const r of mod.resources || []) {
			configs.push({ base: prefix + r.address, prefix, type: r.type, mode: r.mode, expr: r.expressions || {}, dependsOn: r.depends_on || [] });
		}
		for (const [name, call] of Object.entries(mod.module_calls || {})) {
			walk(call.module, prefix + 'module.' + name + '.', prefix, call.expressions, { source: call.source || null, version: call.version_constraint || null });
		}
	})(plan.configuration && plan.configuration.root_module, '', null, null);
	return { configs, calls, outputs };
}

// All { path, refs } found in an expression tree (nested blocks included).
function exprRefs(expr) {
	const out = [];
	(function walk(e, path) {
		if (Array.isArray(e)) return e.forEach((x) => walk(x, path));
		if (!isObj(e)) return;
		if (Array.isArray(e.references)) out.push({ path, refs: e.references });
		if ('references' in e || 'constant_value' in e) return;
		for (const [k, v] of Object.entries(e)) walk(v, path ? path + '.' + k : k);
	})(expr, '');
	return out;
}

// String leaves of a value tree whose key path matches `re`: [{ path, value }].
function stringLeaves(v, re) {
	const out = [];
	(function walk(x, path) {
		if (typeof x === 'string') { if (re.test(path)) out.push({ path, value: x }); return; }
		if (Array.isArray(x)) return x.forEach((y) => walk(y, path));
		if (!isObj(x)) return;
		for (const [k, y] of Object.entries(x)) walk(y, path ? path + '.' + k : k);
	})(v, '');
	return out;
}

// --- ARNs ---------------------------------------------------------------------

// ARN service → Terraform-like type prefix used to pick an icon.
const ARN_ICON = {
	'execute-api': 'api_gateway', apigateway: 'api_gateway', es: 'opensearch', aoss: 'opensearch', logs: 'cloudwatch',
	monitoring: 'cloudwatch', states: 'sfn', events: 'cloudwatch_event', elasticloadbalancing: 'lb', 'ecs-tasks': 'ecs',
	edgelambda: 'lambda', firehose: 'kinesis_firehose', 'elasticfilesystem': 'efs', backup: 'backup', sts: 'iam'
};
const SERVICE_NAMES = {
	iam: 'IAM', s3: 'S3', kms: 'KMS', sqs: 'SQS', sns: 'SNS', lambda: 'Lambda', dynamodb: 'DynamoDB', logs: 'CloudWatch Logs',
	states: 'Step Functions', events: 'EventBridge', secretsmanager: 'Secrets Manager', ssm: 'SSM', ecr: 'ECR', ec2: 'EC2',
	rds: 'RDS', glue: 'Glue', kinesis: 'Kinesis', firehose: 'Firehose', 'execute-api': 'API Gateway', apigateway: 'API Gateway',
	es: 'OpenSearch', elasticloadbalancing: 'ELB', sts: 'STS', ecs: 'ECS', eks: 'EKS', elasticfilesystem: 'EFS', backup: 'Backup'
};

function iconTypeOf(service) {
	return 'aws_' + (ARN_ICON[service] || service.replace(/-/g, '_'));
}

/** arn:partition:service:region:account:resource → parts, or null. */
function parseArn(arn) {
	const m = /^arn:(aws[\w-]*):([\w-]+):([\w-]*):(\d{12}|aws)?:(.*)$/.exec(arn);
	if (!m) return null;
	const [, , service, region, account, res] = m;
	let rtype = '', name = res;
	if (service === 's3') rtype = res.includes('/') ? 'object' : 'bucket';
	else if (service === 'sqs') rtype = 'queue';
	else if (service === 'sns') rtype = 'topic';
	else {
		const i = res.search(/[:/]/);
		if (i > 0) { rtype = res.slice(0, i); name = res.slice(i + 1); }
	}
	return { service, region, account: account || '', rtype, name };
}

function globRe(pattern) {
	return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

const ICON_SERVICE = { 'ecs-tasks': 'ecs', states: 'sfn', events: 'cloudwatch_event', logs: 'cloudwatch', monitoring: 'cloudwatch', edgelambda: 'lambda' };

function serviceType(principal) {
	const svc = principal.split('.')[0];
	return 'aws_' + (ICON_SERVICE[svc] || svc.replace(/-/g, '_'));
}

// Condition block(s) → readable strings ("StringEquals aws:SourceAccount = 123").
function conditionStrings(cond) {
	const out = [];
	if (isObj(cond)) {
		for (const [op, kv] of Object.entries(cond)) {
			if (!isObj(kv)) continue;
			for (const [k, v] of Object.entries(kv)) out.push(op + ' ' + k + ' = ' + arr(v).join(', '));
		}
	}
	return out;
}

// Resource policies: type → [policy attribute, attribute naming the protected resource
// ('self': the resource itself, null: the statements' Resource)].
const RESOURCE_POLICIES = {
	aws_s3_bucket_policy: ['policy', 'bucket'],
	aws_s3_bucket: ['policy', 'self'],
	aws_s3_access_point: ['policy', 'self'],
	aws_s3control_access_point_policy: ['policy', 'access_point_arn'],
	aws_s3control_bucket_policy: ['policy', 'bucket'],
	aws_sqs_queue_policy: ['policy', 'queue_url'],
	aws_sqs_queue: ['policy', 'self'],
	aws_sns_topic_policy: ['policy', 'arn'],
	aws_sns_topic: ['policy', 'self'],
	aws_kms_key: ['policy', 'self'],
	aws_kms_key_policy: ['policy', 'key_id'],
	aws_ecr_repository_policy: ['policy', 'repository'],
	aws_ecrpublic_repository_policy: ['policy', 'repository_name'],
	aws_secretsmanager_secret_policy: ['policy', 'secret_arn'],
	aws_secretsmanager_secret: ['policy', 'self'],
	aws_api_gateway_rest_api_policy: ['policy', 'rest_api_id'],
	aws_api_gateway_rest_api: ['policy', 'self'],
	aws_opensearch_domain_policy: ['access_policies', 'domain_name'],
	aws_opensearch_domain: ['access_policies', 'self'],
	aws_elasticsearch_domain_policy: ['access_policies', 'domain_name'],
	aws_elasticsearch_domain: ['access_policies', 'self'],
	aws_cloudwatch_event_bus_policy: ['policy', 'event_bus_name'],
	aws_cloudwatch_log_resource_policy: ['policy_document', null],
	aws_efs_file_system_policy: ['policy', 'file_system_id'],
	aws_backup_vault_policy: ['policy', 'backup_vault_name'],
	aws_glue_resource_policy: ['policy', null],
	aws_dynamodb_resource_policy: ['policy', 'resource_arn'],
	aws_kinesis_resource_policy: ['policy', 'resource_arn'],
	aws_vpc_endpoint_policy: ['policy', 'vpc_endpoint_id'],
	aws_vpc_endpoint: ['policy', 'self'],
	aws_codeartifact_domain_permissions_policy: ['policy_document', 'domain'],
	aws_codeartifact_repository_permissions_policy: ['policy_document', 'repository'],
	aws_glacier_vault: ['access_policy', 'self'],
	aws_media_store_container_policy: ['policy', 'container_name'],
	aws_iot_policy: ['policy', null],
	aws_serverlessapplicationrepository_cloudformation_stack: ['policy', 'self']
};

class GraphBuilder {
	constructor(plan) {
		this.nodes = new Map();
		this.edges = new Map();
		const { configs, calls, outputs } = collectConfig(plan);
		this.configs = configs;
		this.calls = calls;
		this.outputs = outputs;
		this.bases = new Set(configs.map((c) => c.base));
		this.byBase = new Map(configs.map((c) => [c.base, c]));
		this.instances = new Map();
		this.values = new Map();
		this.arnIndex = new Map();
		this.idIndex = new Map();
		this.nameIndex = new Map();

		for (const rc of plan.resource_changes || []) {
			if (rc.deposed) continue;
			const ch = rc.change || {};
			const base = stripIdx(rc.address);
			if (!this.instances.has(base)) this.instances.set(base, []);
			this.instances.get(base).push(rc.address);
			const value = isObj(ch.after) ? ch.after : isObj(ch.before) ? ch.before : {};
			this.values.set(rc.address, { value, unknown: isObj(ch.after_unknown) ? ch.after_unknown : {} });
			this.nodes.set(rc.address, {
				id: rc.address, label: rc.address, type: rc.type, kind: 'resource',
				action: actionOf(ch.actions), module: rc.module_address || 'root', iconType: rc.type
			});
			this.index(rc.address, rc.type, value);
			if (isObj(ch.before) && ch.before !== value) this.index(rc.address, rc.type, ch.before);
		}
		// Resources only known from the configuration (e.g. data sources read during plan).
		for (const c of configs) {
			if (this.instances.has(c.base)) continue;
			this.instances.set(c.base, [c.base]);
			this.values.set(c.base, { value: {}, unknown: {} });
			this.nodes.set(c.base, {
				id: c.base, label: c.base, type: c.type, kind: 'resource', action: 'noop',
				module: c.prefix ? c.prefix.slice(0, -1) : 'root', iconType: c.type
			});
		}
		// Prior state values also help matching literal ARNs.
		for (const r of priorResources(plan)) {
			if (this.nodes.has(r.address)) this.index(r.address, r.type, r.values || {});
		}
	}

	index(id, type, v) {
		if (typeof v.arn === 'string') this.arnIndex.set(v.arn, id);
		if (type === 'aws_s3_bucket' && typeof v.bucket === 'string') this.arnIndex.set('arn:aws:s3:::' + v.bucket, id);
		if (typeof v.id === 'string' && v.id) this.idIndex.set(v.id, id);
		// IAM principals are also referenced by name (role = "my-role").
		const kind = { aws_iam_role: 'role', aws_iam_user: 'user', aws_iam_group: 'group' }[type];
		if (kind && typeof v.name === 'string') this.nameIndex.set(kind + ':' + v.name, id);
	}

	inst(base) {
		return this.instances.get(base) || [];
	}

	// Reference → resource base addresses. Follows module variables (to the caller's
	// expression) and module outputs (to the child's output expression).
	resolve(ref, prefix, depth = 0) {
		if (depth > 12) return [];
		const r = stripIdx(ref);
		const exact = prefix + r;
		if (this.bases.has(exact)) return [exact];
		const parts = r.split('.');
		if (parts[0] === 'var' && prefix && this.calls.has(prefix)) {
			const call = this.calls.get(prefix);
			const e = call.expressions[parts[1]];
			return isObj(e) && e.references ? this.resolveAll(e.references, call.parent, depth + 1) : [];
		}
		if (parts[0] === 'module' && parts.length >= 3) {
			const child = prefix + 'module.' + parts[1] + '.';
			const o = (this.outputs.get(child) || {})[parts[2]];
			return o && isObj(o.expression) && o.expression.references ? this.resolveAll(o.expression.references, child, depth + 1) : [];
		}
		const n = parts[0] === 'data' ? 3 : 2;
		if (parts.length < n) return [];
		const cand = prefix + parts.slice(0, n).join('.');
		return this.bases.has(cand) ? [cand] : [];
	}

	resolveAll(refs, prefix, depth = 0) {
		const out = new Set();
		for (const r of refs || []) for (const b of this.resolve(r, prefix, depth)) out.add(b);
		return [...out];
	}

	// Constant value of an expression, following module variables to the caller.
	constant(e, prefix, depth = 0) {
		if (constOf(e) !== undefined) return constOf(e);
		if (!isObj(e) || !Array.isArray(e.references) || depth > 12) return undefined;
		for (const ref of e.references) {
			const parts = stripIdx(ref).split('.');
			if (parts[0] !== 'var' || !this.calls.has(prefix)) continue;
			const call = this.calls.get(prefix);
			const v = this.constant(call.expressions[parts[1]], call.parent, depth + 1);
			if (v !== undefined) return v;
		}
		return undefined;
	}

	external(id, label, iconType, sub, detail) {
		if (!this.nodes.has(id)) this.nodes.set(id, { id, label, type: sub, kind: 'external', action: null, module: null, iconType, detail: detail || null });
		return id;
	}

	// Node for an ARN outside the project (or a pattern), recognised from the ARN itself.
	externalArn(arn) {
		const a = parseArn(arn);
		if (!a) return null;
		if (a.service === 'iam' && a.rtype === 'policy' && a.account === 'aws') return this.managedPolicy(arn);
		if (a.service === 'iam' && a.rtype === '' && a.name === 'root') return this.account(a.account, true);
		const svc = SERVICE_NAMES[a.service] || a.service.toUpperCase();
		const label = a.service === 's3' ? a.name : a.name.split('/').filter(Boolean).pop() || a.name;
		const detail = svc + (a.rtype ? ' ' + a.rtype.replace(/-/g, ' ') : '') + (a.account && a.account !== 'aws' ? ' · ' + a.account : '');
		const node = this.external('ext:' + arn, label, iconTypeOf(a.service), 'arn', detail);
		this.nodes.get(node).arnType = a.service + ':' + a.rtype;
		return node;
	}

	// IAM principal referenced by name only.
	externalNamed(kind, name) {
		const known = this.nameIndex.get(kind + ':' + name);
		if (known) return known;
		const node = this.external('ext:iam:' + kind + '/' + name, name, 'aws_iam_' + kind, 'arn', 'IAM ' + kind);
		this.nodes.get(node).arnType = 'iam:' + kind;
		return node;
	}

	account(id, root) {
		return this.external('ext:acct:' + id, 'Account ' + id + (root ? ' (root)' : ''), 'aws_organizations', 'account');
	}

	managedPolicy(arn) {
		return this.external('ext:' + arn, arn.split('/').pop(), 'aws_iam_policy', 'managed-policy');
	}

	// Literal ARN / pattern / "*" from a policy → node ids.
	matchLiteral(lit) {
		if (typeof lit !== 'string') return [];
		if (lit === '*') return [this.external('ext:*', 'All resources (*)', null, 'wildcard')];
		if (this.arnIndex.has(lit)) return [this.arnIndex.get(lit)];
		const s3 = /^(arn:aws[\w-]*:s3:::[^/*?]+)(\/.*)?$/.exec(lit);
		if (s3 && this.arnIndex.has(s3[1])) return [this.arnIndex.get(s3[1])];
		if (/[*?]/.test(lit)) {
			const re = globRe(lit), hits = new Set();
			// Sub-resources: objects (bucket/*), indexes (table/t/*), log streams (log-group:g:*), versions (function:f:*).
			for (const [arn, id] of this.arnIndex) if (re.test(arn) || re.test(arn + '/x') || re.test(arn + ':x')) hits.add(id);
			if (hits.size) return [...hits];
		}
		const ext = this.externalArn(lit);
		return ext ? [ext] : [];
	}

	principal(type, id) {
		if (id === '*') return this.external('ext:anyone', 'Anyone (*)', null, 'anyone');
		if (typeof id !== 'string') return this.external('ext:' + type + ':' + JSON.stringify(id), String(id), null, String(type).toLowerCase());
		if (type === 'Service') return this.external('ext:svc:' + id, id, serviceType(id), 'service');
		if (this.arnIndex.has(id)) return this.arnIndex.get(id);
		if (/^\d{12}$/.test(id)) return this.account(id, false);
		if (id.startsWith('arn:')) return this.externalArn(id) || this.external('ext:' + id, id, null, 'aws');
		return this.external('ext:' + type + ':' + id, id, type === 'AWS' ? 'aws_iam' : null, type.toLowerCase());
	}

	edge(from, to, kind, opts = {}) {
		if (!from || !to || from === to) return;
		const effect = opts.effect || null;
		const key = from + '|' + to + '|' + kind + '|' + effect;
		let e = this.edges.get(key);
		if (!e) {
			e = { from, to, kind, effect, labels: new Set(), actions: new Set(), via: new Set(), conditions: new Set(), stmts: new Map() };
			this.edges.set(key, e);
		}
		if (opts.label) e.labels.add(opts.label);
		for (const a of opts.actions || []) e.actions.add(a);
		if (opts.via) e.via.add(opts.via);
		for (const c of opts.conditions || []) e.conditions.add(c);
		if (opts.actions && opts.actions.length) {
			const sid = opts.sid || null;
			if (!e.stmts.has(sid)) e.stmts.set(sid, { sid, actions: new Set(), conditions: new Set() });
			const st = e.stmts.get(sid);
			for (const a of opts.actions) st.actions.add(a);
			for (const c of opts.conditions || []) st.conditions.add(c);
		}
	}

	// --- Policy documents -------------------------------------------------------

	// Statements of the policy held by `attr` of instance `id` (config `cfg`).
	statementsOf(cfg, id, attr) {
		if (cfg.type === 'aws_iam_policy_document') return { stmts: this.docStatements(cfg, id), via: id };
		const e = cfg.expr[attr];
		const refs = isObj(e) ? e.references : undefined;
		const doc = this.resolveAll(refs, cfg.prefix).find((b) => this.byBase.get(b).type === 'aws_iam_policy_document');
		if (doc) {
			const docId = this.inst(doc)[0];
			return { stmts: this.docStatements(this.byBase.get(doc), docId), via: docId };
		}
		const v = this.values.get(id) || { value: {}, unknown: {} };
		const raw = v.value[attr] !== undefined && v.value[attr] !== null ? v.value[attr] : this.constant(e, cfg.prefix);
		if (typeof raw === 'string' && raw) {
			try {
				return { stmts: this.jsonStatements(JSON.parse(raw)), via: null };
			} catch {
				/* not JSON */
			}
		}
		if (v.unknown[attr] === true && refs) {
			// jsonencode() depending on unknown values: we only know which resources it mentions.
			const targets = this.resolveAll(refs, cfg.prefix).filter((b) => !this.byBase.get(b).type.startsWith('aws_iam_'));
			return { stmts: [{ effect: 'Allow', actions: ['(known after apply)'], targets: targets.flatMap((b) => this.inst(b)), principals: [], conditions: [] }], via: null };
		}
		return null;
	}

	docStatements(cfg, id) {
		const exprs = arr(cfg.expr.statement);
		const after = arr((this.values.get(id) || { value: {} }).value.statement);
		const n = Math.max(exprs.length, after.length);
		const out = [];
		const val = (e, a) => (constOf(e) !== undefined ? constOf(e) : this.constant(e, cfg.prefix) !== undefined ? this.constant(e, cfg.prefix) : a);
		for (let i = 0; i < n; i++) {
			const e = exprs[i] || {}, a = after[i] || {};
			const targets = [];
			for (const key of ['resources', 'not_resources']) {
				if (isObj(e[key])) for (const b of this.resolveAll(e[key].references, cfg.prefix)) if (key === 'resources') targets.push(...this.inst(b));
			}
			for (const l of arr(val(e.resources, a.resources))) targets.push(...this.matchLiteral(l));
			const notResources = arr(val(e.not_resources, a.not_resources));
			if (notResources.length && !targets.length) targets.push(...this.matchLiteral('*'));
			const principals = arr(e.principals).map((p, j) => {
				const ap = arr(a.principals)[j] || {};
				const type = val(p.type, ap.type) || 'AWS';
				const ids = arr(val(p.identifiers, ap.identifiers));
				const refIds = isObj(p.identifiers) ? this.resolveAll(p.identifiers.references, cfg.prefix).flatMap((b) => this.inst(b)) : [];
				return { type, ids, nodes: refIds };
			});
			const actions = arr(val(e.actions, a.actions));
			const notActions = arr(val(e.not_actions, a.not_actions)).map((x) => 'not ' + x);
			const conditions = arr(e.condition).map((c, j) => {
				const ac = arr(a.condition)[j] || {};
				return val(c.test, ac.test) + ' ' + val(c.variable, ac.variable) + ' = ' + arr(val(c.values, ac.values)).join(', ');
			});
			if (notResources.length) conditions.push('except ' + notResources.join(', '));
			const all = actions.concat(notActions);
			out.push({
				sid: val(e.sid, a.sid) || null,
				effect: val(e.effect, a.effect) || 'Allow',
				actions: all.length ? all : ['(unknown)'],
				targets,
				principals,
				conditions
			});
		}
		return out;
	}

	jsonStatements(doc) {
		return arr(doc && doc.Statement).map((s) => {
			const principals = [];
			if (s.Principal === '*') principals.push({ type: '*', ids: ['*'], nodes: [] });
			else if (isObj(s.Principal)) {
				for (const [type, ids] of Object.entries(s.Principal)) principals.push({ type, ids: arr(ids), nodes: [] });
			}
			const conditions = conditionStrings(s.Condition);
			let targets = arr(s.Resource).flatMap((r) => this.matchLiteral(r));
			if (!targets.length && s.NotResource) {
				targets = this.matchLiteral('*');
				conditions.push('except ' + arr(s.NotResource).join(', '));
			}
			const actions = arr(s.Action).concat(arr(s.NotAction).map((a) => 'not ' + a));
			return { sid: typeof s.Sid === 'string' && s.Sid ? s.Sid : null, effect: s.Effect || 'Allow', actions: actions.length ? actions : ['(unknown)'], targets, principals, conditions };
		});
	}

	principalNodes(stmt) {
		const out = [...stmt.principals.flatMap((p) => p.nodes)];
		for (const p of stmt.principals) for (const id of p.ids) out.push(this.principal(p.type, id));
		return out;
	}

	// policy ──perm──▶ each resource its statements target.
	allow(policy, stmts, via, onto) {
		for (const s of stmts) {
			for (const t of onto || s.targets) {
				this.edge(policy, t, 'perm', { actions: s.actions, via, effect: s.effect === 'Deny' ? 'Deny' : null, conditions: s.conditions, sid: s.sid });
			}
		}
	}

	// --- Helpers over a configuration entry ---------------------------------------

	refsOf(c, attrs) {
		return attrs
			.flatMap((a) => this.resolveAll(isObj(c.expr[a]) ? c.expr[a].references : [], c.prefix))
			.flatMap((b) => this.inst(b));
	}

	// Values of `attrs` (instance values, else constants), as a flat list of strings.
	stringsOf(c, id, attrs) {
		const v = (this.values.get(id) || { value: {} }).value;
		return attrs.flatMap((a) => arr(v[a] !== undefined && v[a] !== null ? v[a] : this.constant(c.expr[a], c.prefix)))
			.filter((x) => typeof x === 'string' && x);
	}

	// IAM principals named by role(s) / user(s) / group(s): references, else ARNs or names.
	principalsOf(c, id, attrs) {
		const refs = this.refsOf(c, attrs);
		if (refs.length) return refs;
		const out = [];
		for (const a of attrs) {
			const kind = a.replace(/s$/, '');
			for (const s of this.stringsOf(c, id, [a])) out.push(s.startsWith('arn:') ? this.principal('AWS', s) : this.externalNamed(kind, s));
		}
		return out;
	}

	// Policy ARN attribute → policy node (in project, AWS managed, or external customer policy).
	policiesOf(c, id, attr) {
		const refs = this.refsOf(c, [attr]);
		if (refs.length) return refs;
		return this.stringsOf(c, id, [attr]).map((arn) => this.arnIndex.get(arn) || this.externalArn(arn)).filter(Boolean);
	}

	// Resource protected by a resource policy: reference, else ARN / id / name value.
	protectedOf(c, id, attr) {
		const refs = this.refsOf(c, [attr]);
		if (refs.length) return refs;
		return this.stringsOf(c, id, [attr]).flatMap((s) => {
			if (this.idIndex.has(s)) return [this.idIndex.get(s)];
			return s.startsWith('arn:') ? this.matchLiteral(s) : [];
		});
	}

	// --- Passes -----------------------------------------------------------------

	// resource ──runs-as──▶ role: role / role_arn / execution_role_arn…, or an EC2 instance
	// profile. Roles in the project are found through references; others from their ARN.
	executionRoles() {
		const profileRoles = new Map();
		for (const c of this.configs) {
			if (c.type !== 'aws_iam_instance_profile') continue;
			for (const id of this.inst(c.base)) profileRoles.set(id, this.principalsOf(c, id, ['role']));
		}
		const rolesOf = (t) => {
			const n = this.nodes.get(t);
			if (!n) return [];
			if (n.type === 'aws_iam_role' || n.arnType === 'iam:role') return [t];
			if (n.type === 'aws_iam_instance_profile') return profileRoles.get(t) || [];
			if (n.arnType === 'iam:instance-profile') return [t];
			return [];
		};
		for (const c of this.configs) {
			if (c.type.startsWith('aws_iam_')) continue;
			for (const from of this.inst(c.base)) {
				for (const x of exprRefs(c.expr)) {
					if (!/role|instance_profile/i.test(x.path)) continue;
					for (const t of this.resolveAll(x.refs, c.prefix)) {
						for (const i of this.inst(t)) for (const r of rolesOf(i)) this.edge(from, r, 'runs-as', { label: x.path });
					}
				}
				const v = (this.values.get(from) || { value: {} }).value;
				for (const { path, value } of stringLeaves(v, /(^|\.)[\w]*(role|instance_profile)[\w]*$/i)) {
					if (!/^arn:aws[\w-]*:iam::\d{12}:(role|instance-profile)\//.test(value)) continue;
					const t = this.arnIndex.get(value) || this.externalArn(value);
					for (const r of rolesOf(t)) this.edge(from, r, 'runs-as', { label: path });
				}
			}
		}
	}

	policies() {
		// Inline policies declared as aws_iam_role_policy resources also show up in the role's
		// `inline_policy` blocks (state / refreshed plan): only keep one of them.
		const inlineNames = new Set();
		for (const c of this.configs) {
			if (c.type !== 'aws_iam_role_policy') continue;
			for (const id of this.inst(c.base)) {
				const v = (this.values.get(id) || { value: {} }).value;
				if (typeof v.name === 'string') inlineNames.add(v.name);
			}
		}

		for (const c of this.configs) {
			for (const id of this.inst(c.base)) {
				const v = (this.values.get(id) || { value: {} }).value;
				switch (c.type) {
					case 'aws_iam_role_policy':
					case 'aws_iam_user_policy':
					case 'aws_iam_group_policy': {
						for (const p of this.principalsOf(c, id, ['role', 'user', 'group'])) this.edge(p, id, 'attach', { via: id });
						const doc = this.statementsOf(c, id, 'policy');
						if (doc) this.allow(id, doc.stmts, doc.via);
						break;
					}
					case 'aws_iam_policy': {
						const doc = this.statementsOf(c, id, 'policy');
						if (doc) this.allow(id, doc.stmts, doc.via);
						break;
					}
					case 'aws_iam_role_policy_attachment':
					case 'aws_iam_user_policy_attachment':
					case 'aws_iam_group_policy_attachment':
					case 'aws_iam_policy_attachment': {
						const principals = this.principalsOf(c, id, ['role', 'roles', 'user', 'users', 'group', 'groups']);
						for (const pol of this.policiesOf(c, id, 'policy_arn')) for (const p of principals) this.edge(p, pol, 'attach', { via: id });
						break;
					}
					case 'aws_iam_role':
					case 'aws_iam_user': {
						if (c.type === 'aws_iam_role') {
							const trust = this.statementsOf(c, id, 'assume_role_policy');
							if (trust) {
								for (const s of trust.stmts) {
									for (const p of this.principalNodes(s)) this.edge(p, id, 'trust', { actions: s.actions, via: trust.via || id, conditions: s.conditions, sid: s.sid });
								}
							}
							for (const pol of this.policiesOf(c, id, 'managed_policy_arns')) this.edge(id, pol, 'attach', { via: id });
							for (const ip of arr(v.inline_policy)) {
								if (!isObj(ip) || typeof ip.policy !== 'string' || !ip.policy || inlineNames.has(ip.name)) continue;
								try {
									const stmts = this.jsonStatements(JSON.parse(ip.policy));
									const pol = this.external('inline:' + id + ':' + (ip.name || ''), ip.name || 'inline policy', 'aws_iam_policy', 'inline-policy');
									this.edge(id, pol, 'attach', { via: id });
									this.allow(pol, stmts, null);
								} catch {
									/* not JSON */
								}
							}
						}
						for (const pol of this.policiesOf(c, id, 'permissions_boundary')) this.edge(id, pol, 'boundary', { label: 'permissions boundary', via: id });
						break;
					}
					case 'aws_iam_user_group_membership':
					case 'aws_iam_group_membership': {
						const users = this.principalsOf(c, id, ['user', 'users']);
						const groups = this.principalsOf(c, id, ['group', 'groups']);
						for (const u of users) for (const g of groups) this.edge(u, g, 'member', { via: id });
						break;
					}
					case 'aws_organizations_policy': {
						const doc = this.statementsOf(c, id, 'content');
						if (doc) this.allow(id, doc.stmts, doc.via);
						break;
					}
					case 'aws_organizations_policy_attachment': {
						const targets = this.refsOf(c, ['target_id']).concat(
							this.refsOf(c, ['target_id']).length ? [] : this.stringsOf(c, id, ['target_id']).map((t) => /^\d{12}$/.test(t) ? this.account(t) : this.external('ext:org:' + t, t, 'aws_organizations', 'org-unit')));
						for (const pol of this.refsOf(c, ['policy_id'])) for (const t of targets) this.edge(t, pol, 'boundary', { label: 'service control policy', via: id });
						break;
					}
					case 'aws_lambda_permission': {
						// The permission is a resource policy statement on the function.
						const who = this.stringsOf(c, id, ['principal'])[0];
						const action = this.stringsOf(c, id, ['action'])[0] || 'lambda:InvokeFunction';
						if (who) this.edge(/\.amazonaws\.com$/.test(who) ? this.principal('Service', who) : this.principal('AWS', who), id, 'attach', { via: id });
						const conditions = this.stringsOf(c, id, ['source_arn']).map((a) => 'ArnLike aws:SourceArn = ' + a)
							.concat(this.stringsOf(c, id, ['source_account']).map((a) => 'StringEquals aws:SourceAccount = ' + a));
						const sid = this.stringsOf(c, id, ['statement_id'])[0];
						for (const f of this.protectedOf(c, id, 'function_name')) this.edge(id, f, 'perm', { actions: [action], via: id, conditions, sid });
						break;
					}
					default: {
						// Resource policies: principals named in the statements use the policy, which
						// allows its actions on the protected resource.
						const spec = RESOURCE_POLICIES[c.type];
						if (!spec) break;
						const [attr, target] = spec;
						const doc = this.statementsOf(c, id, attr);
						if (!doc) break;
						const onto = target === 'self' ? [id] : target ? this.protectedOf(c, id, target) : null;
						const pol = target === 'self' ? this.external('policy:' + id, id + ' policy', c.type, 'resource-policy') : id;
						for (const s of doc.stmts) {
							for (const p of this.principalNodes(s)) this.edge(p, pol, 'attach', { via: id });
						}
						this.allow(pol, doc.stmts, doc.via || id, onto);
					}
				}
			}
		}
	}

	build() {
		this.executionRoles();
		this.policies();
		const edges = [...this.edges.values()].map((e) => ({
			from: e.from, to: e.to, kind: e.kind, effect: e.effect,
			labels: [...e.labels], actions: [...e.actions].sort(), via: [...e.via], conditions: [...e.conditions],
			statements: [...e.stmts.values()].map((s) => ({ sid: s.sid, actions: [...s.actions].sort(), conditions: [...s.conditions] }))
		}));
		const used = new Set(edges.flatMap((e) => [e.from, e.to]));
		const nodes = [...this.nodes.values()].filter((n) => used.has(n.id));
		// Module calls (address without instance keys → source), to group their resources.
		const modules = {};
		for (const [prefix, call] of this.calls) if (call.source && call.source.source) modules[prefix.slice(0, -1)] = call.source;
		return { nodes, edges, modules };
	}
}

function priorResources(plan) {
	const out = [];
	(function walk(mod) {
		if (!mod) return;
		out.push(...(mod.resources || []));
		for (const c of mod.child_modules || []) walk(c);
	})(plan.prior_state && plan.prior_state.values && plan.prior_state.values.root_module);
	return out;
}

/** @param {object} plan parsed `terraform show -json` output */
function buildGraph(plan) {
	return new GraphBuilder(plan).build();
}

module.exports = { buildGraph, parseArn };
