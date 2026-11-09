import test from 'node:test';
import assert from 'node:assert/strict';
import { WaveQuery } from '../dist/query.js';
import { Water } from '../dist/index.js';
import { FFTOcean } from '../dist/fft.js';

function frame(points, cells = 1) {
  const query = Object.create(WaveQuery.prototype);
  const vertices = new Float32Array(points.length * 12);
  points.forEach((p, i) => vertices.set([...p, p[0], 0, 1, 0, p[2], 2, 3, 4, 0], i * 12));
  Object.assign(query, {
    time: 12.5,
    segments: cells,
    vertices,
    bounds: new Float32Array([-1e6, -1e6, 1e6, 1e6]),
    levels: [{ side: 1, offset: 0 }],
  });
  return query;
}
test('vertical queries interpolate actual displaced triangles and retain frame time', () => {
  const q = frame([
    [1, 0, 0],
    [3, 2, 0],
    [1, 4, 2],
    [3, 8, 2],
  ]);
  assert.equal(q.heightAt(1.5, 0.5), 1.5);
  assert.equal(q.heightAt(2.5, 1.5), 5.5);
  assert.equal(q.heightAt(0, 1), undefined, 'rest-space lookup must not hit outside displaced mesh');
  assert.equal(q.sample(2, 1).time, 12.5);
  assert.deepEqual(q.velocityAt(2, 1), [2, 3, 4]);
  assert.deepEqual(q.normalAt(2, 1), [0, 1, 0]);
  assert.ok(Math.abs(Math.hypot(...q.sample(2, 1).geometricNormal) - 1) < 1e-15);
});
test('all shared-edge and corner hits survive; collinear triangles miss', () => {
  const q = frame([
    [0, 1, 0],
    [1, 2, 0],
    [0, 3, 1],
    [1, 4, 1],
  ]);
  for (let i = 0; i <= 1024; i++) {
    const t = i / 1024;
    assert.equal(q.heightAt(t, 1 - t), 3 - t);
  }
  for (const [x, z] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ])
    assert.notEqual(q.sample(x, z), undefined);
  assert.equal(
    frame([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
    ]).sample(1, 0),
    undefined,
  );
  assert.throws(() => q.sample(NaN, 0), RangeError);
  assert.throws(() => q.sample(0, Infinity), RangeError);
});
test('folded overlapping triangles select the highest hit rather than a Newton branch', () => {
  const q = frame([
    [0, 0, 0],
    [2, 2, 0],
    [0, 0, 2],
    [0.2, 5, 0.2],
  ]);
  const hit = q.sample(0.5, 0.5);
  assert.ok(hit.height > 1, 'folded second triangle lies above the first');
  assert.ok(hit.geometricNormal[1] >= 0);
});
test('capture validates live rendered source and pre-abort without GPU work', async () => {
  for (const source of [new Water(), new FFTOcean(), {}])
    await assert.rejects(WaveQuery.capture(source), { code: 'state' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(WaveQuery.capture(new Water(), { signal: controller.signal }), { name: 'AbortError' });
});
test('terrain masks preserve still fill interpolation and dynamic dry thresholds', () => {
  const q = frame([
    [0, 2, 0],
    [1, 2, 0],
    [0, 2, 1],
    [1, 2, 1],
  ]);
  q.coast = {
    width: 2,
    height: 2,
    origin: [0, 0],
    size: [1, 1],
    still: true,
    data: new Float32Array([1, 1, 0, 2, 0, 3, 0, 2, 1, 1, 0, 2, 0, 3, 0, 2]),
  };
  assert.equal(q.heightAt(0.25, 0.5), 2);
  assert.equal(q.heightAt(0.75, 0.5), undefined);
  assert.equal(q.heightAt(0.5, 0.5), undefined, 'signed fill waterline between texels');
  q.coast.still = false;
  assert.equal(q.heightAt(0.75, 0.5), undefined);
});
