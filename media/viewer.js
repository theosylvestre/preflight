// @ts-nocheck
// Preflight webview. Receives the model built by src/planParser.js
// via postMessage and renders it.
(function () {
	const vscode = acquireVsCodeApi();

	const PLAN_ACT = {
		create:  { sym: '+', label: 'create',          verb: 'will be created',          fg: '#56d364', bg: 'rgba(46,160,67,0.16)',  bd: 'rgba(46,160,67,0.45)' },
		update:  { sym: '~', label: 'update in-place', verb: 'will be updated in-place', fg: '#e3b341', bg: 'rgba(210,153,34,0.16)', bd: 'rgba(210,153,34,0.45)' },
		replace: { sym: '±', label: 'replace',         verb: 'must be replaced',         fg: '#c297ff', bg: 'rgba(163,113,247,0.18)', bd: 'rgba(163,113,247,0.5)' },
		delete:  { sym: '−', label: 'destroy',         verb: 'will be destroyed',        fg: '#ff7b72', bg: 'rgba(248,81,73,0.16)',  bd: 'rgba(248,81,73,0.45)' },
		read:    { sym: '≤', label: 'read',            verb: 'will be read during apply', fg: '#79c0ff', bg: 'rgba(56,139,253,0.16)', bd: 'rgba(56,139,253,0.45)' },
		forget:  { sym: '⊘', label: 'forget',          verb: 'will be removed from state', fg: '#f0883e', bg: 'rgba(240,136,62,0.16)', bd: 'rgba(240,136,62,0.45)' },
		noop:    { sym: '=', label: 'no changes',      verb: 'has no changes',           fg: '#8b94a7', bg: 'rgba(139,148,167,0.12)', bd: 'rgba(139,148,167,0.35)' }
	};
	// In a state nothing changes: resources are simply "managed" or "data sources".
	const STATE_ACT = Object.assign({}, PLAN_ACT, {
		noop: { sym: '•', label: 'managed', verb: 'is in the state', fg: '#8b94a7', bg: 'rgba(139,148,167,0.12)', bd: 'rgba(139,148,167,0.35)' },
		read: { sym: '≤', label: 'data source', verb: 'is a data source', fg: '#79c0ff', bg: 'rgba(56,139,253,0.16)', bd: 'rgba(56,139,253,0.45)' }
	});
	let ACT = PLAN_ACT;
	const ORDER = ['create', 'update', 'replace', 'delete', 'read', 'forget', 'noop'];
	const OPTIONAL = { read: true, forget: true };
	const STATE_CHIP_LABEL = { all: 'All', noop: 'Managed', read: 'Data' };
	const CHIP_LABEL = { all: 'All', create: 'Create', update: 'Update', replace: 'Replace', delete: 'Destroy', read: 'Read', forget: 'Forget', noop: 'No-op' };
	const SIGN = { a: '+', d: '−', c: ' ' };

	const $ = (id) => document.getElementById(id);
	const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

	// Viewer settings (persisted by the extension, shared by every plan / state view).
	const DEFAULTS = { label: 'both', anim: false, glow: false, chips: true, modules: true, tubes: false, direction: 'horizontal', size: 'm' };
	const ZOOM = { s: 0.9, m: 1, l: 1.12 };
	const SETTINGS = [
		{ title: 'Resources', items: [
			{ key: 'label', type: 'choice', label: 'Resource name', hint: 'Terraform address (type.name), name in AWS (bucket, role, function…), or both.',
				options: [['address', 'Terraform'], ['cloud', 'AWS'], ['both', 'Both']] }
		] },
		{ title: 'Diff', items: [
			{ key: 'nums', state: true, type: 'toggle', label: 'Line numbers' },
			{ key: 'hide', state: true, type: 'toggle', label: 'Hide unchanged attributes' },
			{ key: 'view', state: true, type: 'choice', label: 'Layout', options: [['unified', 'Unified'], ['split', 'Split']] }
		] },
		{ title: 'Graph', items: [
			{ key: 'direction', type: 'choice', label: 'Layout', hint: 'Groups stacked in layers following their links (top to bottom, or left to right), or resources placed freely by a force simulation, without groups.',
				options: [['vertical', 'Vertical'], ['horizontal', 'Horizontal'], ['force', 'Force']] },
			{ key: 'tubes', type: 'toggle', label: 'Tubes between groups', hint: 'Links from one group to another bundled into a single tube (not with the force layout).' },
			{ key: 'modules', type: 'toggle', label: 'Group by module', info: 'On: resources declared in a module are grouped by module. Off: every resource is grouped by resource type (AWS category).' },
			{ key: 'anim', type: 'toggle', label: 'Animated links', hint: 'Particles flowing in the direction of each link.' },
			{ key: 'glow', type: 'toggle', label: 'Glow on hover' },
			{ key: 'chips', type: 'toggle', label: 'Action labels on links' }
		] },
		{ title: 'Display', items: [
			{ key: 'size', type: 'choice', label: 'Text size', options: [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']] }
		] }
	];
	let cfg = Object.assign({}, DEFAULTS);

	let model = null;
	let meta = { path: [], error: null };
	let st = Object.assign({ tab: 'plan', sel: null, filter: 'all', q: '', view: 'split', hide: false, nums: true, folds: {}, gsel: null, ghide: {}, gnodes: {}, gfocus: null, gfsel: null }, vscode.getState() || {});

	function applyCfg() {
		const b = document.body.classList;
		b.toggle('no-anim', !cfg.anim);
		b.toggle('no-glow', !cfg.glow);
		b.toggle('no-chips', !cfg.chips);
		document.querySelector('.app').style.zoom = ZOOM[cfg.size] || 1;
	}
	function setCfg(patch) {
		cfg = Object.assign({}, cfg, patch);
		applyCfg();
		vscode.postMessage({ type: 'settings', settings: cfg });
		render();
	}

	// Resource label according to the "Resource name" setting: { main, pre, sub }.
	function labelOf(r, sp) {
		const name = r.cloudName;
		if (cfg.label === 'cloud' && name) return { pre: '', main: name, extra: r.addr };
		if (cfg.label === 'both' && name) return { pre: sp.pre, main: sp.name, extra: name };
		return { pre: sp.pre, main: sp.name, extra: '' };
	}

	// `quiet`: saves the state without re-rendering (the caller updates the page itself).
	function setState(patch, quiet) {
		st = Object.assign({}, st, patch);
		vscode.setState(st);
		if (!quiet) render();
	}

	// --- Helpers from the design -------------------------------------------------

	function isBrace(v) { return typeof v === 'string' && /^(?:[\[\]{}()]+,?|jsonencode\()$/.test(v); }
	const OPEN = { '{': '}', '[': ']', 'jsonencode(': ')' };

	// Maps each opening line ({, [, jsonencode() to the index of its closing line.
	function blocks(r) {
		if (r._blocks) return r._blocks;
		const map = new Map(), stack = [];
		r.lines.forEach((e, i) => {
			const v = e[3];
			if (typeof v !== 'string') return;
			if (OPEN[v]) stack.push(i);
			else if (!e[2] && stack.length && OPEN[r.lines[stack[stack.length - 1]][3]] === v) map.set(stack.pop(), i);
		});
		r._blocks = map;
		return map;
	}
	// Lines to keep when unchanged lines are hidden: the changes, plus the opening and
	// closing lines of the blocks that contain one (so a change keeps its path).
	function relevantLines(r) {
		const keep = new Set(), stack = [];
		r.lines.forEach((e, i) => {
			const v = e[3], changed = e[0] !== 'c';
			if (changed) {
				keep.add(i);
				for (const b of stack) b.changed = true;
			}
			if (typeof v === 'string' && OPEN[v]) stack.push({ i, changed: false });
			else if (isBrace(v) && /^[\]})]/.test(v) && stack.length) {
				const b = stack.pop();
				if (b.changed) { keep.add(b.i); keep.add(i); }
			}
		});
		return keep;
	}
	function foldedOf(r) { return new Set((st.folds && st.folds[r.addr]) || []); }
	function setFolds(r, set) {
		setState({ folds: Object.assign({}, st.folds, { [r.addr]: [...set] }) });
	}
	function muted(v) { return typeof v === 'string' && v.charAt(0) === '('; }
	function splitAddr(a) {
		// Splits on the last "." outside brackets (module.x.aws_y.z["a.b"]).
		let depth = 0, cut = -1;
		for (let i = 0; i < a.length; i++) {
			const ch = a.charAt(i);
			if (ch === '[') depth++;
			else if (ch === ']') depth--;
			else if (ch === '.' && depth === 0) cut = i;
		}
		return { pre: a.slice(0, cut + 1), name: a.slice(cut + 1) };
	}
	function keyParts(key) {
		if (!key) return { key: '', eq: '' };
		if (key.charAt(0) === '@') return { key: key.slice(1), eq: ' ' };
		return { key: key, eq: ' = ' };
	}
	function diffParts(a, b) {
		let p = 0, s = 0;
		if (a.charAt(0) === '"' && b.charAt(0) === '"') {
			const max = Math.min(a.length, b.length);
			while (p < max && a.charAt(p) === b.charAt(p)) p++;
			while (s < max - p && a.charAt(a.length - 1 - s) === b.charAt(b.length - 1 - s)) s++;
		}
		return {
			a: { pre: a.slice(0, p), mid: a.slice(p, a.length - s), post: a.slice(a.length - s) },
			b: { pre: b.slice(0, p), mid: b.slice(p, b.length - s), post: b.slice(b.length - s) }
		};
	}
	function iconHtml(r, cls) {
		if (!r.icon) return '<span class="' + cls + ' none" aria-hidden="true"></span>';
		return '<img class="' + cls + '" src="' + esc(r.icon) + '" alt="' + esc(r.service.replace(/-/g, ' ')) + '" title="' + esc(r.service.replace(/-/g, ' ')) + '">';
	}
	// Changes by kind; `u`: values known after apply (AWS decides), counted apart.
	function stats(r) {
		let a = 0, d = 0, m = 0, u = 0;
		r.lines.forEach((e) => {
			if (e[5]) { if (e[0] !== 'd' && !isBrace(e[3])) u++; }
			else if (e[0] === 'm') m++;
			else if (!isBrace(e[3])) { if (e[0] === 'a') a++; if (e[0] === 'd') d++; }
		});
		return { a, d, m, u };
	}

	// A "side" is one half of a row (kind, line number, content).
	function side(kind, e, val, parts, no, note) {
		return { kind, no, e, val, parts, note: note || '', unk: !!e[5] };
	}
	// Row class and sign: a blue "?" for values only AWS will settle.
	function kindCls(sd) { return 'k-' + sd.kind + (sd.unk ? ' k-u' : ''); }
	function signOf(sd) { return sd.unk ? '?' : SIGN[sd.kind]; }
	function emptySide() { return { kind: 'e' }; }

	// Diff rows (unified `u` and split `s`), honouring collapsed blocks
	// (`folded`: indexes of opening lines) and hidden unchanged lines.
	function build(r, hide, folded) {
		const u = [], s = [], bl = blocks(r), keep = hide ? relevantLines(r) : null;
		let o = 1, n = 1, oc = 0, nc = 0, skipTo = -1;
		r.lines.forEach((e, i) => {
			const k = e[0], v = e[3];
			// Inside a collapsed block: only the line counters move forward.
			if (i <= skipTo) {
				if (k !== 'a') { o++; oc++; }
				if (k !== 'd') { n++; nc++; }
				return;
			}
			const fold = bl.has(i) ? { idx: i, open: !folded.has(i) } : null;
			let collapsed = null;
			if (fold && !fold.open) {
				const end = bl.get(i), inner = r.lines.slice(i + 1, end);
				skipTo = end;
				collapsed = { close: r.lines[end][3], count: inner.length, changes: inner.filter((x) => x[0] !== 'c').length };
			}
			const mk = (kind, val, parts, no, note) => Object.assign(side(kind, e, val, parts, no, note), { fold, collapsed });

			if (k === 'c') {
				if (keep && !keep.has(i)) { o++; n++; oc++; nc++; return; }
				u.push({ side: mk('c', v, null, n), o, n });
				s.push({ L: mk('c', v, null, o), R: mk('c', v, null, n) });
				o++; n++; oc++; nc++;
				return;
			}
			if (k === 'a') {
				const R = mk('a', v, null, n, e[4]);
				u.push({ side: R, o: '', n });
				s.push({ L: emptySide(), R });
				n++; nc++;
			} else if (k === 'd') {
				const L = mk('d', v, null, o, e[4]);
				u.push({ side: L, o, n: '' });
				s.push({ L, R: emptySide() });
				o++; oc++;
			} else if (k === 'm') {
				const dp = diffParts(v[0], v[1]);
				u.push({ side: side('d', e, v[0], dp.a, o), o, n: '' });
				u.push({ side: side('a', e, v[1], dp.b, n, e[4]), o: '', n });
				s.push({ L: side('d', e, v[0], dp.a, o), R: side('a', e, v[1], dp.b, n, e[4]) });
				o++; n++; oc++; nc++;
			}
		});
		return { u, s, hunk: '@@ -1,' + oc + ' +1,' + nc + ' @@' };
	}

	// --- HTML rendering ------------------------------------------------------------

	function valueHtml(sd) {
		const kp = keyParts(sd.e[2]);
		const cls = 'v' + (muted(sd.val) ? ' muted' : '');
		const pad = 20 + sd.e[1] * 20;
		let v;
		if (sd.parts) {
			v = '<span class="' + cls + '">' + esc(sd.parts.pre) + '</span>' +
				'<span class="' + cls + ' hl">' + esc(sd.parts.mid) + '</span>' +
				'<span class="' + cls + '">' + esc(sd.parts.post) + '</span>';
		} else {
			v = '<span class="' + cls + '">' + esc(sd.val) + '</span>';
		}
		if (sd.collapsed) {
			const c = sd.collapsed;
			v += '<span class="more" data-fold="' + sd.fold.idx + '">⋯ ' + c.count + ' line' + (c.count > 1 ? 's' : '') +
				(c.changes ? ' · <b>' + c.changes + ' change' + (c.changes > 1 ? 's' : '') + '</b>' : '') + '</span>' +
				'<span class="v">' + esc(c.close) + '</span>';
		}
		const chev = sd.fold
			? '<button type="button" class="chev" data-fold="' + sd.fold.idx + '" aria-expanded="' + sd.fold.open + '" aria-label="' + (sd.fold.open ? 'Collapse' : 'Expand') + '" style="left:' + (pad - 17) + 'px">' +
				'<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="' + (sd.fold.open ? 'M2 3.5 5 6.5 8 3.5' : 'M3.5 2 6.5 5 3.5 8') + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>'
			: '';
		return '<span class="val" style="padding-left:' + pad + 'px">' + chev + '<span class="k">' + esc(kp.key) + '</span><span class="eq">' + kp.eq + '</span>' + v + '</span>';
	}
	function noteHtml(sd) {
		return '<span class="note-cell">' + (sd.note ? '<span class="note"># ' + esc(sd.note) + '</span>' : '') + '</span>';
	}
	function unifiedHtml(rows, single) {
		return rows.map((row) => {
			const sd = row.side;
			const guts = single
				? '<span class="gut">' + (row.n || row.o) + '</span>'
				: '<span class="gut">' + row.o + '</span><span class="gut">' + row.n + '</span>';
			return '<div class="u-row ' + kindCls(sd) + '"' + (sd.unk ? ' title="Known after apply: AWS evaluates this value"' : '') + '>' + guts +
				'<span class="sign">' + signOf(sd) + '</span>' + valueHtml(sd) + noteHtml(sd) + '</div>';
		}).join('');
	}
	function splitSide(sd) {
		if (sd.kind === 'e') return '<div class="s-side k-e"><span class="gut"></span><span></span><span></span><span></span></div>';
		return '<div class="s-side ' + kindCls(sd) + '"><span class="gut">' + sd.no + '</span><span class="sign">' + signOf(sd) + '</span>' + valueHtml(sd) + noteHtml(sd) + '</div>';
	}
	function splitHtml(rows) {
		return '<div class="cols"><div>Before · current state</div><div>After · plan</div></div>' +
			rows.map((row) => '<div class="s-row">' + splitSide(row.L) + splitSide(row.R) + '</div>').join('');
	}

	function renderHeader() {
		const parts = meta.path.length ? meta.path : ['tfplan.json'];
		$('crumbs').innerHTML = parts.map((p, i) =>
			(i ? '<span class="s">/</span>' : '') + '<span' + (i >= parts.length - 2 ? ' class="hi"' : '') + '>' + esc(p) + '</span>'
		).join('');
		let gen = '';
		if (model && model.timestamp) {
			const d = new Date(model.timestamp);
			if (!isNaN(d.getTime())) {
				gen = 'Generated ' + d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) +
					' · ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
			}
		}
		if (isState()) {
			const s = model.state || {};
			gen = 'State' + (s.serial !== null && s.serial !== undefined ? ' · serial ' + s.serial : '') + (s.format ? ' · ' + s.format : '');
		}
		$('gen').textContent = gen;
		$('ver').textContent = model ? 'terraform ' + model.terraformVersion : '';
		$('ver').hidden = !model;
	}

	function render() {
		renderHeader();
		if (meta.error || !model) {
			$('body').hidden = true;
			$('graph').hidden = true;
			document.querySelector('.dock').hidden = true;
			$('state').hidden = false;
			$('state').innerHTML = meta.error
				? '<h2>Unable to read this plan</h2><p>' + esc(meta.error) + '</p><pre>terraform plan -out=tfplan.bin\nterraform show -json tfplan.bin &gt; tfplan.json</pre>'
				: '<p>Loading plan…</p>';
			$('foot-status').className = 'led' + (meta.error ? ' err' : '');
			$('foot-status').innerHTML = '<i></i>' + (meta.error ? 'Read error' : 'Loading…');
			return;
		}
		$('state').hidden = true;
		const isGraph = st.tab === 'graph';
		$('tab-plan').setAttribute('aria-label', isState() ? 'State' : 'Plan');
		$('tab-plan').title = isState() ? 'State' : 'Plan';
		$('tab-plan').setAttribute('aria-selected', String(!isGraph));
		$('tab-graph').setAttribute('aria-selected', String(isGraph));
		$('body').hidden = isGraph;
		$('graph').hidden = !isGraph;
		document.querySelector('.dock').hidden = false;
		if (isGraph) renderGraph();
		renderPlan();
	}

	function renderGraph() {
		if (!window.PreflightGraph) return;
		if (model.graph.error) {
			$('graph').innerHTML = '<div class="state"><h2>Unable to build the graph</h2><p>' + esc(model.graph.error) + '</p></div>';
			return;
		}
		// Group by module: resources of a module take their module's group instead of their type's.
		const graph = cfg.modules ? Object.assign({}, model.graph, { nodes: model.graph.nodes.map((n) => n.moduleGroup ? Object.assign({}, n, n.moduleGroup) : n) }) : model.graph;
		window.PreflightGraph.render($('graph'), {
			graph, act: ACT, esc, st, setState, docName: isState() ? 'state' : 'plan',
			label: cfg.label, direction: cfg.direction, modules: cfg.modules, tubes: cfg.tubes, chips: cfg.chips, setCfg, zoom: ZOOM[cfg.size] || 1,
			inPlan: (id) => model.resources.some((r) => r.addr === id),
			openInPlan: (id) => setState({ tab: 'plan', sel: id, filter: 'all', q: '' }),
			openUrl: (url) => vscode.postMessage({ type: 'openExternal', url })
		});
	}

	function renderPlan() {

		const PLAN = model.resources;
		const counts = { all: PLAN.length };
		ORDER.forEach((k) => { counts[k] = 0; });
		PLAN.forEach((r) => { counts[r.action]++; });
		if (st.filter !== 'all' && OPTIONAL[st.filter] && !counts[st.filter]) st.filter = 'all';

		// Summary
		const state = isState();
		const modules = new Set(PLAN.map((r) => r.module).filter((m) => m && m !== 'root')).size;
		const sums = state
			? [['State summary'], [counts.noop, 'resources', '#e2e2e2'], [counts.read, 'data sources', '#79c0ff'], [modules, 'modules', '#e2e2e2']]
			: [['Plan summary'], [counts.create + counts.replace, 'to add', '#56d364'], [counts.update, 'to change', '#e3b341'], [counts.delete + counts.replace, 'to destroy', '#ff7b72']];
		$('sum-title').textContent = sums[0][0];
		['sum-add', 'sum-change', 'sum-destroy'].forEach((id, i) => {
			$(id).textContent = sums[i + 1][0];
			$(id).style.color = sums[i + 1][2];
			$(id + '-l').textContent = sums[i + 1][1];
		});
		document.querySelector('.legend').hidden = state;
		$('segs').innerHTML = ORDER.filter((k) => counts[k] > 0).map((k) =>
			'<span style="flex-grow:' + counts[k] + ';background:' + ACT[k].fg + '"></span>').join('');

		// Filters
		const labels = state ? STATE_CHIP_LABEL : CHIP_LABEL;
		$('chips').innerHTML = ['all'].concat(ORDER).filter((k) => state ? k in STATE_CHIP_LABEL : !OPTIONAL[k] || counts[k] > 0).map((k) =>
			'<button type="button" class="chip" data-filter="' + k + '" aria-pressed="' + (st.filter === k) + '">' +
			'<span class="dot" style="background:' + (k === 'all' ? '#dce1ea' : ACT[k].fg) + '"></span>' +
			'<span class="lbl">' + labels[k] + '</span><span class="n">' + counts[k] + '</span></button>'
		).join('');
		if ($('q').value !== st.q) $('q').value = st.q;

		// List
		const q = (st.q || '').toLowerCase();
		const visible = PLAN.filter((r) => (st.filter === 'all' || r.action === st.filter) && (!q || r.addr.toLowerCase().indexOf(q) !== -1 || (r.cloudName || '').toLowerCase().indexOf(q) !== -1));
		if (!st.sel || !PLAN.some((r) => r.addr === st.sel)) {
			const first = PLAN.find((r) => r.action !== 'noop' && r.action !== 'read') || PLAN[0];
			st.sel = first ? first.addr : null;
		}
		$('list-count').textContent = visible.length;
		$('list').innerHTML = visible.map((r) => {
			const A = ACT[r.action], sp = splitAddr(r.addr), on = r.addr === st.sel, c = stats(r), lb = labelOf(r, sp);
			return '<button type="button" class="item" data-sel="' + esc(r.addr) + '" aria-pressed="' + on + '"' +
				(on ? ' style="box-shadow: inset 3px 0 0 ' + A.fg + '"' : '') + '>' +
				'<span class="badge" aria-hidden="true" style="color:' + A.fg + ';background:' + A.bg + ';border:1px solid ' + A.bd + '">' + A.sym + '</span>' +
				iconHtml(r, 'svc') +
				'<span class="txt"><span class="addr" title="' + esc(r.addr + (r.cloudName ? '\n' + r.cloudName : '')) + '"><span class="pre">' + esc(lb.pre) + '</span><span class="name">' + esc(lb.main) + '</span></span>' +
				'<span class="sub">' + A.label + (lb.extra ? ' · <span class="cloud">' + esc(lb.extra) + '</span>' : '') + '</span></span>' +
				'<span class="stats">' +
				(c.a ? '<span style="color:#56d364">+' + c.a + '</span>' : '') +
				(c.m ? '<span style="color:#e3b341">~' + c.m + '</span>' : '') +
				(c.d ? '<span style="color:#ff7b72">−' + c.d + '</span>' : '') +
				'</span></button>';
		}).join('') + (visible.length ? '' : '<div class="empty-list">No matching resources.</div>');

		$('total').textContent = PLAN.length;
		$('foot-status').className = 'led';
		$('foot-status').innerHTML = '<i></i>' + (state ? 'State' : 'Plan') + ' loaded · ' + PLAN.length + ' resource' + (PLAN.length > 1 ? 's' : '') +
			(model.errored ? ' · <span style="color:#ff7b72">plan errored</span>' : '');

		const r = PLAN.find((x) => x.addr === st.sel);
		if (!r) {
			$('main').innerHTML = '<div class="state"><h2>No changes</h2><p>This plan contains no resources.</p></div>';
			return;
		}
		renderMain(r, visible);
	}

	function renderMain(r, visible) {
		const state = isState();
		const hl = labelOf(r, splitAddr(r.addr));
		const A = ACT[r.action], c = stats(r), folded = foldedOf(r), b = build(r, st.hide && !state, folded);
		const comment = '# ' + r.addr + ' ' + A.verb + (r.reason ? ' (' + r.reason + ')' : '');

		const idx = visible.findIndex((x) => x.addr === r.addr);
		const prev = idx > 0 ? visible[idx - 1] : null;
		const next = idx >= 0 && idx < visible.length - 1 ? visible[idx + 1] : (idx === -1 && visible.length ? visible[0] : null);
		const isU = state || st.view !== 'split';
		// A read (data source) has no "before": a single line-number column.
		const single = state || r.action === 'read';
		const tops = [...blocks(r).keys()].filter((i) => r.lines[i][1] === 0);
		const anyFolded = folded.size > 0;
		const codeCls = 'code' + (st.nums === false ? ' no-nums' : '') + (single && isU ? ' one-gut' : '');

		$('main').innerHTML =
			'<section class="head">' +
				'<div class="title"><span class="pill" style="color:' + A.fg + ';background:' + A.bg + ';border:1px solid ' + A.bd + '"><b>' + A.sym + '</b>' + A.label + '</span>' +
				iconHtml(r, 'svc-lg') + '<h1 title="' + esc(r.addr) + '"><span style="color:var(--muted)">' + esc(hl.pre) + '</span><span style="color:var(--fg-strong);font-weight:700">' + esc(hl.main) + '</span></h1></div>' +
				'<div class="comment">' + esc(comment) + '</div>' +
				'<div class="tags">' +
					(state ? '' :
						'<span class="tag add"><b>+' + c.a + '</b>added</span>' +
						'<span class="tag mod"><b>~' + c.m + '</b>changed</span>' +
						'<span class="tag del"><b>−' + c.d + '</b>removed</span>' +
						(c.u ? '<span class="tag unk" title="Values AWS only knows after apply"><b>?' + c.u + '</b>known after apply</span>' : '')) +
					'<span class="tag meta"><span class="k">provider</span><span class="v">' + esc(r.provider || '—') + '</span></span>' +
					'<span class="tag meta"><span class="k">module</span><span class="v">' + esc(r.module) + '</span></span>' +
					(r.cloudName && cfg.label !== 'address' ? '<span class="tag meta"><span class="k">' + (cfg.label === 'cloud' ? 'address' : 'name') + '</span><span class="v">' + esc(cfg.label === 'cloud' ? r.addr : r.cloudName) + '</span></span>' : '') +
				'</div>' +
				(r.action === 'replace' ?
					'<div class="warn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#c297ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>' +
					'<span><strong>-/+</strong> destroy then create — ' +
					(r.force ? 'replacement forced by <code>' + esc(r.force) + '</code>' : esc(r.reason || 'replacement requested')) + '</span></div>' : '') +
			'</section>' +
			'<div class="toolbar">' +
				'<span class="t">' + (state ? 'Attributes' : 'Changes') + '</span>' +
				'<span class="info">' + r.lines.length + ' lines' + (state ? '' : ' · ' + (c.a + c.m + c.d + c.u) + ' attribute(s) affected') + '</span>' +
				'<div class="grow"></div>' +
				'<div class="nav">' +
					'<button type="button" class="icon-btn" data-sel="' + esc(prev ? prev.addr : '') + '"' + (prev ? '' : ' disabled') + ' aria-label="Previous resource" title="Previous (k)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"></polyline></svg></button>' +
					'<button type="button" class="icon-btn" data-sel="' + esc(next ? next.addr : '') + '"' + (next ? '' : ' disabled') + ' aria-label="Next resource" title="Next (j)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg></button>' +
				'</div>' +
				(state ? '' : '<div class="seg" role="group" aria-label="View mode">' +
					'<button type="button" data-view="unified" aria-pressed="' + isU + '">Unified</button>' +
					'<button type="button" data-view="split" aria-pressed="' + !isU + '">Split</button>' +
				'</div>' +
				'<button type="button" class="toggle" data-act="toggleHide" aria-pressed="' + !!st.hide + '"><span class="track" aria-hidden="true"><i></i></span>Hide unchanged</button>') +
				'<button type="button" class="toggle" data-act="toggleNums" aria-pressed="' + (st.nums !== false) + '"><span class="track" aria-hidden="true"><i></i></span>Line numbers</button>' +
				'<button type="button" class="icon-btn" data-act="foldAll"' + (tops.length || anyFolded ? '' : ' disabled') + ' aria-label="' + (anyFolded ? 'Expand all' : 'Collapse all') + '" title="' + (anyFolded ? 'Expand all' : 'Collapse all') + '">' +
					(anyFolded
						? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="7 15 12 20 17 15"></polyline><polyline points="7 9 12 4 17 9"></polyline></svg>'
						: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="7 20 12 15 17 20"></polyline><polyline points="7 4 12 9 17 4"></polyline></svg>') +
				'</button>' +
			'</div>' +
			'<div class="scroll"><div class="' + codeCls + '">' +
				'<div class="hunk"><span>' + (state ? r.lines.length + ' lines' : b.hunk) + '</span><span class="c">' + esc(comment) + '</span></div>' +
				(r.lines.length === 0 ? '<div class="no-lines">No attributes to display.</div>'
					: !b.u.length ? '<div class="no-lines">No changed attribute (unchanged ones are hidden).</div>'
					: isU ? unifiedHtml(b.u, single) : splitHtml(b.s)) +
			'</div></div>';

		if (render.scrollSel !== st.sel) {
			render.scrollSel = st.sel;
			const el = $('list').querySelector('[aria-pressed="true"]');
			if (el) el.scrollIntoView({ block: 'nearest' });
		}
	}

	// --- Events --------------------------------------------------------------------

	document.addEventListener('click', (ev) => {
		const more = ev.target.closest('.more[data-fold]');
		if (more) return toggleFold(Number(more.dataset.fold));
		const t = ev.target.closest('button');
		if (!t || t.disabled) return;
		if (t.dataset.tab) setState({ tab: t.dataset.tab });
		else if (t.dataset.filter) setState({ filter: t.dataset.filter });
		else if (t.dataset.sel) setState({ sel: t.dataset.sel });
		else if (t.dataset.view) setState({ view: t.dataset.view });
		else if (t.dataset.fold) toggleFold(Number(t.dataset.fold));
		else if (t.dataset.act === 'toggleHide') setState({ hide: !st.hide });
		else if (t.dataset.act === 'toggleNums') setState({ nums: st.nums === false });
		else if (t.dataset.act === 'foldAll') foldAll();
	});
	function isState() { return !!model && model.kind === 'state'; }
	function current() { return model && model.resources.find((x) => x.addr === st.sel); }
	function toggleFold(i) {
		const r = current();
		if (!r) return;
		const set = foldedOf(r);
		if (set.has(i)) set.delete(i); else set.add(i);
		setFolds(r, set);
	}
	// Collapses every top-level block, or expands everything if something is collapsed.
	function foldAll() {
		const r = current();
		if (!r) return;
		const set = foldedOf(r);
		setFolds(r, set.size ? new Set() : new Set([...blocks(r).keys()].filter((i) => r.lines[i][1] === 0)));
	}

	// --- Settings dialog -----------------------------------------------------------------

	function renderSettings() {
		const value = (it) => (it.state ? st[it.key] : cfg[it.key]);
		$('settings-body').innerHTML = SETTINGS.map((sec) => '<section class="set-sec"><h3>' + sec.title + '</h3>' + sec.items.map((it) => {
			const v = value(it);
			const on = it.key === 'nums' ? v !== false : !!v;
			const ctl = it.type === 'toggle'
				? '<button type="button" class="toggle" data-set="' + it.key + '"' + (it.state ? ' data-state' : '') + ' aria-pressed="' + on + '" aria-label="' + esc(it.label) + '"><span class="track" aria-hidden="true"><i></i></span></button>'
				: '<div class="seg" role="group" aria-label="' + esc(it.label) + '">' + it.options.map(([k, l]) =>
					'<button type="button" data-set="' + it.key + '" data-val="' + k + '"' + (it.state ? ' data-state' : '') + ' aria-pressed="' + (v === k) + '">' + l + '</button>').join('') + '</div>';
			return '<div class="set-row"><div class="set-txt"><div class="set-label">' + it.label + '</div>' + (it.hint ? '<div class="set-hint">' + it.hint + '</div>' : '') + '</div>' + ctl + '</div>';
		}).join('') + '</section>').join('');
	}
	function openSettings() {
		renderSettings();
		$('settings').hidden = false;
		$('settings').querySelector('.modal-close').focus();
	}
	function closeSettings() {
		if ($('settings').hidden) return;
		$('settings').hidden = true;
		$('open-settings').focus();
	}
	$('open-settings').addEventListener('click', openSettings);
	$('settings').addEventListener('click', (ev) => {
		if (ev.target === $('settings') || ev.target.closest('[data-close]')) return closeSettings();
		const b = ev.target.closest('[data-set]');
		if (!b) return;
		ev.stopPropagation();
		const key = b.dataset.set, isState = 'state' in b.dataset;
		const current = isState ? st[key] : cfg[key];
		const val = 'val' in b.dataset ? b.dataset.val : key === 'nums' ? current === false : !current;
		if (isState) setState({ [key]: val }); else setCfg({ [key]: val });
		renderSettings();
	});
	document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeSettings(); });

	$('q').addEventListener('input', (ev) => setState({ q: ev.target.value }));

	// j / k to move between visible resources.
	document.addEventListener('keydown', (ev) => {
		if (st.tab === 'graph' || !$('settings').hidden || ev.target.tagName === 'INPUT' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
		if (ev.key !== 'j' && ev.key !== 'k') return;
		const btn = $('main').querySelectorAll('.nav .icon-btn')[ev.key === 'k' ? 0 : 1];
		if (btn && !btn.disabled) { btn.click(); ev.preventDefault(); }
	});

	window.addEventListener('message', (ev) => {
		const msg = ev.data;
		if (msg.settings) {
			cfg = Object.assign({}, DEFAULTS, msg.settings);
			applyCfg();
		}
		if (msg.type === 'settings') {
			render();
			if (!$('settings').hidden) renderSettings();
		} else if (msg.type === 'plan') {
			model = msg.model;
			ACT = model.kind === 'state' ? STATE_ACT : PLAN_ACT;
			meta = { path: msg.path || [], error: null };
			render();
		} else if (msg.type === 'error') {
			model = null;
			meta = { path: msg.path || [], error: msg.message };
			render();
		}
	});

	render();
	vscode.postMessage({ type: 'ready' });
})();
