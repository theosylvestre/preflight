// Describes a Terraform module source (`source` / `version` of a module call) as something
// readable and, when possible, a link to the repository or registry page.
//
//   git::https://host/org/repo.git//sub?ref=v1  → git, host/org/repo, ref v1, subdir sub
//   git@github.com:org/repo.git?ref=v1          → git, github.com/org/repo
//   github.com/org/repo                         → git, github.com/org/repo
//   terraform-aws-modules/vpc/aws, "~> 5.0"     → registry, terraform-aws-modules/vpc/aws
//   ./modules/net                               → local

const REGISTRY = /^(?:([\w.-]+\.[\w.-]+)\/)?([\w-]+)\/([\w-]+)\/([\w-]+)$/;

/**
 * @param {string | null | undefined} source
 * @param {string | null | undefined} [version]
 * @returns {{ kind: 'git' | 'registry' | 'local' | 'other', label: string, url: string | null, ref: string | null, subdir: string | null } | null}
 */
function describeSource(source, version) {
	if (typeof source !== 'string' || !source.trim()) return null;
	const raw = source.trim();
	if (/^\.\.?([/\\]|$)/.test(raw) || /^[/\\]/.test(raw)) return { kind: 'local', label: raw, url: null, ref: null, subdir: null };

	const reg = REGISTRY.exec(raw);
	if (reg) {
		const host = reg[1] || 'registry.terraform.io';
		const label = reg.slice(2).join('/');
		// Private registries have no predictable page URL.
		const url = host === 'registry.terraform.io' ? 'https://registry.terraform.io/modules/' + label : null;
		return { kind: 'registry', label: (reg[1] ? reg[1] + '/' : '') + label, url, ref: version || null, subdir: null };
	}

	let s = raw;
	const getter = /^(\w+)::/.exec(s);
	if (getter) s = s.slice(getter[0].length);
	let ref = null;
	const q = s.indexOf('?');
	if (q >= 0) {
		const params = new URLSearchParams(s.slice(q + 1));
		ref = params.get('ref') || params.get('version') || null;
		s = s.slice(0, q);
	}
	// "//sub/dir" after the repository path (not the scheme's "//").
	let subdir = null;
	const scheme = /^[a-z][\w+.-]*:\/\//i.exec(s);
	const rest = scheme ? s.slice(scheme[0].length) : s;
	const cut = rest.indexOf('//');
	if (cut >= 0) {
		subdir = rest.slice(cut + 2) || null;
		s = (scheme ? scheme[0] : '') + rest.slice(0, cut);
	}

	let hostPath = null;
	const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(s);
	if (scp) hostPath = scp[1] + '/' + scp[2];
	else if (/^(ssh|git\+ssh):\/\//i.test(s)) hostPath = s.replace(/^[^:]+:\/\/([^@/]+@)?/, '').replace(/^([^/:]+):\d+/, '$1');
	else if (/^https?:\/\//i.test(s)) hostPath = s.replace(/^https?:\/\/([^@/]+@)?/i, '');
	else if (/^(github\.com|bitbucket\.org|gitlab\.com)\//i.test(s)) hostPath = s;

	const isGit = getter ? getter[1] === 'git' : !!hostPath && (!!scp || /^(ssh|git\+ssh):/i.test(s) || /\.git$/.test(s) || /^(github\.com|bitbucket\.org|gitlab\.com)\//i.test(hostPath));
	if (hostPath && (isGit || !getter)) {
		hostPath = hostPath.replace(/\.git$/, '').replace(/\/+$/, '');
		return { kind: isGit ? 'git' : 'other', label: hostPath, url: 'https://' + hostPath, ref, subdir };
	}
	return { kind: 'other', label: raw, url: /^https?:\/\//i.test(raw) ? raw : null, ref, subdir };
}

/** One-line text: "host/org/repo//sub @ ref". */
function sourceText(d) {
	if (!d) return '';
	return d.label + (d.subdir ? '//' + d.subdir : '') + (d.ref ? ' @ ' + d.ref : '');
}

module.exports = { describeSource, sourceText };
