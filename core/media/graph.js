// @ts-nocheck
// Graph tab: the plan's resources grouped by AWS category, their references and IAM
// permissions, rendered as SVG with pan / zoom and a details panel.
(function () {
	const W = 250, H = 56, MARGIN = 40;
	const PAD = 28, HEAD = 54, NODE_GAP = 48, CLUSTER_GAP = 90, MAX_ROW_W = 1800, MAX_COL_H = 1400;
	const CATEGORY_ORDER = [
		'AWS-Services', 'External', 'Security-Identity', 'Compute', 'Containers', 'Serverless', 'Analytics', 'Application-Integration',
		'Artificial-Intelligence', 'Storage', 'Databases', 'Networking-Content-Delivery', 'Management-Tools', 'Developer-Tools'
	];

	// IAM model: resource ─runs as→ role ─uses→ policy ─allows→ resource; principal ─can assume→ role.
	const KINDS = {
		'runs-as': { label: 'Runs as', color: '#79c0ff', width: 1.6 },
		trust: { label: 'Can assume', color: '#c297ff', width: 1.6, dash: '6 4' },
		member: { label: 'Member of', color: '#7fd4c1', width: 1.5 },
		attach: { label: 'Uses policy', color: '#b7bfcc', width: 1.5, dash: '4 3' },
		boundary: { label: 'Boundary', color: '#f0883e', width: 1.5, dash: '2 3' },
		perm: { label: 'Allows', color: '#e3b341', width: 2 }
	};
	const DENY = '#ff7b72';
	const SUB = {
		service: 'AWS service principal', 'managed-policy': 'AWS managed policy', wildcard: 'Wildcard resource',
		anyone: 'Public principal', account: 'AWS account', arn: 'External ARN', aws: 'AWS principal', federated: 'Federated principal',
		'inline-policy': 'Inline policy', 'resource-policy': 'Resource policy'
	};

	// Main graph and the focus view (modal opened by double-clicking a resource).
	const view = { key: null, x: 0, y: 0, k: 1, layout: null, vp: 'g-vp', side: 'g-side' };
	const fview = { key: null, x: 0, y: 0, k: 1, layout: null, vp: 'gf-vp', side: 'gf-side' };
	let ctx = null;

	function splitAddr(a) {
		let depth = 0, cut = -1;
		for (let i = 0; i < a.length; i++) {
			const ch = a.charAt(i);
			if (ch === '[') depth++;
			else if (ch === ']') depth--;
			else if (ch === '.' && depth === 0) cut = i;
		}
		return { pre: a.slice(0, cut), name: a.slice(cut + 1) };
	}
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

	// Access chain of a node: downstream (runs as → role → uses → policy → allows → resource)
	// and upstream, plus direct trust. `rank` is the signed distance from the node.
	function chainOf(focus, edges) {
		const hl = new Set(), rank = new Map([[focus, 0]]);
		for (const e of edges) {
			if (e.kind !== 'trust') continue;
			if (e.from === focus) { hl.add(e); if (!rank.has(e.to)) rank.set(e.to, 1); }
			else if (e.to === focus) { hl.add(e); if (!rank.has(e.from)) rank.set(e.from, -1); }
		}
		const walk = (forward) => {
			const seen = new Set([focus]), queue = [focus];
			while (queue.length) {
				const cur = queue.shift();
				for (const e of edges) {
					if (e.kind === 'trust' || (forward ? e.from : e.to) !== cur) continue;
					hl.add(e);
					const next = forward ? e.to : e.from;
					if (!rank.has(next)) rank.set(next, rank.get(cur) + (forward ? 1 : -1));
					if (!seen.has(next)) { seen.add(next); queue.push(next); }
				}
			}
		};
		walk(true);
		walk(false);
		return { hl, rank };
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

	// SVG path with rounded corners.
	function pathOf(pts) {
		const R = 7;
		let d = 'M' + pts[0][0] + ',' + pts[0][1];
		for (let i = 1; i < pts.length; i++) {
			const a = pts[i - 1], b = pts[i];
			const len = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
			if (i === pts.length - 1) { d += ' L' + b[0] + ',' + b[1]; break; }
			const c = pts[i + 1];
			const r = Math.min(R, len / 2, (Math.abs(c[0] - b[0]) + Math.abs(c[1] - b[1])) / 2);
			const inX = Math.sign(b[0] - a[0]), inY = Math.sign(b[1] - a[1]);
			const outX = Math.sign(c[0] - b[0]), outY = Math.sign(c[1] - b[1]);
			d += ' L' + (b[0] - inX * r) + ',' + (b[1] - inY * r) + ' Q' + b[0] + ',' + b[1] + ' ' + (b[0] + outX * r) + ',' + (b[1] + outY * r);
		}
		return d;
	}

	// Spots tried along a segment, from its middle outwards.
	const CHIP_SPOTS = [0.5];
	for (let k = 1; k <= 9; k++) CHIP_SPOTS.push(0.5 - k * 0.05, 0.5 + k * 0.05);

	// Chip position on the route: first spot (longest segments first) where a w×20 chip
	// overlaps neither a node nor an already placed chip.
	function placeChip(v, pts, w, taken) {
		const hits = (x, y) => {
			const r = [x - w / 2 - 4, y - 14, x + w / 2 + 4, y + 14];
			const over = (o) => r[0] < o[2] && o[0] < r[2] && r[1] < o[3] && o[1] < r[3];
			for (const p of v.layout.xy.values()) if (over([p.x, p.y, p.x + W, p.y + H])) return true;
			return taken.some(over);
		};
		const segs = [];
		for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]);
		segs.sort((a, b) => (Math.abs(b[1][0] - b[0][0]) + Math.abs(b[1][1] - b[0][1])) - (Math.abs(a[1][0] - a[0][0]) + Math.abs(a[1][1] - a[0][1])));
		for (const [a, b] of segs) {
			for (const t of CHIP_SPOTS) {
				const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
				if (!hits(x, y)) {
					taken.push([x - w / 2, y - 10, x + w / 2, y + 10]);
					return [x, y];
				}
			}
		}
		const [a, b] = segs[0];
		return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
	}

	// --- Rendering ---------------------------------------------------------------

	function visibleEdges() {
		const hidden = ctx.st.ghide || {};
		const muted = ctx.st.gnodes || {};
		return ctx.graph.edges.filter((e) => !hidden[e.kind] && !muted[e.from] && !muted[e.to]);
	}

	// Returns the edge paths and, separately, their action chips (drawn above the nodes).
	function edgesSvg(v, edges, hl) {
		const chips = [], taken = [];
		const paths = edges.map((e) => {
			const pts = v.routes.get(edgeKey(e));
			if (!pts) return '';
			const dpath = pathOf(pts);
			const K = KINDS[e.kind];
			const color = e.effect === 'Deny' ? DENY : K.color;
			const dim = hl && !hl.has(e) ? ' dim' : '';
			const title = K.label + ': ' + e.from + ' → ' + e.to +
				(e.actions.length ? '\n' + e.actions.join('\n') : '') +
				(e.labels.length ? '\n(' + e.labels.join(', ') + ')' : '') +
				(e.via.length ? '\nvia ' + e.via.join(', ') : '') +
				(e.conditions && e.conditions.length ? '\nif ' + e.conditions.join('\nand ') : '') +
				(e.statements && e.statements.some((s) => s.sid) ? '\nSid: ' + e.statements.map((s) => s.sid || '—').join(', ') : '');
			const t = chipText(e);
			if (t) {
				const w = chipWidth(t);
				const [mx, my] = placeChip(v, pts, w, taken);
				chips.push('<g class="edge chip' + dim + '" style="--c:' + color + '" data-from="' + ctx.esc(e.from) + '" data-to="' + ctx.esc(e.to) + '" transform="translate(' + (mx - w / 2) + ',' + (my - 10) + ')"><title>' + ctx.esc(title) + '</title>' +
					'<rect width="' + w + '" height="20" rx="4" fill="#141414" fill-opacity="0.92" stroke="' + color + '" stroke-opacity="0.75"></rect>' +
					'<text x="' + w / 2 + '" y="14" text-anchor="middle" fill="' + color + '">' + ctx.esc(t) + '</text></g>');
			}
			// Base line + a "flow" overlay whose dashes run along the edge direction (CSS animation).
			return '<g class="edge' + dim + '" data-kind="' + e.kind + '" data-from="' + ctx.esc(e.from) + '" data-to="' + ctx.esc(e.to) + '" style="--c:' + color + '"><title>' + ctx.esc(title) + '</title>' +
				'<path class="hit" d="' + dpath + '"></path>' +
				'<path class="line" d="' + dpath + '" stroke="' + color + '" stroke-width="' + K.width + '"' + (K.dash ? ' stroke-dasharray="' + K.dash + '"' : '') +
				' marker-end="url(#arrow-' + (e.effect === 'Deny' ? 'deny' : e.kind) + ')"></path>' +
				'<path class="flow flow-' + e.kind + '" d="' + dpath + '" stroke="' + color + '" stroke-width="' + (K.width + 1) + '"></path></g>';
		}).join('');
		return { paths, chips: chips.join('') };
	}

	// `eyes: false` (focus view) drops the per-node "hide links" toggle and the muted state.
	function nodesSvg(v, nodes, focus, near, eyes = true) {
		const { xy } = v.layout;
		const muted = eyes ? ctx.st.gnodes || {} : {};
		return nodes.map((n) => {
			const p = xy.get(n.id);
			const A = n.action ? ctx.act[n.action] : null;
			const accent = A ? A.fg : '#5a5a5a';
			let sp = n.kind === 'external' ? { pre: n.detail || SUB[n.type] || 'External', name: n.label } : splitAddr(n.label);
			// "Resource name" setting: Terraform address, AWS name, or both (AWS name on the 2nd line).
			if (n.cloudName && ctx.label === 'cloud') sp = { name: n.cloudName, pre: n.label };
			else if (n.cloudName && ctx.label === 'both') sp = { name: sp.name, pre: n.cloudName };
			const cls = 'node' + (n.kind === 'external' ? ' ext' : '') + (n.id === focus ? ' sel' : '') + (focus && !near.has(n.id) ? ' dim' : '') + (muted[n.id] ? ' muted' : '');
			const icon = n.icon
				? '<image href="' + ctx.esc(n.icon) + '" x="14" y="14" width="28" height="28"></image>'
				: '<rect x="14" y="14" width="28" height="28" rx="4" fill="#1a1a1a"></rect><text x="28" y="33" text-anchor="middle" class="glyph">' + (n.type === 'wildcard' || n.type === 'anyone' ? '*' : '?') + '</text>';
			const glow = n.kind === 'external' ? '#c297ff' : A && n.action !== 'noop' ? A.fg : '#9fb3c8';
			return '<g class="' + cls + '" data-node="' + ctx.esc(n.id) + '" style="--glow:' + glow + '" transform="translate(' + p.x + ',' + p.y + ')">' +
				'<title>' + ctx.esc(n.label + (n.cloudName ? '\n' + n.cloudName : '') + (A ? '\n' + A.label : '')) + '</title>' +
				'<rect class="box" width="' + W + '" height="' + H + '" rx="5"></rect>' +
				(n.kind === 'resource' ? '<rect x="0" y="10" width="3" height="' + (H - 20) + '" rx="1.5" fill="' + accent + '"></rect>' : '') +
				icon +
				'<text x="54" y="25" class="name">' + ctx.esc(trunc(sp.name, 24)) + '</text>' +
				'<text x="54" y="42" class="pre">' + ctx.esc(trunc(sp.pre, 30)) + '</text>' +
				(A && n.action !== 'noop' ? '<text x="' + (W - 12) + '" y="25" text-anchor="end" class="sym" fill="' + A.fg + '">' + A.sym + '</text>' : '') +
				(eyes ? '<g class="eye" data-ghide-node="' + ctx.esc(n.id) + '" transform="translate(' + (W - 28) + ',6)"><title>' + (muted[n.id] ? 'Show links' : 'Hide links') + '</title>' +
					eyeSvg(muted[n.id]) + '</g>' : '') +
				'</g>';
		}).join('');
	}

	function eyeSvg(muted) {
		return '<rect width="22" height="22" rx="4"></rect>' +
			'<path d="M3 11s3-5.5 8-5.5 8 5.5 8 5.5-3 5.5-8 5.5S3 11 3 11z"></path><circle cx="11" cy="11" r="2.4"></circle>' +
			(muted ? '<path d="M4 4l14 14"></path>' : '');
	}

	function clustersSvg() {
		const gnodes = ctx.st.gnodes || {};
		return view.layout.clusters.map((c) => {
			const tx = c.icon ? PAD + 30 : PAD;
			// A group is muted when every one of its resources is.
			const muted = c.nodes.every((n) => gnodes[n.id]);
			return '<g class="cluster' + (muted ? ' muted' : '') + '" transform="translate(' + c.x + ',' + c.y + ')">' +
				'<rect class="cbox" width="' + c.w + '" height="' + c.h + '" rx="8"></rect>' +
				(c.icon ? '<image href="' + ctx.esc(c.icon) + '" x="' + PAD + '" y="12" width="22" height="22"></image>' : '') +
				'<text x="' + tx + '" y="28" class="ctitle">' + ctx.esc(trunc(c.label, Math.floor((c.w - tx - 40) / 7))) + '</text>' +
				'<text x="' + (c.w - PAD - 30) + '" y="28" text-anchor="end" class="ccount">' + c.nodes.length + '</text>' +
				'<g class="eye" data-ghide-group="' + ctx.esc(c.key) + '" transform="translate(' + (c.w - PAD - 22) + ',12)"><title>' + (muted ? 'Show links of the group' : 'Hide links of the group') + '</title>' + eyeSvg(muted) + '</g>' +
				// Module source (git repository, registry…), clickable when it has a web page.
				(c.sub ? '<text x="' + tx + '" y="46" class="csub' + (c.url ? ' link" data-gurl="' + ctx.esc(c.url) : '') + '">' +
					'<title>' + ctx.esc(c.sub + (c.url ? '\nOpen ' + c.url : '')) + '</title>' + ctx.esc(trunc(c.sub, Math.floor((c.w - tx - PAD) / 6.2))) + '</text>' : '') +
				'</g>';
		}).join('');
	}

	function defs() {
		const m = (id, color) => '<marker id="arrow-' + id + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="' + color + '"></path></marker>';
		// Tube arrows keep a fixed size whatever the tube's width.
		const t = (id, color) => '<marker id="tube-' + id + '" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="16" markerHeight="16" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="' + color + '"></path></marker>';
		return '<defs>' + Object.entries(KINDS).map(([k, K]) => m(k, K.color) + t(k, K.color)).join('') + m('deny', DENY) +
			'</defs>';
	}

	// --- Details panel -------------------------------------------------------------

	function nodeName(id) {
		const n = ctx.graph.nodes.find((x) => x.id === id);
		return n ? n.label : id;
	}
	// Address split into its module path (muted, own line) and the resource itself.
	function addrHtml(a) {
		const m = /^((?:module\.[^.[]+(?:\[[^\]]*\])?\.)+)(.+)$/.exec(a);
		return m ? '<span class="g-lpre">' + ctx.esc(m[1].slice(0, -1)) + '</span><span class="g-lname">' + ctx.esc(m[2]) + '</span>'
			: '<span class="g-lname">' + ctx.esc(a) + '</span>';
	}
	function link(id) {
		const name = nodeName(id);
		return '<button type="button" class="g-link" data-gsel="' + ctx.esc(id) + '" title="' + ctx.esc(name) + '">' + addrHtml(name) + '</button>';
	}
	// Link to something that may not be a graph node (policy document, attachment…):
	// select it when it is, else open it in the plan, else plain text.
	function refLink(id) {
		if (ctx.graph.nodes.some((n) => n.id === id)) return link(id);
		if (ctx.inPlan(id)) return '<button type="button" class="g-link" data-open-plan="' + ctx.esc(id) + '" title="Show in the ' + ctx.docName + '">' + addrHtml(id) + '</button>';
		return '<span class="g-ref">' + addrHtml(id) + '</span>';
	}
	// One "label  value" row under an item.
	function kv(label, value) {
		return '<div class="g-kv"><span class="g-k">' + label + '</span><span class="g-v">' + value + '</span></div>';
	}
	// Actions of an edge, one block per policy statement (with its Sid) when statements are named.
	function actionsHtml(e) {
		const stmts = e.statements || [];
		if (stmts.some((s) => s.sid)) {
			return stmts.map((s) => '<div class="g-stmt">' +
				'<div class="g-sid">' + (s.sid ? 'Sid <code>' + ctx.esc(s.sid) + '</code>' : 'Statement without Sid') + '</div>' +
				flatActionsHtml({ actions: s.actions, conditions: s.conditions, effect: e.effect }) + '</div>').join('');
		}
		return flatActionsHtml(e);
	}
	function flatActionsHtml(e) {
		return '<div class="g-acts">' + e.actions.map((a) => '<span class="g-act' + (e.effect === 'Deny' ? ' deny' : '') + '">' + ctx.esc(a) + '</span>').join('') + '</div>' +
			(e.conditions && e.conditions.length ? '<div class="g-conds">' + e.conditions.map((c) => '<div class="g-cond">if ' + ctx.esc(c) + '</div>').join('') + '</div>' : '');
	}
	function viaHtml(e) {
		return e.via.length ? kv('via', e.via.map(refLink).join('')) : '';
	}
	function section(title, items) {
		return items.length ? '<section class="g-sec"><h3>' + title + '<span>' + items.length + '</span></h3>' + items.join('') + '</section>' : '';
	}

	// Effective permissions of a principal: its own policies, plus those of the roles it runs as.
	function effective(id) {
		const edges = ctx.graph.edges;
		const out = [];
		const through = [{ who: id, role: null }]
			.concat(edges.filter((e) => (e.kind === 'runs-as' || e.kind === 'member') && e.from === id).map((e) => ({ who: e.to, role: e.to, how: e.kind === 'member' ? 'group' : 'role' })));
		for (const { who, role, how } of through) {
			for (const a of edges.filter((e) => e.kind === 'attach' && e.from === who)) {
				for (const p of edges.filter((e) => e.kind === 'perm' && e.from === a.to)) out.push({ e: p, policy: a.to, role, how });
			}
		}
		return out;
	}

	// Who can reach a resource: policies allowing it, the principals using those policies,
	// and the resources running as those principals.
	function accessors(id) {
		const edges = ctx.graph.edges;
		const out = [];
		for (const p of edges.filter((e) => e.kind === 'perm' && e.to === id)) {
			const users = edges.filter((e) => e.kind === 'attach' && e.to === p.from).map((e) => e.from);
			if (!users.length) out.push({ e: p, who: null, policy: p.from, role: null });
			for (const u of users) {
				out.push({ e: p, who: u, policy: p.from, role: null });
				for (const r of edges.filter((e) => (e.kind === 'runs-as' || e.kind === 'member') && e.to === u)) out.push({ e: p, who: r.from, policy: p.from, role: u, how: r.kind === 'member' ? 'member of' : 'runs as' });
			}
		}
		return out;
	}

	function detailsHtml(id, inModal) {
		const edges = ctx.graph.edges;
		const n = ctx.graph.nodes.find((x) => x.id === id);
		if (!n) return overviewHtml();
		const A = n.action ? ctx.act[n.action] : null;
		const outE = (k) => edges.filter((e) => e.from === id && e.kind === k);
		const inE = (k) => edges.filter((e) => e.to === id && e.kind === k);
		const item = (head, body) => '<div class="g-item">' + head + (body ? '<div class="g-ibody">' + body + '</div>' : '') + '</div>';
		const note = (txt) => txt ? '<div class="g-note">' + txt + '</div>' : '';
		const through = (x) => (x.role ? kv(x.how, link(x.role)) : '');

		// Principal side.
		const runsAs = outE('runs-as').map((e) => item(link(e.to), note(ctx.esc(e.labels.join(', ')))));
		const policies = outE('attach').map((a) => item(link(a.to),
			edges.filter((e) => e.kind === 'perm' && e.from === a.to).map((p) => '<div class="g-perm">' + kv('allows on', link(p.to)) + actionsHtml(p) + '</div>').join('') ||
			note('content not in the plan (AWS managed)')));
		const perms = effective(id).map((x) => item(link(x.e.to), kv('via', link(x.policy)) + through(x) + actionsHtml(x.e)));
		const canAssume = outE('trust').map((e) => item(link(e.to), actionsHtml(e)));
		const memberOf = outE('member').map((e) => item(link(e.to)));
		const members = inE('member').map((e) => item(link(e.from)));
		const limits = outE('boundary').map((e) => item(link(e.to), note(ctx.esc(e.labels.join(', ')) + ' — caps the permissions above, grants nothing')));
		const limited = inE('boundary').map((e) => item(link(e.from), note(ctx.esc(e.labels.join(', ')))));
		// Role side.
		const usedBy = inE('runs-as').map((e) => item(link(e.from), note(ctx.esc(e.labels.join(', ')))));
		const assumedBy = inE('trust').map((e) => item(link(e.from), viaHtml(e) + actionsHtml(e)));
		// Policy side.
		const attachedTo = inE('attach').map((e) => item(link(e.from)));
		const allows = outE('perm').map((e) => item(link(e.to), viaHtml(e) + actionsHtml(e)));
		// Resource side.
		const access = accessors(id).map((x) => item(x.who ? link(x.who) : link(x.policy),
			(x.who ? kv('via', link(x.policy)) : note('policy not attached in this ' + ctx.docName)) + through(x) + actionsHtml(x.e)));

		const total = memberOf.length + members.length + limits.length + limited.length + runsAs.length + policies.length + perms.length + canAssume.length + usedBy.length + assumedBy.length + attachedTo.length + allows.length + access.length;
		const inPlan = n.kind === 'resource' && ctx.inPlan(n.id);
		const isHidden = !!(ctx.st.gnodes || {})[n.id];
		return '<div class="g-head">' +
			(n.icon ? '<img src="' + ctx.esc(n.icon) + '" alt="">' : '<span class="g-noicon"></span>') +
			'<div><div class="g-title">' + addrHtml(n.label) + '</div>' +
			(n.cloudName ? '<div class="g-sub g-cloud">' + ctx.esc(n.cloudName) + '</div>' : '') +
			(n.categorySub ? '<div class="g-sub g-cloud">' + (n.categoryUrl ? '<button type="button" class="g-link g-src" data-gurl="' + ctx.esc(n.categoryUrl) + '">' + ctx.esc(n.categorySub) + '</button>' : ctx.esc(n.categorySub)) + '</div>' : '') +
			'<div class="g-sub">' + (A ? '<span style="color:' + A.fg + '">' + A.sym + ' ' + A.label + '</span>' : ctx.esc((n.detail || SUB[n.type] || 'External') + (n.kind === 'external' ? ' · outside project' : ''))) + '</div></div></div>' +
			'<div class="g-actions">' +
				(inPlan ? '<button type="button" class="btn g-open" data-open-plan="' + ctx.esc(n.id) + '">Show in ' + ctx.docName + '</button>' : '') +
				(inModal ? (id !== ctx.st.gfocus ? '<button type="button" class="btn g-open" data-gfocus="' + ctx.esc(n.id) + '">Focus on it</button>' : '')
					: '<button type="button" class="btn g-open" data-gfocus="' + ctx.esc(n.id) + '">Focus view</button>' +
					'<button type="button" class="btn g-open" data-ghide-node="' + ctx.esc(n.id) + '">' + (isHidden ? 'Show links' : 'Hide links') + '</button>') +
			'</div>' +
			section('Runs as', runsAs) +
			section('Used by', usedBy) +
			section('Can be assumed by', assumedBy) +
			section('Can assume', canAssume) +
			section('Member of', memberOf) +
			section('Members', members) +
			section('Limited by', limits) +
			section('Limits', limited) +
			section('Policies', policies) +
			section('Attached to', attachedTo) +
			section('Allows', allows) +
			section('Effective permissions', perms) +
			section('Who can access it', access) +
			(total ? '' : '<p class="g-empty">No IAM relationship for this resource.</p>');
	}

	function overviewHtml() {
		const edges = ctx.graph.edges;
		// Principals using at least one policy, with what each policy allows.
		const principals = [...new Set(edges.filter((e) => e.kind === 'attach').map((e) => e.from))];
		const items = principals.map((p) => '<div class="g-item g-principal">' + link(p) + '<div class="g-ibody">' +
			edges.filter((e) => e.kind === 'attach' && e.from === p).map((a) => '<div class="g-perm">' + kv('uses', link(a.to)) +
				edges.filter((e) => e.kind === 'perm' && e.from === a.to).map((x) => '<div class="g-allow">' + kv('allows on', link(x.to)) + actionsHtml(x) + '</div>').join('') +
			'</div>').join('') + '</div></div>');
		return '<div class="g-head"><div><div class="g-title">IAM overview</div>' +
			'<div class="g-sub">Click a resource, role or policy to see its permissions</div></div></div>' +
			(items.length ? section('Principals', items) : '<p class="g-empty">No IAM policy found in this ' + ctx.docName + '.</p>');
	}

	// --- Tubes ----------------------------------------------------------------------
	// Links whose ends are in two different groups, bundled per pair of groups: one thick
	// link between the two frames, routed around them, with its number of links.

	function tubesOf(edges) {
		const frameOf = new Map();
		view.layout.clusters.forEach((c) => { for (const n of c.nodes) frameOf.set(n.id, c); });
		const inner = [], tubes = new Map();
		for (const e of edges) {
			const a = frameOf.get(e.from), b = frameOf.get(e.to);
			if (!a || !b || a === b) { inner.push(e); continue; }
			const fwd = a.key < b.key, k = fwd ? a.key + '\u0000' + b.key : b.key + '\u0000' + a.key;
			if (!tubes.has(k)) tubes.set(k, { key: k, a: fwd ? a : b, b: fwd ? b : a, edges: [], fwd: 0, back: 0 });
			const t = tubes.get(k);
			t.edges.push(e);
			if (fwd) t.fwd++; else t.back++;
		}
		return { inner, tubes: [...tubes.values()] };
	}

	// Routes between the frames (the frames being the obstacles), cached per set of tubes.
	function tubeRoutes(tubes) {
		const key = view.key + '#' + tubes.map((t) => t.key).join('|');
		if (view.tubeKey === key) return view.tubeRoutes;
		const L = view.layout, xy = new Map();
		for (const c of L.clusters) xy.set('frame:' + c.key, { x: c.x, y: c.y, w: c.w, h: c.h });
		const g = {
			nodes: L.clusters.map((c) => ({ id: 'frame:' + c.key })),
			edges: tubes.map((t) => ({ from: 'frame:' + t.a.key, to: 'frame:' + t.b.key, kind: 'tube', effect: t.key }))
		};
		view.tubeKey = key;
		view.tubeRoutes = routeAll(g, { xy, clusters: [], width: L.width, height: L.height });
		return view.tubeRoutes;
	}

	function tubesSvg(tubes, hl) {
		const routes = tubeRoutes(tubes), chips = [], taken = [];
		const paths = tubes.map((t) => {
			const pts = routes.get('frame:' + t.a.key + '|frame:' + t.b.key + '|tube|' + t.key);
			if (!pts) return '';
			const n = t.edges.length;
			const count = {};
			for (const e of t.edges) count[e.kind] = (count[e.kind] || 0) + 1;
			const kinds = Object.keys(count).sort((x, y) => count[y] - count[x]);
			const color = KINDS[kinds[0]].color, width = Math.min(3 + 2 * Math.sqrt(n), 16);
			const dim = hl && !t.edges.some((e) => hl.has(e)) ? ' dim' : '';
			const title = t.a.label + ' ↔ ' + t.b.label + '\n' + n + (n > 1 ? ' links: ' : ' link: ') + kinds.map((k) => count[k] + ' ' + KINDS[k].label).join(', ') +
				'\n\n' + t.edges.slice(0, 12).map((e) => e.from + ' → ' + e.to).join('\n') + (n > 12 ? '\n…' : '');
			const txt = n + (n > 1 ? ' links' : ' link'), w = chipWidth(txt);
			const [mx, my] = placeChip(view, pts, w, taken);
			chips.push('<g class="edge chip tube-chip' + dim + '" style="--c:' + color + '" transform="translate(' + (mx - w / 2) + ',' + (my - 10) + ')"><title>' + ctx.esc(title) + '</title>' +
				'<rect width="' + w + '" height="20" rx="10" fill="#141414" fill-opacity="0.95" stroke="' + color + '" stroke-opacity="0.8"></rect>' +
				'<text x="' + w / 2 + '" y="14" text-anchor="middle" fill="' + color + '">' + txt + '</text></g>');
			const d = pathOf(pts);
			return '<g class="edge tube' + dim + '" style="--c:' + color + '"><title>' + ctx.esc(title) + '</title>' +
				'<path class="hit" d="' + d + '"></path>' +
				'<path class="line" d="' + d + '" stroke="' + color + '" stroke-width="' + width + '" stroke-opacity="0.45" stroke-linecap="round"' +
				(t.fwd ? ' marker-end="url(#tube-' + kinds[0] + ')"' : '') + (t.back ? ' marker-start="url(#tube-' + kinds[0] + ')"' : '') + '></path></g>';
		}).join('');
		return { paths, chips: chips.join('') };
	}

	// --- Graph options dock ----------------------------------------------------------

	const DOCK_ICON = {
		vertical: '<path d="M12 3v18M7 16l5 5 5-5"></path>',
		horizontal: '<path d="M3 12h18M16 7l5 5-5 5"></path>',
		force: '<circle cx="6" cy="6" r="2.5"></circle><circle cx="18" cy="8" r="2.5"></circle><circle cx="10" cy="18" r="2.5"></circle><path d="M8.3 7l7.4.7M7 8.3l2.2 7.4M16.5 10l-4.6 6.3"></path>',
		modules: '<rect x="3" y="3" width="8" height="8" rx="1.5"></rect><rect x="13" y="3" width="8" height="8" rx="1.5"></rect><rect x="3" y="13" width="8" height="8" rx="1.5"></rect><rect x="13" y="13" width="8" height="8" rx="1.5"></rect>',
		tubes: '<path d="M3 8h6c4 0 4 8 8 8h4" stroke-width="5" stroke-opacity=".45"></path><path d="M3 8h6c4 0 4 8 8 8h4"></path>',
		chips: '<rect x="3" y="8" width="18" height="8" rx="4"></rect><path d="M7 12h10"></path>'
	};

	function dockHtml() {
		const svg = (k) => '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + DOCK_ICON[k] + '</svg>';
		const force = ctx.direction === 'force';
		const choice = (val, label) => '<button type="button" data-gcfg="direction" data-val="' + val + '" aria-pressed="' + (ctx.direction === val) + '" title="' + label + '" aria-label="' + label + '">' + svg(val) + '</button>';
		const toggle = (key, label, off) => '<button type="button" data-gcfg="' + key + '" aria-pressed="' + (!!ctx[key] && !off) + '"' + (off ? ' disabled' : '') +
			' title="' + label + (off ? ' (not with the force layout)' : '') + '" aria-label="' + label + '">' + svg(key) + '</button>';
		return '<div class="g-dock" role="toolbar" aria-label="Graph options">' +
			choice('vertical', 'Layout: top to bottom') + choice('horizontal', 'Layout: left to right') + choice('force', 'Layout: force') +
			'<span class="sep" aria-hidden="true"></span>' +
			toggle('modules', 'Group by module', force) +
			toggle('tubes', 'Bundle the links between two groups into one tube', force) +
			toggle('chips', 'Action labels on links') +
		'</div>';
	}

	// --- Public API ------------------------------------------------------------------

	const ICON = {
		fit: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"></path></svg>',
		close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>'
	};

	function render(root, c) {
		ctx = c;
		const key = c.graph.nodes.map((n) => n.id + '@' + n.category).join('|') + '#' + c.graph.edges.length + '#' + c.direction;
		if (view.key !== key) {
			view.key = key;
			if (c.direction === 'force') {
				view.layout = forceLayout(c.graph);
				view.routes = straightRoutes(c.graph, view.layout);
			} else {
				view.layout = layout(c.graph, c.direction === 'horizontal');
				view.routes = routeAll(c.graph, view.layout);
			}
			view.fit = true;
		}
		// Muted resources stay in place, dimmed, with their links hidden.
		const gnodes = c.st.gnodes || {};
		const hiddenCount = c.graph.nodes.filter((n) => gnodes[n.id]).length;
		const focus = c.st.gsel && c.graph.nodes.some((n) => n.id === c.st.gsel) ? c.st.gsel : null;
		const edges = visibleEdges();
		// Highlight the whole access chain of the selection.
		let hl = null;
		const near = new Set([focus]);
		if (focus) {
			hl = chainOf(focus, edges).hl;
			for (const e of hl) { near.add(e.from); near.add(e.to); }
		}
		const hidden = c.st.ghide || {};
		// Tubes: links between two groups drawn as one bundle (not with the force layout,
		// which has no groups); links inside a group stay individual.
		const tubed = c.tubes && c.direction !== 'force' && view.layout.clusters.length > 1;
		const bundles = tubed ? tubesOf(edges) : null;
		const drawn = edgesSvg(view, bundles ? bundles.inner : edges, hl);
		if (bundles) {
			const t = tubesSvg(bundles.tubes, hl);
			drawn.paths = t.paths + drawn.paths;
			drawn.chips += t.chips;
		}

		root.innerHTML =
			'<div class="g-bar">' +
				'<span class="t">AWS IAM</span>' +
				'<span class="info">' + c.graph.nodes.length + ' nodes · ' + c.graph.edges.length + ' links</span>' +
				'<div class="grow"></div>' +
				(hiddenCount ? '<button type="button" class="g-kind" data-gact="unhide" title="Show the links of every muted resource">' +
					'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A9.8 9.8 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"></path></svg>' +
					hiddenCount + ' muted · Show all</button>' : '') +
				'<div class="g-legend">' + Object.entries(KINDS).map(([k, K]) =>
					'<button type="button" class="g-kind" data-gkind="' + k + '" aria-pressed="' + !hidden[k] + '">' +
					'<svg width="22" height="8" aria-hidden="true"><line x1="1" y1="4" x2="21" y2="4" stroke="' + K.color + '" stroke-width="2"' + (K.dash ? ' stroke-dasharray="' + K.dash + '"' : '') + '></line></svg>' +
					K.label + '<span class="n">' + c.graph.edges.filter((e) => e.kind === k).length + '</span></button>').join('') +
				'</div>' +
				'<button type="button" class="icon-btn" data-gact="fit" title="Fit to screen" aria-label="Fit to screen">' + ICON.fit + '</button>' +
			'</div>' +
			'<div class="g-body">' +
				'<div class="g-canvas" id="g-canvas"><svg id="g-svg" width="100%" height="100%">' + defs() +
					'<g id="g-vp">' + clustersSvg() + drawn.paths + nodesSvg(view, c.graph.nodes, focus, near) + drawn.chips + '</g></svg>' +
					'<div class="g-hint">Scroll to zoom · drag to pan · double-click a resource to focus on its relations</div>' +
					dockHtml() +
				'</div>' +
				'<aside class="g-side" id="g-side">' + (focus ? detailsHtml(focus) : overviewHtml()) + '</aside>' +
			'</div>' +
			focusModalHtml(edges);

		if (view.fit) fit(view);
		else applyView(view);
		if (fview.key) {
			if (fview.fit) fit(fview);
			else applyView(fview);
		}
		bind(root);
	}

	// Focus view: the focused node and its access chain only, laid out left to right.
	function focusModalHtml(edges) {
		const id = ctx.st.gfocus;
		const n = id && ctx.graph.nodes.find((x) => x.id === id);
		if (!n) { fview.key = null; return ''; }
		const { hl, rank } = chainOf(id, edges);
		const sub = [...hl];
		const nodes = ctx.graph.nodes.filter((x) => rank.has(x.id));
		const fresh = !fview.key;
		const key = id + '#' + view.key + '#' + sub.map(edgeKey).join(',');
		if (fview.key !== key) {
			fview.key = key;
			fview.layout = focusLayout(nodes, sub, rank);
			fview.routes = routeAll({ nodes, edges: sub }, fview.layout);
			fview.fit = true;
		}
		const sel = ctx.st.gfsel && rank.has(ctx.st.gfsel) ? ctx.st.gfsel : id;
		const drawn = edgesSvg(fview, sub, null);
		return '<div class="modal g-fmodal' + (fresh ? ' fresh' : '') + '" id="g-fmodal" role="dialog" aria-label="Relations of ' + ctx.esc(n.label) + '">' +
			'<div class="modal-card g-fcard">' +
				'<div class="modal-head">' +
					'<div class="g-fhead">' + (n.icon ? '<img src="' + ctx.esc(n.icon) + '" alt="">' : '') +
						'<div><h2>' + addrHtml(n.label) + '</h2><div class="g-sub">' + (nodes.length - 1) + ' related · ' + sub.length + ' links</div></div></div>' +
					'<div class="g-factions">' +
						'<button type="button" class="icon-btn" data-gact="ffit" title="Fit to screen" aria-label="Fit to screen">' + ICON.fit + '</button>' +
						'<button type="button" class="modal-close" data-gact="fclose" title="Close (Esc)" aria-label="Close">' + ICON.close + '</button>' +
					'</div>' +
				'</div>' +
				'<div class="g-fbody">' +
					'<div class="g-canvas" id="gf-canvas"><svg width="100%" height="100%">' + defs() +
						'<g id="gf-vp">' + drawn.paths + nodesSvg(fview, nodes, sel, new Set(rank.keys()), false) + drawn.chips + '</g></svg>' +
						'<div class="g-hint">Click to inspect · double-click to refocus</div>' +
					'</div>' +
					'<aside class="g-side g-fside" id="gf-side">' + detailsHtml(sel, true) + '</aside>' +
				'</div>' +
			'</div>' +
		'</div>';
	}

	function applyView(v) {
		const vp = document.getElementById(v.vp);
		if (vp) vp.setAttribute('transform', 'translate(' + v.x + ',' + v.y + ') scale(' + v.k + ')');
	}

	function fit(v) {
		const vp = document.getElementById(v.vp);
		const cv = vp && vp.closest('.g-canvas');
		if (!cv || !cv.clientWidth) return;
		const { width, height } = v.layout;
		// The details panel floats over the right of the main canvas.
		const side = document.getElementById(v.side);
		const avail = cv.clientWidth - (side && getComputedStyle(side).position === 'absolute' ? side.offsetWidth + 24 : 0);
		v.k = Math.min(1.2, Math.max(0.2, Math.min(avail / width, cv.clientHeight / height)));
		v.x = (avail - width * v.k) / 2;
		v.y = (cv.clientHeight - height * v.k) / 2;
		v.fit = false;
		applyView(v);
	}

	// Focus view: inspecting a node only moves the selection and refreshes the details
	// panel, without redrawing the view (null inspects the focused node).
	function inspect(id) {
		ctx.setState({ gfsel: id }, true);
		ctx.st = Object.assign({}, ctx.st, { gfsel: id });
		const sel = id || ctx.st.gfocus;
		document.querySelectorAll('#gf-vp .node').forEach((el) => el.classList.toggle('sel', el.dataset.node === sel));
		const side = document.getElementById('gf-side');
		if (side) {
			side.innerHTML = detailsHtml(sel, true);
			side.scrollTop = 0;
		}
	}

	function bind(root) {
		if (root.dataset.bound) return;
		root.dataset.bound = '1';
		let drag = null;
		const viewOf = (cv) => (cv.id === 'gf-canvas' ? fview : view);
		const closeFocus = () => ctx.setState({ gfocus: null, gfsel: null });

		root.addEventListener('click', (ev) => {
			const t = ev.target;
			const opt = t.closest('[data-gcfg]');
			if (opt) {
				if (opt.disabled) return;
				return ctx.setCfg({ [opt.dataset.gcfg]: 'val' in opt.dataset ? opt.dataset.val : !ctx[opt.dataset.gcfg] });
			}
			const inModal = !!t.closest('#g-fmodal');
			if (t.id === 'g-fmodal' || t.closest('[data-gact="fclose"]')) return closeFocus();
			if (t.closest('[data-gact="ffit"]')) return fit(fview);
			const kind = t.closest('[data-gkind]');
			if (kind) {
				const h = Object.assign({}, ctx.st.ghide);
				h[kind.dataset.gkind] = !h[kind.dataset.gkind];
				return ctx.setState({ ghide: h });
			}
			if (t.closest('[data-gact="fit"]')) return fit(view);
			if (t.closest('[data-gact="unhide"]')) return ctx.setState({ gnodes: {} });
			const url = t.closest('[data-gurl]');
			if (url && !(drag && drag.moved)) return ctx.openUrl(url.dataset.gurl);
			const group = t.closest('[data-ghide-group]');
			if (group && !(drag && drag.moved)) {
				const c = view.layout.clusters.find((x) => x.key === group.dataset.ghideGroup);
				if (!c) return;
				const h = Object.assign({}, ctx.st.gnodes);
				const muted = c.nodes.every((n) => h[n.id]);
				for (const n of c.nodes) { if (muted) delete h[n.id]; else h[n.id] = true; }
				return ctx.setState({ gnodes: h });
			}
			const hide = t.closest('[data-ghide-node]');
			if (hide && !(drag && drag.moved)) {
				const h = Object.assign({}, ctx.st.gnodes);
				const id = hide.dataset.ghideNode;
				if (h[id]) delete h[id]; else h[id] = true;
				return ctx.setState({ gnodes: h });
			}
			const foc = t.closest('[data-gfocus]');
			if (foc) return ctx.setState({ gfocus: foc.dataset.gfocus, gfsel: null });
			const open = t.closest('[data-open-plan]');
			if (open) {
				if (inModal) closeFocus();
				return ctx.openInPlan(open.dataset.openPlan);
			}
			const sel = t.closest('[data-gsel]');
			if (sel) {
				if (!inModal) return ctx.setState({ gsel: sel.dataset.gsel });
				// Inside the focus view: inspect a node already shown, refocus on any other.
				const shown = fview.layout.xy.has(sel.dataset.gsel);
				return shown ? inspect(sel.dataset.gsel) : ctx.setState({ gfocus: sel.dataset.gsel, gfsel: null });
			}
			if (drag && drag.moved) return;
			// The second click of a double-click must not undo the first one.
			if (ev.detail > 1) return;
			const node = t.closest('[data-node]');
			if (inModal) {
				if (node) return inspect(node.dataset.node === ctx.st.gfsel ? null : node.dataset.node);
				if (t.closest('.g-canvas')) inspect(null);
				return;
			}
			if (node) return ctx.setState({ gsel: node.dataset.node === ctx.st.gsel ? null : node.dataset.node });
			if (t.closest('.g-canvas')) ctx.setState({ gsel: null });
		});
		let hovered = null;
		root.addEventListener('mouseover', (ev) => {
			const node = ev.target.closest('[data-node]');
			const id = node ? node.dataset.node : null;
			if (id === hovered) return;
			hovered = id;
			root.querySelectorAll('.edge.lit').forEach((el) => el.classList.remove('lit'));
			if (id) node.closest('svg').querySelectorAll('.edge').forEach((el) => {
				if (el.dataset.from === id || el.dataset.to === id) el.classList.add('lit');
			});
		});
		root.addEventListener('dblclick', (ev) => {
			if (ev.target.closest('[data-ghide-node], [data-ghide-group]')) return;
			const node = ev.target.closest('[data-node]');
			if (node && node.dataset.node !== ctx.st.gfocus) ctx.setState({ gfocus: node.dataset.node, gfsel: null });
		});
		document.addEventListener('keydown', (ev) => {
			if (ev.key === 'Escape' && ctx && ctx.st.gfocus && root.offsetParent) closeFocus();
		});
		root.addEventListener('pointerdown', (ev) => {
			const cv = ev.target.closest('.g-canvas');
			if (!cv || ev.button !== 0) return;
			const v = viewOf(cv);
			drag = { v, cv, x: ev.clientX, y: ev.clientY, vx: v.x, vy: v.y, moved: false };
		});
		window.addEventListener('pointermove', (ev) => {
			if (!drag) return;
			const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
			if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
			if (!drag.moved) return;
			drag.v.x = drag.vx + dx / (ctx.zoom || 1);
			drag.v.y = drag.vy + dy / (ctx.zoom || 1);
			applyView(drag.v);
			drag.cv.classList.add('panning');
		});
		window.addEventListener('pointerup', () => {
			root.querySelectorAll('.g-canvas.panning').forEach((cv) => cv.classList.remove('panning'));
			setTimeout(() => { drag = null; }, 0);
		});
		root.addEventListener('wheel', (ev) => {
			const cv = ev.target.closest('.g-canvas');
			if (!cv) return;
			ev.preventDefault();
			const v = viewOf(cv);
			const r = cv.getBoundingClientRect();
			const z = ctx.zoom || 1;
			const px = (ev.clientX - r.left) / z, py = (ev.clientY - r.top) / z;
			const k = Math.min(2.5, Math.max(0.2, v.k * Math.exp(-ev.deltaY * 0.0015)));
			v.x = px - (px - v.x) * (k / v.k);
			v.y = py - (py - v.y) * (k / v.k);
			v.k = k;
			applyView(v);
		}, { passive: false });
		window.addEventListener('resize', () => {
			if (!ctx || !root.offsetParent) return;
			applyView(view);
			if (fview.key) applyView(fview);
		});
	}

	window.PreflightGraph = { render, fit: () => { view.fit = true; fit(view); } };
})();
