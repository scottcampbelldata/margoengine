// The /multinoise entry: nearest point or box over user-chosen axes, integer only. Unit tests drive the scorer on
// hand-made grids (ties, boxes, ignored axes, out-of-range inputs, empty and huge lists, validation), world tests pin
// digests and compare main thread, 1 worker and 4 workers byte for byte, and a saved world keeps its classifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BiomeWorld, defineBiome } from '../dist/index.js';
import { loadWorld, saveWorld } from '../dist/io.js';
import { presets } from '../dist/presets.js';
import { multiNoise, multiNoisePresets } from '../dist/multinoise.js';
import { ThreadWebWorker } from './thread-worker.js';
import { cases, makeWorld } from './multinoise-cases.mjs';

const ONE = 65536,
  golden = JSON.parse(readFileSync(new URL('./golden/multinoise.json', import.meta.url), 'utf8'));

const biome = (id, extra = {}) => ({ id, climate: {}, ground: [{ material: 'grass' }], ...extra });
/** Runs a scorer over planes of warped values (one per slot name, stored units: temperature in C x 100). */
const score = (c, biomes, slots, planes, cells) => {
  const member = new Int32Array(biomes.length * cells);
  c.scorer(biomes, (layer) => slots.indexOf(layer))(Int32Array.from(planes.flat()), cells, member);
  return biomes.map((_, b) => [...member.subarray(b * cells, (b + 1) * cells)]);
};
const axis = { field: 'temperature', range: [0, 100] }; // stored x 100: 0..10000
const line = (...points) => multiNoise({ axes: [axis], points: points.map(([b, t]) => ({ biome: b, at: { temperature: t } })), blend: 0 });

test('nearest point wins; midway ties go to the higher priority, then the smaller id', () => {
  const c = line(['a', 20], ['b', 60]);
  // cell values (C x 100): near a, near b, exactly midway (4000).
  const [a, b] = score(c, [biome('a'), biome('b')], ['temperature'], [[1500, 6500, 4000]], 3);
  assert.deepEqual(a, [ONE, 0, ONE], 'a wins the tie by id');
  assert.deepEqual(b, [0, ONE, 0]);
  const [pa, pb] = score(c, [biome('a'), biome('b', { priority: 1 })], ['temperature'], [[4000]], 1);
  assert.deepEqual([pa[0], pb[0]], [0, ONE], 'priority breaks the tie before id');
});

test('boxes have no gap inside, points in the same biome use the nearest, an unlisted axis does not count', () => {
  const two = multiNoise({
    axes: [axis, { field: 'rainfall', range: [0, 1000] }],
    points: [
      { biome: 'a', at: { temperature: [10, 30] } }, // box, any rainfall
      { biome: 'b', at: { temperature: 70, rainfall: 900 } },
      { biome: 'b', at: { temperature: 70, rainfall: 100 } }, // second point of b
    ],
    blend: 0,
  });
  const slots = ['temperature', 'rainfall'],
    cell = (t, r) => score(two, [biome('a'), biome('b')], slots, [[t], [r]], 1).map((m) => m[0]);
  assert.deepEqual(cell(2000, 500), [ONE, 0], 'inside the box and far from b');
  assert.deepEqual(cell(3000, 0), [ONE, 0], 'on the box edge');
  assert.deepEqual(cell(6500, 880), [0, ONE], 'near the first b point');
  assert.deepEqual(cell(6500, 130), [0, ONE], 'near the second b point');
});

test('inputs beyond the axis range count as its edge, in both directions', () => {
  const c = line(['a', 0], ['b', 100]);
  const [a, b] = score(c, [biome('a'), biome('b')], ['temperature'], [[-2_000_000_000, 2_000_000_000, 10000, 0]], 4);
  assert.deepEqual(a, [ONE, 0, 0, ONE]);
  assert.deepEqual(b, [0, ONE, ONE, 0]);
});

