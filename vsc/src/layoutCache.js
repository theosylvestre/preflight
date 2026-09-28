const fs = require('fs/promises');
const path = require('path');

// Keys come from the page (graphLayout.js layoutKey): checked before being used as file names.
const KEY = /^[a-z0-9-]{1,120}$/;

/**
 * Graph layouts computed by the viewer, kept between sessions so that the graph of a plan
 * already seen shows at once: one JSON file per layout, the least recently used removed
 * beyond `maxFiles`.
 */
class LayoutCache {
	/**
	 * @param {string} dir
	 * @param {number} [maxFiles]
	 */
	constructor(dir, maxFiles = 200) {
		this.dir = dir;
		this.maxFiles = maxFiles;
		this.saves = 0;
	}

	/**
	 * Layouts found among `keys`, by key (read ones count as recently used).
	 * @param {unknown} keys
	 * @returns {Promise<Record<string, unknown>>}
	 */
	async load(keys) {
		/** @type {Record<string, unknown>} */
		const out = {};
		for (const key of Array.isArray(keys) ? keys : []) {
			if (typeof key !== 'string' || !KEY.test(key)) continue;
			const file = path.join(this.dir, key + '.json');
			try {
				out[key] = JSON.parse(await fs.readFile(file, 'utf8'));
				const now = new Date();
				await fs.utimes(file, now, now);
			} catch {
				/* not cached, or unreadable */
			}
		}
		return out;
	}

	/**
	 * @param {unknown} key
	 * @param {unknown} data
	 */
	async save(key, data) {
		if (typeof key !== 'string' || !KEY.test(key) || !data || typeof data !== 'object') return;
		try {
			await fs.mkdir(this.dir, { recursive: true });
			const file = path.join(this.dir, key + '.json');
			const tmp = file + '.' + process.pid + '.tmp';
			await fs.writeFile(tmp, JSON.stringify(data));
			await fs.rename(tmp, file);
			if (++this.saves % 10 === 1) await this.prune();
		} catch {
			/* the cache is only a shortcut */
		}
	}

	/** Removes the least recently used layouts beyond `maxFiles`. */
	async prune() {
		const files = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.json'));
		if (files.length <= this.maxFiles) return;
		const dated = await Promise.all(files.map(async (f) => ({ f, t: (await fs.stat(path.join(this.dir, f))).mtimeMs })));
		dated.sort((a, b) => b.t - a.t);
		await Promise.all(dated.slice(this.maxFiles).map(({ f }) => fs.rm(path.join(this.dir, f), { force: true })));
	}
}

module.exports = { LayoutCache };
