// Builds dist/preflight-core.js: the parsers and the view model bundled for the webview
// (globalThis.PreflightCore), with the index of media/aws-icons embedded, since the page
// cannot list the icon folders itself.
//
//   node scripts/build.mjs [--production]

import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { indexIcons, indexCategoryIcons } = require('../src/awsIcons');

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const media = join(here, 'media');
const production = process.argv.includes('--production');

/** @type {esbuild.Plugin} */
const iconIndex = {
	name: 'preflight-icons',
	setup(build) {
		build.onResolve({ filter: /^preflight:icons$/ }, (args) => ({ path: args.path, namespace: 'preflight-icons' }));
		build.onLoad({ filter: /.*/, namespace: 'preflight-icons' }, () => ({
			loader: 'json',
			contents: JSON.stringify({
				services: Object.fromEntries(indexIcons(media)),
				categories: Object.fromEntries(indexCategoryIcons(media))
			}),
			watchDirs: [join(media, 'aws-icons')]
		}));
	}
};

await esbuild.build({
	entryPoints: [join(here, 'src', 'browser.js')],
	outfile: join(here, 'dist', 'preflight-core.js'),
	bundle: true,
	platform: 'browser',
	format: 'iife',
	target: 'es2022',
	plugins: [iconIndex],
	minify: production,
	legalComments: 'none',
	logLevel: 'info'
});