test('blend: shares fall smoothly with distance, sum to at least 1 at the nearest, and vanish past the band', () => {
  const c = multiNoise({ axes: [axis], points: [{ biome: 'a', at: { temperature: 40 } }, { biome: 'b', at: { temperature: 60 } }], blend: 0.2 });
  const values = [];
  for (let t = 3000; t <= 7000; t += 100) values.push(t);
  const [a, b] = score(c, [biome('a'), biome('b')], ['temperature'], [values], values.length);
  for (let i = 1; i < values.length; i++) {
    assert.ok(a[i] <= a[i - 1], 'a only falls as the cell moves toward b');
    assert.ok(b[i] >= b[i - 1], 'b only rises');
  }
  assert.equal(a[0], ONE);
  assert.equal(b[0], 0, 'beyond the band, b has no share');
  const mid = values.indexOf(5000);
  assert.equal(a[mid], b[mid], 'equal at the midpoint');
  assert.ok(a[mid] > 0 && a[mid] <= ONE);
  assert.ok(a.some((v) => v > 0 && v < ONE), 'a smooth ramp, not a step');
});

test('weights scale a gap: a heavy axis decides, a light one only breaks near ties', () => {
  const spec = (w) =>
    multiNoise({
      axes: [{ ...axis, weight: w }, { field: 'rainfall', range: [0, 1000] }],
      points: [
        { biome: 'a', at: { temperature: 50, rainfall: 0 } },
        { biome: 'b', at: { temperature: 60, rainfall: 400 } },
      ],
      blend: 0,
    });
  const slots = ['temperature', 'rainfall'],
    cell = (w) => score(spec(w), [biome('a'), biome('b')], slots, [[5400], [250]], 1).map((m) => m[0]);
  assert.deepEqual(cell(1), [0, ONE], 'b is nearer: its rainfall gap (0.15) is smaller than the one for a (0.25) and the temperature gaps are small');
  assert.deepEqual(cell(16), [ONE, 0], 'temperature counts sixteen times, and the temperature gap to a (0.04) is smaller than to b (0.06)');
});

test('a biome with no point never appears; a point naming a biome the world lacks fails', () => {
  const c = line(['a', 50]);
  const [a, spare] = score(c, [biome('a'), biome('spare')], ['temperature'], [[0, 10000]], 2);
  assert.deepEqual(a, [ONE, ONE]);
  assert.deepEqual(spare, [0, 0]);
  assert.throws(() => c.scorer([biome('other')], () => 0), { name: 'RangeError', message: /biome the world does not have/ });
});

