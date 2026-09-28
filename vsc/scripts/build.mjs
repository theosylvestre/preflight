// Builds the extension from this folder and ../core: vsce only packages files of the
// extension folder, so the shared code is bundled into dist/, and the shared page, license and
// changelog copied here (all generated, ignored by git).
//
//   node scripts/build.mjs [--production] [--watch]

import * as esbuild from 'esbuild';
import { cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = join(here, '..', 'core');
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

function copyShared() {
	rmSync(join(here, 'media'), { recursive: true, force: true });
	cpSync(join(core, 'media'), join(here, 'media'), { recursive: true });
	cpSync(join(here, '..', 'LICENSE'), join(here, 'LICENSE'));
	cpSync(join(here, '..', 'CHANGELOG.md'), join(here, 'CHANGELOG.md'));
}

/** @type {esbuild.BuildOptions} */
const options = {
	entryPoints: [join(here, 'extension.js')],
	outfile: join(here, 'dist', 'extension.js'),
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node22',
	external: ['vscode'],
	sourcemap: !production,
	minify: production,
	logLevel: 'info'
};

copyShared();
if (watch) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
} else {
	await esbuild.build(options);
}
