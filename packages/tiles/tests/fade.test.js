import assert from 'node:assert/strict';
import test from 'node:test';
import { TilesFade, ditherRank } from '../dist/fade.js';
function tile(parent = null, refine = 'REPLACE') {
  const t = { parent, children: [], refine, renderable: { visible: false } };
  parent?.children.push(t);
  return t;
}
function fixture() {
  const root = tile(),
    a = tile(root),
    b = tile(root);
  let listener;
  let now = 0;
  const renderer = {
    tileset: {
      root,
      on(event, fn) {
        assert.equal(event, 'selection');
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    },
    last: { selected: [] },
  };
  const fade = new TilesFade({ clock: () => now, duration: 1 }).attach(renderer);
  return {
    root,
    a,
    b,
    fade,
    time(t) {
      now = t;
    },
    select(selected) {
      renderer.last = { selected };
      listener?.({ selected });
    },
  };
}
const model = (tile) => ({
  kind: 'model',
  tile,
  model: { primitives: [{ extension: undefined }] },
  content: { type: 'gltf' },
});
const range = (ctx) => Array.from(ctx.model.primitives[0].extension.factors.subarray(0, 2));
const coverage = (range) =>
  Array.from({ length: 16 }, (_, i) => i).filter((rank) => {
    const v = (rank + 0.5) / 16;
    return v >= range[0] && v < range[1];
  });
test('ordered screen-door ranks contain each sample exactly once', () => {
  const all = [];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) all.push(ditherRank(x, y));
  assert.deepEqual(
    all.sort((a, b) => a - b),
    Array.from({ length: 16 }, (_, i) => i),
  );
});
test('replacement uses complementary mesh, point and splat intervals and reverses continuously', async () => {
  const f = fixture(),
    parent = model(f.root),
    point = { kind: 'points', tile: f.a, cloud: { material: {} }, content: {} },
    ranges = [];
  const splat = {
    kind: 'splats',
    tile: f.b,
    model: { primitives: [] },
    content: {},
    fade: (lo, hi) => ranges.push([lo, hi]),
  };
  const decorations = await Promise.all([f.fade.decorate(parent), f.fade.decorate(point), f.fade.decorate(splat)]);
  f.select([f.root]);
  assert.deepEqual(range(parent), [0, 1]);
  f.select([f.a, f.b]);
  f.time(0.5);
  f.select([f.a, f.b]);
  assert.deepEqual(range(parent), [0.5, 1]);
  assert.deepEqual(point.cloud.material.ditherFade, [0, 0.5]);
  assert.deepEqual(ranges.at(-1), [0, 0.5]);
  assert.deepEqual(
    [...coverage(range(parent)), ...coverage(ranges.at(-1))].sort((a, b) => a - b),
    Array.from({ length: 16 }, (_, i) => i),
  );
  f.select([f.root]);
  assert.deepEqual(range(parent), [0.5, 1]);
  f.time(1);
  f.select([f.root]);
  assert.deepEqual(range(parent), [0.25, 1]);
  assert.deepEqual(point.cloud.material.ditherFade, [0, 0.25]);
  f.time(2);
  f.select([f.root]);
  assert.equal(f.a.renderable.visible, false);
  assert.equal(f.root.renderable.visible, true);
  f.fade.dispose();
  assert.equal(parent.model.primitives[0].extension, undefined);
  decorations.forEach((d) => d.dispose());
});
test('nested replacements partition every path while an ancestor is still fading', async () => {
  const f = fixture(),
    grand = tile(f.a),
    contexts = [model(f.root), model(f.a), model(grand)];
  for (const c of contexts) await f.fade.decorate(c);
  f.select([f.root]);
  f.select([f.a]);
  f.time(0.25);
  f.select([f.a]);
  f.select([grand]);
  f.time(0.75);
  f.select([grand]);
  const intervals = contexts.map(range);
  const ranks = intervals.flatMap(coverage);
  assert.equal(new Set(ranks).size, 16);
  assert.equal(ranks.length, 16);
  assert.deepEqual(intervals, [
    [0.75, 1],
    [0.375, 0.75],
    [0, 0.375],
  ]);
  f.fade.dispose();
});
test('ADD keeps parent and children coverage, and disposal restores prior extensions and lifetimes', async () => {
  const f = fixture();
  f.root.refine = 'ADD';
  const a = model(f.root),
    b = model(f.a);
  await f.fade.decorate(a);
  await f.fade.decorate(b);
  f.select([f.root, f.a]);
  assert.deepEqual(range(a), [0, 1]);
  assert.deepEqual(range(b), [0, 1]);
  assert.equal(f.root.renderable.visible, true);
  assert.equal(f.a.renderable.visible, true);
  f.fade.dispose();
  assert.throws(() => new TilesFade({ duration: 0 }), /duration/);
});
