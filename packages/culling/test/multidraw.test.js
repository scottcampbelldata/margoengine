// MultiDraw (@margoengine/culling/multidraw) without a GPU: merge keeps every part where it was, range checks, and the
// feature gate. The pictures are checked in test/gpu/multidraw-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { MULTI_DRAW_FEATURE, MultiDraw } from '../dist/multidraw.js';

test('merge places each geometry after the last and offsets its indices', () => {
  const a = box(1, 1, 1),
    b = box(2, 0.5, 2),
    { geometry, ranges } = MultiDraw.merge([a, b]);
  assert.deepEqual(ranges, [
    { first: 0, count: a.indices.length },
    { first: a.indices.length, count: b.indices.length },
  ]);
  const base = a.vertices.length / 6;
  assert.equal(geometry.vertices.length, a.vertices.length + b.vertices.length);
  assert.deepEqual(
    [...geometry.indices.subarray(a.indices.length)],
    [...b.indices].map((i) => i + base),
  );
  assert.deepEqual([...geometry.vertices.subarray(a.vertices.length)], [...b.vertices]);
  assert.throws(() => MultiDraw.merge([]), TypeError);
});

test('ranges must be whole triangles inside the geometry', () => {
  const g = box();
  for (const bad of [[], [{ first: -3, count: 3 }], [{ first: 0, count: 4 }], [{ first: 3, count: g.indices.length }]])
    assert.throws(() => new MultiDraw(g, bad), bad.length ? RangeError : TypeError);
  const draw = new MultiDraw(g, [
    { first: 0, count: 6 },
    { first: 6, count: 30 },
  ]);
  assert.equal(draw.isVisible(1), true);
  draw.setVisible(1, false);
  assert.equal(draw.isVisible(1), false);
  assert.throws(() => draw.setVisible(2, false), RangeError);
  assert.throws(() => draw.setVisible(0, 1), TypeError);
});

test('multi: true needs the multi-draw-indirect feature', () => {
  const features = new Set(),
    engine = { gpu: { features, createBuffer: () => ({ destroy() {} }) } };
  assert.throws(() => new MultiDraw(box(), [{ first: 0, count: 6 }], { multi: true }).setup(engine), {
    code: 'unsupported',
  });
  const plain = new MultiDraw(box(), [{ first: 0, count: 6 }]);
  plain.setup(engine);
  assert.equal(plain.multi, false);
  features.add(MULTI_DRAW_FEATURE);
  const multi = new MultiDraw(box(), [{ first: 0, count: 6 }]);
  multi.setup(engine);
  assert.equal(multi.multi, true);
});
