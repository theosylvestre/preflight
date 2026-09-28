// Indexes the icons of the official AWS pack stored in media/aws-icons.
// Reads the disk: used by the VS Code extension host and by the build of the webview bundle.

const fs = require('fs');
const path = require('path');

/**
 * Indexes the 64 px service icons: service name → path relative to media/.
 * The pack folder is dated (Architecture-Service-Icons_MMDDYYYY), so it is matched by prefix.
 * @param {string} mediaDir
 */
function indexIcons(mediaDir) {
	const index = new Map();
	const root = path.join(mediaDir, 'aws-icons');
	let packs;
	try {
		packs = fs.readdirSync(root).filter((d) => d.startsWith('Architecture-Service-Icons'));
	} catch {
		return index;
	}
	for (const pack of packs) {
		for (const cat of fs.readdirSync(path.join(root, pack))) {
			const dir = path.join(root, pack, cat, '64');
			if (!fs.existsSync(dir)) continue;
			for (const f of fs.readdirSync(dir)) {
				const m = /^Arch_(.+)_64\.svg$/.exec(f);
				if (m) index.set(m[1], ['aws-icons', pack, cat, '64', f].join('/'));
			}
		}
	}
	return index;
}

/**
 * Category icons (Arch-Category_<Category>_64.svg): slug → path relative to media/.
 * @param {string} mediaDir
 */
function indexCategoryIcons(mediaDir) {
	const index = new Map();
	const root = path.join(mediaDir, 'aws-icons');
	try {
		for (const pack of fs.readdirSync(root).filter((d) => d.startsWith('Category-Icons'))) {
			const dir = path.join(root, pack, 'Arch-Category_64');
			for (const f of fs.readdirSync(dir)) {
				const m = /^Arch-Category_(.+)_64\.svg$/.exec(f);
				if (m) index.set(m[1], ['aws-icons', pack, 'Arch-Category_64', f].join('/'));
			}
		}
	} catch {
		/* no category icons */
	}
	return index;
}

module.exports = { indexIcons, indexCategoryIcons };
