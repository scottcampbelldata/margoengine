import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BiomeWorld } from '../dist/index.js';
import { BiomePlacement } from '../dist/placement.js';
import { presets, presetWorlds } from '../dist/presets.js';
import { hydrology, hydrologyOf } from '../dist/hydrology.js';
import { canonicalBytes, sha256 } from '../dist/digest.js';
import {
  disturbance,
  disturbanceOf,
  disturbanceTile,
  successionStage,
  encodeDisturbance,
  decodeDisturbance,
  DISTURBANCE_LAYERS,
} from '../dist/disturbance.js';
import * as entry from '@margoengine/biomes/disturbance';

const grid = (nx = 24, nz = nx, step = 1000) => ({ nx, nz, step, height: new Int32Array(nx * nz) });
const authored = (ignitions, extra = {}) => ({
  years: 1,
  flood: false,
  fire: { ignitions, ignitionsPerYear: 0, moisture: 0, duration: 1000, ...extra },
});
const packageDir = fileURLToPath(new URL('../', import.meta.url));

test('same seed and inputs give the same bytes, another seed changes burns; all inputs stay intact', () => {
  const g = grid(48),
    fuel = new Uint8Array(48 * 48).fill(255),
    water = new Uint8Array(fuel.length),
    rock = water.slice();
  const h = hydrology(g),
    options = { seed: 7, years: 2, fuel, water, rock, flood: false, fire: { duration: 3, moisture: 0 } };
  const before = structuredClone({ g, h, options });
  const a = disturbance(g, h, options),
    b = disturbance(g, h, options),
    other = disturbance(g, h, { ...options, seed: 19 });
  assert.deepEqual(encodeDisturbance(a), encodeDisturbance(b));
  assert.notDeepEqual(a.age, other.age, 'different ignition locations, not just the encoded seed');
  assert.deepEqual({ g, h, options }, before);
  a.height[0] = 500;
  assert.equal(g.height[0], 0);
  assert.ok(Object.isFrozen(DISTURBANCE_LAYERS) && Object.isFrozen(DISTURBANCE_LAYERS.age));
});

test('tile bytes do not depend on raster, reverse or shuffled request order', async () => {
  const w = await BiomeWorld.create({ size: [512, 512], tileSize: 128, resolution: 4, height: { relief: {} } });
  const d = disturbanceOf(w, hydrologyOf(w), { seed: 7, years: 3 });
  const orders = [
    Array.from({ length: 16 }, (_, i) => i),
    Array.from({ length: 16 }, (_, i) => 15 - i),
    [5, 11, 0, 9, 2, 14, 7, 3, 15, 1, 6, 13, 8, 4, 12, 10],
  ];
  const maps = [];
  for (const order of orders) {
    const map = {};
    for (const i of order) map[i] = await sha256(canonicalBytes(disturbanceTile(w, d, i % 4, Math.floor(i / 4))));
    maps.push(map);
  }
  assert.deepEqual(maps[0], maps[1]);
  assert.deepEqual(maps[0], maps[2]);
  assert.throws(() => disturbanceTile(w, d, -1, 0), /tile indices inside the world/);
  assert.throws(() => disturbanceTile(w, d, 4, 0), RangeError);
  assert.throws(() => disturbanceTile(w, d, 0.5, 0), RangeError);
});

test('water and rock lines block cardinal, diagonal and knight spread in every direction', () => {
  for (const kind of ['water', 'rock'])
    for (const diagonal of [false, true])
      for (const flip of [false, true])
        for (const sign of [-1, 1]) {
          const g = grid(),
            mask = new Uint8Array(g.height.length);
          const side = (x, z) => sign * (diagonal ? (flip ? x + z - 23 : x - z) : flip ? z - 12 : x - 12);
          for (let z = 0; z < g.nz; z++)
            for (let x = 0; x < g.nx; x++) {
              const i = z * g.nx + x;
              mask[i] = side(x, z) === 0 ? 1 : 0;
              g.height[i] = Math.max(0, side(x, z)) * 5000;
            }
          const start = Array.from(mask.keys()).find((i) => side(i % g.nx, Math.floor(i / g.nx)) === -1);
          const d = disturbance(g, undefined, {
            ...authored([start], { wind: { speed: 80, direction: (flip ? 90 : 0) + (sign === -1 ? 180 : 0) } }),
            [kind]: mask,
          });
          assert.equal(d.age[start], 0);
          assert.ok(d.age.some((a, i) => a === 0 && i !== start));
          for (let i = 0; i < mask.length; i++)
            if (side(i % g.nx, Math.floor(i / g.nx)) >= 0)
              assert.equal(d.age[i], 65535, `${kind}, diagonal=${diagonal}, flip=${flip}, cell=${i}`);
        }
});

