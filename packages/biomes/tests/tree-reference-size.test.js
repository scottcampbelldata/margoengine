// KB-BIOMES-BROADLEAFSIZE1: scatter scales a species' mesh by its reverse-J size (about a third to `size.max` times),
// so a grown species mesh is the reference size, not the largest tree. When `procedural:broadleaf` drew a mature oak
// (18.8 m tall, 19.8 m across) a temperate forest's largest oaks stood 45 m tall and 47 m across, and the crowns of
// objects-look.html (80 a hectare) ran together into three regions where 40 trees are measured. The generic key is now
// the pole oak, and every preset that scales a species mesh names it at pole age or younger.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as all from '../dist/presets.js';
import {
  BROADLEAF_AGES,
  BROADLEAF_SPECIES,
  broadleafForm,
  parseBroadleafKey,
} from '../../procedural/dist/broadleaf-species.js';
import { CONIFER_AGES, parseConiferKey } from '../../procedural/dist/conifer-species.js';

const definitions = () => {
  const out = new Map();
  for (const value of Object.values(all)) {
    if (!value || typeof value !== 'object') continue;
    const list = Array.isArray(value.biomes) ? value.biomes : value.id && value.plants ? [value] : Object.values(value);
    for (const d of list) if (d && typeof d === 'object' && Array.isArray(d.plants)) out.set(`${d.id}`, d);
  }
  return [...out.values()];
};

test('every preset tree drawn from a species mesh names it at pole age or younger, its reference size', () => {
  // The rockies presets name `/pole` (presets.ts: the reverse-J sizes run from about a third of it to 2.4 times, inside
  // the old-growth heights of the Silvics chapters); a mature mesh there reaches 2.4 times a mature tree.
  let checked = 0;
  for (const biome of definitions())
    for (const plant of biome.plants) {
      const key = parseBroadleafKey(plant.mesh) ?? parseConiferKey(plant.mesh);
      if (!key || key.condition === 'snag' || key.condition === 'burnt') continue;
      const ages = parseBroadleafKey(plant.mesh) ? BROADLEAF_AGES : CONIFER_AGES,
        max = plant.size?.max ?? 1;
      assert.ok(
        max <= 1 || ages[key.age] <= ages.pole,
        `${biome.id} ${plant.id} (${plant.mesh}): a ${key.age} mesh scaled up to ${max} times`,
      );
      checked++;
    }
  assert.ok(checked >= 6, `species-mesh trees checked: ${checked}`);
  // What it prevents: the mature oak at the forest presets' largest size, against the oak's forest-grown asymptote.
  const mature = broadleafForm('english-oak', { age: 'mature' }).height * 2.4;
  assert.ok(mature > BROADLEAF_SPECIES['english-oak'].growth[0] * 1.5, `${mature}`);
});

test('the generic broadleaf key is the pole oak, the reference size', () => {
  assert.deepEqual(parseBroadleafKey('procedural:broadleaf'), {
    species: 'english-oak',
    age: 'pole',
    condition: 'live',
  });
  assert.ok(Math.abs(broadleafForm('english-oak', { age: 'pole' }).height - 9.9) < 0.1);
});
