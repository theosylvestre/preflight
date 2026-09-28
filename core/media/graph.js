// @ts-nocheck
// Graph tab: the plan's resources grouped by AWS category, their references and IAM
// permissions, rendered as SVG with pan / zoom and a details panel.
(function () {
	const {
		W, H, PAD, trunc, layout, forceLayout, straightRoutes, focusLayout, routeAll, chipText, chipWidth, edgeKey
	} = window.PreflightLayout;


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
