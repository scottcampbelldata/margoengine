// Writes test/fixtures/alpine-crest.bin and alpine-crest.json for test/crest.browser.mjs: the heights of the biomes
// package's alpine preset world on its 2 m view grid over the crests that biome shot 05 looks at (a camera 1,400 m
// from the highest point, 150 m over the ground, looking at it). The terrain package does not depend on biomes, so
// the heights are sampled once here and kept as a Margo-made fixture: unsigned 16-bit little-endian, rows of
// increasing z, height = offset + value * scale. The camera is stored beside them. Build the packages first, then
// `node packages/terrain/scripts/make-crest-fixture.mjs` rewrites both files.
import { writeFileSync } from 'node:fs';
import { BiomeWorld } from '../../biomes/dist/index.js';
import { presets, presetWorlds } from '../../biomes/dist/presets.js';

const STEP = 2,
  ORIGIN = [-1800, -1600],
  COUNT = [426, 201],
  world = await BiomeWorld.create({
    biomes: [presets.alpine],
    climate: presetWorlds.alpine.climate,
    height: { relief: presetWorlds.alpine.relief },
  }),
  ground = (x, z) => world.sample(x, z).height;
// Biome shot 05: the highest point on a 64 m grid, seen from 1,400 m toward the world's centre.
let peak = [0, 0, -Infinity];
for (let z = -2000; z <= 2000; z += 64)
  for (let x = -2000; x <= 2000; x += 64) {
    const h = ground(x, z);
    if (h > peak[2]) peak = [x, z, h];
  }
const [hx, hz, hh] = peak,
  length = Math.hypot(hx, hz) || 1,
  px = hx - (hx / length) * 1400,
  pz = hz - (hz / length) * 1400,
  camera = { position: [px, ground(px, pz) + 150, pz], target: [hx, hh - 60, hz] },
  [n, m] = COUNT,
  heights = new Float64Array(n * m);
for (let j = 0; j < m; j++)
  for (let i = 0; i < n; i++) heights[j * n + i] = ground(ORIGIN[0] + i * STEP, ORIGIN[1] + j * STEP);
world.dispose();
let low = Infinity,
  high = -Infinity;
for (const h of heights) {
  low = Math.min(low, h);
  high = Math.max(high, h);
}
const offset = Math.floor(low),
  scale = (Math.ceil(high) - offset) / 65535, // float division: quantisation step, about 1.5 cm
  data = new Uint16Array(n * m);
for (let k = 0; k < data.length; k++) data[k] = Math.round((heights[k] - offset) / scale); // float division
const dir = new URL('../test/fixtures/', import.meta.url);
writeFileSync(new URL('alpine-crest.bin', dir), new Uint8Array(data.buffer));
writeFileSync(
  new URL('alpine-crest.json', dir),
  `${JSON.stringify({ source: 'make-crest-fixture.mjs: @margoengine/biomes alpine preset world', origin: ORIGIN, count: COUNT, step: STEP, offset, scale, camera }, null, 1)}\n`,
);
console.log(`alpine-crest: ${n} x ${m} heights ${offset}..${Math.ceil(high)} m, camera ${JSON.stringify(camera)}`);