test('validation: every bad spec names what is wrong', () => {
  const ok = { axes: [axis], points: [{ biome: 'a', at: { temperature: 10 } }] };
  const bad = (spec, kind, text) => assert.throws(() => multiNoise(spec), { name: kind, message: text });
  bad(undefined, 'TypeError', /takes \{ axes, points/);
  bad({ axes: 1, points: [] }, 'TypeError', /takes \{ axes, points/);
  bad({ ...ok, axes: [] }, 'RangeError', /1 to 8 axes/);
  bad({ ...ok, axes: Array.from({ length: 9 }, (_, i) => ({ field: 'mask/n' + i, range: [0, 1] })) }, 'RangeError', /1 to 8 axes/);
  bad({ ...ok, points: [] }, 'RangeError', /1 to 1,024 points/);
  bad({ ...ok, points: Array.from({ length: 1025 }, () => ok.points[0]) }, 'RangeError', /1 to 1,024 points/);
  bad({ ...ok, blend: -0.1 }, 'RangeError', /blend/);
  bad({ ...ok, blend: 1.5 }, 'RangeError', /blend/);
  bad({ ...ok, blend: 'x' }, 'RangeError', /blend/);
  bad({ ...ok, axes: [null] }, 'TypeError', /axes are \{ field/);
  bad({ ...ok, axes: [{ field: 'temperature', range: [5, 5] }] }, 'RangeError', /min below max/);
  bad({ ...ok, axes: [{ field: 'temperature', range: [0, NaN] }] }, 'RangeError', /min below max/);
  bad({ ...ok, axes: [{ field: 'nonsense', range: [0, 1] }] }, 'RangeError', /Unknown envelope field/);
  bad({ ...ok, axes: [{ ...axis, weight: 0 }] }, 'RangeError', /weight/);
  bad({ ...ok, axes: [{ ...axis, weight: 1.5 }] }, 'RangeError', /weight/);
  bad({ ...ok, axes: [{ ...axis, weight: 17 }] }, 'RangeError', /weight/);
  bad({ ...ok, axes: [axis, axis] }, 'RangeError', /different/);
  bad({ ...ok, points: [null] }, 'TypeError', /points are \{ biome, at \}/);
  bad({ ...ok, points: [{ biome: 'a' }] }, 'TypeError', /points are \{ biome, at \}/);
  bad({ ...ok, points: [{ biome: 'a', at: { rainfall: 5 } }] }, 'RangeError', /not an axis/);
  bad({ ...ok, points: [{ biome: 'a', at: { temperature: 'hot' } }] }, 'RangeError', /number or \[min, max\]/);
  bad({ ...ok, points: [{ biome: 'a', at: { temperature: [30, 10] } }] }, 'RangeError', /number or \[min, max\]/);
  bad({ ...ok, points: [{ biome: 'a', at: { temperature: Infinity } }] }, 'RangeError', /number or \[min, max\]/);
  bad({ ...ok, points: [{ biome: 'a', at: { temperature: -1 } }] }, 'RangeError', /inside the axis range/);
  bad({ ...ok, points: [{ biome: 'a', at: { temperature: [50, 101] } }] }, 'RangeError', /inside the axis range/);
  assert.doesNotThrow(() => multiNoise({ ...ok, blend: 0 }));
  assert.doesNotThrow(() => multiNoise({ ...ok, blend: 1 }));
});

test('the maximum sizes work: 8 axes, 1,024 points, a heavy weight, the full range', () => {
  const fields = ['temperature', 'rainfall', 'moisture', 'height', 'coldest', 'warmest', 'gdd5', 'season'],
    ranges = [[-20, 40], [0, 4000], [0, 1], [-100, 4000], [-30, 30], [-10, 45], [0, 6000], [0, 365]],
    axes = fields.map((field, i) => ({ field, range: ranges[i], weight: 16 })),
    points = Array.from({ length: 1024 }, (_, i) => ({
      biome: i % 2 ? 'a' : 'b',
      at: Object.fromEntries(fields.map((f, a) => [f, ranges[a][0] + ((ranges[a][1] - ranges[a][0]) * ((i * (a + 3)) % 17)) / 17])),
    })),
    c = multiNoise({ axes, points, blend: 1 }),
    cells = 64,
    planes = fields.map((_, a) => Array.from({ length: cells }, (_, k) => ((k * 7919 * (a + 1)) % 20001) - 5000));
  const [a, b] = score(c, [biome('a'), biome('b')], fields, planes, cells);
  for (let k = 0; k < cells; k++) assert.ok(a[k] === ONE || b[k] === ONE, `cell ${k} has a winner at full share`);
  assert.deepEqual(score(c, [biome('a'), biome('b')], fields, planes, cells), [a, b], 'repeatable');
});

test('the spec is copied and frozen: later changes to the caller object do nothing', () => {
  const spec = { axes: [{ ...axis }], points: [{ biome: 'a', at: { temperature: 10 } }] },
    c = multiNoise(spec);
  spec.points[0].biome = 'zzz';
  spec.axes[0].range[1] = 5;
  assert.equal(c.spec.points[0].biome, 'a');
  assert.deepEqual(c.spec.axes[0].range, [0, 100]);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.spec) && Object.isFrozen(c.spec.points[0]));
  assert.ok(Object.isFrozen(multiNoisePresets.climate) && Object.isFrozen(multiNoisePresets.climate.points[0]));
  assert.deepEqual([...c.inputs], ['temperature']);
});

test('presets: every point sits inside its axes and names a preset biome, and both build a world', async () => {
  for (const [name, spec] of Object.entries(multiNoisePresets)) {
    assert.doesNotThrow(() => multiNoise(spec), name);
    for (const p of spec.points) assert.ok(p.biome in presets, `${name}: ${p.biome}`);
  }
});

test('a world classified by multiNoise: each point is the main biome of its own climate, weights sum to 255', async () => {
  const w = await BiomeWorld.create({
    seed: 3,
    size: [512, 512],
    biomes: [
      defineBiome({ id: 'cold', climate: {}, ground: [{ material: 'snow' }] }),
      defineBiome({ id: 'warm', climate: {}, ground: [{ material: 'sand' }] }),
    ],
    height: { field: (x) => ((x + 256) / 512) * 3000 },
    climate: { latitude: 30, coldAir: 0 },
    classifier: multiNoise({
      axes: [{ field: 'height', range: [0, 3000] }],
      points: [
        { biome: 'warm', at: { height: 0 } },
        { biome: 'cold', at: { height: 3000 } },
      ],
      blend: 0.1,
    }),
    workers: false,
  });
  const t = await w.tile(0, 0),
    east = await w.tile(1, 0),
    ids = t.layer('biome').data,
    weights = t.layer('biomeWeight').data,
    at = (i, j) => (j * t.cells + i) * 4;
  assert.equal(w.biomes[ids[at(10, 100)]].id, 'warm');
  assert.equal(w.biomes[east.layer('biome').data[at(east.cells - 10, 100)]].id, 'cold');
  for (let k = 0; k < t.cells * t.cells; k++)
    assert.equal(weights[k * 4] + weights[k * 4 + 1] + weights[k * 4 + 2] + weights[k * 4 + 3], 255);
});

test('a painted mask is an axis: noise you write decides the biome', async () => {
  const w = await BiomeWorld.create({
    seed: 3,
    size: [256, 256],
    tileSize: 256,
    biomes: [
      defineBiome({ id: 'low', climate: {}, ground: [{ material: 'grass' }] }),
      defineBiome({ id: 'high', climate: {}, ground: [{ material: 'rock' }] }),
    ],
    classifier: multiNoise({
      axes: [{ field: 'mask/erosion', range: [0, 1] }],
      points: [
        { biome: 'low', at: { 'mask/erosion': 0 } },
        { biome: 'high', at: { 'mask/erosion': 1 } },
      ],
      blend: 0,
    }),
    workers: false,
  });
  const t0 = await w.tile(0, 0),
    cells = t0.cells,
    mask = new Uint8Array(cells * cells);
  for (let j = 0; j < cells; j++) for (let i = cells >> 1; i < cells; i++) mask[j * cells + i] = 255;
  w.writeLayer('mask/erosion', 0, 0, mask);
  const t1 = await w.tile(0, 0),
    id = (i, j) => w.biomes[t1.layer('biome').data[(j * cells + i) * 4]].id;
  assert.equal(id(10, 50), 'low');
  assert.equal(id(cells - 10, 50), 'high');
});

test('golden digests: five worlds, pinned', async () => {
  for (const [name, c] of Object.entries(cases)) assert.equal(await (await makeWorld(c)).digest(2, 1), golden[name], name);
});

test('1 worker and 4 workers give the main thread bytes', { timeout: 240000 }, async () => {
  const c = cases['climate:1'],
    main = await makeWorld(c);
  for (const n of [1, 4]) {
    const remote = await makeWorld(c, { workers: n, createWorker: () => new ThreadWebWorker() });
    assert.ok(remote.workers, `${n} workers started`);
    for (const [x, z] of [
      [2, 1],
      [0, 0],
      [3, 3],
    ])
      assert.equal(await remote.digest(x, z), await main.digest(x, z), `${n} workers, tile ${x},${z}`);
    remote.dispose();
  }
  main.dispose();
});

test('saveWorld and loadWorld keep the classifier and its spec', async () => {
  const world = await makeWorld(cases['relief-wide:3']),
    saved = JSON.parse(JSON.stringify(saveWorld(world))),
    copy = await loadWorld(saved, { workers: false });
  assert.equal(saved.options.classifier.kind, 'multinoise');
  assert.deepEqual(saved.options.classifier.spec, world.state().classifier.spec);
  assert.equal(await copy.digest(2, 1), golden['relief-wide:3']);
  assert.equal(JSON.stringify(saveWorld(copy)), JSON.stringify(saveWorld(world)));
  await assert.rejects(loadWorld({ ...saved, options: { ...saved.options, classifier: 'nope' } }), RangeError);
});

test('update swaps the classifier both ways', async () => {
  const world = await makeWorld(cases['climate:1']),
    before = await world.digest(2, 1);
  world.update({ classifier: 'envelopes' });
  assert.notEqual(await world.digest(2, 1), before);
  world.update({ classifier: multiNoise(cases['climate:1'].spec) });
  assert.equal(await world.digest(2, 1), before);
  assert.throws(() => world.update({ classifier: { kind: 'multinoise' } }), RangeError);
});

test('the entry is lazy: no static import of the root reaches it', () => {
  const seen = new Set(),
    walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      for (const [, name] of text.matchAll(/^import .*?from "\.\/([^"]+)"/gm)) walk('../dist/' + name);
    };
  walk('../dist/index.js');
  assert.ok(![...seen].some((f) => /multinoise/.test(f)), [...seen].join(' '));
});
