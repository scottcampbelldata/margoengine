// Regression tests for the defects the 2026-11-15 line-by-line read of corpus, live-host, assets and porting found.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createIndex, loadCorpus, searchCorpus } from '../dist/index.js';
import { createLiveHost } from '../dist/live-host.js';
import { AssetLibrary } from '../dist/assets.js';
import { loadPortingGuides, parsePortingGuide } from '../dist/porting.js';

async function scratch() {
  await mkdir(join(process.cwd(), 'test-results'), { recursive: true });
  return mkdtemp(join(process.cwd(), 'test-results/audit-reads-'));
}

test('searchCorpus refuses a limit that is not a finite number instead of returning every hit', () => {
  const docs = Array.from({ length: 30 }, (_, i) => ({
    path: `docs/page-${i}.md`,
    title: `Page ${i}`,
    summary: '',
    text: `# Page ${i}\n\nalpha beta ${i}`,
  }));
  const index = createIndex({ packages: [], docs, examples: [], readme: '' });
  assert.equal(searchCorpus(index, 'alpha').length, 8);
  assert.equal(searchCorpus(index, 'alpha', { limit: 2.5 }).length, 2);
  for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, '5'])
    assert.throws(() => searchCorpus(index, 'alpha', { limit }), RangeError);
});

test('a corpus or porting file that is not JSON rejects with a coded failed error', async () => {
  const dir = await scratch();
  try {
    const file = join(dir, 'broken.json');
    await writeFile(file, '{ not json');
    await assert.rejects(loadCorpus(file), (error) => error.name === 'MargoError' && error.code === 'failed');
    await assert.rejects(loadPortingGuides(file), (error) => error.name === 'MargoError' && error.code === 'failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the live relay decodes a result whose UTF-8 character straddles two body chunks', { timeout: 10000 }, async () => {
  const host = await createLiveHost({ origins: [], timeoutMs: 5000 });
  try {
    const answer = host.request('scene', {});
    const command = await (await fetch(`${host.endpoint}/poll`, { headers: { Authorization: `Bearer ${host.token}` } })).json();
    const body = Buffer.from(JSON.stringify({ id: command.id, value: 'café 世界' }));
    // Cut inside the two bytes of the e with an acute accent.
    const cut = body.indexOf(0xc3) + 1;
    const status = await new Promise((resolve, reject) => {
      const req = request(`${host.endpoint}/result`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json' },
      });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.write(body.subarray(0, cut));
      setTimeout(() => req.end(body.subarray(cut)), 150);
    });
    assert.equal(status, 204);
    assert.equal(await answer, 'café 世界');
  } finally {
    await host.close();
  }
});

const PH = 'https://api.polyhaven.com/';
const DL = 'https://dl.polyhaven.org/';
const pixel = new Uint8Array([7, 7, 7, 7]);
const respond = (data) => new Response(JSON.stringify(data));

test('a glTF dependency URI with percent escapes is saved under its decoded file name', { timeout: 10000 }, async () => {
  const fetched = [];
  const fetcher = async (url) => {
    const href = new URL(url).href;
    fetched.push(href);
    if (href.startsWith(PH + 'assets')) return respond({ spaced_rock: { type: 2, name: 'Spaced rock', authors: {} } });
    if (href === PH + 'files/spaced_rock') return respond({ gltf: { '1k': { gltf: { url: DL + 'spaced.gltf' } } } });
    if (href === DL + 'spaced.gltf')
      return respond({ asset: { version: '2.0' }, images: [{ uri: 'maps/rock%20colour.png' }] });
    if (href === DL + 'maps/rock%20colour.png') return new Response(pixel);
    throw new TypeError('Unexpected test URL ' + href);
  };
  const dir = await scratch();
  try {
    const library = new AssetLibrary({ directory: dir, fetch: fetcher });
    await library.search({ query: 'spaced', provider: 'polyhaven' });
    const result = await library.download('polyhaven:spaced_rock', 'gltf/1k/gltf');
    assert.ok(fetched.includes(DL + 'maps/rock%20colour.png'));
    assert.deepEqual(
      result.files.map((file) => file.path),
      ['spaced.gltf', 'maps/rock colour.png'],
    );
    // A loader resolving the uri against the glTF file finds the decoded name on disk.
    assert.deepEqual(new Uint8Array(await readFile(join(result.directory, 'maps', 'rock colour.png'))), pixel);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a glTF dependency URI that decodes to a parent path is refused', { timeout: 10000 }, async () => {
  const fetcher = async (url) => {
    const href = new URL(url).href;
    if (href.startsWith(PH + 'assets')) return respond({ sly_rock: { type: 2, name: 'Sly rock', authors: {} } });
    if (href === PH + 'files/sly_rock') return respond({ gltf: { '1k': { gltf: { url: DL + 'sly.gltf' } } } });
    if (href === DL + 'sly.gltf') return respond({ asset: { version: '2.0' }, images: [{ uri: '%2E%2E/escape.png' }] });
    return new Response(pixel);
  };
  const dir = await scratch();
  try {
    const library = new AssetLibrary({ directory: dir, fetch: fetcher });
    await library.search({ query: 'sly', provider: 'polyhaven' });
    await assert.rejects(library.download('polyhaven:sly_rock', 'gltf/1k/gltf'), TypeError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an ambientCG download without a size in its record is not refused as a size mismatch', { timeout: 10000 }, async () => {
  const fetcher = async (url) => {
    const href = new URL(url).href;
    if (href.startsWith('https://ambientcg.com/api/v3/assets'))
      return respond({
        assets: [
          {
            id: 'Plain001',
            title: 'Plain',
            type: 'material',
            downloads: [{ attributes: '1K', url: 'https://ambientcg.com/get?file=Plain.png' }],
          },
        ],
      });
    if (href.startsWith('https://ambientcg.com/get')) return new Response(pixel);
    throw new TypeError('Unexpected test URL ' + href);
  };
  const dir = await scratch();
  try {
    const library = new AssetLibrary({ directory: dir, fetch: fetcher });
    await library.search({ query: 'plain', provider: 'ambientcg' });
    const files = await library.files('ambientcg:Plain001');
    assert.equal('size' in files[0], false);
    const result = await library.download('ambientcg:Plain001', '1K');
    assert.equal(result.entry, 'Plain.png');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a matrix cell with an escaped pipe stays one cell, as GitHub tables read it', () => {
  const matrix = [
    '# Acme 9 parity matrix',
    '',
    '## Matrix',
    '',
    '### 1. Logic',
    '',
    '| Acme | Status | Margo | Shows it | Notes |',
    '| --- | --- | --- | --- | --- |',
    '| `Either` (`a \\| b`) | COVERED | `either` | | Picks one \\| the other |',
  ].join('\n');
  const guide = parsePortingGuide(matrix);
  assert.equal(guide.rows.length, 1);
  assert.deepEqual(
    { from: guide.rows[0].from, status: guide.rows[0].status, margo: guide.rows[0].margo, notes: guide.rows[0].notes },
    { from: '`Either` (`a | b`)', status: 'COVERED', margo: '`either`', notes: 'Picks one | the other' },
  );
});
