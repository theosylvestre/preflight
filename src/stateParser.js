// Turns a Terraform state (raw `terraform.tfstate` v4, or `terraform show -json` output)
// into a plan-shaped document, so the same view model and graph builder can be reused.
//
// A state has no `configuration` section, so references between resources are inferred
// from values (an attribute equal to another resource's ARN / id / name, an s3:// URL…)
// and completed with the dependencies recorded in the state.

function isObj(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function stripIdx(a) {
	return a.replace(/\[[^\]]*\]/g, '');
}

function isRawState(doc) {
	return isObj(doc) && typeof doc.version === 'number' && Array.isArray(doc.resources) && !('format_version' in doc);
}

function isShowState(doc) {
	return isObj(doc) && 'format_version' in doc && isObj(doc.values) && !('resource_changes' in doc) && !('planned_values' in doc);
}

function isState(doc) {
	return isRawState(doc) || isShowState(doc);
}

function indexKey(k) {
	if (k === undefined || k === null) return '';
	return typeof k === 'number' ? '[' + k + ']' : '[' + JSON.stringify(k) + ']';
}

// Raw state `sensitive_attributes` (list of paths) → mirror object like `sensitive_values`.
function sensitiveMirror(paths) {
	const root = {};
	for (const path of paths || []) {
		const steps = Array.isArray(path) ? path : [];
		if (!steps.length) continue;
		let node = root;
		steps.forEach((s, i) => {
			const key = s && isObj(s.value) ? s.value.value : s && s.value;
			if (key === undefined) return;
			if (i === steps.length - 1) node[key] = true;
			else node = node[key] = isObj(node[key]) ? node[key] : {};
		});
	}
	return root;
}

// Flat list of { address, mode, type, name, module, provider, values, sensitive, deps, status }.
function collectInstances(doc) {
	const out = [];
	if (isRawState(doc)) {
		for (const r of doc.resources) {
			const prefix = (r.module ? r.module + '.' : '') + (r.mode === 'data' ? 'data.' : '');
			const provider = (/provider\["([^"]+)"\]/.exec(r.provider || '') || [])[1] || r.provider || '';
			for (const inst of r.instances || []) {
				out.push({
					address: prefix + r.type + '.' + r.name + indexKey(inst.index_key),
					mode: r.mode, type: r.type, name: r.name, module: r.module || null, provider,
					values: inst.attributes || {}, sensitive: sensitiveMirror(inst.sensitive_attributes),
					deps: inst.dependencies || [], status: inst.status || null, deposed: inst.deposed || null
				});
			}
		}
		return out;
	}
	(function walk(mod) {
		if (!mod) return;
		for (const r of mod.resources || []) {
			out.push({
				address: r.address, mode: r.mode, type: r.type, name: r.name, module: mod.address || null,
				provider: r.provider_name || '', values: r.values || {}, sensitive: r.sensitive_values || {},
				deps: r.depends_on || [], status: r.tainted ? 'tainted' : null, deposed: r.deposed_key || null
			});
		}
		for (const c of mod.child_modules || []) walk(c);
	})(doc.values && doc.values.root_module);
	return out;
}

// Attributes identifying a resource: common ones, plus type-specific ones (an aws_s3_object
// also has a `bucket`, but it names its parent, not itself).
const ID_KEYS = ['arn', 'id', 'name'];
const TYPE_ID_KEYS = { aws_s3_bucket: ['bucket'], aws_lambda_function: ['function_name'], aws_kms_key: ['key_id'] };
// Top-level attributes that never point at another resource (or duplicate a policy link).
const SKIP_KEYS = new Set(['tags', 'tags_all', 'inline_policy', 'policy', 'assume_role_policy']);

