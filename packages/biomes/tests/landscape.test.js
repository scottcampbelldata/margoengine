import assert from 'node:assert/strict';
import test from 'node:test';
import { evolveRelief } from '../dist/landscape.js';
import { createRelief } from '../dist/relief.js';

test('a landscape snapshot samples the physical bed and leaves the input relief reusable', async () => {
  const relief = createRelief({ seed: 7, origin: [80, -65], size: [70, 90], relief: 2 });
  const model = await evolveRelief(relief, {
    step: 13,
    uplift: 0.12,
    erodibility: 0,
    hillslopeDiffusivity: 0,
    thermalDiffusivity: 0,
  });
  const { origin, size } = relief.settings;
  const x = origin[0] + size[0] / 2;
  const z = origin[1] + size[1] / 2;
  const before = model.snapshotRelief();
  const beforeHeight = before.height(x, z);
  const beforePhysical = model.terrain.bed.sample(x / 1000, z / 1000).elevation;
  const originalHeight = relief.height(x, z);
  model.world.advance(61);
  const after = model.snapshotRelief();
  const afterPhysical = model.terrain.bed.sample(x / 1000, z / 1000).elevation;
  assert.ok(Math.abs(afterPhysical - beforePhysical - 0.12) < 2e-7); // One f32 ULP at the fixture's elevations.
  assert.equal(after.height(x, z), Math.round(1000 * afterPhysical));
  assert.equal(before.height(x, z), beforeHeight);
  assert.equal(relief.height(x, z), originalHeight);
  assert.equal(after.height(x, origin[1] - 1), relief.height(x, origin[1] - 1));
  assert.equal(after.rivers, relief.rivers);
});
