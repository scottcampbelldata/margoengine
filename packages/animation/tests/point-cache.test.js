// parsePointCache on real files: tests/fixtures/ball.pc2 and ball.mdd were written by the published Blender add-ons
// "Export Pointcache Format (.pc2)" 1.1.4 and "NewTek MDD format" 1.0.3 from a waved icosphere in Blender 5.3, and
// ball.frames.json holds the same frames as Blender itself evaluates them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePointCache } from '../dist/point-cache.js';
import { encodeGeometryCache, readGeometryCache } from '../dist/geometry-cache.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`fixtures/${name}`, import.meta.url))),
  truth = JSON.parse(readFileSync(new URL('fixtures/ball.frames.json', import.meta.url), 'utf8')),
  worst = (cache, frame, map) => {
    const want = truth.frames[frame],
      size = cache.vertexCount * 3;
    let off = 0;
    for (let n = 0; n < size; n += 3) {
      const [x, y, z] = map(want[n], want[n + 1], want[n + 2]),
        at = Number(frame) * size + n;
      off = Math.max(off, Math.abs(cache.positions[at] - x), Math.abs(cache.positions[at + 1] - y), Math.abs(cache.positions[at + 2] - z));
    }
    return off;
  };

test('a real MDD file holds the frames Blender evaluates, at its own frame rate', () => {
  const cache = parsePointCache(fixture('ball.mdd'));
  assert.equal(cache.format, 'mdd');
  assert.deepEqual([cache.frameCount, cache.vertexCount], [8, truth.count]);
  assert.ok(Math.abs(cache.rate - 24) < 1e-4);
  assert.ok(Math.abs(cache.times[3] - 0.125) < 1e-6);
  for (const frame of Object.keys(truth.frames)) assert.ok(worst(cache, frame, (x, y, z) => [x, y, z]) < 2e-6);
});

test('a real PC2 file holds the same frames, in the Y-up axes the add-on wrote by default', () => {
  const cache = parsePointCache(fixture('ball.pc2'), { fps: 24 });
  assert.equal(cache.format, 'pc2');
  assert.deepEqual([cache.frameCount, cache.vertexCount, cache.rate], [8, truth.count, 24]);
  assert.ok(Math.abs(cache.times[0] - 1 / 24) < 1e-6);
  for (const frame of Object.keys(truth.frames)) assert.ok(worst(cache, frame, (x, y, z) => [x, z, -y]) < 2e-6);
});

test('zUp turns a Z-up file to Y-up, so both real files agree', () => {
  const mdd = parsePointCache(fixture('ball.mdd'), { zUp: true }),
    pc2 = parsePointCache(fixture('ball.pc2'));
  for (let n = 0; n < mdd.positions.length; n++) assert.ok(Math.abs(mdd.positions[n] - pc2.positions[n]) < 1e-5);
});

test('a real cache with its mesh\'s triangles reads back through the geometry cache format', async () => {
  const cache = parsePointCache(fixture('ball.pc2')),
    indices = new Uint32Array(truth.indices),
    file = encodeGeometryCache(cache.rate, [{ frameCount: cache.frameCount, positions: cache.positions, indices }]);
  const chunks = [];
  for await (const chunk of readGeometryCache(file)) chunks.push(chunk);
  assert.equal(chunks.length, 1);
  assert.deepEqual([chunks[0].frameCount, chunks[0].vertexCount, chunks[0].rate], [8, truth.count, 24]);
  assert.deepEqual([...chunks[0].positions.subarray(0, 30)], [...cache.positions.subarray(0, 30)]);
  assert.deepEqual(chunks[0].indices, indices);
});

test('a cut, empty, unknown or oversized file is refused with a code', () => {
  const pc2 = fixture('ball.pc2'),
    mdd = fixture('ball.mdd'),
    code = (bytes, wanted, options) =>
      assert.throws(() => parsePointCache(bytes, options), (error) => error.code === wanted);
  code(pc2.subarray(0, 20), 'failed');
  code(pc2.subarray(0, pc2.length - 4), 'failed');
  code(mdd.subarray(0, 4), 'failed');
  code(mdd.subarray(0, mdd.length - 4), 'failed');
  code(new Uint8Array(32), 'failed');
  const other = pc2.slice();
  other[12] = 2;
  code(other, 'unsupported');
  code(pc2, 'failed', { maxFloats: 10 });
  const still = mdd.slice();
  still.set(still.subarray(8, 12), 12);
  code(still, 'failed');
  assert.throws(() => parsePointCache(pc2, { fps: 0 }), RangeError);
});

test('a file that is no point cache is refused as one, not as a cache too large for maxFloats', () => {
  // A web page answered for a missing .pc2 reads as an MDD header of about 10^9 frames of 10^9 vertices: the readme run
  // saw "Point cache holds 3418670067845590500 floats, over maxFloats; raise maxFloats", advice no setting could follow.
  const page = new TextEncoder().encode('<!DOCTYPE html><html><head><title>Not found</title></head><body></body></html>');
  assert.throws(
    () => parsePointCache(page),
    (error) => error.code === 'failed' && !/maxFloats/.test(error.message) && /not a PC2 or MDD file/.test(error.message),
  );
  // A real file over the limit still names the limit.
  assert.throws(() => parsePointCache(fixture('ball.pc2'), { maxFloats: 10 }), /over maxFloats 10/);
});
