import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AssetLibrary, createAssetTools, licenseUrl, smithsonianSource } from '../dist/assets.js';
import { AssetInstaller } from '../dist/assets-page.js';

// The test-results folder is not tracked, so a run from the package folder must create it first.
async function scratch() {
  await mkdir(join(process.cwd(), 'test-results'), { recursive: true });
  return mkdtemp(join(process.cwd(), 'test-results/assets-test-'));
}

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
  // A reference without a search: Mixed is found, and refused for its non-commercial record.
  await assert.rejects(library.files('khronos:Mixed'), /licence CC0-1.0 AND CC-BY-NC-4.0 is not in licenses/);
});

test('download preserves relative dependencies, hashes and licence manifest, and wires only owned downloads', {
  timeout: 10000,
}, async () => {
  const directory = await scratch();
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
    const directory = await scratch();
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

test('attach creates a disposable asset owner whose callback rejects after disposal', async () => {
  const installer = AssetInstaller.attach({});
  assert.ok(installer instanceof AssetInstaller);
  installer[Symbol.dispose]();
  installer.dispose();
  await assert.rejects(
    installer.load({ kind: 'model', url: 'https://example.invalid/model.glb' }, new AbortController().signal),
    { name: 'AbortError' },
  );
});

test('every catalogue and download request names the app with its userAgent option (GAP-FILM-ASSETLIB-UA)', {
  timeout: 10000,
}, async () => {
  const agents = [],
    recording = (url, init) => {
      agents.push(new Headers(init?.headers).get('user-agent'));
      // The shared stand-in checks for the default agent; it answers the same either way.
      return fetcher(url, { ...init, headers: { 'User-Agent': 'MargoEngine-MCP/1.0 asset-tools' } });
    };
  await new AssetLibrary({
    directory: 'test-results',
    fetch: recording,
    userAgent: 'FilmStudio/2.1 (+https://example.com)',
  }).search({
    query: 'stone',
    provider: 'polyhaven',
  });
  await new AssetLibrary({ directory: 'test-results', fetch: recording }).search({
    query: 'stone',
    provider: 'polyhaven',
  });
  assert.ok(agents.length >= 2);
  assert.equal(agents[0], 'FilmStudio/2.1 (+https://example.com)');
  assert.equal(agents.at(-1), 'MargoEngine-MCP/1.0 asset-tools', 'the default names the engine');
  for (const userAgent of ['', ' Padded', 'Bad\nAgent', 'é/1', 'x'.repeat(257), 7])
    assert.throws(
      () => new AssetLibrary({ directory: 'test-results', fetch: recording, userAgent }),
      RangeError,
      String(userAgent),
    );
});

// GAP-FILM-ASSETLIB: a stable folder per asset and variant with reuse, a reference without a search, a licence per item,
// a provider interface and a Smithsonian provider.
const counting = () => {
  const urls = [];
  const get = (url, options) => {
    const path = String(url);
    urls.push(path);
    if (path === PH + 'info/test_rock') return json({ type: 2, name: 'Test rock', authors: { Artist: 'All' } });
    if (path === PH + 'info/missing') return new Response('{}', { status: 404 });
    return fetcher(url, options);
  };
  return { urls, get };
};

test('download keeps one folder per asset and variant, reuses it when complete and repairs it when changed', {
  timeout: 10000,
}, async () => {
  const directory = await scratch();
  try {
    const { urls, get } = counting();
    const library = new AssetLibrary({ directory, fetch: get });
    // No search first: the reference is looked up from Poly Haven's own record of the id.
    const first = await library.download('polyhaven:test_rock', 'gltf/1k/gltf');
    assert.equal(first.reused, false);
    assert.equal(first.variant, 'gltf/1k/gltf');
    assert.match(first.directory, /polyhaven-test_rock-gltf_1k_gltf-[0-9a-f]{8}$/);
    const fetched = urls.filter((u) => u.startsWith(DL)).length;
    assert.equal(fetched, 2, 'the .gltf and its texture');
    // A new library (a new process) finds the same folder complete and downloads nothing.
    const again = await new AssetLibrary({ directory, fetch: get }).download('polyhaven:test_rock', 'gltf/1k/gltf');
    assert.equal(again.reused, true);
    assert.equal(again.directory, first.directory);
    assert.deepEqual(again.files, first.files);
    assert.equal(urls.filter((u) => u.startsWith(DL)).length, fetched);
    // A changed file is found by its SHA-256 and the folder is downloaded again.
    await writeFile(join(first.directory, 'textures/map.png'), new Uint8Array([9, 9, 9, 9]));
    const repaired = await library.download('polyhaven:test_rock', 'gltf/1k/gltf');
    assert.equal(repaired.reused, false);
    assert.deepEqual([...(await readFile(join(first.directory, 'textures/map.png')))], [...payload]);
    // Two calls at once share one download.
    await rm(first.directory, { recursive: true, force: true });
    const before = urls.filter((u) => u.startsWith(DL)).length;
    const [a, b] = await Promise.all([
      library.download('polyhaven:test_rock', 'gltf/1k/gltf'),
      library.download('polyhaven:test_rock', 'gltf/1k/gltf'),
    ]);
    assert.equal(a, b);
    assert.equal(urls.filter((u) => u.startsWith(DL)).length - before, 2, 'no file is fetched twice');
    assert.deepEqual(
      (await readdir(directory)).filter((n) => n.startsWith('.incoming')),
      [],
      'no partial folder is left',
    );
    await assert.rejects(library.lookup('polyhaven:missing'), /HTTP 404/);
    await assert.rejects(library.lookup('nowhere:x'), /provider/);
    await assert.rejects(library.lookup('polyhaven:../x'), /without paths/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('each item carries its own licence; licenses accepts more, and a refused one is named', {
  timeout: 10000,
}, async () => {
  const get = (url, options) => {
    const path = String(url);
    if (path === KHR + 'model-index.json')
      return json([
        { name: 'Allowed', label: 'Allowed', variants: { 'glTF-Binary': 'Allowed.glb' } },
        { name: 'Credit', label: 'Credit', variants: { 'glTF-Binary': 'Credit.glb' } },
      ]);
    if (path === KHR + 'Credit/metadata.json') return json({ legal: [{ spdx: 'CC-BY-4.0', artist: 'B', year: 2020 }] });
    return fetcher(url, options);
  };
  const strict = new AssetLibrary({ directory: 'test-results', fetch: get });
  assert.deepEqual(
    (await strict.search({ query: '', provider: 'khronos' })).map((a) => a.id),
    ['Allowed'],
  );
  await assert.rejects(strict.lookup('khronos:Credit'), /licence CC-BY-4\.0 is not in licenses/);
  const open = new AssetLibrary({ directory: 'test-results', fetch: get, licenses: ['CC0-1.0', 'CC-BY-4.0'] });
  const found = await open.search({ query: '', provider: 'khronos' });
  assert.deepEqual(
    found.map((a) => [a.id, a.license, a.licenseUrl, a.credit]),
    [
      ['Allowed', 'CC0-1.0', 'https://creativecommons.org/publicdomain/zero/1.0/', 'A ()'],
      ['Credit', 'CC-BY-4.0', 'https://creativecommons.org/licenses/by/4.0/', 'B (2020)'],
    ],
  );
  assert.equal((await open.lookup('khronos:Credit')).license, 'CC-BY-4.0');
  assert.throws(() => new AssetLibrary({ directory: 'test-results', licenses: [] }), /SPDX/);
  assert.throws(() => new AssetLibrary({ directory: 'test-results', licenses: ['CC0 1.0'] }), /SPDX/);
});

test('an AssetSource adds a catalogue: its hosts bound every request and its items pass the licence check', {
  timeout: 10000,
}, async () => {
  const directory = await scratch();
  const seen = [];
  const museum = {
    name: 'museum',
    hosts: ['api.museum.example'],
    kinds: ['image'],
    headers: { 'X-Api-Key': 'k1' },
    async search({ query }, { json }) {
      const rows = await json(`https://api.museum.example/search?q=${encodeURIComponent(query)}`);
      return rows.map((r) => ({
        provider: 'museum',
        id: r.id,
        kind: 'image',
        title: r.id,
        source: `https://museum.example/${r.id}`,
        license: r.license,
        licenseUrl: licenseUrl(r.license),
        credit: 'Museum',
      }));
    },
    async lookup(id, context) {
      return id === 'bad' ? undefined : (await this.search({ query: id }, context))[0];
    },
    async files(asset) {
      return [
        { variant: 'image', url: `https://api.museum.example/files/${asset.id}`, name: `${asset.id}.png` },
        { variant: 'elsewhere', url: 'https://evil.example/x.png' },
      ];
    },
  };
  const get = (url, init) => {
    const u = new URL(url);
    seen.push([u.href, new Headers(init.headers).get('x-api-key')]);
    if (u.pathname === '/search')
      return json([
        { id: 'plate', license: 'CC0-1.0' },
        { id: 'poster', license: 'CC-BY-NC-4.0' },
      ]);
    if (u.pathname === '/files/plate') return new Response(payload);
    throw new TypeError('Unexpected test URL ' + u.href);
  };
  try {
    const library = new AssetLibrary({ directory, fetch: get, sources: [museum] });
    assert.deepEqual(library.providers, ['polyhaven', 'ambientcg', 'khronos', 'museum']);
    assert.deepEqual(
      (await library.search({ query: 'plate', provider: 'museum' })).map((a) => a.id),
      ['plate'],
      'the non-commercial item is left out',
    );
    const saved = await library.download('museum:plate', 'image');
    assert.equal(saved.entry, 'plate.png');
    assert.deepEqual([...(await readFile(join(saved.directory, 'plate.png')))], [...payload]);
    assert.ok(
      seen.every(([, key]) => key === 'k1'),
      'the source headers go with its requests',
    );
    const manifest = await readFile(saved.manifest, 'utf8');
    assert.doesNotMatch(manifest, /k1/, 'headers never reach the manifest');
    await assert.rejects(library.download('museum:plate', 'elsewhere'), /allow list/);
    await assert.rejects(library.lookup('museum:bad'), /Unknown asset reference/);
    const tools = createAssetTools(library);
    assert.deepEqual(tools[0].inputSchema.properties.provider.enum, ['polyhaven', 'ambientcg', 'khronos', 'museum']);
    assert.throws(() => new AssetLibrary({ directory, sources: [{ ...museum, name: 'Bad Name' }] }), /a-z/);
    // A picture is wired onto a material map, as a texture: the page installer takes model, hdri or texture.
    const requests = [];
    const wiring = new AssetLibrary({
      directory,
      fetch: get,
      sources: [museum],
      publicUrl: 'http://localhost:5173/assets/',
      live: { request: async (...args) => (requests.push(args), { installed: true }) },
    });
    const reused = await wiring.download('museum:plate', 'image');
    assert.equal(reused.reused, true);
    await wiring.wire(reused.directory, { target: 'poster', slot: 'map' });
    assert.equal(requests[0][1].kind, 'texture');
    assert.equal(requests[0][1].license, 'CC0-1.0');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('smithsonianSource finds CC0 images and GLB models and keeps its key out of URLs', {
  timeout: 10000,
}, async () => {
  const directory = await scratch();
  const SI = 'https://api.si.edu/openaccess/api/v1.0/';
  const record = {
    id: 'edanmdm-nasm_A1',
    title: 'Lunar module',
    unitCode: 'NASM',
    content: {
      descriptiveNonRepeating: {
        record_link: 'https://collections.si.edu/search/results.htm?q=record_ID=nasm_A1',
        online_media: {
          media: [
            { type: 'Images', content: 'https://ids.si.edu/ids/deliveryService?id=NASM-1', usage: { access: 'CC0' } },
            {
              type: 'Images',
              content: 'https://ids.si.edu/ids/deliveryService?id=NASM-2',
              usage: { access: 'Usage conditions apply' },
            },
            {
              type: '3d_package',
              usage: { access: 'CC0' },
              resources: [
                {
                  label: 'Full resolution glb',
                  url: 'https://3d-api.si.edu/content/document/3d_package:1/lm-full.glb',
                },
                { label: 'Full resolution obj', url: 'https://3d-api.si.edu/content/document/3d_package:1/lm.obj' },
              ],
            },
          ],
        },
      },
    },
  };
  const urls = [];
  const get = (url, init) => {
    const u = new URL(url);
    urls.push(u.href);
    assert.equal(new Headers(init.headers).get('x-api-key'), 'TEST_KEY');
    if (u.href.startsWith(SI + 'search')) return json({ response: { rows: [record] } });
    if (u.href === SI + 'content/edanmdm-nasm_A1') return json({ response: record });
    if (u.hostname === 'ids.si.edu' || u.hostname === '3d-api.si.edu') return new Response(payload);
    throw new TypeError('Unexpected test URL ' + u.href);
  };
  try {
    const library = new AssetLibrary({ directory, fetch: get, sources: [smithsonianSource({ apiKey: 'TEST_KEY' })] });
    const found = await library.search({ query: 'lunar', provider: 'smithsonian' });
    assert.deepEqual(
      found.map((a) => [a.id, a.kind, a.license, a.credit]),
      [
        ['edanmdm-nasm_A1~0', 'image', 'CC0-1.0', 'Smithsonian (NASM)'],
        ['edanmdm-nasm_A1~2', 'model', 'CC0-1.0', 'Smithsonian (NASM)'],
      ],
      'the media with usage conditions is left out',
    );
    assert.deepEqual(
      (await library.search({ query: 'lunar', provider: 'smithsonian', kind: 'model' })).map((a) => a.id),
      ['edanmdm-nasm_A1~2'],
    );
    // By reference, from a new library: no search.
    const fresh = new AssetLibrary({ directory, fetch: get, sources: [smithsonianSource({ apiKey: 'TEST_KEY' })] });
    assert.deepEqual(
      (await fresh.files('smithsonian:edanmdm-nasm_A1~2')).map((f) => f.variant),
      ['Full resolution glb'],
    );
    const model = await fresh.download('smithsonian:edanmdm-nasm_A1~2', 'Full resolution glb');
    assert.equal(model.entry, 'edanmdm-nasm_A1-2.glb');
    const image = await fresh.download('smithsonian:edanmdm-nasm_A1~0', 'image');
    assert.equal(image.entry, 'edanmdm-nasm_A1-0.jpg');
    await assert.rejects(fresh.lookup('smithsonian:edanmdm-nasm_A1~1'), /licence/);
    assert.ok(
      urls.every((u) => !u.includes('TEST_KEY')),
      'the key goes in a header, never a URL',
    );
    assert.throws(() => smithsonianSource({ apiKey: 'a b' }), /api.data.gov key/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
