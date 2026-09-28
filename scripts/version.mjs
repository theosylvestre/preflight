// Sets the version of both packages (VS Code extension, JetBrains plugin, shared core) and
// releases the Unreleased section of the changelog under it.
//   node scripts/version.mjs <x.y.z> [--date YYYY-MM-DD]   (make version V=x.y.z)

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const version = args[0];
const dateArg = args.indexOf('--date');
const date = dateArg >= 0 ? args[dateArg + 1] : new Date().toISOString().slice(0, 10);

function fail(message) {
	console.error(message);
	process.exit(1);
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
if (!version || !SEMVER.test(version)) fail('Usage: make version V=x.y.z (semantic version, e.g. 0.2.0)');
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('--date: YYYY-MM-DD expected');

const file = (p) => join(root, p);
const vscPackage = JSON.parse(readFileSync(file('vsc/package.json'), 'utf8'));
const current = vscPackage.version;
const parts = (v) => v.split('-')[0].split('.').map(Number);
const [a, b] = [parts(version), parts(current)];
const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
if (cmp < 0 || (cmp === 0 && version === current)) fail(`${version} is not after the current version ${current}`);

// Changelog: the Unreleased section becomes this version's, a new empty one goes above it.
const changelog = readFileSync(file('CHANGELOG.md'), 'utf8');
if (changelog.includes(`## [${version}]`)) fail(`CHANGELOG.md already has a ${version} section`);
const unreleased = /^## \[Unreleased\]\n([\s\S]*?)(?=^## \[)/m.exec(changelog);
if (!unreleased) fail('CHANGELOG.md: no "## [Unreleased]" section followed by a released one');
if (!/^- /m.test(unreleased[1])) fail('CHANGELOG.md: the Unreleased section is empty, describe the changes first');
writeFileSync(file('CHANGELOG.md'), changelog.replace('## [Unreleased]\n', `## [Unreleased]\n\n## [${version}] - ${date}\n`));

// package.json files: only the "version" line changes, the formatting is kept.
for (const p of ['vsc/package.json', 'core/package.json']) {
	const text = readFileSync(file(p), 'utf8');
	writeFileSync(file(p), text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`));
}
const props = readFileSync(file('jetbrains/gradle.properties'), 'utf8');
writeFileSync(file('jetbrains/gradle.properties'), props.replace(/^(pluginVersion\s*=\s*).*$/m, `$1${version}`));

console.log(`${current} → ${version} (${date}): vsc/package.json, core/package.json, jetbrains/gradle.properties, CHANGELOG.md`);
