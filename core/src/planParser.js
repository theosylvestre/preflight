// Turns the output of `terraform show -json <plan>` into a view model:
// a list of resources, each with its diff lines.
//
// A line is a tuple [kind, depth, key, value, note?]:
//   kind  : 'a' (added), 'd' (removed), 'c' (unchanged), 'm' (modified)
//   depth : indentation level
//   key   : attribute name ('' for a list element or a closing bracket,
//           prefixed with '@' for a nested block: `key {`)
//   value : formatted value, or [before, after] for 'm'
//   note  : optional annotation (e.g. "forces replacement")

const { buildGraph } = require('./planGraph');
const { isState, stateToPlan } = require('./stateParser');

const UNKNOWN = '(known after apply)';
const SENSITIVE = '(sensitive value)';
const IDENT = /^[a-z_][a-z0-9_-]*$/;
const JSON_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const REASONS = {
	replace_because_tainted: 'the object is tainted',
	replace_because_cannot_update: 'a change forces replacement',
	replace_by_request: 'replacement requested with -replace',
	replace_by_triggers: 'triggered by replace_triggered_by',
	delete_because_no_resource_config: 'not in configuration',
	delete_because_no_module: 'its module no longer exists',
	delete_because_wrong_repetition: 'wrong repetition mode (count / for_each)',
	delete_because_count_index: 'count index out of range',
	delete_because_each_key: 'for_each key no longer exists',
	delete_because_no_move_target: 'moved target does not exist',
	read_because_config_unknown: 'config depends on values not yet known',
	read_because_dependency_pending: 'a dependency has pending changes',
	read_because_check_nested: 'read by a check block'
};

function isAbsent(v) {
	return v === undefined || v === null;
}

