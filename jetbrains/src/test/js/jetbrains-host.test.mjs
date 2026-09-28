// jetbrains-host.js (page side of the bridge) with the core bundle, in a vm context that
// stands in for the page: fetch serves the file text, window.postMessage is recorded.
//   node --test src/test/js/jetbrains-host.test.mjs   (or ./gradlew testWebHost)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const hostJs = join(root, 'src', 'main', 'resources', 'preflight-web', 'jetbrains-host.js');
const coreJs = join(root, '..', 'core', 'dist', 'preflight-core.js');
const fixture = (name) => readFileSync(join(root, '..', 'core', 'test', 'fixtures', name), 'utf8');
const ORIGIN = 'https://preflight.local';

function page(sources) {
	const posted = [];
	const fetched = [];
	const style = {};
	const window = {
		postMessage: (msg, target) => { assert.equal(target, '*'); posted.push(msg); }
	};
	const context = vm.createContext({
		window,
		location: { origin: ORIGIN },
		document: { documentElement: { style: { setProperty: (k, v) => { style[k] = v; } } } },
		fetch: async (url) => {
			fetched.push(url);
			const text = sources.shift();
			return text === undefined ? { ok: false, status: 404 } : { ok: true, status: 200, text: async () => text };
		}
	});
	vm.runInContext(readFileSync(coreJs, 'utf8'), context, { filename: coreJs });
	window.PreflightCore = context.PreflightCore;
	vm.runInContext(readFileSync(hostJs, 'utf8'), context, { filename: hostJs });
	const bridge = { calls: [], ready() { this.calls.push(['ready']); }, settings(s) { this.calls.push(['settings', s]); }, openExternal(u) { this.calls.push(['open', u]); } };
	return { host: window.PreflightHost, posted, fetched, style, bridge };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test('messages sent before the plugin connects are delivered on connect', () => {
	const { host, bridge } = page([]);
	host.postMessage({ type: 'ready' });
	host.postMessage({ type: 'settings', settings: { label: 'cloud' } });
	assert.deepEqual(bridge.calls, []);
	host._connect(bridge);
	host.postMessage({ type: 'openExternal', url: 'https://github.com/acme/net' });
	assert.deepEqual(bridge.calls, [['ready'], ['settings', '{"label":"cloud"}'], ['open', 'https://github.com/acme/net']]);
});

test('view state is kept in the page', () => {
	const { host } = page([]);
	assert.equal(host.getState(), null);
	host.setState({ tab: 'graph' });
	assert.deepEqual(host.getState(), { tab: 'graph' });
});

test('_load fetches the file and posts the model built by the core bundle', async () => {
	const { host, posted, fetched, style } = page([fixture('mixed-plan.json')]);
	host._load({ path: ['tf-test', 'plan.json'], modulesJson: null, settings: '{"label":"both"}', fontFamily: 'JetBrains Mono' });
	await settle();
	assert.equal(fetched.length, 1);
	assert.ok(fetched[0].startsWith(ORIGIN + '/__source'));
	assert.equal(style['--vscode-editor-font-family'], 'JetBrains Mono');
	assert.equal(posted.length, 1);
	const msg = posted[0];
	assert.equal(msg.type, 'plan');
	assert.deepEqual([...msg.path], ['tf-test', 'plan.json']);
	assert.equal(msg.settings.label, 'both');
	assert.equal(msg.model.resources.length, 5);
	const ec2 = msg.model.resources.find((r) => r.type === 'aws_instance');
	assert.match(ec2.icon, /^https:\/\/preflight\.local\/media\/aws-icons\/.+Arch_Amazon-EC2_64\.svg$/);
});

test('a file that is not a plan is reported, bad settings are ignored', async () => {
	const { host, posted } = page(['{"name":"not a plan"}']);
	host._load({ path: ['package.json'], modulesJson: null, settings: 'not json' });
	await settle();
	assert.equal(posted[0].type, 'error');
	assert.ok(posted[0].message);
	assert.deepEqual({ ...posted[0].settings }, {});
});

test('a failed read is reported', async () => {
	const { host, posted } = page([]);
	host._load({ path: [], modulesJson: null, settings: '{}' });
	await settle();
	assert.equal(posted[0].type, 'error');
	assert.match(posted[0].message, /HTTP 404/);
});

test('only the latest load is displayed', async () => {
	const { host, posted } = page([fixture('mixed-plan.json'), fixture('sample.tfstate')]);
	host._load({ path: ['a'], modulesJson: null, settings: '{}' });
	host._load({ path: ['b'], modulesJson: null, settings: '{}' });
	await settle();
	assert.equal(posted.length, 1);
	assert.equal(posted[0].model.kind, 'state');
});

test('settings from another view are forwarded to the viewer', () => {
	const { host, posted } = page([]);
	host._settings('{"direction":"vertical"}');
	assert.equal(posted[0].type, 'settings');
	assert.equal(posted[0].settings.direction, 'vertical');
});
