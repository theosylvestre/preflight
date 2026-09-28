// @ts-nocheck
// Graph layouts — frames by AWS category or module, force-directed — and link routing: pure
// computations on the graph data, no DOM. graph.js runs them in a Web Worker (this whole
// function is its source), or on the page when workers are unavailable.
function preflightLayoutModule(scope) {
	'use strict';
	const W = 250, H = 56, MARGIN = 40;
	const PAD = 28, HEAD = 54, NODE_GAP = 48, CLUSTER_GAP = 90, MAX_ROW_W = 1800, MAX_COL_H = 1400;
	const CATEGORY_ORDER = [
		'AWS-Services', 'External', 'Security-Identity', 'Compute', 'Containers', 'Serverless', 'Analytics', 'Application-Integration',
		'Artificial-Intelligence', 'Storage', 'Databases', 'Networking-Content-Delivery', 'Management-Tools', 'Developer-Tools'
	];

	function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
	function summarize(actions) {
		if (!actions.length) return '';
		return actions.length <= 2 ? actions.join(', ') : actions[0] + ' +' + (actions.length - 1);
	}

	// --- Layered ordering -----------------------------------------------------------
	// Simplified Sugiyama: cycles broken by DFS, layers by longest path (unless given), edges
	// spanning several layers split by dummy nodes, then alternating barycentre sweeps keeping
	// the order with the fewest crossings. The initial order of `ids` breaks ties.
	// Returns the ordered layers (real ids only) and the layer of each id.
	function layered(ids, links, fixed, sweeps = 12) {
		const known = new Set(ids);
		const E = links.filter((e) => e.from !== e.to && known.has(e.from) && known.has(e.to));
		const push = (map, k, v) => (map.get(k) || map.set(k, []).get(k)).push(v);
		const layer = new Map(ids.map((id) => [id, 0]));
		let dag;
		if (fixed) {
			// Given layers: each edge goes from the lower layer to the higher one.
			for (const id of ids) layer.set(id, fixed.get(id));
			dag = E.filter((e) => layer.get(e.from) !== layer.get(e.to))
				.map((e) => layer.get(e.from) < layer.get(e.to) ? e : { from: e.to, to: e.from });
		} else {
			// 1. Break the cycles (back edges of a DFS are reversed).
			const adj = new Map(ids.map((id) => [id, []]));
			E.forEach((e, i) => adj.get(e.from).push(i));
			const state = new Map(), reversed = new Set();
			const dfs = (u) => {
				state.set(u, 1);
				for (const i of adj.get(u)) {
					const v = E[i].to;
					if (state.get(v) === 1) reversed.add(i);
					else if (!state.has(v)) dfs(v);
				}
				state.set(u, 2);
			};
			ids.forEach((id) => { if (!state.has(id)) dfs(id); });
			dag = E.map((e, i) => reversed.has(i) ? { from: e.to, to: e.from } : e);
			// 2. Layers: topological order + longest path.
			const indeg = new Map(ids.map((id) => [id, 0])), succ = new Map(ids.map((id) => [id, []]));
			for (const e of dag) { succ.get(e.from).push(e.to); indeg.set(e.to, indeg.get(e.to) + 1); }
			const queue = ids.filter((id) => indeg.get(id) === 0);
			while (queue.length) {
				const u = queue.shift();
				for (const v of succ.get(u)) {
					layer.set(v, Math.max(layer.get(v), layer.get(u) + 1));
					indeg.set(v, indeg.get(v) - 1);
					if (indeg.get(v) === 0) queue.push(v);
				}
			}
		}
		const base = Math.min(0, ...layer.values());

		// 3. Dummy nodes on the edges skipping layers.
		const layers = [], dummies = new Set();
		const at = new Map();
		const put = (id, l) => { (layers[l - base] = layers[l - base] || []).push(id); at.set(id, l - base); };
		ids.forEach((id) => put(id, layer.get(id)));
		const up = new Map(), down = new Map();
		let k = 0;
		for (const e of dag) {
			const chain = [e.from];
			for (let l = layer.get(e.from) + 1; l < layer.get(e.to); l++) {
				const d = 'dummy:' + k++;
				dummies.add(d);
				put(d, l);
				chain.push(d);
			}
			chain.push(e.to);
			for (let j = 0; j < chain.length - 1; j++) {
				push(down, chain[j], chain[j + 1]);
				push(up, chain[j + 1], chain[j]);
			}
		}
		for (let l = 0; l < layers.length; l++) layers[l] = layers[l] || [];

		// 4. Crossing reduction (barycentre, alternating sweeps).
		const pos = new Map();
		const reindex = () => layers.forEach((L) => L.forEach((id, i) => pos.set(id, i)));
		reindex();
		const bary = (id, nb) => {
			const n = nb.get(id);
			return n && n.length ? n.reduce((s, x) => s + pos.get(x), 0) / n.length : pos.get(id);
		};
		const crossings = () => {
			let c = 0;
			for (let l = 0; l < layers.length - 1; l++) {
				const segs = [];
				for (const a of layers[l]) for (const b of down.get(a) || []) segs.push([pos.get(a), pos.get(b)]);
				for (let i = 0; i < segs.length; i++)
					for (let j = i + 1; j < segs.length; j++)
						if ((segs[i][0] - segs[j][0]) * (segs[i][1] - segs[j][1]) < 0) c++;
			}
			return c;
		};
		let best = layers.map((L) => [...L]), bestC = crossings();
		for (let s = 0; s < sweeps && bestC > 0; s++) {
			const goingDown = s % 2 === 0;
			for (let l = 1; l < layers.length; l++) {
				const L = goingDown ? layers[l] : layers[layers.length - 1 - l];
				const nb = goingDown ? up : down;
				const b = new Map(L.map((id) => [id, bary(id, nb)]));
				L.sort((x, y) => b.get(x) - b.get(y));
				L.forEach((id, i) => pos.set(id, i));
			}
			const c = crossings();
			if (c < bestC) { bestC = c; best = layers.map((L) => [...L]); }
		}
		return { layers: best.map((L) => L.filter((id) => !dummies.has(id))), layer: at };
	}

	// --- Layout ------------------------------------------------------------------
	// One frame per AWS category (Security & Identity, Analytics, Storage…) or module. Frames
	// are stacked in layers following the links between them (layered ordering on the frame
	// graph): rows top to bottom, or columns left to right when `horizontal`, wrapped when too
	// long, unlinked frames last), then the nodes of each frame
	// are placed in a small grid ordered by the position of their neighbours.
	function layout(g, horizontal) {
		const groups = new Map();
		for (const n of g.nodes) {
			const k = n.category || 'Other';
			if (!groups.has(k)) groups.set(k, { key: k, label: n.categoryLabel || k, icon: n.categoryIcon || null, sub: n.categorySub || null, url: n.categoryUrl || null, nodes: [] });
			groups.get(k).nodes.push(n);
		}
		const rank = (k) => {
			const i = CATEGORY_ORDER.indexOf(k);
			return i >= 0 ? i : k === 'Other' ? 1000 : k.startsWith('Module:') ? 500 : 100;
		};
		const clusters = [...groups.values()].sort((a, b) => rank(a.key) - rank(b.key) || a.label.localeCompare(b.label));
		for (const c of clusters) {
			c.nodes.sort((a, b) => a.label.localeCompare(b.label));
			const n = c.nodes.length;
			c.cols = n <= 4 ? 1 : n <= 10 ? 2 : 3;
			c.rows = Math.ceil(n / c.cols);
			c.w = PAD * 2 + c.cols * W + (c.cols - 1) * NODE_GAP;
			c.head = c.sub ? HEAD + 14 : HEAD;
			c.h = c.head + c.rows * H + (c.rows - 1) * NODE_GAP + PAD;
		}

		// Frame graph: one link per edge between two different frames.
		const frameOf = new Map();
		for (const c of clusters) for (const n of c.nodes) frameOf.set(n.id, c);
		const links = [];
		for (const e of g.edges) {
			const a = frameOf.get(e.from), b = frameOf.get(e.to);
			if (a && b && a !== b) links.push({ from: a.key, to: b.key });
		}
		const linked = new Set(links.flatMap((l) => [l.from, l.to]));
		const byKey = new Map(clusters.map((c) => [c.key, c]));
		const bands = layered(clusters.filter((c) => linked.has(c.key)).map((c) => c.key), links).layers
			.map((L) => L.map((k) => byKey.get(k)));
		const alone = clusters.filter((c) => !linked.has(c.key));
		if (alone.length) bands.push(alone);

		// Each layer is a row of frames (vertical) or a column (horizontal), wrapped when too long.
		const [along, across, pa, pc] = horizontal ? ['h', 'w', 'y', 'x'] : ['w', 'h', 'x', 'y'];
		const maxLen = horizontal ? MAX_COL_H : MAX_ROW_W;
		const lines = [];
		for (const band of bands) {
			let line = null;
			for (const c of band) {
				if (!line || (line.items.length && line.len + CLUSTER_GAP + c[along] > maxLen)) {
					line = { items: [], len: -CLUSTER_GAP, depth: 0 };
					lines.push(line);
				}
				line.items.push(c);
				line.len += CLUSTER_GAP + c[along];
				line.depth = Math.max(line.depth, c[across]);
			}
		}
		const span = Math.max(0, ...lines.map((l) => l.len));
		let depth = MARGIN;
		for (const l of lines) {
			let at = MARGIN + (span - l.len) / 2;
			for (const c of l.items) {
				c[pa] = at;
				c[pc] = depth;
				at += c[along] + CLUSTER_GAP;
			}
			depth += l.depth + CLUSTER_GAP;
		}
		const size = { [along]: span + MARGIN * 2, [across]: Math.max(depth - CLUSTER_GAP, MARGIN) + MARGIN };

		// Nodes of a frame: column-major grid. Starting from the alphabetical order, a few
		// barycentre passes send each node towards its neighbours: columns by mean x, then
		// lines by mean y. Nodes without neighbours keep the alphabetical order, at the end.
		const xy = new Map();
		const place = (c) => c.nodes.forEach((nd, i) => {
			const col = Math.floor(i / c.rows), line = i % c.rows;
			xy.set(nd.id, { x: c.x + PAD + col * (W + NODE_GAP), y: c.y + c.head + line * (H + NODE_GAP) });
		});
		clusters.forEach(place);
		const nbs = new Map();
		for (const e of g.edges) {
			if (e.from === e.to || !frameOf.has(e.from) || !frameOf.has(e.to)) continue;
			push(nbs, e.from, e.to);
			push(nbs, e.to, e.from);
		}
		const mean = (id, axis) => {
			const list = nbs.get(id);
			return list ? list.reduce((s, o) => s + xy.get(o)[axis], 0) / list.length : Infinity;
		};
		for (let pass = 0; pass < 3; pass++) {
			for (const c of clusters) {
				const sx = new Map(c.nodes.map((n) => [n.id, mean(n.id, 'x')]));
				const sy = new Map(c.nodes.map((n) => [n.id, mean(n.id, 'y')]));
				const byName = (a, b) => a.label.localeCompare(b.label);
				const sorted = [...c.nodes].sort((a, b) => sx.get(a.id) - sx.get(b.id) || byName(a, b));
				c.nodes = [];
				for (let i = 0; i < sorted.length; i += c.rows) {
					c.nodes.push(...sorted.slice(i, i + c.rows).sort((a, b) => sy.get(a.id) - sy.get(b.id) || byName(a, b)));
				}
				place(c);
			}
		}
		return { xy, clusters, width: size.w, height: size.h };
	}

	function push(map, k, v) {
		(map.get(k) || map.set(k, []).get(k)).push(v);
	}

	// --- Force layout ---------------------------------------------------------------
	// Fruchterman-Reingold from a circle in breadth-first order, plus an angular force that
	// spreads the links evenly around each node. Crossings are then removed by swapping the
	// ends of crossing links (kept when it helps, followed by a short simulation), and
	// overlapping boxes pushed apart. No frames: links are straight, cut at the node borders.
	const FORCE = { length: 100, iterations: 300, angular: 0.3, gravity: 0.02, swapRounds: 6, maxSwapEdges: 400, maxClearWork: 400000, gap: 24 };
	function forceLayout(g) {
		// Connected components laid out one by one, then packed in rows (largest first),
		// so unrelated parts don't drift apart.
		const comp = new Map(), adj = new Map(g.nodes.map((n) => [n.id, []]));
		for (const e of g.edges) if (adj.has(e.from) && adj.has(e.to) && e.from !== e.to) { adj.get(e.from).push(e.to); adj.get(e.to).push(e.from); }
		const parts = [];
		for (const n of g.nodes) {
			if (comp.has(n.id)) continue;
			const list = [], q = [n.id];
			comp.set(n.id, parts.length);
			while (q.length) {
				const u = q.shift();
				list.push(u);
				for (const v of adj.get(u)) if (!comp.has(v)) { comp.set(v, parts.length); q.push(v); }
			}
			parts.push(list);
		}
		const byId = new Map(g.nodes.map((n) => [n.id, n]));
		const boxes = [];
		const singles = [];
		for (const ids of parts) {
			if (ids.length === 1) { singles.push(ids[0]); continue; }
			const set = new Set(ids);
			boxes.push(forceComponent({ nodes: ids.map((id) => byId.get(id)), edges: g.edges.filter((e) => set.has(e.from) && set.has(e.to)) }));
		}
		// Unlinked resources: a grid block.
		if (singles.length) {
			const cols = Math.ceil(Math.sqrt(singles.length)), xy = new Map();
			singles.sort((a, b) => byId.get(a).label.localeCompare(byId.get(b).label))
				.forEach((id, i) => xy.set(id, { x: (i % cols) * (W + FORCE.gap), y: Math.floor(i / cols) * (H + FORCE.gap) }));
			const rowsN = Math.ceil(singles.length / cols);
			boxes.push({ xy, w: cols * (W + FORCE.gap) - FORCE.gap, h: rowsN * (H + FORCE.gap) - FORCE.gap });
		}
		boxes.sort((a, b) => b.w * b.h - a.w * a.h);
		const maxW = Math.max(MAX_ROW_W, ...boxes.map((b) => b.w));
		const xy = new Map();
		let x = 0, y = 0, rowH = 0, width = 0;
		for (const b of boxes) {
			if (x > 0 && x + b.w > maxW) { x = 0; y += rowH + CLUSTER_GAP; rowH = 0; }
			for (const [id, p] of b.xy) xy.set(id, { x: p.x + x + MARGIN, y: p.y + y + MARGIN });
			x += b.w + CLUSTER_GAP;
			rowH = Math.max(rowH, b.h);
			width = Math.max(width, x - CLUSTER_GAP);
		}
		return { xy, clusters: [], width: width + MARGIN * 2, height: y + rowH + MARGIN * 2 };
	}

	// Force layout of one connected component: top-left corners from (0, 0) and the size.
	function forceComponent(g) {
		const { length, iterations, angular, gravity, swapRounds } = FORCE;
		const nodes = g.nodes, N = nodes.length;
		const idx = new Map(nodes.map((n, i) => [n.id, i]));
		// Links carrying an action label get longer, so the label fits between the two boxes.
		const E = g.edges.filter((e) => e.from !== e.to && idx.has(e.from) && idx.has(e.to))
			.map((e) => {
				const cw = chipText(e) ? chipWidth(chipText(e)) : 0;
				return [idx.get(e.from), idx.get(e.to), length + (cw ? cw + FORCE.gap : 0), cw];
			});
		const nb = Array.from({ length: N }, () => []);
		for (const [a, b] of E) { nb[a].push(b); nb[b].push(a); }

		// 1. Initial circle, in breadth-first order: neighbours start side by side.
		const order = [], seen = new Array(N).fill(false);
		for (let s = 0; s < N; s++) {
			if (seen[s]) continue;
			const q = [s];
			seen[s] = true;
			while (q.length) {
				const u = q.shift();
				order.push(u);
				for (const v of nb[u]) if (!seen[v]) { seen[v] = true; q.push(v); }
			}
		}
		const x = new Float64Array(N), y = new Float64Array(N);
		const R = (N * length) / (2 * Math.PI);
		order.forEach((u, i) => {
			const a = (2 * Math.PI * i) / N;
			x[u] = R * Math.cos(a);
			y[u] = R * Math.sin(a);
		});

		// Spacing constraints, as displacements: overlapping boxes move apart; a node lying on a link it isn't part of moves
		// off it (along the link's normal, by what its box overlaps the line), the link ends the
		// other way; the box of each action label, in the middle of its link, keeps nodes out,
		// and when one of the link's own nodes covers it, the two ends are pushed apart.
		const clearance = (dx, dy) => {
			// Overlapping boxes, apart along the axis where they overlap the least.
			for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
				const ex = x[j] - x[i], ey = y[j] - y[i];
				const ox = W + FORCE.gap - Math.abs(ex), oy = H + FORCE.gap - Math.abs(ey);
				if (ox <= 0 || oy <= 0) continue;
				if (ox / W < oy / H) { const m = (ox / 2) * (ex < 0 ? -1 : 1); dx[i] -= m; dx[j] += m; }
				else { const m = (oy / 2) * (ey < 0 ? -1 : 1); dy[i] -= m; dy[j] += m; }
			}
			for (const [a, b] of E) {
				const ex = x[b] - x[a], ey = y[b] - y[a], d = Math.hypot(ex, ey);
				if (d < 1) continue;
				const nx = -ey / d, ny = ex / d;
				for (let u = 0; u < N; u++) {
					if (u === a || u === b) continue;
					const px = x[u] - x[a], py = y[u] - y[a];
					const along = (px * ex + py * ey) / (d * d);
					if (along <= 0 || along >= 1) continue;
					const side = px * nx + py * ny;
					const half = Math.abs(nx) * (W / 2) + Math.abs(ny) * (H / 2) + FORCE.gap;
					if (Math.abs(side) >= half) continue;
					const m = (half - Math.abs(side)) * (side < 0 ? -1 : 1);
					dx[u] += nx * m; dy[u] += ny * m;
					dx[a] -= nx * m / 2; dy[a] -= ny * m / 2; dx[b] -= nx * m / 2; dy[b] -= ny * m / 2;
				}
			}
			for (const [a, b, , cw] of E) {
				if (!cw) continue;
				const mx = (x[a] + x[b]) / 2, my = (y[a] + y[b]) / 2;
				for (let u = 0; u < N; u++) {
					const ox = W / 2 + cw / 2 + FORCE.gap / 2 - Math.abs(x[u] - mx), oy = H / 2 + 10 + FORCE.gap / 2 - Math.abs(y[u] - my);
					if (ox <= 0 || oy <= 0) continue;
					if (u === a || u === b) {
						const ex = x[b] - x[a], ey = y[b] - y[a], d = Math.hypot(ex, ey) || 1, m = Math.min(ox, oy);
						dx[a] -= ex / d * m; dy[a] -= ey / d * m; dx[b] += ex / d * m; dy[b] += ey / d * m;
					} else if (ox < oy) {
						const m = ox * (x[u] < mx ? -1 : 1);
						dx[u] += m; dx[a] -= m / 2; dx[b] -= m / 2;
					} else {
						const m = oy * (y[u] < my ? -1 : 1);
						dy[u] += m; dy[a] -= m / 2; dy[b] -= m / 2;
					}
				}
			}
		};

		// 2. Simulation: repulsion k²/d, attraction d²/k, angular spreading, gravity; moves
		// capped by a decreasing temperature.
		const simulate = (iters, t0, clear) => {
			const dx = new Float64Array(N), dy = new Float64Array(N);
			for (let it = 0; it < iters; it++) {
				const t = t0 * (1 - it / iters);
				dx.fill(0);
				dy.fill(0);
				for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
					let ex = x[i] - x[j], ey = y[i] - y[j];
					let d2 = ex * ex + ey * ey;
					// Coincident nodes: a fixed nudge keeps the layout deterministic.
					if (d2 < 1e-4) { ex = ((i * 7 + j) % 11) / 11 - 0.5; ey = ((i * 3 + j * 5) % 13) / 13 - 0.5; d2 = ex * ex + ey * ey; }
					const f = (length * length) / d2;
					dx[i] += ex * f; dy[i] += ey * f; dx[j] -= ex * f; dy[j] -= ey * f;
				}
				for (const [a, b, len] of E) {
					const ex = x[a] - x[b], ey = y[a] - y[b];
					const f = Math.hypot(ex, ey) / len;
					dx[a] -= ex * f; dy[a] -= ey * f; dx[b] += ex * f; dy[b] += ey * f;
				}
				if (angular > 0) for (let u = 0; u < N; u++) {
					const k = nb[u].length;
					if (k < 2) continue;
					const gap0 = (2 * Math.PI) / k;
					const A = nb[u].map((v) => ({ v, a: Math.atan2(y[v] - y[u], x[v] - x[u]) })).sort((p, q) => p.a - q.a);
					const rotate = (v, a, amount) => {
						const m = amount * Math.hypot(x[v] - x[u], y[v] - y[u]);
						dx[v] -= Math.sin(a) * m;
						dy[v] += Math.cos(a) * m;
					};
					for (let i = 0; i < k; i++) {
						const p = A[i], q = A[(i + 1) % k];
						const gap = q.a - p.a + (i === k - 1 ? 2 * Math.PI : 0);
						if (gap >= gap0) continue;
						const amount = (angular * (gap0 - gap)) / 2;
						rotate(p.v, p.a, -amount);
						rotate(q.v, q.a, amount);
					}
				}
				if (clear) clearance(dx, dy);
				for (let i = 0; i < N; i++) {
					dx[i] -= x[i] * gravity;
					dy[i] -= y[i] * gravity;
					const d = Math.hypot(dx[i], dy[i]);
					if (d > 0) { const m = Math.min(d, t) / d; x[i] += dx[i] * m; y[i] += dy[i] * m; }
				}
			}
		};

		// 3. Crossings between non-adjacent links.
		const orient = (a, b, c) => Math.sign((x[b] - x[a]) * (y[c] - y[a]) - (y[b] - y[a]) * (x[c] - x[a]));
		const crosses = (i, j) => {
			const [a, b] = E[i], [c, d] = E[j];
			if (a === c || a === d || b === c || b === d) return false;
			return orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
		};
		const crossingPairs = () => {
			const r = [];
			for (let i = 0; i < E.length; i++) for (let j = i + 1; j < E.length; j++) if (crosses(i, j)) r.push([i, j]);
			return r;
		};
		// Crossing pairs with a link at u or v: the only ones a swap of u and v can change, so
		// the total after the swap is the total before, minus these before, plus these after.
		const incident = Array.from({ length: N }, () => []);
		E.forEach(([a, b], i) => { incident[a].push(i); if (b !== a) incident[b].push(i); });
		const mark = new Int32Array(E.length);
		let markGen = 0;
		const crossingsAround = (u, v) => {
			markGen++;
			const S = [];
			for (const i of incident[u].concat(incident[v])) if (mark[i] !== markGen) { mark[i] = markGen; S.push(i); }
			let n = 0;
			for (const i of S) for (let j = 0; j < E.length; j++) {
				if (j === i || (mark[j] === markGen && j < i)) continue;
				if (crosses(i, j)) n++;
			}
			return n;
		};

		// 4. Simulation, then swaps of the ends of crossing links (skipped on large graphs,
		// where counting crossings for every swap gets too slow).
		simulate(iterations, length);
		const swap = (u, v) => {
			[x[u], x[v]] = [x[v], x[u]];
			[y[u], y[v]] = [y[v], y[u]];
		};
		if (E.length <= FORCE.maxSwapEdges) {
			let best = { x: x.slice(), y: y.slice(), c: crossingPairs().length };
			for (let r = 0; r < swapRounds && best.c > 0; r++) {
				const pairs = crossingPairs();
				let base = pairs.length;
				for (const [i, j] of pairs) {
					const q = [E[i][0], E[i][1], E[j][0], E[j][1]];
					for (let s = 0; s < 4; s++) for (let t = s + 1; t < 4; t++) {
						const around = crossingsAround(q[s], q[t]);
						swap(q[s], q[t]);
						const c = base - around + crossingsAround(q[s], q[t]);
						if (c < base) base = c; else swap(q[s], q[t]);
					}
				}
				simulate(Math.ceil(iterations / 3), length / 4);
				const c = crossingPairs().length;
				if (c < best.c) best = { x: x.slice(), y: y.slice(), c };
				else { x.set(best.x); y.set(best.y); }
			}
			x.set(best.x);
			y.set(best.y);
		}

		// 5. Short simulation clearing the links, then nodes (W×H boxes) that still overlap
		// are pushed apart along the axis where they overlap the least.
		if (E.length * N <= FORCE.maxClearWork) {
			simulate(Math.ceil(iterations / 2), length / 2, true);
			// Then the constraints alone, until they hold (or stop improving).
			const dx = new Float64Array(N), dy = new Float64Array(N);
			for (let pass = 0; pass < 300; pass++) {
				dx.fill(0);
				dy.fill(0);
				clearance(dx, dy);
				let moved = 0;
				for (let i = 0; i < N; i++) {
					x[i] += dx[i] * 0.5;
					y[i] += dy[i] * 0.5;
					moved = Math.max(moved, Math.abs(dx[i]), Math.abs(dy[i]));
				}
				if (moved < 1) break;
			}
		}
		const gw = W + FORCE.gap, gh = H + FORCE.gap;
		for (let pass = 0; pass < 100; pass++) {
			let moved = false;
			for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
				const ex = x[j] - x[i], ey = y[j] - y[i];
				const ox = gw - Math.abs(ex), oy = gh - Math.abs(ey);
				if (ox <= 0 || oy <= 0) continue;
				moved = true;
				if (ox / gw < oy / gh) { const m = (ox / 2) * (ex < 0 ? -1 : 1); x[i] -= m; x[j] += m; }
				else { const m = (oy / 2) * (ey < 0 ? -1 : 1); y[i] -= m; y[j] += m; }
			}
			if (!moved) break;
		}
		// Guarantee: from the centre outwards, a node still overlapping an already placed one
		// moves to the nearest free spot (rings of growing radius around its position).
		const cx = x.reduce((a, b) => a + b, 0) / N, cy = y.reduce((a, b) => a + b, 0) / N;
		const placed = [];
		const hit = (px, py) => placed.some((j) => Math.abs(px - x[j]) < gw && Math.abs(py - y[j]) < gh);
		for (const i of [...Array(N).keys()].sort((a, b) => Math.hypot(x[a] - cx, y[a] - cy) - Math.hypot(x[b] - cx, y[b] - cy))) {
			if (hit(x[i], y[i])) {
				search: for (let r = 1; ; r++) {
					const n = 8 * r;
					for (let k = 0; k < n; k++) {
						const a = (2 * Math.PI * k) / n, px = x[i] + Math.cos(a) * 16 * r * 2, py = y[i] + Math.sin(a) * 16 * r / 2;
						if (!hit(px, py)) { x[i] = px; y[i] = py; break search; }
					}
				}
			}
			placed.push(i);
		}

		// Top-left corners, shifted to positive coordinates.
		const minX = Math.min(...x), minY = Math.min(...y);
		const xy = new Map();
		nodes.forEach((n, i) => xy.set(n.id, { x: x[i] - minX, y: y[i] - minY }));
		return { xy, w: Math.max(...x) - minX + W, h: Math.max(...y) - minY + H };
	}

	// Straight links for the force layout, cut at the node borders. Links joining the same
	// two nodes are spread side by side.
	function straightRoutes(g, L) {
		const routes = new Map(), pairs = new Map();
		for (const e of g.edges) {
			if (e.from === e.to || !L.xy.has(e.from) || !L.xy.has(e.to)) continue;
			const k = e.from < e.to ? e.from + '|' + e.to : e.to + '|' + e.from;
			if (!pairs.has(k)) pairs.set(k, []);
			pairs.get(k).push(e);
		}
		const cut = (c, ux, uy) => {
			// Distance from the centre to the box border (plus a small gap) along (ux, uy).
			const t = Math.min(ux ? (W / 2 + 2) / Math.abs(ux) : Infinity, uy ? (H / 2 + 2) / Math.abs(uy) : Infinity);
			return [c[0] + ux * t, c[1] + uy * t];
		};
		for (const list of pairs.values()) {
			list.forEach((e, i) => {
				const a = L.xy.get(e.from), b = L.xy.get(e.to);
				const off = (i - (list.length - 1) / 2) * 10;
				const d = Math.hypot(b.x - a.x, b.y - a.y) || 1, ux = (b.x - a.x) / d, uy = (b.y - a.y) / d;
				// Same perpendicular for both directions of the pair.
				const sgn = e.from < e.to ? 1 : -1, px = -uy * off * sgn, py = ux * off * sgn;
				const ca = [a.x + W / 2 + px, a.y + H / 2 + py], cb = [b.x + W / 2 + px, b.y + H / 2 + py];
				routes.set(edgeKey(e), [cut(ca, ux, uy), cut(cb, -ux, -uy)]);
			});
		}
		return routes;
	}

	// Focus view layout: one column per distance from the focused node (upstream on the left,
	// downstream on the right), each column ordered by layered crossing reduction.
	const COL_GAP = 190, ROW_GAP = 36;
	function focusLayout(nodes, edges, rank) {
		const sorted = [...nodes].sort((a, b) => a.label.localeCompare(b.label));
		const { layers } = layered(sorted.map((n) => n.id), edges, rank);
		const cols = layers.filter((L) => L.length);
		const maxRows = Math.max(...cols.map((L) => L.length));
		const fullH = maxRows * H + (maxRows - 1) * ROW_GAP;
		const xy = new Map();
		cols.forEach((L, ci) => {
			const x = MARGIN + ci * (W + COL_GAP);
			const y0 = MARGIN + (fullH - (L.length * H + (L.length - 1) * ROW_GAP)) / 2;
			L.forEach((id, i) => xy.set(id, { x, y: y0 + i * (H + ROW_GAP) }));
		});
		return { xy, clusters: [], width: MARGIN * 2 + cols.length * W + (cols.length - 1) * COL_GAP, height: MARGIN * 2 + fullH };
	}

	// --- Edge routing --------------------------------------------------------------
	// Orthogonal A* on a GRID-px grid: nodes (plus a margin) are obstacles, crossing another
	// category's frame and turning are penalised, and cells already used by an edge cost more
	// so parallel edges spread into distinct tracks.
	const GRID = 8, NODE_MARGIN = 6, TURN_COST = 6, FOREIGN_FRAME_COST = 3, USED_COST = 2.5;
	// Edges never attach closer than CORNER px to a node corner, and ends sharing a side are
	// kept PORT_SPACING cells apart.
	const CORNER = 20, PORT_SPACING = 3;
	const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
	const KIND_ORDER = ['perm', 'attach', 'runs-as', 'member', 'boundary', 'trust'];

	// Binary heap of (key, value) pairs on typed arrays, growing as needed; ties are broken
	// exactly as by a plain binary heap, so the routes don't depend on the storage.
	class MinHeap {
		constructor() { this.k = new Float64Array(1024); this.v = new Int32Array(1024); this.size = 0; }
		clear() { this.size = 0; }
		push(key, val) {
			if (this.size === this.k.length) {
				const k = new Float64Array(this.size * 2), v = new Int32Array(this.size * 2);
				k.set(this.k); v.set(this.v);
				this.k = k; this.v = v;
			}
			const k = this.k, v = this.v;
			let i = this.size++;
			while (i > 0) {
				const p = (i - 1) >> 1;
				if (k[p] <= key) break;
				k[i] = k[p]; v[i] = v[p]; i = p;
			}
			k[i] = key; v[i] = val;
		}
		pop() {
			const k = this.k, v = this.v, top = v[0], n = --this.size, lk = k[n], lv = v[n];
			if (n) {
				let i = 0;
				for (;;) {
					let c = 2 * i + 1;
					if (c >= n) break;
					if (c + 1 < n && k[c + 1] < k[c]) c++;
					if (k[c] >= lk) break;
					k[i] = k[c]; v[i] = v[c]; i = c;
				}
				k[i] = lk; v[i] = lv;
			}
			return top;
		}
	}

	// Nodes are W×H boxes unless their position in `L.xy` carries its own `w` / `h`.
	function routeAll(g, L) {
		const cols = Math.ceil(L.width / GRID) + 2, rows = Math.ceil(L.height / GRID) + 2, N = cols * rows;
		const owner = new Int32Array(N).fill(-1);
		const frame = new Int16Array(N).fill(-1);
		const used = new Float32Array(N);
		const cell = (x, y) => Math.floor(y / GRID) * cols + Math.floor(x / GRID);
		const center = (c) => [(c % cols) * GRID + GRID / 2, Math.floor(c / cols) * GRID + GRID / 2];

		L.clusters.forEach((c, ci) => {
			for (let y = c.y; y < c.y + c.h; y += GRID) for (let x = c.x; x < c.x + c.w; x += GRID) frame[cell(x, y)] = ci;
		});
		const index = new Map(g.nodes.map((n, i) => [n.id, i]));
		g.nodes.forEach((n, i) => {
			const p = L.xy.get(n.id);
			const x0 = Math.floor((p.x - NODE_MARGIN) / GRID), x1 = Math.floor((p.x + (p.w || W) + NODE_MARGIN) / GRID);
			const y0 = Math.floor((p.y - NODE_MARGIN) / GRID), y1 = Math.floor((p.y + (p.h || H) + NODE_MARGIN) / GRID);
			for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (x >= 0 && y >= 0 && x < cols && y < rows) owner[y * cols + x] = i;
		});

		// Free cells just outside a node side (away from its corners), with the outward
		// direction of that side and a cost growing with the distance to the side's middle.
		const ports = (i) => {
			const p = L.xy.get(g.nodes[i].id), out = [];
			const x0 = Math.floor((p.x - NODE_MARGIN) / GRID), x1 = Math.floor((p.x + (p.w || W) + NODE_MARGIN) / GRID);
			const y0 = Math.floor((p.y - NODE_MARGIN) / GRID), y1 = Math.floor((p.y + (p.h || H) + NODE_MARGIN) / GRID);
			const add = (x, y, dir, offset) => {
				if (x < 0 || y < 0 || x >= cols || y >= rows) return;
				const c = y * cols + x;
				if (owner[c] === -1) out.push({ c, dir, offset });
			};
			const inside = (v, lo, hi) => v >= lo + CORNER && v <= hi - CORNER;
			const my = (y0 + y1) / 2, mx = (x0 + x1) / 2;
			for (let y = y0; y <= y1; y++) {
				if (!inside(y * GRID + GRID / 2, p.y, p.y + (p.h || H))) continue;
				add(x1 + 1, y, 0, Math.abs(y - my));
				add(x0 - 1, y, 2, Math.abs(y - my));
			}
			for (let x = x0; x <= x1; x++) {
				if (!inside(x * GRID + GRID / 2, p.x, p.x + (p.w || W))) continue;
				add(x, y1 + 1, 1, Math.abs(x - mx) * 0.6 + 2);
				add(x, y0 - 1, 3, Math.abs(x - mx) * 0.6 + 2);
			}
			return out;
		};
		// Port cells already holding an edge end (plus their neighbours along the side).
		const taken = new Set();
		const take = (c) => {
			for (let k = -PORT_SPACING; k <= PORT_SPACING; k++) { taken.add(c + k); taken.add(c + k * cols); }
		};
		const free = (list) => {
			const f = list.filter((p) => !taken.has(p.c));
			return f.length ? f : list;
		};
		const portCache = new Map();
		const portsOf = (i) => portCache.get(i) || portCache.set(i, ports(i)).get(i);
		const frameOf = (i) => {
			const p = L.xy.get(g.nodes[i].id);
			return frame[cell(p.x + (p.w || W) / 2, p.y + (p.h || H) / 2)];
		};

		// Search state per (cell, direction), valid for the current search only (`gen`), so it
		// is never cleared; column / row of each cell precomputed for the heuristic.
		const dist = new Float32Array(N * 4), prev = new Int32Array(N * 4), stamp = new Int32Array(N * 4);
		const goalStamp = new Int32Array(N), colOf = new Int32Array(N), rowOf = new Int32Array(N);
		for (let c = 0; c < N; c++) { colOf[c] = c % cols; rowOf[c] = Math.floor(c / cols); }
		const heap = new MinHeap();
		let gen = 0;
		// A* from any start port to any goal port; returns the cells and the port of each end.
		const search = (e, starts, goals) => {
			const si = index.get(e.from), ti = index.get(e.to);
			gen++;
			for (const p of goals) goalStamp[p.c] = gen;
			const fs = frameOf(si), ft = frameOf(ti);
			const tp = L.xy.get(e.to), tx = (tp.x + (tp.w || W) / 2) / GRID, ty = (tp.y + (tp.h || H) / 2) / GRID;
			heap.clear();
			for (const p of starts) {
				const s = p.c * 4 + p.dir, d = p.offset * 0.5 + used[p.c] * USED_COST;
				if (stamp[s] !== gen || d < dist[s]) { stamp[s] = gen; dist[s] = d; prev[s] = -1; heap.push(d + Math.abs(colOf[p.c] - tx) + Math.abs(rowOf[p.c] - ty), s); }
			}
			let found = -1, budget = N * 6;
			while (heap.size && budget-- > 0) {
				const s = heap.pop(), c = s >> 2, dir = s & 3, d = dist[s];
				if (goalStamp[c] === gen) { found = s; break; }
				const cx = colOf[c], cy = rowOf[c];
				for (let nd = 0; nd < 4; nd++) {
					if (nd === ((dir + 2) & 3)) continue;
					const nx = cx + DIRS[nd][0], ny = cy + DIRS[nd][1];
					if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
					const n = ny * cols + nx;
					if (owner[n] !== -1) continue;
					const f = frame[n];
					const step = 1 + (nd !== dir ? TURN_COST : 0) + used[n] * USED_COST + (f !== -1 && f !== fs && f !== ft ? FOREIGN_FRAME_COST : 0);
					const ns = n * 4 + nd, ndist = d + step;
					if (stamp[ns] !== gen || ndist < dist[ns]) { stamp[ns] = gen; dist[ns] = ndist; prev[ns] = s; heap.push(ndist + Math.abs(nx - tx) + Math.abs(ny - ty), ns); }
				}
			}
			if (found < 0) return null;
			const cells = [];
			for (let s = found; s !== -1; s = prev[s]) cells.push(s >> 2);
			cells.reverse();
			for (const c of cells) used[c] += 1;
			// Last goal port on that cell, as a Map built from the goals would keep.
			const last = cells[cells.length - 1];
			let end = null;
			for (const p of goals) if (p.c === last) end = p;
			return { cells, start: starts.find((p) => p.c === cells[0]), end };
		};

		const edges = [...g.edges].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
			.filter((e) => index.has(e.from) && index.has(e.to) && e.from !== e.to);

		// Pass 1: free routing, which picks the side of the node each end leaves from.
		const first = new Map();
		for (const e of edges) {
			const r = search(e, free(portsOf(index.get(e.from))), free(portsOf(index.get(e.to))));
			if (!r) continue;
			take(r.cells[0]);
			take(r.cells[r.cells.length - 1]);
			first.set(e, r);
		}

		// Ends sharing a node side are spread evenly along it (k ends at 1/(k+1), 2/(k+1)…),
		// ordered so they don't cross: ends turning towards the start of the side first
		// (the shallowest turn outermost), straight ones by position, then the others.
		const sides = new Map();
		for (const [e, r] of first) {
			const pts = simplify(r.cells.map(center));
			for (const [id, port, path] of [[e.from, r.start, pts], [e.to, r.end, [...pts].reverse()]]) {
				const k = id + '#' + port.dir, ax = port.dir & 1 ? 0 : 1;
				// First move along the side (a turn right at the port), else the first bend.
				const sideways = path.length > 1 ? Math.sign(path[1][ax] - path[0][ax]) : 0;
				const turn = sideways || (path.length > 2 ? Math.sign(path[2][ax] - path[1][ax]) : 0);
				const depth = sideways || path.length < 2 ? 0 : Math.abs(path[1][1 - ax] - path[0][1 - ax]);
				const key = turn < 0 ? [0, depth] : turn > 0 ? [2, -depth] : [1, path[path.length - 1][ax]];
				if (!sides.has(k)) sides.set(k, []);
				sides.get(k).push({ e, id, dir: port.dir, from: id === e.from && port === r.start, key });
			}
		}
		const slot = new Map();
		for (const list of sides.values()) {
			list.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1]);
			list.forEach((end, i) => {
				const p = L.xy.get(end.id), vertical = end.dir & 1;
				const along = vertical ? p.x + (i + 1) * (p.w || W) / (list.length + 1) : p.y + (i + 1) * (p.h || H) / (list.length + 1);
				const x = vertical ? Math.floor(along / GRID) : end.dir === 0 ? Math.floor((p.x + (p.w || W) + NODE_MARGIN) / GRID) + 1 : Math.floor((p.x - NODE_MARGIN) / GRID) - 1;
				const y = !vertical ? Math.floor(along / GRID) : end.dir === 1 ? Math.floor((p.y + (p.h || H) + NODE_MARGIN) / GRID) + 1 : Math.floor((p.y - NODE_MARGIN) / GRID) - 1;
				const c = y * cols + x;
				const ok = x >= 0 && y >= 0 && x < cols && y < rows && owner[c] === -1;
				slot.set(end.e.from + '>' + end.e.to + '>' + end.e.kind + '>' + end.e.effect + (end.from ? '<s' : '<t'), ok ? { c, dir: end.dir, offset: 0, along } : null);
			});
		}

		// Pass 2: each edge routed between its two slots (pass 1 route if a slot is blocked).
		used.fill(0);
		const routes = new Map();
		for (const e of edges) {
			const r1 = first.get(e);
			if (!r1) continue;
			const k = e.from + '>' + e.to + '>' + e.kind + '>' + e.effect;
			const s = slot.get(k + '<s'), t = slot.get(k + '<t');
			const r = (s && t && search(e, [s], [t])) || r1;
			const pts = r.cells.map(center);
			const sp = L.xy.get(e.from), tp = L.xy.get(e.to);
			pts.unshift(borderPoint(sp, r.start.dir, pts[0]));
			pts.push(borderPoint(tp, r.end.dir, pts[pts.length - 1]));
			routes.set(edgeKey(e), r === r1 ? simplify(pts) : align(simplify(pts), r.start.dir, s.along, r.end.dir, t.along));
		}
		return routes;
	}

	// Moves both ends of an orthogonal route (from grid cell centres) to their exact slot along
	// the node side, shifting the first / last bend with them so every segment stays straight.
	function align(pts, sdir, sa, edir, ea) {
		const as = sdir & 1 ? 0 : 1, ae = edir & 1 ? 0 : 1, n = pts.length;
		if (n === 2) {
			if (pts[0][as] === sa && pts[1][ae] === ea) return pts;
			// Straight line: a small jog halfway.
			const m = (pts[0][1 - as] + pts[1][1 - as]) / 2;
			const p = (a, b) => (as === 0 ? [a, b] : [b, a]);
			return [p(sa, pts[0][1 - as]), p(sa, m), p(ea, m), p(ea, pts[1][1 - as])];
		}
		pts = pts.map((q) => [...q]);
		pts[0][as] = sa;
		pts[1][as] = sa;
		pts[n - 1][ae] = ea;
		pts[n - 2][ae] = ea;
		return pts;
	}

	function borderPoint(p, dir, near) {
		if (dir === 0) return [p.x + (p.w || W), near[1]];
		if (dir === 2) return [p.x, near[1]];
		if (dir === 1) return [near[0], p.y + (p.h || H)];
		return [near[0], p.y];
	}

	function simplify(pts) {
		const out = [pts[0]];
		for (let i = 1; i < pts.length - 1; i++) {
			const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
			if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) continue;
			out.push(b);
		}
		out.push(pts[pts.length - 1]);
		return out;
	}

	// Action label drawn on a permission / trust link (null when the link has none).
	function chipText(e) {
		if ((e.kind !== 'perm' && e.kind !== 'trust') || !e.actions.length) return null;
		return (e.effect === 'Deny' ? 'DENY ' : '') + trunc(summarize(e.actions), 30) + (e.conditions && e.conditions.length ? ' · if' : '');
	}
	function chipWidth(t) {
		return t.length * 6.4 + 14;
	}

	function edgeKey(e) {
		return e.from + '|' + e.to + '|' + e.kind + '|' + e.effect;
	}


	scope.PreflightLayout = {
		W, H, MARGIN, PAD, HEAD, NODE_GAP, CLUSTER_GAP, GRID,
		layered, layout, forceLayout, straightRoutes, focusLayout, routeAll, chipText, chipWidth, edgeKey, trunc, summarize
	};
}

preflightLayoutModule(typeof window !== 'undefined' ? window : self);
