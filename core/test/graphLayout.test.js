// media/graphLayout.js (pure layout and routing, run by the page or its Web Worker) in a
// bare context, as a worker would load it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildViewModel } = require('../src/viewModel');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'graphLayout.js'), 'utf8');

function load() {
	const context = vm.createContext({ self: {} });
	vm.runInContext(source, context);
	return context.self.PreflightLayout;
}

suite('graphLayout', () => {
	const L = load();
	const graph = buildViewModel(fixture('sample.tfstate'), { icons: new Map(), categoryIcons: new Map(), iconUri: String }).graph;
	const overlap = (a, b) => a.x < b.x + L.W && b.x < a.x + L.W && a.y < b.y + L.H && b.y < a.y + L.H;

	test('loads without a DOM, on `self` as in a worker', () => {
		for (const f of ['layout', 'forceLayout', 'routeAll', 'straightRoutes', 'focusLayout', 'edgeKey']) assert.strictEqual(typeof L[f], 'function', f);
	});

	for (const horizontal of [false, true]) {
		test('frames layout (' + (horizontal ? 'horizontal' : 'vertical') + '): every node placed once, no overlap, every link routed', () => {
			const lay = L.layout(graph, horizontal);
			assert.deepStrictEqual([...lay.xy.keys()].sort(), graph.nodes.map((n) => n.id).sort());
			const pos = [...lay.xy.values()];
			for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) assert.ok(!overlap(pos[i], pos[j]), 'nodes overlap');
			for (const p of pos) assert.ok(p.x >= 0 && p.y >= 0 && p.x + L.W <= lay.width && p.y + L.H <= lay.height, 'node outside the layout');
			const routes = L.routeAll(graph, lay);
			for (const e of graph.edges.filter((x) => x.from !== x.to)) assert.ok(routes.get(L.edgeKey(e)), 'no route for ' + L.edgeKey(e));
		});
	}

	test('force layout: deterministic, no overlap, straight links', () => {
		const a = L.forceLayout(graph), b = L.forceLayout(graph);
		assert.deepStrictEqual([...a.xy], [...b.xy]);
		const pos = [...a.xy.values()];
		for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) assert.ok(!overlap(pos[i], pos[j]), 'nodes overlap');
		const routes = L.straightRoutes(graph, a);
		for (const r of routes.values()) assert.strictEqual(r.length, 2);
	});
});
