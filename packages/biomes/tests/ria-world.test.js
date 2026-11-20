// riaWorld (@margoengine/biomes/presets): the Sanriku ria fishing bay preset world builds, is open to the sea through
// its mouth, has level town ground near 3.5 m at the head of the bay and forest on the hills.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeWorld } from '../dist/index.js';
import { presets, riaWorld } from '../dist/presets.js';

const size = 4096,
  origin = [-2048, -2048];
const world = () =>
  BiomeWorld.create({ seed: 2011, origin, size: [size, size], biomes: riaWorld.biomes, climate: riaWorld.climate, height: { relief: riaWorld.relief } });

test('ria world: a bay open to the sea in the east, level town ground at its head, steep hills on both sides', async () => {
  assert.equal(riaWorld.relief.coast, 'east');
  assert.deepEqual(riaWorld.biomes, [presets.temperate]);
  assert.ok(Object.isFrozen(riaWorld) && Object.isFrozen(riaWorld.relief.ria), 'the preset is frozen');
  const w = await world();
  // The bay's axis runs along z = 0 from the coast edge (x = 2048) to its head 2.4 km in (x = -352).
  for (let x = -200; x <= 2000; x += 100) assert.ok(w.heightAt(x, 0) < 0, `water on the axis at x ${x}: ${w.heightAt(x, 0)}`);
  assert.ok(w.heightAt(2000, 0) < -20, `deep at the mouth: ${w.heightAt(2000, 0)}`);
  // Level ground for the town: most of the head's land within 300 m is 2.5 to 5 m up.
  let land = 0,
    level = 0;
  for (let z = -300; z <= 300; z += 20)
    for (let x = -700; x <= -380; x += 20) {
      const h = w.heightAt(x, z);
      if (h > 0) land++;
      if (h >= 2.5 && h <= 5) level++;
    }
  assert.ok(land > 200 && level / land > 0.6, `${level} of ${land} land points level`);
  // Steep hills both sides of the bay half way out.
  assert.ok(w.heightAt(800, -700) > 150 && w.heightAt(800, 700) > 150, `hills: ${w.heightAt(800, -700)}, ${w.heightAt(800, 700)}`);
  assert.equal(await w.digest(2, 1), await (await world()).digest(2, 1), 'the same settings give the same world');
  assert.equal(w.sampleRegion(-600, -900).biomes[0], 'temperate');
});
