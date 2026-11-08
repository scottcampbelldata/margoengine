// @margoengine/voxel/light-rgb: each channel floods exactly like VoxelLighting's block light with that channel's levels
// (checked cell for cell against VoxelLighting runs with the emitters' levels set per channel), colours mix where lights
// overlap, edits and recolouring flood again, and the options are checked. The GPU side: light-rgb-browser-check.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BlockTypes, VoxelWorld } from '../dist/index.js';
import { VoxelLighting } from '../dist/light.js';
import { VoxelColorLight } from '../dist/light-rgb.js';

const engine = { camera: { position: [0, 0, 0] } }; // no GPU: update() floods and skips the volume
const build = (lights) => {
  const blocks = new BlockTypes();
  blocks.define('stone');
  blocks.define('torch', { shape: 'cross', layer: 'cutout', solid: false, light: lights[0] });
  blocks.define('lamp', { light: lights[1] });
  blocks.define('glass', { layer: 'translucent', opacity: 2 });
  const world = new VoxelWorld({ blocks }),
    edits = [];
  for (let cz = 0; cz < 2; cz++)
    for (let cx = 0; cx < 2; cx++) for (let cy = 0; cy < 2; cy++) world.addChunk(cx, cy, cz);
  // A closed stone box 0..63 with pillars and a glass wall, a torch and a lamp inside.
  for (let z = 0; z < 64; z++)
    for (let x = 0; x < 64; x++)
      for (let y = 0; y < 64; y++) {
        const wall = x === 0 || z === 0 || y === 0 || x === 63 || z === 63 || y === 63,
          pillar = x % 9 === 4 && z % 7 === 3 && y < 40;
        if (wall || pillar) edits.push(x, y, z, 1);
        else if (x === 30 && y < 50) edits.push(x, y, z, 4);
      }
  edits.push(12, 10, 12, 2, 22, 10, 14, 3);
  world.setBlocks(edits);
  return world;
};

test('each channel equals VoxelLighting block light with that channel of each emitter; colours mix', () => {
  const world = build([14, 15]),
    rgb = VoxelColorLight.attach(engine, {
      world,
      colors: { torch: [1, 0.5, 0], lamp: [0, 0.4, 1] },
      budget: Infinity,
    });
  rgb.update();
  const per = [
    [14, 15 * 0],
    [7, 6],
    [0, 15],
  ].map((levels) => {
    const ref = build(levels),
      lighting = VoxelLighting.attach(ref, { budget: Infinity });
    lighting.update();
    return lighting;
  });
  for (let i = 0; i < 20000; i++) {
    const x = 1 + ((i * 7919) % 62),
      y = 1 + ((i * 104729) % 62),
      z = 1 + ((i * 1299709) % 62),
      got = rgb.levels(x, y, z);
    for (let c = 0; c < 3; c++) assert.equal(got[c], per[c].blockLight(x, y, z), `channel ${c} at ${x},${y},${z}`);
  }
  const torch = rgb.levels(12, 11, 12),
    lamp = rgb.levels(22, 11, 14);
  assert.ok(torch[0] === 13 && torch[1] === 6 && torch[2] < 6, `over the torch: ${torch}`); // orange, a little blue
  assert.ok(lamp[2] === 14 && lamp[1] === 5 && lamp[0] < 5, `over the lamp: ${lamp}`);
  const between = rgb.levels(17, 11, 13);
  assert.ok(between[0] > 0 && between[2] > 0, `red and blue mix between them: ${between}`);
  // An edit floods again: the torch taken away leaves no red.
  world.setBlock(12, 10, 12, 0);
  rgb.update();
  assert.equal(rgb.levels(12, 11, 12)[0], 0);
  // Recoloured: the lamp turns red.
  rgb.setColor('lamp', [1, 0, 0]);
  rgb.update();
  assert.deepEqual(rgb.levels(22, 11, 14), [14, 0, 0]);
  assert.equal(rgb.pbr(1), undefined); // no GPU volume yet
  rgb.dispose();
  assert.throws(() => rgb.update(), { code: 'disposed' });
});

test('options are checked', () => {
  const world = build([14, 15]);
  assert.throws(() => VoxelColorLight.attach(engine, { world: {} }), TypeError);
  assert.throws(() => VoxelColorLight.attach(engine, { world, colors: { torch: [2, 0, 0] } }), RangeError);
  assert.throws(() => VoxelColorLight.attach(engine, { world, extent: [100, 64, 128] }), RangeError);
  const rgb = VoxelColorLight.attach(engine, { world });
  assert.throws(() => rgb.setColor('nope', [1, 1, 1]), RangeError);
  rgb.dispose();
});
