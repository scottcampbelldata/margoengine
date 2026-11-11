// The ecotone warp works in exact integers (cell index x cell mm x 65536) and shifts cell indices as 32-bit numbers.
// Far from the origin those products passed 2^53 - 1 and the shifts wrapped, so classification came out silently
// wrong; such a grid is now refused with a RangeError before any work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeWorld } from '../dist/index.js';
import { presets, presetWorlds } from '../dist/presets.js';

const world = () => {
  const [pw] = Object.values(presetWorlds);
  return BiomeWorld.create({
    seed: 3,
    size: [1024, 1024],
    biomes: Object.values(presets).filter((b) => b.id !== 'beach'),
    climate: pw.climate,
    height: { relief: pw.relief },
  });
};
const refused = (error) => error instanceof RangeError && /exact/.test(error.message);

test('a point query past the warp exact range throws, and one inside it answers', async () => {
  const w = await world();
  // 2^53 / 65536 mm = 137,438,953 m from the origin is the edge; resolution 1 m cells.
  for (const x of [2e8, -2e8, 2 ** 40])
    for (const [a, b] of [
      [x, 0],
      [0, x],
    ])
      assert.throws(() => w.sampleRegion(a, b), refused, `sampleRegion(${a}, ${b})`);
  const near = w.sampleRegion(1e8, -1e8);
  assert.ok(Number.isFinite(near.temperature) && near.biomes.length > 0);
  w.dispose?.();
});
