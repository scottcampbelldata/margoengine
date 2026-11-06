import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLAS, writeLAS } from '../dist/las.js';
import { OctreeCloud } from '../dist/octree.js';
import { PotreeSource } from '../dist/potree.js';
import { serve, writePotree1, writePotree2 } from './potree-writer.js';

function scan(n = 6000) {
  let s = 11;
  const random = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const positions = new Array(n * 3),
    colors = new Array(n * 3);
  for (let i = 0; i < n; i++) {
    // Far from zero, as a survey is.
    positions[i * 3] = 500_000 + ((i * 7919) % n) * (80 / n); // no two alike, so sorting by x pairs them
    positions[i * 3 + 1] = 4_000_000 + random() * 80;
    positions[i * 3 + 2] = 100 + random() * 10;
    colors[i * 3] = i % 256;
    colors[i * 3 + 1] = (i * 7) % 256;
    colors[i * 3 + 2] = 200;
  }
  return { positions, colors, capacity: 300 };
}
const walk = (node, out = []) => {
  out.push(node);
  for (const child of node.children) if (child) walk(child, out);
  return out;
};
const signal = new AbortController().signal;

/** Loads every node, checks each point lies in its node, and returns world points with their colours, sorted. */
async function everyPoint(source) {
  const out = [];
  for (const node of walk(source.root)) {
    const data = await source.load(node, signal);
    assert.equal(data.positions.length, node.count * 3, `node ${node.id} point count`);
    const b = node.bounds;
    for (let i = 0; i < node.count; i++) {
      const p = [0, 1, 2].map((a) => data.positions[i * 3 + a]);
      for (let a = 0; a < 3; a++)
        assert.ok(p[a] >= b[a] - 0.01 && p[a] <= b[a + 3] + 0.01, `point in node ${node.id}: ${p} in ${b}`);
      out.push([...p.map((v, a) => v + source.origin[a]), ...(data.colors?.slice(i * 3, i * 3 + 3) ?? [])]);
    }
    for (const [o, child] of node.children.entries()) if (child) assert.equal(child.id, node.id + o);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
function sameAs(points, cloud) {
  const n = cloud.positions.length / 3,
    want = [];
  for (let i = 0; i < n; i++) want.push([...cloud.positions.slice(i * 3, i * 3 + 3), ...cloud.colors.slice(i * 3, i * 3 + 3)]);
  want.sort((a, b) => a[0] - b[0]);
  assert.equal(points.length, n, 'every point once');
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) assert.ok(Math.abs(points[i][a] - want[i][a]) < 0.01, `point ${i} axis ${a}`);
    assert.deepEqual(points[i].slice(3), want[i].slice(3), `colour of point ${i}`);
  }
}

test('2.0: a folder with proxy chunks gives back every point and colour, by range requests', async () => {
  const cloud = scan(),
    log = [],
    source = await PotreeSource.open('/scan/', { fetch: serve(writePotree2(cloud, { step: 1 }), '/scan/', log) });
  assert.equal(source.version, '2.0');
  assert.equal(source.points, 6000);
  assert.ok(log.filter((l) => l.startsWith('hierarchy.bin')).length > 1, 'proxies were followed');
  assert.ok(walk(source.root).length > 8);
  sameAs(await everyPoint(source), cloud);
  assert.ok(log.filter((l) => l.startsWith('octree.bin')).every((l) => l.includes('bytes=')));
});

test('2.0: 16-bit colours take their high byte; the metadata decides for every node alike', async () => {
  const cloud = { ...scan(), wideColors: true },
    source = await PotreeSource.open('/scan/metadata.json', { fetch: serve(writePotree2(cloud), '/scan/') });
  sameAs(await everyPoint(source), cloud);
});

test('2.0: a server that ignores Range still works', async () => {
  const cloud = scan(1000),
    files = writePotree2(cloud),
    whole = async (url) => new Response(files.get(String(url).slice('/s/'.length)), { status: 200 }),
    source = await PotreeSource.open('/s/metadata.json', { fetch: whole });
  sameAs(await everyPoint(source), cloud);
});

test('2.0: BROTLI, other versions and corrupt data are refused by name', async () => {
  const cloud = scan(1000);
  await assert.rejects(
    PotreeSource.open('/scan/', { fetch: serve(writePotree2(cloud, { encoding: 'BROTLI' }), '/scan/') }),
    (e) => e.code === 'unsupported' && /BROTLI/.test(e.message),
  );
  await assert.rejects(
    PotreeSource.open('/scan/metadata.json', { fetch: serve(writePotree2(cloud, { version: '3.0' }), '/scan/') }),
    (e) => e.code === 'unsupported',
  );
  const broken = writePotree2(cloud);
  broken.set('hierarchy.bin', broken.get('hierarchy.bin').slice(0, 30));
  await assert.rejects(PotreeSource.open('/scan/', { fetch: serve(broken, '/scan/') }), RangeError);
  const short = writePotree2(cloud);
  short.set('octree.bin', short.get('octree.bin').slice(0, 100));
  const source = await PotreeSource.open('/scan/', { fetch: serve(short, '/scan/') });
  await assert.rejects(source.load(source.root, signal), /cut short/);
  const notJson = new Map([['metadata.json', new Uint8Array([60, 104])]]);
  await assert.rejects(PotreeSource.open('/scan/', { fetch: serve(notJson, '/scan/') }), TypeError);
  await assert.rejects(PotreeSource.open('/scan/', { fetch: serve(new Map(), '/scan/') }), (e) => e.code === 'failed');
});

