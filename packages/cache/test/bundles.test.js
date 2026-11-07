// @margoengine/cache/bundles: a manifest of bundles with dependencies; a level and its shared assets load as one unit,
// offline afterwards, and a release downloads only the files whose hash changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetCache } from '../dist/index.js';
import { AssetBundles } from '../dist/bundles.js';
import { hashBytes } from '../dist/hashed.js';
import { base, bytes, fakeIndexedDB, read, server } from './support.js';

const contents = {
  '/shared/rock.glb': bytes(300, 1),
  '/shared/sky.ktx2': bytes(200, 2),
  '/level1/map.glb': bytes(400, 3),
  '/level2/map.glb': bytes(500, 4),
  '/ui/font.bin': bytes(50, 5),
};
const manifestOf = async (files) => {
  const hash = async (path) => hashBytes(files[path]);
  return {
    version: '1',
    bundles: {
      ui: { files: { 'ui/font.bin': await hash('/ui/font.bin') } },
      shared: {
        files: { 'shared/rock.glb': await hash('/shared/rock.glb'), 'shared/sky.ktx2': await hash('/shared/sky.ktx2') },
        deps: ['ui'],
      },
      level1: { files: { 'level1/map.glb': await hash('/level1/map.glb') }, deps: ['shared'] },
      level2: { files: { 'level2/map.glb': await hash('/level2/map.glb') }, deps: ['shared'] },
    },
  };
};
const table = (files) =>
  Object.fromEntries(Object.entries(files).map(([path, body]) => [path, { body, etag: `"${path}"` }]));
const serve = (files) => server(table(files));
const fetched = (network) => network.log.map((entry) => new URL(entry.url).pathname);

test('a bundle loads with its dependencies first, each shared file once, and then works offline', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const network = serve(contents),
    manifest = await manifestOf(contents),
    bundles = new AssetBundles(new AssetCache({ name: 'b1', fetch: network }), manifest, { base });
  assert.deepEqual(bundles.order('level1'), ['ui', 'shared', 'level1']);
  assert.deepEqual(
    bundles.files('level1').map((url) => new URL(url).pathname),
    ['/ui/font.bin', '/shared/rock.glb', '/shared/sky.ktx2', '/level1/map.glb'],
  );
  const progress = [];
  await bundles.load('level1', { onProgress: (p) => progress.push([p.loaded, p.total]), concurrency: 2 });
  assert.deepEqual(progress.at(-1), [4, 4]);
  await bundles.load('level2');
  assert.deepEqual(fetched(network).sort(), [
    '/level1/map.glb',
    '/level2/map.glb',
    '/shared/rock.glb',
    '/shared/sky.ktx2',
    '/ui/font.bin',
  ]);
  assert.ok(
    network.log.every((entry) => /\?v=[0-9a-f]{64}$/.test(entry.url)),
    'stored by content hash',
  );
  network.offline = true;
  const offline = new AssetBundles(new AssetCache({ name: 'b1', fetch: network }), manifest, { base });
  await offline.load('level2');
  assert.deepEqual(await read(await offline.fetch(base + 'level2/map.glb')), contents['/level2/map.glb']);
  assert.deepEqual(
    await read(await offline.fetch('shared/rock.glb')),
    contents['/shared/rock.glb'],
    'relative URLs too',
  );
});

test('a new release drops and downloads only the files whose hash changed, and names the bundles to reload', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const files = { ...contents },
    served = table(files),
    network = server(served),
    cache = new AssetCache({ name: 'b2', fetch: network }),
    bundles = new AssetBundles(cache, await manifestOf(files), { base });
  await bundles.load('level1');
  await bundles.load('level2');
  files['/shared/sky.ktx2'] = bytes(210, 9);
  const next = await manifestOf(files);
  next.bundles.level2 = {
    ...next.bundles.level2,
    files: { ...next.bundles.level2.files, 'level2/props.glb': await hashBytes(bytes(30, 7)) },
  };
  files['/level2/props.glb'] = bytes(30, 7);
  Object.assign(served, table(files));
  const update = await bundles.update(next);
  assert.deepEqual(update, { dropped: 1, changed: ['shared', 'level1', 'level2'] });
  const before = network.log.length;
  await bundles.load('level1');
  await bundles.load('level2');
  const after = network.log.slice(before);
  // The same AssetCache serves unchanged files without asking again; only the new sky and the new prop are fetched.
  assert.deepEqual(after.map((entry) => new URL(entry.url).pathname).sort(), ['/level2/props.glb', '/shared/sky.ktx2']);
  assert.deepEqual(await read(await bundles.fetch(base + 'shared/sky.ktx2')), files['/shared/sky.ktx2']);
  // A release that changes nothing changes no bundle.
  assert.deepEqual(await bundles.update(next), { dropped: 0, changed: [] });
});

test('a file whose bytes do not match fails the load; bad manifests and names throw', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const network = serve({ ...contents, '/level1/map.glb': bytes(400, 99) }),
    manifest = await manifestOf(contents),
    bundles = new AssetBundles(new AssetCache({ name: 'b3', fetch: network }), manifest, { base });
  await assert.rejects(bundles.load('level1'), { name: 'MargoError', code: 'failed' });
  assert.throws(() => bundles.order('level9'), TypeError);
  const hash = manifest.bundles.ui.files['ui/font.bin'];
  const bad = [
    { bundles: { a: { files: {}, deps: ['missing'] } } },
    { bundles: { a: { files: {}, deps: ['b'] }, b: { files: {}, deps: ['a'] } } },
    { bundles: { a: { files: { x: hash } }, b: { files: { x: hash.replace(/^./, hash[0] === '0' ? '1' : '0') } } } },
    { bundles: { a: { files: { x: 'not-a-hash' } } } },
    {},
  ];
  for (const manifest of bad) assert.throws(() => new AssetBundles(new AssetCache(), manifest, { base }), TypeError);
  await assert.rejects(bundles.update(bad[0]), TypeError);
  assert.deepEqual(bundles.order('level2'), ['ui', 'shared', 'level2'], 'a refused update keeps the old manifest');
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await assert.rejects(bundles.load('level2', { signal: controller.signal }), /stop/);
  await assert.rejects(bundles.load('level2', { concurrency: 0 }), RangeError);
  const missing = new AssetBundles(new AssetCache({ name: 'b4', fetch: serve({}) }), manifest, { base });
  await assert.rejects(missing.load('ui'), { code: 'failed' }, 'an HTTP error status fails the load');
});