function isObj(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Walks down a "mirror" structure (after_unknown, *_sensitive):
// `true` applies to the whole subtree.
function sub(mirror, k) {
	if (mirror === true) return true;
	if (mirror !== null && typeof mirror === 'object') return mirror[k];
	return undefined;
}

function fmt(v) {
	if (typeof v === 'string') return JSON.stringify(v);
	return String(v);
}

function fmtKey(k, quote) {
	if (typeof k === 'number' || k === '') return '';
	return quote && !IDENT.test(k) ? JSON.stringify(k) : k;
}

// A non-empty array holding only objects is rendered as repeated nested blocks
// (`command { … }`), like `terraform plan` does.
function isBlockList(v) {
	return Array.isArray(v) && v.length > 0 && v.every(isObj);
}

// True if an after_unknown structure holds at least one unknown value.
function hasUnknown(unk) {
	if (unk === true) return true;
	if (unk !== null && typeof unk === 'object') return Object.values(unk).some(hasUnknown);
	return false;
}

// String holding a JSON document (IAM policy, etc.): returns the decoded object / array
// so it can be shown indented inside `jsonencode( … )`, otherwise undefined.
function parseJsonString(v) {
	if (typeof v !== 'string') return undefined;
	const t = v.trim();
	if (!(t.startsWith('{') && t.endsWith('}')) && !(t.startsWith('[') && t.endsWith(']'))) return undefined;
	try {
		const j = JSON.parse(t);
		return j !== null && typeof j === 'object' && !isEmpty(j) ? j : undefined;
	} catch {
		return undefined;
	}
}

function jsonKey(k) {
	return JSON_IDENT.test(k) ? k : JSON.stringify(k);
}

function sameJson(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

class LineWriter {
	constructor(replacePaths) {
		this.lines = [];
		this.replace = new Set((replacePaths || []).map((p) => JSON.stringify(p)));
		this.forced = [];
	}

	// Line: [kind, depth, key, value, note?, uncertain?]. `uncertain` marks a change only
	// AWS will settle: a value known after apply, and the old value it may replace.
	push(kind, depth, key, value, path) {
		const line = [kind, depth, key, value];
		if (path && kind !== 'c' && this.replace.has(JSON.stringify(path))) {
			line.push('forces replacement');
			this.forced.push(path.join('.'));
		}
		if (kind !== 'c' && (this.uncertain || value === UNKNOWN || (Array.isArray(value) && value[1] === UNKNOWN))) {
			line[4] = line[4] || null;
			line[5] = true;
		}
		this.lines.push(line);
	}

	// Old value replaced by one known after apply: its lines are uncertain too.
	before(depth, key, b, bs, path, quote, unknown) {
		this.uncertain = unknown;
		this.all('d', depth, key, b, undefined, bs, path, quote);
		this.uncertain = false;
	}

	// Renders a whole value on one side only (creation or destruction).
	all(kind, depth, key, val, unk, sens, path, quote) {
		const k = fmtKey(key, quote);
		if (sens === true) return this.push(kind, depth, k, SENSITIVE, path);
		if (unk === true) return this.push(kind, depth, k, UNKNOWN, path);

		if (isObj(val) || (isAbsent(val) && isObj(unk) && hasUnknown(unk))) {
			const obj = val || {};
			const keys = unionKeys(obj, unk);
			if (keys.length === 0) return this.push(kind, depth, k, '{}', path);
			this.push(kind, depth, k, '{');
			for (const ck of keys) {
				if (isAbsent(obj[ck]) && sub(unk, ck) !== true) continue;
				this.all(kind, depth + 1, ck, obj[ck], sub(unk, ck), sub(sens, ck), path.concat(ck), true);
			}
			return this.push(kind, depth, '', '}');
		}

		if (Array.isArray(val)) {
			if (val.length === 0) return this.push(kind, depth, k, '[]', path);
			if (isBlockList(val)) {
				val.forEach((el, i) => this.block(kind, depth, key, el, sub(unk, i), sub(sens, i), path.concat(i)));
				return;
			}
			this.push(kind, depth, k, '[');
			val.forEach((el, i) => this.all(kind, depth + 1, i, el, sub(unk, i), sub(sens, i), path.concat(i), true));
			return this.push(kind, depth, '', ']');
		}

		const j = parseJsonString(val);
		if (j !== undefined) {
			this.push(kind, depth, k, 'jsonencode(');
			this.jsonAll(kind, depth + 1, '', j, path);
			return this.push(kind, depth, '', ')');
		}

		if (!isAbsent(val)) this.push(kind, depth, k, fmt(val), path);
	}

	// JSON document rendered entirely on one side.
	jsonAll(kind, depth, k, val, path) {
		if (isObj(val)) {
			const keys = Object.keys(val).sort();
			if (keys.length === 0) return this.push(kind, depth, k, '{}', path);
			this.push(kind, depth, k, '{');
			for (const ck of keys) this.jsonAll(kind, depth + 1, jsonKey(ck), val[ck], path.concat(ck));
			return this.push(kind, depth, '', '}');
		}
		if (Array.isArray(val)) {
			if (val.length === 0) return this.push(kind, depth, k, '[]', path);
			this.push(kind, depth, k, '[');
			val.forEach((el, i) => this.jsonAll(kind, depth + 1, '', el, path.concat(i)));
			return this.push(kind, depth, '', ']');
		}
		this.push(kind, depth, k, fmt(val), path);
	}

	// Diff of two JSON documents (objects by key, arrays by index).
	jsonDiff(depth, k, b, a, path) {
		if (sameJson(b, a)) return this.jsonAll('c', depth, k, a, path);
		if (isObj(b) && isObj(a)) {
			this.push('c', depth, k, '{');
			for (const ck of unionKeys(b, a)) {
				const p = path.concat(ck);
				if (!(ck in b)) this.jsonAll('a', depth + 1, jsonKey(ck), a[ck], p);
				else if (!(ck in a)) this.jsonAll('d', depth + 1, jsonKey(ck), b[ck], p);
				else this.jsonDiff(depth + 1, jsonKey(ck), b[ck], a[ck], p);
			}
			return this.push('c', depth, '', '}');
		}
		if (Array.isArray(b) && Array.isArray(a)) {
			this.push('c', depth, k, '[');
			for (let i = 0; i < Math.max(b.length, a.length); i++) {
				const p = path.concat(i);
				if (i >= b.length) this.jsonAll('a', depth + 1, '', a[i], p);
				else if (i >= a.length) this.jsonAll('d', depth + 1, '', b[i], p);
				else this.jsonDiff(depth + 1, '', b[i], a[i], p);
			}
			return this.push('c', depth, '', ']');
		}
		if (!(b !== null && typeof b === 'object') && !(a !== null && typeof a === 'object')) {
			return this.push('m', depth, k, [fmt(b), fmt(a)], path);
		}
		this.jsonAll('d', depth, k, b, path);
		this.jsonAll('a', depth, k, a, path);
	}

	block(kind, depth, key, obj, unk, sens, path) {
		this.push(kind, depth, '@' + key, '{');
		for (const ck of unionKeys(obj, unk)) {
			if (isAbsent(obj[ck]) && sub(unk, ck) !== true) continue;
			this.all(kind, depth + 1, ck, obj[ck], sub(unk, ck), sub(sens, ck), path.concat(ck), false);
		}
		this.push(kind, depth, '', '}');
	}

	// Compares both sides of the same path.
	diff(depth, key, b, a, unk, bs, as, path, quote) {
		const k = fmtKey(key, quote);
		const aUnknown = unk === true;
		const bAbsent = isAbsent(b);
		const aAbsent = isAbsent(a) && !hasUnknown(unk);

		if (bAbsent && aAbsent) return;
		if (bAbsent) return this.all('a', depth, key, a, unk, as, path, quote);
		if (aAbsent) return this.all('d', depth, key, b, undefined, bs, path, quote);

		const bLeaf = bs === true || !(isObj(b) || Array.isArray(b)) || isEmpty(b);
		const aLeaf = aUnknown || as === true || !(isObj(a) || Array.isArray(a)) || isEmpty(a);

		if (bLeaf && aLeaf) {
			const bj = bs === true ? undefined : parseJsonString(b);
			const aj = aUnknown || as === true ? undefined : parseJsonString(a);
			if (bj !== undefined && aj !== undefined) {
				this.push('c', depth, k, 'jsonencode(');
				this.jsonDiff(depth + 1, '', bj, aj, path);
				return this.push('c', depth, '', ')');
			}
			if ((bj !== undefined || aj !== undefined) && !sameJson(b, a)) {
				this.before(depth, key, b, bs, path, quote, aUnknown);
				return this.all('a', depth, key, a, unk, as, path, quote);
			}
			const bv = bs === true ? SENSITIVE : isEmpty(b) ? emptyRepr(b) : fmt(b);
			const av = aUnknown ? UNKNOWN : as === true ? SENSITIVE : isEmpty(a) ? emptyRepr(a) : fmt(a);
			if (!aUnknown && sameJson(b, a)) return this.push('c', depth, k, av, path);
			return this.push('m', depth, k, [bv, av], path);
		}

		if (isObj(b) && isObj(a)) {
			this.push('c', depth, k, '{');
			for (const ck of unionKeys(b, a, unk)) {
				this.diff(depth + 1, ck, b[ck], a[ck], sub(unk, ck), sub(bs, ck), sub(as, ck), path.concat(ck), true);
			}
			return this.push('c', depth, '', '}');
		}

		if (Array.isArray(b) && Array.isArray(a)) {
			if (isBlockList(b) && isBlockList(a)) {
				const n = Math.max(b.length, a.length);
				for (let i = 0; i < n; i++) {
					const bi = b[i], ai = a[i], p = path.concat(i);
					if (bi === undefined) this.block('a', depth, key, ai, sub(unk, i), sub(as, i), p);
					else if (ai === undefined) this.block('d', depth, key, bi, undefined, sub(bs, i), p);
					else {
						this.push('c', depth, '@' + key, '{');
						for (const ck of unionKeys(bi, ai, sub(unk, i))) {
							this.diff(depth + 1, ck, bi[ck], ai[ck], sub(sub(unk, i), ck), sub(sub(bs, i), ck), sub(sub(as, i), ck), p.concat(ck), false);
						}
						this.push('c', depth, '', '}');
					}
				}
				return;
			}
			return this.list(depth, k, b, a, unk, path);
		}

		// Incompatible types (e.g. list → unknown): old value removed, new one added.
		this.before(depth, key, b, bs, path, quote, aUnknown);
		this.all('a', depth, key, a, unk, as, path, quote);
	}

	// List of scalars: set-based diff, keeping the incoming order.
	list(depth, k, b, a, unk, path) {
		const after = new Set(a.map((v) => JSON.stringify(v)));
		const before = new Set(b.map((v) => JSON.stringify(v)));
		this.push('c', depth, k, '[');
		b.forEach((v) => {
			if (!after.has(JSON.stringify(v))) this.push('d', depth + 1, '', fmt(v), path);
		});
		a.forEach((v, i) => {
			if (sub(unk, i) === true) this.push('a', depth + 1, '', UNKNOWN, path);
			else this.push(before.has(JSON.stringify(v)) ? 'c' : 'a', depth + 1, '', fmt(v), path);
		});
		this.push('c', depth, '', ']');
	}
}

function isEmpty(v) {
	return (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0);
}

function emptyRepr(v) {
	return Array.isArray(v) ? '[]' : '{}';
}

function unionKeys(...objs) {
	const keys = new Set();
	for (const o of objs) if (isObj(o)) Object.keys(o).forEach((k) => keys.add(k));
	return [...keys].sort();
}

function actionOf(actions) {
	const a = (actions || []).join(',');
	switch (a) {
		case 'create': return 'create';
		case 'update': return 'update';
		case 'delete': return 'delete';
		case 'read': return 'read';
		case 'forget': return 'forget';
		case 'no-op': return 'noop';
		case 'delete,create':
		case 'create,delete':
		case 'create,forget':
		case 'forget,create':
			return 'replace';
		default: return 'noop';
	}
}

function shortProvider(name) {
	return (name || '').replace(/^registry\.(terraform|opentofu)\.io\//, '');
}

// Name the resource has in the cloud (bucket name, role name, function name…), when known.
const NAME_KEYS = ['name', 'bucket', 'function_name', 'identifier', 'cluster_identifier', 'table_name', 'repository_name', 'domain_name', 'key'];

// Types whose meaningful name is not the first generic key (an S3 object is named by its key).
const TYPE_NAME_KEYS = { aws_s3_object: ['key'], aws_s3_bucket_object: ['key'] };

function cloudNameOf(values, type) {
	if (!isObj(values)) return null;
	for (const k of (TYPE_NAME_KEYS[type] || []).concat(NAME_KEYS)) if (typeof values[k] === 'string' && values[k]) return values[k];
	return null;
}

function reasonOf(rc) {
	const parts = [];
	if (rc.action_reason) parts.push(REASONS[rc.action_reason] || rc.action_reason);
	if (rc.previous_address && rc.previous_address !== rc.address) parts.push('moved from ' + rc.previous_address);
	if (rc.deposed) parts.push('deposed object ' + rc.deposed);
	if (rc.status === 'tainted') parts.push('tainted');
	return parts.join(' · ');
}

function parseResource(rc) {
	const ch = rc.change || {};
	const action = actionOf(ch.actions);
	const w = new LineWriter(ch.replace_paths);
	const b = isObj(ch.before) ? ch.before : {};
	const a = isObj(ch.after) ? ch.after : {};
	for (const k of unionKeys(b, a, ch.after_unknown)) {
		w.diff(0, k, b[k], a[k], sub(ch.after_unknown, k), sub(ch.before_sensitive, k), sub(ch.after_sensitive, k), [k], false);
	}
	// A read (data source) changes nothing: show the read value as neutral.
	const lines = action === 'read'
		? w.lines.map((l) => ['c', l[1], l[2], l[0] === 'm' ? l[3][1] : l[3]])
		: w.lines;
	return {
		addr: rc.address + (rc.deposed ? ' (deposed)' : ''),
		action,
		mode: rc.mode,
		type: rc.type,
		provider: shortProvider(rc.provider_name),
		module: rc.module_address || 'root',
		cloudName: cloudNameOf(isObj(ch.after) ? ch.after : ch.before, rc.type),
		reason: reasonOf(rc),
		force: w.forced.join(', '),
		lines
	};
}

/**
 * Parses a JSON plan (`terraform show -json <plan>`) or a state (`terraform.tfstate`,
 * `terraform show -json`) into the view model.
 * @param {string} text
 */
function parsePlan(text) {
	let doc;
	try {
		doc = JSON.parse(text);
	} catch (e) {
		throw new Error('Invalid JSON: ' + e.message);
	}
	if (isState(doc)) {
		const plan = stateToPlan(doc);
		return Object.assign(modelOf(plan), { kind: 'state', state: plan.state });
	}
	if (!isObj(doc) || !('format_version' in doc) || !('terraform_version' in doc) ||
		(!Array.isArray(doc.resource_changes) && !isObj(doc.planned_values))) {
		throw new Error('This file is neither a Terraform plan (terraform show -json <plan>) nor a Terraform state.');
	}
	return Object.assign(modelOf(doc), { kind: 'plan' });
}

function modelOf(plan) {
	const resources = (plan.resource_changes || []).map(parseResource);
	const graph = safeGraph(plan);
	const names = new Map(resources.map((r) => [r.addr, r.cloudName]));
	for (const n of graph.nodes) n.cloudName = names.get(n.id) || null;
	return {
		formatVersion: plan.format_version,
		terraformVersion: plan.terraform_version,
		timestamp: plan.timestamp || null,
		errored: !!plan.errored,
		resources,
		graph
	};
}

// The graph is a bonus: a failure there must not prevent reading the plan.
function safeGraph(plan) {
	try {
		return buildGraph(plan);
	} catch (e) {
		return { nodes: [], edges: [], error: e instanceof Error ? e.message : String(e) };
	}
}

module.exports = { parsePlan, cloudNameOf, UNKNOWN, SENSITIVE };
