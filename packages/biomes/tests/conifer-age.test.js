// coniferAge of @margoengine/biomes/presets: the rockies presets drawn at another conifer age. Every aged conifer key
// takes the new age, snag, burnt, shrub and rock keys stay, placement fields are untouched, the result is valid for a
// world and the presets themselves are not changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defineBiome } from '../dist/index.js';
import { coniferAge, rockiesValleyWorld, rockiesPresets } from '../dist/presets.js';
import { parseConiferKey } from '../../procedural/dist/conifer-species.js';

test('coniferAge: every aged conifer key takes the age, the rest stays', () => {
  const before = rockiesValleyWorld.biomes,
    after = coniferAge(before, 'mature');
  assert.equal(after.length, before.length);
  let aged = 0;
  for (let b = 0; b < before.length; b++) {
    assert.notEqual(after[b], before[b]);
    assert.ok(Object.isFrozen(after[b]));
    assert.equal(after[b].id, before[b].id);
    assert.deepEqual(after[b].ground, before[b].ground);
    for (let p = 0; p < (before[b].plants?.length ?? 0); p++) {
      const was = before[b].plants[p],
        now = after[b].plants[p],
        key = parseConiferKey(was.mesh);
      assert.deepEqual({ ...now, mesh: was.mesh }, { ...was }, 'placement fields unchanged');
      if (key && /\/(sapling|pole|mature|old)$/.test(was.mesh)) {
        aged++;
        assert.deepEqual(parseConiferKey(now.mesh), { ...key, age: 'mature' }, now.mesh);
      } else assert.equal(now.mesh, was.mesh);
    }
    defineBiome(after[b]); // still a valid definition
  }
  assert.equal(aged, 6, 'white pine, cedar, grand fir, two Douglas-firs and larch');
  assert.equal(rockiesPresets['rockies-dry-forest'].plants[0].mesh, 'procedural:douglas-fir/pole', 'presets unchanged');
});

test('coniferAge: keeps snags and unaged keys, and refuses an unknown age', () => {
  const biome = { id: 'snags', plants: [{ id: 'a', mesh: 'procedural:conifer-snag', density: 10, radius: 2 }, { id: 'b', mesh: 'procedural:douglas-fir/snag', density: 10, radius: 2 }, { id: 'c', mesh: 'procedural:grand-fir', density: 10, radius: 2 }] };
  assert.deepEqual(coniferAge([biome], 'old')[0].plants.map((p) => p.mesh), ['procedural:conifer-snag', 'procedural:douglas-fir/snag', 'procedural:grand-fir']);
  assert.throws(() => coniferAge(rockiesValleyWorld.biomes, 'ancient'), RangeError);
});