// References inferred from values: [{ path, target }].
function inferRefs(inst, index, arns, buckets) {
	const found = [];
	const self = stripIdx(inst.address);
	const match = (s) => {
		const hit = index.get(s);
		if (hit && hit !== self) return hit;
		for (const [arn, base] of arns) if (base !== self && (s.startsWith(arn + '/') || s.startsWith(arn + ':'))) return base;
		for (const [bucket, base] of buckets) if (base !== self && s.startsWith('s3://' + bucket + '/')) return base;
		return null;
	};
	(function walk(v, path, top) {
		if (typeof v === 'string') {
			if (v.length < 6 || /^\s*[[{]/.test(v)) return;
			const t = match(v);
			if (t) found.push({ path, target: t });
			return;
		}
		if (Array.isArray(v)) return v.forEach((x) => walk(x, path, false));
		if (!isObj(v)) return;
		for (const [k, x] of Object.entries(v)) {
			if (top && SKIP_KEYS.has(k)) continue;
			walk(x, path ? path + '.' + k : k, false);
		}
	})(inst.values, '', true);
	return found;
}

// Nested expression object carrying `references`, as in a plan `configuration`.
function setRef(expr, path, target) {
	const keys = path.split('.');
	let node = expr;
	keys.forEach((k, i) => {
		if (i === keys.length - 1) {
			node[k] = isObj(node[k]) && Array.isArray(node[k].references) ? node[k] : { references: [] };
			if (!node[k].references.includes(target)) node[k].references.push(target);
		} else {
			node = node[k] = isObj(node[k]) && !Array.isArray(node[k].references) ? node[k] : {};
		}
	});
}

/** State document → plan-shaped document (no-op / read changes + synthetic configuration). */
function stateToPlan(doc) {
	const insts = collectInstances(doc).filter((i) => !i.deposed);

	// Distinctive identifiers → owning resource (ambiguous values are dropped).
	const owners = new Map();
	const arns = [], buckets = [];
	for (const i of insts) {
		if (i.mode !== 'managed') continue;
		const base = stripIdx(i.address);
		for (const k of ID_KEYS.concat(TYPE_ID_KEYS[i.type] || [])) {
			const v = i.values[k];
			if (typeof v !== 'string' || v.length < 6) continue;
			if (!owners.has(v)) owners.set(v, new Set());
			owners.get(v).add(base);
		}
		if (typeof i.values.arn === 'string') arns.push([i.values.arn, base]);
		if (i.type === 'aws_s3_bucket' && typeof i.values.bucket === 'string') {
			buckets.push([i.values.bucket, base]);
			arns.push(['arn:aws:s3:::' + i.values.bucket, base]);
		}
	}
	// A value shared by several resources (e.g. a bucket name reused as the id of its
	// versioning / encryption resources) belongs to the only one that has an ARN.
	const hasArn = new Set(insts.filter((i) => typeof i.values.arn === 'string').map((i) => stripIdx(i.address)));
	const index = new Map();
	for (const [v, set] of owners) {
		const cands = set.size === 1 ? [...set] : [...set].filter((b) => hasArn.has(b));
		if (cands.length === 1) index.set(v, cands[0]);
	}

	const configs = new Map(), matched = new Map(), deps = new Map();
	for (const i of insts) {
		const base = stripIdx(i.address);
		const c = configs.get(base) || { address: base, mode: i.mode, type: i.type, expressions: {}, depends_on: [] };
		configs.set(base, c);
		if (!matched.has(base)) { matched.set(base, new Set()); deps.set(base, new Set()); }
		for (const d of i.deps) deps.get(base).add(stripIdx(d));
		if (i.type === 'aws_iam_policy_document') continue;
		for (const r of inferRefs(i, index, arns, buckets)) {
			setRef(c.expressions, r.path, r.target);
			matched.get(base).add(r.target);
		}
	}
	// Recorded dependencies are transitive: keep only those not already reached
	// through an inferred reference.
	for (const [base, c] of configs) {
		const reached = new Set();
		for (const t of matched.get(base)) {
			reached.add(t);
			for (const x of deps.get(t) || []) reached.add(x);
			for (const x of matched.get(t) || []) reached.add(x);
		}
		c.depends_on = [...deps.get(base)].filter((d) => !reached.has(d));
	}

	return {
		format_version: doc.format_version || '1.0',
		terraform_version: doc.terraform_version,
		resource_changes: insts.map((i) => ({
			address: i.address,
			module_address: i.module || undefined,
			mode: i.mode,
			type: i.type,
			name: i.name,
			provider_name: i.provider,
			status: i.status,
			change: {
				actions: [i.mode === 'data' ? 'read' : 'no-op'],
				before: i.mode === 'data' ? null : i.values,
				after: i.values,
				after_unknown: {},
				before_sensitive: i.sensitive,
				after_sensitive: i.sensitive
			}
		})),
		configuration: { root_module: { resources: [...configs.values()] } },
		state: {
			serial: doc.serial !== undefined ? doc.serial : null,
			lineage: doc.lineage || null,
			format: isRawState(doc) ? 'tfstate v' + doc.version : 'terraform show -json',
			outputs: Object.keys((isRawState(doc) ? doc.outputs : doc.values && doc.values.outputs) || {}).length
		}
	};
}

module.exports = { isState, stateToPlan };
