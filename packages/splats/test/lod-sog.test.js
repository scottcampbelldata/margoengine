import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { loadStreamedSog, StreamedSogSource } from '../dist/lod-sog.js';
import { SplatLod, chooseSplatNodes } from '../dist/lod.js';
import { parseSog, validateSplats, transformSplats, encodeSog, encodeSpz, encodeSplat } from '../dist/data.js';
import { encodePly } from '../dist/formats.js';
import { encodeWebpLossless } from '../src/webp.ts';

const signal = new AbortController().signal;
const bounds = { min: [-3, -3, -3], max: [3, 3, 3] };
const json = (value) => new TextEncoder().encode(JSON.stringify(value));
function unzip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    files = {};
  let end = bytes.length - 22;
  while (v.getUint32(end, true) !== 0x06054b50) end--;
  let at = v.getUint32(end + 16, true);
  for (let i = 0; i < v.getUint16(end + 10, true); i++) {
    const method = v.getUint16(at + 10, true),
      size = v.getUint32(at + 20, true),
      n = v.getUint16(at + 28, true),
      extra = v.getUint16(at + 30, true),
      comment = v.getUint16(at + 32, true),
      local = v.getUint32(at + 42, true),
      name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + n)),
      start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    files[name] = method === 0 ? bytes.slice(start, start + size) : inflateRawSync(bytes.subarray(start, start + size));
    at += 46 + n + extra + comment;
  }
  return files;
}
const real = unzip(readFileSync(new URL('fixtures/raccoon.sog', import.meta.url)));
function scene(options = {}) {
  const count = JSON.parse(new TextDecoder().decode(real['meta.json'])).count,
    half = Math.floor(count / 2);
  const leaf = (offset, n) => ({
    bound: structuredClone(bounds),
    lods: { 0: { file: 0, offset, count: n }, 2: { file: 1, offset, count: n } },
    errors: [0, 0, 2],
  });
  const manifest = {
    version: 1,
    count: count * 2,
    counts: [count, 0, count],
    lodLevels: 3,
    lodErrors: true,
    environment: 'env/meta.json',
    filenames: ['arbitrary/fine/meta.json', 'coarse/meta.json'],
    tree: { bound: structuredClone(bounds), children: [leaf(0, half), leaf(half, count - half)] },
    ...options,
  };
  const files = new Map([['/scene/lod-meta.json', json(manifest)]]);
  for (const dir of ['arbitrary/fine', 'coarse', 'env'])
    for (const [name, bytes] of Object.entries(real)) files.set(`/scene/${dir}/${name}`, bytes);
  const requests = [],
    aborted = [];
  let hold = false,
    release;
  const gate = new Promise((resolve) => (release = resolve));
  const fetch = async (url, { signal } = {}) => {
    const path = new URL(url).pathname;
    requests.push(path);
    signal?.throwIfAborted();
    if (hold && !path.endsWith('json'))
      await new Promise((resolve, reject) => {
        const stop = () => {
          aborted.push(path);
          reject(signal.reason);
        };
        signal?.addEventListener('abort', stop, { once: true });
        gate.then(() => {
          signal?.removeEventListener('abort', stop);
          resolve();
        });
      });
    signal?.throwIfAborted();
    return new Response(files.get(path), { status: files.has(path) ? 200 : 404 });
  };
  return { manifest, files, requests, aborted, fetch, hold: () => (hold = true), release };
}
test('streamed SOG reads real capture ranges lazily, keeps environment at every cut, and accepts sparse levels', async () => {
  const fixture = scene(),
    source = await loadStreamedSog('https://local/scene/lod-meta.json', { fetch: fixture.fetch });
  assert.ok(source instanceof StreamedSogSource);
  assert.equal(source.coefficients, 16);
  assert.equal(fixture.requests.length, 4, 'manifest plus small metadata only');
  const all = () => true,
    view = { eye: [0, 0, 10], focal: 100, near: 0.1 };
  const fine = chooseSplatNodes(source.nodes, view, { maxError: 0, budget: 1e6, loaded: all }).selected,
    coarse = chooseSplatNodes(
      source.nodes,
      { ...view, eye: [0, 0, 1e6] },
      { maxError: 2, budget: 1e6, loaded: all },
    ).selected;
  assert.ok(fine.includes(1) && coarse.includes(1), 'environment never refines away');
  assert.ok(fine.every((i) => !source.nodes[i].children.length));
  assert.notDeepEqual(fine, coarse);
  const reference = await parseSog(real),
    halves = await Promise.all(fine.filter((i) => i !== 1).map((i) => source.load(i, signal)));
  for (const key of ['positions', 'covariances', 'colors', 'sphericalHarmonics']) {
    const joined = new Float32Array(halves.reduce((n, d) => n + d[key].length, 0));
    let at = 0;
    for (const d of halves) {
      joined.set(d[key], at);
      at += d[key].length;
    }
    assert.deepEqual(joined, reference[key], key);
  }
  assert.equal(fixture.requests.filter((p) => p.endsWith('sh0.webp')).length, 1, 'shared chunk decoded once');
  halves[0].positions.fill(123);
  assert.notEqual((await source.load(fine[0], signal)).positions[0], 123, 'callers cannot mutate cached chunks');
  source.dispose();
  source.dispose();
  await assert.rejects(source.load(1, signal), { code: 'disposed' });
});
test('streamed SOG caller abort leaves a shared decode alive; last caller abort cancels the request', async () => {
  const f = scene(),
    source = await loadStreamedSog('https://local/scene/lod-meta.json', { fetch: f.fetch, cacheChunks: 0 });
  f.hold();
  const a = new AbortController(),
    b = new AbortController(),
    pa = source.load(4, a.signal),
    pb = source.load(6, b.signal);
  a.abort(new Error('caller cancelled'));
  await assert.rejects(pa, /caller cancelled/);
  assert.deepEqual(f.aborted, []);
  f.release();
  assert.ok((await pb).positions.length > 0);
  source.dispose();
  const g = scene(),
    other = await loadStreamedSog('https://local/scene/lod-meta.json', { fetch: g.fetch });
  g.hold();
  const c = new AbortController(),
    p = other.load(4, c.signal);
  c.abort(new Error('last caller'));
  await assert.rejects(p, /last caller/);
  await Promise.resolve();
  assert.ok(g.aborted.length > 0);
  other.dispose();
});
test('streamed SOG pre-release defaults, bounded cache, and abortable lifetime', async () => {
  const f = scene({ version: undefined, count: undefined, counts: undefined, lodErrors: false, environment: null }),
    parent = new AbortController(),
    s = await loadStreamedSog('https://local/scene/lod-meta.json', {
      fetch: f.fetch,
      signal: parent.signal,
      cacheChunks: 1,
    });
  for (const i of [2, 1, 2]) await s.load(i, signal);
  assert.equal(f.requests.filter((p) => p.endsWith('sh0.webp')).length, 3, 'LRU evicts the other chunk');
  parent.abort(new Error('parent cancelled'));
  await assert.rejects(s.load(2, signal), /parent cancelled/);
  await assert.rejects(loadStreamedSog('https://local/nope', { fetch: f.fetch }), { code: 'failed' });
  await assert.rejects(
    loadStreamedSog('https://local/scene/lod-meta.json', {
      fetch: f.fetch,
      signal: AbortSignal.abort(new Error('early')),
    }),
    /early/,
  );
});
test('streamed SOG rejects malformed trees, ranges, errors, and count totals', async () => {
  for (const mutate of [
    (m) => (m.version = 2),
    (m) => m.count++,
    (m) => m.counts[0]++,
    (m) => m.tree.children[0].lods[0].offset++,
    (m) => (m.tree.children[0].errors = [2, 0, 1]),
    (m) => (m.tree.children[0].bound.min = [NaN, 0, 0]),
    (m) => m.tree.children.pop(),
  ]) {
    const f = scene();
    mutate(f.manifest);
    f.files.set('/scene/lod-meta.json', json(f.manifest));
    await assert.rejects(loadStreamedSog('https://local/scene/lod-meta.json', { fetch: f.fetch }), RangeError);
  }
});
test('structural SplatLod sources validate their minimum coverage budget and enforce occupied slot counts', () => {
  const node = (count, children, error = 1) => ({ count, children, error, center: [0, 0, 0], radius: 1 });
  const nodes = [node(0, [1, 2]), node(4, []), node(1, [3, 4]), node(1, []), node(1, [])];
  assert.throws(() => new SplatLod({ nodes, coefficients: 0, load() {} }, { budget: 4 }), /at least 8/);
  const cut = chooseSplatNodes(
    nodes,
    { eye: [0, 0, 3], near: 0.1, focal: 100 },
    { maxError: 0, budget: 8, maxNodes: 2, loaded: () => true },
  );
  assert.deepEqual(cut.selected, [1, 2], 'small nodes cannot exhaust the fixed pool slots');
});

