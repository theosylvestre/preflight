const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LayoutCache } = require('../src/layoutCache');

suite('LayoutCache', () => {
	/** @type {string} */
	let dir;
	setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-layouts-')); });
	teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	test('saved layouts are loaded back by key', async () => {
		const cache = new LayoutCache(dir);
		await cache.save('vertical-v1-abc-12', { xy: [['a', { x: 1, y: 2 }]], clusters: [], routes: [] });
		const got = await cache.load(['vertical-v1-abc-12', 'force-v1-missing-1']);
		assert.deepStrictEqual(Object.keys(got), ['vertical-v1-abc-12']);
		assert.deepStrictEqual(got['vertical-v1-abc-12'], { xy: [['a', { x: 1, y: 2 }]], clusters: [], routes: [] });
	});

	test('keys that are not file-name safe are ignored', async () => {
		const cache = new LayoutCache(dir);
		await cache.save('../escape', { xy: [] });
		await cache.save('UPPER', { xy: [] });
		await cache.save('ok-1', 'not an object');
		assert.deepStrictEqual(fs.readdirSync(dir), []);
		assert.deepStrictEqual(await cache.load(['../escape', 42, null]), {});
		assert.deepStrictEqual(await cache.load('not a list'), {});
	});

	test('a corrupted file is skipped', async () => {
		fs.writeFileSync(path.join(dir, 'vertical-v1-bad-1.json'), '{ nope');
		assert.deepStrictEqual(await new LayoutCache(dir).load(['vertical-v1-bad-1']), {});
	});

	test('the least recently used layouts go beyond the limit', async () => {
		const cache = new LayoutCache(dir, 2);
		for (const [i, key] of ['a-1', 'b-1', 'c-1'].entries()) {
			await cache.save(key, { i });
			const t = new Date(Date.now() - (10 - i) * 60000);
			fs.utimesSync(path.join(dir, key + '.json'), t, t);
		}
		await cache.load(['a-1']); // used: now the most recent
		await cache.prune();
		assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a-1.json', 'c-1.json']);
	});
});