test('hydrology sea, zero fuel and extinction moisture also block fire', () => {
  const g = grid();
  for (let z = 0; z < g.nz; z++) g.height[z * g.nx + 12] = -2000;
  const h = hydrology(g, { sea: 0, channelCells: 10000 });
  const d = disturbance(g, h, authored([11 * 24 + 11]));
  assert.equal(d.age[11 * 24 + 11], 0);
  for (let z = 0; z < g.nz; z++) for (let x = 12; x < g.nx; x++) assert.equal(d.age[z * 24 + x], 65535);
  const zero = disturbance(grid(), undefined, { ...authored([0]), fuel: new Uint8Array(576) });
  assert.ok(zero.age.every((v) => v === 65535));
  const wet = disturbance(grid(), undefined, authored([0], { moisture: 1 }));
  assert.ok(wet.age.every((v) => v === 65535));
});

test('travel times, destination fuel, wind, slope, moisture and recovery affect burns', () => {
  const g = grid(4, 2),
    fuel = new Uint8Array(8).fill(255);
  assert.equal(
    disturbance(g, undefined, { ...authored([0], { duration: 0 }), fuel }).age.filter((v) => v === 0).length,
    1,
  );
  const dry = disturbance(g, undefined, { ...authored([0], { duration: 1 }), fuel });
  assert.equal(dry.age[1], 0);
  assert.equal(dry.age[2], 65535);
  const moist = disturbance(g, undefined, { ...authored([0], { duration: 1, moisture: 0.8 }), fuel });
  assert.equal(moist.age[1], 65535);
  const windy = disturbance(g, undefined, {
    ...authored([0], { duration: 1, wind: { speed: 10, direction: 0 } }),
    fuel,
  });
  assert.equal(windy.age[6], 0, 'a knight move reaches (2,1) in one windy minute');
  const hill = { ...g, height: Int32Array.from(g.height, (_, i) => (i % 4) * 1000) };
  assert.equal(disturbance(hill, undefined, { ...authored([0], { duration: 1 }), fuel }).age[6], 0);
  const history = disturbance(g, undefined, {
    years: 4,
    fuel,
    flood: false,
    fire: { moisture: 0, recovery: 5, ignitions: [0], ignitionsPerYear: 8 },
  });
  assert.ok(history.age.every((v) => v === 3));
});

test('succession is monotone through all u16 ages with default and custom stages and every cap', () => {
  for (const stages of [undefined, [2, 7, 101, 60000]])
    for (let cap = 0; cap <= 255; cap++) {
      let previous = -1;
      for (let age = 0; age <= 65535; age++) {
        const stage = successionStage(age, cap, stages);
        assert.ok(stage >= previous && stage <= cap);
        previous = stage;
      }
    }
  for (const stages of [
    [1, 1],
    [5, 2],
  ])
    assert.throws(() => successionStage(20, 4, stages), RangeError);
  const g = grid();
  const a = disturbance(g, undefined, { years: 4, fire: false }),
    b = disturbance(g, undefined, { years: 5, fire: false });
  assert.ok(b.stage.every((v, i) => v >= a.stage[i]));
});

function drainageFixture() {
  const g = grid(6, 2, 10000),
    h = hydrology(g);
  h.direction.fill(0);
  h.channel.fill(0);
  h.water.fill(100);
  h.direction[5] = -1;
  h.direction[11] = -1;
  h.channel[5] = 1;
  h.channel[11] = 1;
  h.flow.fill(100);
  h.water[5] = 0;
  h.water[11] = 0;
  h.hand.set([0, 200, 400, 800, 2000, 0, 0, 200, 400, 800, 2000, 0]);
  return { g, h };
}

