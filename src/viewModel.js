// Model displayed by the viewer: the parsed plan / state, completed with the AWS service
// icons and the graph groups. Independent of the IDE: the VS Code extension builds it in the
// extension host, the JetBrains plugin in the webview.

const { parsePlan } = require('./planParser');
const { categoryOf, categoryLabel, serviceFor } = require('./awsServices');
const { describeSource, sourceText } = require('./moduleSource');

/**
 * @param {string} text JSON plan or state
 * @param {object} opts
 * @param {Map<string, string>} opts.icons service → icon path relative to media/
 * @param {Map<string, string>} opts.categoryIcons category → icon path relative to media/
 * @param {(rel: string) => string} opts.iconUri URI of a file of media/ in the webview
 * @param {string | null} [opts.modulesJson] `.terraform/modules/modules.json` next to the file
 */
function buildViewModel(text, { icons, categoryIcons, iconUri, modulesJson }) {
	const model = parsePlan(text);
	const uriOf = (rel) => rel ? iconUri(rel) : null;
	const iconOf = (type) => {
		const service = serviceFor(type);
		const rel = service && icons.get(service);
		return { service, icon: uriOf(rel), category: categoryOf(rel) };
	};
	for (const r of model.resources) {
		const { service, icon } = iconOf(r.type);
		Object.assign(r, { service, icon });
	}
	// Graph nodes are grouped by AWS console category; resources of a module also carry
	// their module group (with its source repository), used when the viewer groups by
	// module. AWS service principals and the rest of what lives outside the project get
	// their own groups.
	const modules = moduleSources(model.graph.modules || {}, modulesJson);
	for (const n of model.graph.nodes) {
		const i = n.iconType ? iconOf(n.iconType) : { icon: null, category: null };
		n.icon = i.icon;
		Object.assign(n, groupOf(n, i.category), { moduleGroup: moduleGroupOf(n, modules) });
		n.categoryIcon = uriOf(categoryIcons.get(n.category));
	}
	return model;
}

/**
 * Graph group of a node by resource type: AWS services, external, or AWS console category.
 * @param {any} n graph node
 * @param {string | null} category AWS category of its icon
 */
function groupOf(n, category) {
	if (n.kind === 'external' && n.type === 'service') return { category: 'AWS-Services', categoryLabel: 'AWS service principals' };
	// Inline and resource policies are declared in the project, next to their owner.
	if (n.kind === 'external' && n.type !== 'inline-policy' && n.type !== 'resource-policy') return { category: 'External', categoryLabel: 'External to project' };
	const c = category || 'Other';
	return { category: c, categoryLabel: c === 'Other' ? 'Other' : categoryLabel(c) };
}

/**
 * Module group of a resource declared in a module (null at the root).
 * @param {any} n graph node
 * @param {Record<string, { source: string | null, version: string | null }>} modules
 */
function moduleGroupOf(n, modules) {
	if (n.kind !== 'resource' || !n.module || n.module === 'root') return null;
	const key = n.module.replace(/\[[^\]]*\]/g, '');
	const m = modules[key];
	const d = m ? describeSource(m.source, m.version) : null;
	return {
		category: 'Module:' + key,
		categoryLabel: 'Module ' + key.replace(/^module\./, '').split('.module.').join(' › '),
		categorySub: d ? sourceText(d) : null,
		categoryUrl: d ? d.url : null,
		categoryIcon: null
	};
}

/**
 * Module sources from the plan, completed by `.terraform/modules/modules.json` next to the
 * file (the only place a state records nothing about its modules).
 * @param {Record<string, { source: string | null, version: string | null }>} fromPlan
 * @param {string | null | undefined} modulesJson
 */
function moduleSources(fromPlan, modulesJson) {
	const out = Object.assign({}, fromPlan);
	if (!modulesJson) return out;
	try {
		for (const m of JSON.parse(modulesJson).Modules || []) {
			if (!m.Key || !m.Source) continue;
			const key = m.Key.split('.').map((k) => 'module.' + k).join('.');
			if (!out[key]) out[key] = { source: m.Source, version: m.Version || null };
		}
	} catch {
		/* invalid modules.json */
	}
	return out;
}

module.exports = { buildViewModel, moduleSources };