test('1.x: hierarchy files every few levels give back every point and colour', async () => {
  const cloud = scan(),
    log = [],
    files = writePotree1(cloud, { step: 2 }),
    source = await PotreeSource.open('/scan', { fetch: serve(files, '/scan/', log) });
  assert.equal(source.version, '1.7');
  assert.ok(log.filter((l) => l.endsWith('.hrc')).length > 1, 'several hierarchy files');
  assert.ok(
    [...files.keys()].some((k) => /^data\/r\/\d\d\/r\d\d\d?\.bin$/.test(k)),
    'deep nodes sit in folders',
  );
  sameAs(await everyPoint(source), cloud);
});

test('1.x: LAS nodes read through the LAS parser', async () => {
  const cloud = scan(1500),
    nodeFile = (points) => {
      const positions = new Float64Array(points.length * 3),
        rgb = new Uint16Array(points.length * 3);
      points.forEach((p, k) => {
        for (let a = 0; a < 3; a++) {
          positions[k * 3 + a] = cloud.positions[p * 3 + a];
          rgb[k * 3 + a] = cloud.colors[p * 3 + a] * 257;
        }
      });
      return writeLAS({ positions, rgb, pointFormat: 2, versionMinor: 2 });
    },
    files = writePotree1(cloud, { kind: 'LAS', nodeFile }),
    fetch = serve(files, '/scan/'),
    source = await PotreeSource.open('/scan/cloud.js', { fetch, parseLAS });
  sameAs(await everyPoint(source), cloud);
  await assert.rejects(
    PotreeSource.open('/scan/cloud.js', { fetch }),
    (e) => e.code === 'unsupported' && /parseLAS/.test(e.message),
  );
});

test('1.x: old versions and unknown attributes are refused by name', async () => {
  const cloud = scan(800);
  await assert.rejects(
    PotreeSource.open('/scan/cloud.js', { fetch: serve(writePotree1(cloud, { version: '1.3' }), '/scan/') }),
    (e) => e.code === 'unsupported' && /1\.3/.test(e.message),
  );
  const files = writePotree1(cloud),
    meta = JSON.parse(new TextDecoder().decode(files.get('cloud.js')));
  meta.pointAttributes.push('MYSTERY');
  files.set('cloud.js', new TextEncoder().encode(JSON.stringify(meta)));
  await assert.rejects(
    PotreeSource.open('/scan/cloud.js', { fetch: serve(files, '/scan/') }),
    (e) => e.code === 'unsupported' && /MYSTERY/.test(e.message),
  );
  const cut = writePotree1(cloud);
  cut.set('data/r/r.hrc', cut.get('data/r/r.hrc').slice(0, 7));
  await assert.rejects(PotreeSource.open('/scan/', { fetch: serve(cut, '/scan/') }), RangeError);
});

test('open and load stop on abort; an empty node makes no request', async () => {
  const files = writePotree2(scan(1000)),
    controller = new AbortController();
  controller.abort(new Error('stop'));
  await assert.rejects(PotreeSource.open('/scan/metadata.json', { fetch: serve(files), signal: controller.signal }), /stop/);
  const log = [],
    source = await PotreeSource.open('/scan/', { fetch: serve(files, '/scan/', log) });
  await assert.rejects(source.load(source.root, controller.signal), /stop/);
  log.length = 0;
  assert.equal((await source.load({ ...source.root, count: 0 }, signal)).positions.length, 0);
  assert.equal(log.length, 0);
});

test('OctreeCloud streams a folder', async () => {
  const clouds = new Set(),
    host = { add: (c) => (clouds.add(c), c), remove: (c) => clouds.delete(c) },
    source = await PotreeSource.open('/scan/', { fetch: serve(writePotree2(scan()), '/scan/') }),
    octree = new OctreeCloud(host, source, { minNodePixels: 1 }),
    view = { position: [0, 0, 200], screenHeight: 800 };
  for (let i = 0, quiet = 0; i < 2000 && quiet < 3; i++) {
    octree.select(view);
    quiet = octree.stats.loading ? 0 : quiet + 1;
    await new Promise((r) => setTimeout(r, 0));
  }
  octree.select(view);
  assert.equal(octree.stats.failed, 0);
  assert.equal(octree.stats.drawn, 6000);
  octree.dispose();
});
