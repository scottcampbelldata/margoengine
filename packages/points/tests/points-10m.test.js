import assert from 'node:assert/strict';
import test from 'node:test';
import { PotreeSource } from '../dist/potree.js';
import { POINTS_SCENE, pointAt, pointCount, potreeBytes } from '../../../scripts/rival-points-scene.mjs';

const serve = (files) => async (url, init) => {
  const name = String(url)
    .replace(/^\/scan\//, '')
    .split('?')[0];
  const bytes = files.get(name);
  if (!bytes) return new Response('missing', { status: 404 });
  const header = init?.headers?.Range ?? init?.headers?.range;
  const match = typeof header === 'string' ? /^bytes=(\d+)-(\d*)$/.exec(header) : null;
  if (!match) return new Response(bytes);
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : bytes.length - 1;
  return new Response(bytes.subarray(start, end + 1), {
    status: 206,
    headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` },
  });
};

test('the published grid is 10,000,000 points filling a 100 m cube', () => {
  assert.equal(pointCount(POINTS_SCENE), 10_000_000);
  assert.equal(POINTS_SCENE.budget, 10_000_000);
  const first = pointAt(0, POINTS_SCENE);
  const last = pointAt(10_000_000 - 1, POINTS_SCENE);
  assert.deepEqual(first, [-50, -50, -50]);
  for (const value of last) assert.ok(Math.abs(value - 50) < 1e-9);
});

test('a small folder of the same layout round-trips through PotreeSource', async () => {
  const spec = { ...POINTS_SCENE, nx: 2, ny: 2, nz: 2 };
  const source = await PotreeSource.open('/scan/metadata.json', { fetch: serve(potreeBytes(spec)) });
  assert.equal(source.points, 8);
  assert.equal(source.root.count, 8);
  const data = await source.load(source.root, new AbortController().signal);
  assert.equal(data.positions.length, 24);
  const scale = spec.scale;
  for (let i = 0; i < 8; i++) {
    const world = pointAt(i, spec);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(data.positions[i * 3 + axis] - world[axis]) <= scale / 2 + 1e-6);
    }
  }
});
