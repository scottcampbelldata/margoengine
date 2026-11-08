import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MATERIAL_DECALS, MaterialDecals } from '@margoengine/post/material-decals';

const decal = (extra = {}) => ({ position: [0, 0, 0], direction: [0, -2, 0], width: 2, height: 1, ...extra });

test('MaterialDecals checks its options and needs a stack', () => {
  assert.throws(() => new MaterialDecals({ enabled: 1 }), TypeError);
  assert.throws(() => new MaterialDecals({ targets: {} }), TypeError);
  assert.throws(() => new MaterialDecals({ atlas: {} }), TypeError);
  assert.throws(() => new MaterialDecals().setup({ gpu: {} }), /PostStack/);
  const effect = new MaterialDecals();
  effect.dispose();
  effect.dispose();
  assert.throws(() => effect.setup({ gpu: {} }), /disposed/);
  assert.throws(() => effect.setDecals([]), RangeError);
});

test('setDecals packs the box, the surface it gives and leaves unset channels unchanged', () => {
  const effect = new MaterialDecals().setDecals([
    decal(),
    decal({
      roughness: 0.1,
      metalness: 1,
      bump: 2,
      color: [0.5, 0.4, 0.3],
      opacity: 0.5,
      angle: Math.PI / 2,
      depth: 4,
    }),
  ]);
  assert.equal(effect.count, 2);
  const [a, b] = [0, 1].map((i) => [...effect['data'].subarray(i * 24, i * 24 + 24)]);
  // Straight down with the default up [0, 0, 1]: right = up x direction = +x, up = direction x right = +z.
  assert.deepEqual(
    a.slice(0, 4).map((v) => +v.toFixed(6)),
    [0, 0, 0, 0.5],
    'centre and cos(PI / 3)',
  );
  assert.deepEqual(
    a.slice(4, 8).map((v) => +v.toFixed(6) + 0),
    [1, 0, 0, 1],
    'half width along right, opacity 1',
  );
  assert.deepEqual(
    a.slice(8, 12).map((v) => +v.toFixed(6) + 0),
    [0, 0, 0.5, 1],
    'half height along up, bump 1',
  );
  assert.deepEqual(
    a.slice(12, 16).map((v) => +v.toFixed(6) + 0),
    [0, -0.5, 0, -1],
    'half depth into the surface, roughness unchanged',
  );
  assert.deepEqual(a.slice(16, 24), [0, 0, 1, 1, 1, 1, 1, -1], 'whole atlas, colour 1, metalness unchanged');
  assert.equal(b[3].toFixed(6), '0.000000');
  assert.deepEqual([b[7], b[11], b[13], +b[15].toFixed(6)], [0.5, 2, -2, 0.1]);
  assert.deepEqual(
    b.slice(20, 24).map((v) => +v.toFixed(6)),
    [0.5, 0.4, 0.3, 1],
  );
  effect.setDecals([]);
  assert.equal(effect.count, 0);
});

test('a bad list throws and keeps the decals set before', () => {
  const effect = new MaterialDecals().setDecals([decal()]);
  for (const bad of [
    decal({ roughness: 1.5 }),
    decal({ metalness: -0.1 }),
    decal({ bump: 5 }),
    decal({ width: 0 }),
    decal({ direction: [0, 0, 0] }),
    decal({ angle: 2 }),
    decal({ color: [1, -1, 1] }),
    decal({ rect: [0, 0, 2, 1] }),
    decal({ up: [0, 1, 0] }),
  ])
    assert.throws(() => effect.setDecals([decal(), bad]), RangeError);
  assert.throws(() => effect.setDecals([decal(), undefined]), RangeError);
  assert.throws(() => effect.setDecals(Array.from({ length: MAX_MATERIAL_DECALS + 1 }, () => decal())), RangeError);
  assert.equal(effect.count, 1);
  assert.equal(MAX_MATERIAL_DECALS, 64);
});