test('flood follows drainage, orders HAND, scales with flow and caps wetland succession', () => {
  const { g, h } = drainageFixture();
  const d = disturbance(g, h, { fire: false });
  assert.equal(d.flood[5], 1);
  assert.equal(d.flood[11], 1);
  assert.equal(d.flood[0], 2);
  assert.ok(d.flood.some((v) => v === 10 || v === 100));
  for (let i = 1; i < 5; i++) assert.ok((d.flood[i] || Infinity) >= (d.flood[i - 1] || Infinity));
  assert.ok(d.stage.every((v, i) => !d.flood[i] || d.flood[i] > 2 || v <= 1));
  const larger = structuredClone(h);
  larger.flow.fill(1000);
  const large = disturbance(g, larger, { fire: false });
  assert.ok(large.flood.every((v, i) => (v || Infinity) <= (d.flood[i] || Infinity)));
  const custom = disturbance(g, h, { fire: false, flood: { returnPeriods: [2, 3, 9, 10, 11, 99, 100, 101, 65535] } });
  assert.ok(custom.flood.every((v, i) => (v || Infinity) <= (d.flood[i] || Infinity)));
  assert.deepEqual(disturbance(g, h, { fire: false, seed: 99 }).flood, d.flood);
  const noHydrology = disturbance(g, undefined, { water: new Uint8Array(12).fill(1), fire: false });
  assert.ok(noHydrology.flood.every((v) => v === 0));
});

test('flood applies frequency factors before rounding or saturating depth', () => {
  const { g, h } = drainageFixture();
  // Submillimetre base depths can exceed a whole millimetre at a long return period.
  g.step = h.step = 10;
  h.flow.fill(1);
  h.hand.fill(1);
  assert.equal(disturbance(g, h, { fire: false }).flood[0], 100);
  // Saturating the base first would reduce the two-year stage below this HAND.
  g.step = h.step = 2000000000;
  h.flow.fill(2000000000);
  h.hand.fill(2000000000);
  assert.equal(disturbance(g, h, { fire: false }).flood[0], 2);
});

test('off mode gives mature no-op layers and preserves existing field and placement goldens', {
  timeout: 120000,
}, async () => {
  const fields = JSON.parse(readFileSync(new URL('./golden/fields.json', import.meta.url), 'utf8'));
  const placed = JSON.parse(readFileSync(new URL('./golden/placement.json', import.meta.url), 'utf8'));
  const plain = await BiomeWorld.create();
  const off = disturbanceOf(plain, undefined, { fire: false, flood: false });
  assert.ok(off.age.every((v) => v === 65535));
  assert.ok(off.flood.every((v) => v === 0));
  assert.ok(off.stage.every((v) => v === 4));
  disturbanceTile(plain, off, 8, 8);
  disturbanceOf(plain, undefined, { seed: 1, years: 1 });
  assert.equal(await plain.digest(8, 8), fields.default88);
  assert.equal(await plain.digest(0, 15), fields.default015);
  for (const seed of [1, 0xffffffff]) {
    const world = await BiomeWorld.create({
      seed,
      size: [512, 512],
      biomes: Object.values(presets).filter((b) => b.id !== 'beach'),
      climate: presetWorlds.temperate.climate,
      height: { relief: presetWorlds.temperate.relief },
    });
    disturbanceTile(world, disturbanceOf(world, undefined, { years: 2 }), 1, 0);
    assert.equal(await BiomePlacement.attach(world).digest(1, 0), placed[`temperate-${seed}`]);
  }
});

test('MGDS little-endian format round trips exactly, including an unaligned byte view', () => {
  const g = grid(4, 3);
  g.height[0] = -123456;
  const d = disturbance(g, undefined, { ...authored([5]), seed: 0xffffffff });
  const bytes = encodeDisturbance(d),
    view = new DataView(bytes.buffer);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'MGDS');
  assert.equal(view.getUint32(4, true), 1);
  assert.equal(view.getUint32(8, true), 4);
  assert.equal(view.getInt32(28, true), -123456);
  assert.deepEqual(decodeDisturbance(bytes), d);
  assert.deepEqual(encodeDisturbance(decodeDisturbance(bytes)), bytes);
  const offset = new Uint8Array(bytes.length + 3);
  offset.set(bytes, 1);
  assert.deepEqual(decodeDisturbance(offset.subarray(1, -2)), d);
  for (const i of [0, 4]) {
    const bad = bytes.slice();
    bad[i] = 9;
    assert.throws(() => decodeDisturbance(bad), RangeError);
  }
  for (const length of [0, 4, 27, bytes.length - 1])
    assert.throws(() => decodeDisturbance(bytes.subarray(0, length)), RangeError);
  assert.throws(() => decodeDisturbance(new Uint8Array(bytes.length + 1)), RangeError);
});

