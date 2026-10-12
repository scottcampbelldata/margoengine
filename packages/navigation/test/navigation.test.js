import test from 'node:test';
import assert from 'node:assert/strict';
import {Navigation} from '../dist/index.js';
test('real Recast Wasm builds a walkable plane, Detour finds a path and resources can be retired', async () => {
  const nav = await Navigation.create([-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, 10], [0, 2, 1, 0, 3, 2], {cs: 0.25, ch: 0.1, minRegionArea: 0, mergeRegionArea: 0, walkableRadius: 0});
  try {const path = nav.path({x: -5, y: 0, z: -5}, {x: 5, y: 0, z: 5}); assert.ok(path?.length >= 2); assert.ok(Math.abs(path.at(-1).x - 5) < 0.1);} finally {nav.dispose();}
  assert.throws(() => nav.path({x: 0, y: 0, z: 0}, {x: 1, y: 0, z: 1}), /disposed/);
  await assert.rejects(Navigation.create([0, 0, 0], [0, 1, 2]), /Invalid/);
});