function v3({ bands = 4, label = 0 } = {}) {
  const files = {},
    count = 1,
    palette = label + 1,
    coeffs = (bands + 1) ** 2 - 1;
  const image = (name, width, height, fill) => {
    const rgba = new Uint8Array(width * height * 4);
    fill(rgba);
    files[name] = encodeWebpLossless(rgba, width, height);
  };
  image('low', 1, 1, (a) => a.set([0, 0, 0, 128]));
  image('high', 1, 1, (a) => a.set([0, 0, 0, 128]));
  image('scales', 1, 1, (a) => a.set([0, 1, 2, 128]));
  image('dc', 1, 1, (a) => a.set([0, 0, 0, 255]));
  image('labels', 1, 1, (a) => a.set([label & 255, (label >>> 8) & 255, label >>> 16, 255]));
  image('centroids', 64 * coeffs, Math.ceil(palette / 64), (a) => {
    a.fill(255);
    a[((label >>> 6) * 64 * coeffs + (label & 63) * coeffs + coeffs - 1) * 4] = 1;
  });
  const book = new Array(256).fill(0);
  book[1] = 0.1;
  files['meta.json'] = json({
    version: 3,
    count,
    means: { mins: [0, 0, 0], maxs: [0, 0, 0], files: ['low', 'high'] },
    scales: { codebook: Array.from({ length: 256 }, (_, i) => Math.log((i + 1) / 100)), files: ['scales'] },
    sh0: { codebook: new Array(256).fill(0), files: ['dc'] },
    shN: { count: palette, bands, codebook: book, files: ['centroids', 'labels'] },
    blind: [{ files: ['unused'], fields: [{ name: 'tag', type: 'u32' }] }],
  });
  return files;
}
test('SOG v3 identity exponential map, squared opacity and all 25 SH coefficients survive validation and rotation', async () => {
  const data = await parseSog(v3());
  assert.equal(validateSplats(data), 1);
  assert.equal(data.colors[3], 1.5625);
  assert.equal(data.sphericalHarmonics.length, 75);
  assert.ok(data.sphericalHarmonics[72] > 0, 'degree 4 retained');
  assert.ok(Math.abs(data.covariances[0] - 0.0001) < 1e-10);
  assert.ok(Math.abs(data.covariances[3] - 0.0004) < 1e-10);
  const angle = 0.4,
    c = Math.cos(angle),
    s = Math.sin(angle),
    matrix = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    inverse = [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const back = transformSplats(transformSplats(data, matrix), inverse);
  data.sphericalHarmonics.forEach((x, i) => assert.ok(Math.abs(x - back.sphericalHarmonics[i]) < 1e-6, `SH ${i}`));
  assert.equal(back.colors[3], 1.5625);
});
test('SOG v3 consumes the high byte of 24-bit palette labels', async () => {
  const data = await parseSog(v3({ bands: 1, label: 65536 }));
  assert.ok(data.sphericalHarmonics[9] > 0, 'palette entry 65536, not entry 0');
});
test('streamed mixed-degree chunks promote neutral bands and preserve v3 opacity, including the environment', async () => {
  const full=v3(), plain={...full}, meta=JSON.parse(new TextDecoder().decode(full['meta.json']));
  delete meta.shN; plain['meta.json']=json(meta);
  const manifest={version:1,lodLevels:1,filenames:['fine/meta.json'],environment:'env/meta.json',tree:{bound:bounds,lods:{0:{file:0,offset:0,count:1}}}},
    source=await loadStreamedSog('https://local/lod-meta.json',{fetch:async url=>{
      const path=new URL(url).pathname;
      return new Response(path==='/lod-meta.json'?json(manifest):(path.startsWith('/env/')?plain:full)[path.split('/').at(-1)]);
    }});
  assert.equal(source.coefficients,25);
  const environment=await source.load(1,signal),fine=await source.load(2,signal);
  assert.equal(environment.colors[3],1.5625);assert.equal(fine.colors[3],1.5625);
  assert.equal(environment.sphericalHarmonics.length,75);
  assert.ok(environment.sphericalHarmonics.slice(3).every(x=>x===0));
  assert.ok(fine.sphericalHarmonics[72]>0);
  source.dispose();
});
test('SOG v3 nonidentity exponential map rotates anisotropic covariance', async () => {
  const files=v3();files.scales=encodeWebpLossless(new Uint8Array([0,1,2,192]),1,1);
  const data=await parseSog(files),angle=64/127*Math.PI,c=Math.cos(angle),s=Math.sin(angle);
  assert.ok(Math.abs(data.covariances[0]-(c*c*0.0001+s*s*0.0004))<1e-9);
  assert.ok(Math.abs(data.covariances[1]-(c*s*(0.0001-0.0004)))<1e-9);
});
test('SOG v3 writer round trips degree 4 and extended opacity; older formats reject unrepresentable opacity', async () => {
  const data = await parseSog(v3()),
    back = await parseSog(await encodeSog(data));
  assert.equal(back.colors[3], 1.5625);
  assert.equal(back.sphericalHarmonics.length, 75);
  data.sphericalHarmonics.forEach((v, i) => assert.ok(Math.abs(v - back.sphericalHarmonics[i]) < 1e-5, `SH ${i}`));
  await assert.rejects(encodeSpz(data), /use SOG/);
  assert.throws(() => encodeSplat(data), /use SOG/);
  assert.throws(() => encodePly(data), /use SOG/);
  data.colors[3] = 1.5626;
  assert.throws(() => validateSplats(data), RangeError);
});