test('invalid inputs name the required replacement and reject cyclic drainage', () => {
  const g = grid();
  const cases = [
    [{ fuel: [] }, TypeError, /Uint8Array/],
    [{ fuel: new Uint8Array(1) }, TypeError, /nx x nz/],
    [{ water: new Uint8Array(576).fill(2) }, RangeError, /0 or 1/],
    [{ seed: -1 }, RangeError, /seed must/],
    [{ years: 0 }, RangeError, /years must/],
    [{ fuel: null }, TypeError, /documented type/],
    [{ seed: null }, TypeError, /documented type/],
    [{ fire: true }, TypeError, /options object/],
    [{ fire: { wind: null } }, TypeError, /wind must/],
    [{ fire: { moisture: 2 } }, RangeError, /moisture must/],
    [{ fire: { duration: -1 } }, RangeError, /duration/],
    [{ fire: { ignitions: [576] } }, RangeError, /cell index/],
    [{ fire: { wind: { speed: 101 } } }, RangeError, /speed/],
    [{ fire: { wind: { direction: NaN } } }, RangeError, /finite degrees/],
    [{ flood: { returnPeriods: [10, 2] } }, RangeError, /strictly increasing/],
    [{ succession: { stages: [1, 1] } }, RangeError, /strictly increasing/],
  ];
  for (const [options, Class, message] of cases)
    assert.throws(
      () => disturbance(g, undefined, options),
      (e) => e instanceof Class && message.test(e.message),
    );
  assert.throws(() => disturbance(null, undefined), TypeError);
  assert.throws(() => disturbance({ ...g, step: 0 }, undefined), /step.*must/);
  assert.throws(() => disturbance(g, undefined, null), TypeError);
  const d = disturbance(g, undefined, { fire: false, flood: false });
  assert.throws(() => encodeDisturbance({ ...d, age: [] }), /age u16/);
  const { g: small, h } = drainageFixture();
  h.direction[0] = 0;
  h.direction[1] = 4;
  assert.throws(() => disturbance(small, h, { fire: false }), /without cycles.*rerun hydrology/);
  h.direction[0] = 4;
  assert.throws(() => disturbance(small, h, { fire: false }), /stay inside.*rerun hydrology/);
});

test('entry import in a fresh process adds no globals', () => {
  const script = `const before = Reflect.ownKeys(globalThis); await import('./dist/disturbance.js');
    const after = Reflect.ownKeys(globalThis); if (after.some(k => !before.includes(k))) process.exit(1);`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: packageDir, timeout: 10000 });
});

test('entry is isolated and emits its public types', () => {
  assert.equal(entry.disturbance, disturbance);
  assert.ok(existsSync(new URL('../dist/disturbance.d.ts', import.meta.url)));
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(!/disturbance/.test(file));
    assert.ok(!/\b(?:disturbanceOf|encodeDisturbance|MGDS)\b/.test(text));
    for (const [, name] of text.matchAll(/(?:import|export)\s[^;]*?from\s*["'](\.\/[^"']+)["']/g))
      walk('../dist/' + name.slice(2));
  };
  walk('../dist/index.js');
  const source = readFileSync(new URL('../src/disturbance.ts', import.meta.url), 'utf8');
  assert.match(source, /import type \{ HeightGrid, Hydrology \} from '.\/hydrology.js'/);
});

test('README disturbance example runs verbatim with literal public imports', { timeout: 30000 }, () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const section = readme.split('## Disturbance\n')[1]?.split('\n## ')[0];
  assert.ok(section);
  const example = /```ts\n([\s\S]*?)```/.exec(section)[1];
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', example], {
    cwd: packageDir,
    encoding: 'utf8',
    timeout: 25000,
  });
  assert.match(output, /age.*flood.*stage/);
  assert.ok(!/[\u2013\u2014]/.test(section));
});
