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
  // strength scales the light in the shader: a value that is not a finite number >= 0 would colour every lit pixel NaN.
  for (const strength of [NaN, -1, Infinity, '2'])
    assert.throws(() => VoxelColorLight.attach(engine, { world, strength }), RangeError, `strength ${strength}`);
  const live = VoxelColorLight.attach(engine, { world, strength: 0 });
  live.strength = NaN;
  assert.throws(() => live.update(), RangeError);
  live.strength = 2;
  live.update();
  live.dispose();
});

// A recording device: the window uniform's bytes and every texture write.
Object.assign(globalThis, {
  GPUTextureUsage: { TEXTURE_BINDING: 4, COPY_DST: 2 },
  GPUBufferUsage: { UNIFORM: 64, COPY_DST: 8 },
});
function gpuEngine(position) {
  const device = {
    buffers: [],
    writes: [],
    createBuffer({ size }) {
      const b = { size, data: new ArrayBuffer(size), destroy() {} };
      device.buffers.push(b);
      return b;
    },
    createTexture: (d) => ({ ...d, createView: () => ({}), destroy() {} }),
    createSampler: (d) => ({ ...d }),
    queue: {
      writeBuffer: (b, offset, data) =>
        new Uint8Array(b.data, offset, data.byteLength).set(
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        ),
      writeTexture: ({ origin }, data) => device.writes.push({ origin: [...origin], data: data.slice() }),
    },
  };
  return { device, engine: { gpu: device, camera: { position } } };
}
// A stone room with a red torch, in the 4 x 2 x 4 chunks from chunk (cx, cy, cz).
function room(cx, cy, cz) {
  const blocks = new BlockTypes();
  blocks.define('stone');
  blocks.define('torch', { shape: 'cross', layer: 'cutout', solid: false, light: 14 });
  const world = new VoxelWorld({ blocks }),
    edits = [];
  for (let z = 0; z < 4; z++)
    for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) world.addChunk(cx + x, cy + y, cz + z);
  const [x0, y0, z0] = [cx * 32, cy * 32, cz * 32];
  for (let z = 0; z < 128; z++) for (let x = 0; x < 128; x++) edits.push(x0 + x, y0 + 1, z0 + z, 1);
  edits.push(x0 + 40, y0 + 2, z0 + 50, 2);
  world.setBlocks(edits);
  return world;
}
const lit = (world, eye, origin) => {
  const { device, engine } = gpuEngine(eye),
    rgb = VoxelColorLight.attach(engine, { world, colors: { torch: [1, 0.25, 0] } });
  rgb.add({ origin, addLighting: () => () => {} });
  while (rgb.update() > 0);
  const window = new Float32Array(device.buffers[0].data),
    // Each write as its texel origin, lit texel count and an FNV-1a hash of its bytes.
    writes = device.writes
      .map((w) => {
        let h = 2166136261,
          n = 0;
        for (const b of w.data) (h = Math.imul(h ^ b, 16777619) >>> 0), (n += +(b !== 0));
        return `${w.origin}:${n}:${h}`;
      })
      .sort();
  rgb.dispose();
  return { window, writes };
};

test('origin: a world 2^24 blocks out, under its renderer origin, uploads the same volume and window as near zero', () => {
  const S = 2 ** 24,
    near = lit(room(0, 0, 0), [60, 10, 64], null),
    far = lit(room(S / 32, 64, -S / 32), [60, 10, 64], { origin: [S, 2048, -S] });
  assert.ok(
    near.writes.some((w) => w.split(':')[1] !== '0'),
    'the torch lights the volume',
  );
  assert.deepEqual(far.writes, near.writes);
  assert.deepEqual([...far.window], [...near.window]);
  assert.deepEqual([...near.window], [-32, -32, 0, 1, 0, 0, 0, 0]);
});

test('origin: a fractional origin far out writes the corner in engine cells and the origin mod the volume size', () => {
  const S = 2 ** 24,
    origin = [S + 70.5, 2048 + 3.25, -S - 9.75],
    eye = [-10, 7, 64],
    { window } = lit(room(S / 32, 64, -S / 32), eye, { origin });
  [128, 64, 128].forEach((size, a) => {
    const corner = (Math.floor((eye[a] + origin[a]) / 32) - (size >> 6)) * 32;
    assert.equal(window[a], Math.fround(corner - origin[a]));
    assert.ok(Math.abs(window[a]) < size);
    assert.equal(window[4 + a], Math.fround(((origin[a] % size) + size) % size));
  });
  assert.throws(() => lit(room(0, 0, 0), eye, { origin: [0, Number.POSITIVE_INFINITY, 0] }), RangeError);
});
