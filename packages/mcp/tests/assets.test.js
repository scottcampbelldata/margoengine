import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AssetLibrary, createAssetTools } from '../dist/assets.js';
import { AssetInstaller } from '../dist/assets-page.js';

const PH = 'https://api.polyhaven.com/';
const DL = 'https://dl.polyhaven.org/';
const KHR = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/';
const json = (data) => new Response(JSON.stringify(data));
const payload = new Uint8Array([1, 2, 3, 4]);
const md5 = createHash('md5').update(payload).digest('hex');
const fetcher = (url, options) => {
  assert.match(options.headers['User-Agent'], /MargoEngine/);
  const u = new URL(url),
    path = u.href;
  if (path.startsWith(PH + 'assets'))
    return json({ test_rock: { type: 2, name: 'Test rock', authors: { Artist: 'All' }, tags: ['stone'] } });
  if (path === PH + 'files/test_rock')
    return json({
      gltf: {
        '1k': {
          gltf: {
            url: DL + 'rock.gltf',
            include: { 'textures/map.png': { url: DL + 'map.png', size: 4, md5 } },
          },
        },
      },
    });
  if (path === DL + 'rock.gltf') return json({ asset: { version: '2.0' }, images: [{ uri: 'textures/map.png' }] });
  if (path === DL + 'map.png') return new Response(payload);
  if (path.startsWith('https://ambientcg.com/api/v3/assets'))
    return json({
      assets: [
        {
          id: 'Stone001',
          title: 'Stone',
          type: 'material',
          downloads: [{ attributes: '1K', url: 'https://ambientcg.com/get?file=Stone.hdr', size: 4 }],
        },
      ],
    });
  if (path.startsWith('https://ambientcg.com/get')) return new Response(payload);
  if (path === KHR + 'model-index.json')
    return json([
      { name: 'Allowed', label: 'Allowed', variants: { 'glTF-Binary': 'Allowed.glb' } },
      { name: 'Mixed' },
      { name: 'Unknown' },
    ]);
  if (path.endsWith('/metadata.json'))
    return json({
      legal: u.pathname.includes('Allowed')
        ? [{ spdx: 'CC0-1.0', artist: 'A' }]
        : u.pathname.includes('Mixed')
          ? [{ spdx: 'CC0-1.0' }, { spdx: 'CC-BY-NC-4.0' }]
          : [],
    });
  if (path.endsWith('.glb')) return new Response(payload);
  throw new TypeError('Unexpected test URL ' + path);
};

test('catalogues search names/tags, enforce CC0 on all Khronos legal records and enumerate variants', {
  timeout: 10000,
}, async () => {
  const library = new AssetLibrary({ directory: 'test-results', fetch: fetcher });
  assert.equal((await library.search({ query: 'stone', provider: 'polyhaven' }))[0].id, 'test_rock');
  assert.equal((await library.search({ query: '', provider: 'ambientcg', kind: 'texture' }))[0].license, 'CC0-1.0');
  assert.deepEqual(
    (await library.search({ query: '', provider: 'khronos' })).map((a) => a.id),
    ['Allowed'],
  );
  assert.equal((await library.files('polyhaven:test_rock'))[0].variant, 'gltf/1k/gltf');
  assert.equal((await library.files('ambientcg:Stone001'))[0].variant, '1K');
  assert.equal((await library.files('khronos:Allowed'))[0].variant, 'glTF-Binary');
  await assert.rejects(library.search({ query: '', limit: 26 }), /limit/);
  await assert.rejects(library.search({ query: '', provider: 'unknown' }), /provider/);
  await assert.rejects(library.files('khronos:Mixed'), /search_assets/);
});

test('download preserves relative dependencies, hashes and licence manifest, and wires only owned downloads', {
  timeout: 10000,
}, async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-results/assets-test-'));
  const calls = [];
  const library = new AssetLibrary({
    directory,
    publicUrl: 'http://localhost:5173/assets/',
    fetch: fetcher,
    live: {
      request: async (...args) => {
        calls.push(args);
        return { installed: true };
      },
    },
  });
  try {
    await library.search({ query: 'stone', provider: 'polyhaven' });
    const result = await library.download('polyhaven:test_rock', 'gltf/1k/gltf');
    assert.deepEqual([...(await readFile(join(result.directory, 'textures/map.png')))], [...payload]);
    const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
    assert.equal(manifest.asset.license, 'CC0-1.0');
    assert.equal(manifest.files[1].sha256, createHash('sha256').update(payload).digest('hex'));
    assert.deepEqual(await library.wire(result.directory), { installed: true });
    assert.equal(calls[0][0], 'asset');
    assert.match(calls[0][1].url, /assets\/polyhaven-test_rock-[^/]+\/rock.gltf$/);
    await assert.rejects(library.wire(directory), /Download/);
    assert.deepEqual(
      createAssetTools(library).map((t) => t.name),
      ['search_assets', 'asset_files', 'download_asset', 'wire_asset'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('download rejects traversal, unsafe redirects, bad checksums and byte caps, cleaning partial directories', {
  timeout: 10000,
}, async () => {
  for (const failure of ['path', 'redirect', 'checksum', 'size']) {
    const directory = await mkdtemp(join(process.cwd(), 'test-results/assets-test-'));
    const get = (url, opts) => {
      const path = String(url);
      if (path === PH + 'files/test_rock')
        return json({
          file: {
            url: DL + 'model.glb',
            ...(failure === 'path' ? { include: { '../escape': { url: DL + 'map.png' } } } : {}),
            ...(failure === 'checksum' ? { md5: '0'.repeat(32) } : {}),
          },
        });
      if (path === DL + 'model.glb')
        return failure === 'redirect'
          ? new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } })
          : new Response(payload);
      return fetcher(url, opts);
    };
    const library = new AssetLibrary({ directory, fetch: get, maxBytes: failure === 'size' ? 2 : 4096 });
    try {
      await library.search({ query: 'stone', provider: 'polyhaven' });
      await assert.rejects(library.download('polyhaven:test_rock', 'file'), /unsafe path|allow list|checksum|maxBytes/);
      assert.deepEqual(await readdir(directory), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('pre-abort prevents network work and disposed page installer refuses loads', { timeout: 10000 }, async () => {
  const controller = new AbortController();
  controller.abort();
  const library = new AssetLibrary({
    directory: 'test-results',
    fetch: () => {
      throw new TypeError('network must not run');
    },
  });
  await assert.rejects(library.search({ query: '', signal: controller.signal }), /abort/i);
  const installer = new AssetInstaller({});
  installer.dispose();
  await assert.rejects(
    installer.load({ kind: 'model', url: 'https://example.test/a.glb' }, new AbortController().signal),
    /abort/i,
  );
});

test('page wiring rejects inherited material names before loading a texture', { timeout: 10000 }, async () => {
  const installer = new AssetInstaller({}, { materials: {} });
  try {
    await assert.rejects(
      installer.load(
        { kind: 'texture', target: '__proto__', url: 'https://example.test/image.png' },
        new AbortController().signal,
      ),
      /registered/,
    );
    assert.equal(Object.prototype.map, undefined);
  } finally {
    installer.dispose();
  }
});
