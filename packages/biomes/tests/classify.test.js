// B2: classification and presets. Weights sum to exactly 255; Whittaker classes away from borders; blends only inside
// blend widths (plus the documented ecotone warp); the nearest-envelope fallback; paint and mask composition;
// Holdridge zones; Koppen labels of known climates; presets; golden digests of every preset world at three seeds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BiomeWorld, WHITTAKER, defineBiome, holdridgeZone, whittakerClass } from '../dist/index.js';
import { presets, presetWorlds } from '../dist/presets.js';
import { KOPPEN, koppen, koppenClass } from '../dist/koppen.js';
import { random } from './random.js';

const golden = JSON.parse(readFileSync(new URL('./golden/presets.json', import.meta.url), 'utf8'));
const ALL = Object.values(presets);
const at = (tile, name, i, j) => {
  const l = tile.layer(name);
  return l.data[j * l.width + i] * l.scale;
};
const top = (tile, i, j) => {
  const k = (j * tile.cells + i) * 4;
  return [tile.layer('biome').data[k], tile.layer('biomeWeight').data[k]];
};

test('every cell stores 4 ids and 4 weights summing to exactly 255, strongest first, unused slots 255 / 0', async () => {
  for (const [id, pw] of Object.entries(presetWorlds).slice(0, 4)) {
    const w = await BiomeWorld.create({
        seed: 3,
        size: [1024, 1024],
        biomes: ALL,
        climate: pw.climate,
        height: { relief: pw.relief },
      }),
      t = await w.tile(1, 2),
      ids = t.layer('biome').data,
      weights = t.layer('biomeWeight').data;
    assert.equal(ids.length, 256 * 256 * 4);
    for (let k = 0; k < ids.length; k += 4) {
      const sum = weights[k] + weights[k + 1] + weights[k + 2] + weights[k + 3];
      assert.equal(sum, 255, `${id} cell ${k / 4}`);
      for (let s = 0; s < 4; s++) {
        if (s && weights[k + s] > weights[k + s - 1]) assert.fail(`${id}: slots out of order at ${k / 4}`);
        if (weights[k + s] === 0) assert.equal(ids[k + s], 255);
        else assert.ok(ids[k + s] < ALL.length);
      }
    }
  }
});

test('Whittaker: every (T, P) grid cell maps to its class away from the borders', () => {
  for (const [name, e] of Object.entries(WHITTAKER)) {
    const [t0, t1] = e.temperature,
      [p0, p1] = e.rainfall,
      lo = (v, fallback) => (v === null ? fallback : v);
    // Points at least a blend band inside the rectangle.
    const ts = [lo(t0, lo(t1, 0) - 20) + 1.5, lo(t1, lo(t0, 0) + 20) - 1.5],
      ps = [lo(p0, 0) + 120, lo(p1, lo(p0, 0) + 2000) - 120];
    for (const t of ts) for (const p of ps) if (p > 0) assert.equal(whittakerClass(t, p), name, `${t} C, ${p} mm`);
  }
  assert.equal(whittakerClass(27, 3500), 'tropical-rainforest');
  assert.equal(whittakerClass(25, 150), 'subtropical-desert');
  assert.equal(whittakerClass(-12, 300), 'tundra');
  assert.equal(whittakerClass(10, 1400), 'temperate-seasonal-forest');
});

/** A world whose mean temperature falls along x: a plane 0 m at x = -1,024 to 3,000 m at x = 1,024. */
const slopeWorld = (biomes, extra = {}) =>
  BiomeWorld.create({
    size: [2048, 512],
    biomes,
    height: { field: (x) => ((x + 1024) / 2048) * 3000 },
    climate: { latitude: 30, coldAir: 0 },
    ...extra,
  });

test('blends happen only inside the blend band (plus the documented +-1.6 K ecotone warp)', async () => {
  const warm = defineBiome({ id: 'warm', climate: { temperature: [12, null] }, ground: [{ material: 'grass' }] }),
    cold = defineBiome({ id: 'cold', climate: { temperature: [null, 12] }, ground: [{ material: 'rock' }] }),
    w = await slopeWorld([warm, cold]);
  let mixed = 0,
    pure = 0;
  for (let tx = 0; tx < 8; tx++) {
    const t = await w.tile(tx, 0);
    for (let i = 0; i < 256; i += 3) {
      const temperature = at(t, 'temperature', i, 100),
        [id, weight] = top(t, i, 100);
      // Open bands blend over 1.5 K centred on the bound; the warp moves it by up to 1.6 K.
      if (Math.abs(temperature - 12) > 0.75 + 1.6 + 0.05) {
        assert.equal(weight, 255, `pure at ${temperature} C`);
        assert.equal(id, temperature > 12 ? 0 : 1);
        pure++;
      } else if (weight < 255) mixed++;
    }
  }
  assert.ok(pure > 300 && mixed > 5, `pure ${pure}, mixed ${mixed}`);
});

test('a cell outside every envelope gets the nearest one, never an empty or divided-by-zero weight', async () => {
  const hot = defineBiome({ id: 'hot', climate: { temperature: [45, null] }, ground: [{ material: 'sand' }] }),
    hotter = defineBiome({ id: 'hotter', climate: { temperature: [60, null] }, ground: [{ material: 'sand' }] }),
    w = await slopeWorld([hotter, hot]),
    t = await w.tile(3, 0);
  for (let i = 0; i < 256; i += 17) assert.deepEqual(top(t, i, 9), [1, 255], 'nearest is "hot"');
  // Equal distance: priority breaks the tie, then the id.
  const a = defineBiome({ id: 'a', climate: { temperature: [80, null] }, ground: [{ material: 'x' }] }),
    b = defineBiome({ id: 'b', climate: { temperature: [80, null] }, ground: [{ material: 'x' }], priority: 2 });
  assert.deepEqual(top(await (await slopeWorld([a, b])).tile(2, 0), 5, 5), [1, 255]);
  assert.deepEqual(
    top(await (await slopeWorld([b, a].map((d) => ({ ...d, priority: 0 })))).tile(2, 0), 5, 5),
    [1, 255],
  );
  // Fuzz: random envelopes on random climates never break the 255 sum.
  const rng = random(21);
  for (let k = 0; k < 6; k++) {
    const biomes = Array.from({ length: 2 + Math.floor(rng() * 5) }, (_, i) => {
      const lo = rng() * 40 - 15;
      return defineBiome({
        id: `b${i}`,
        climate: { temperature: [lo, lo + rng() * 10], moistureIndex: [rng() * 0.5, null] },
        ground: [{ material: 'm' }],
      });
    });
    const world = await BiomeWorld.create({
        seed: k,
        size: [512, 512],
        biomes,
        climate: { latitude: rng() * 80 - 40, rainfall: rng() * 3000 },
      }),
      tile = await world.tile(1, 1),
      weights = tile.layer('biomeWeight').data;
    for (let c = 0; c < weights.length; c += 4 * 31)
      assert.equal(weights[c] + weights[c + 1] + weights[c + 2] + weights[c + 3], 255);
  }
});

test('paint layers: replace, add, multiply and max compose in order, masks scale them, clearing restores the bytes', async () => {
  const w = await BiomeWorld.create({ size: [512, 512], biomes: [presets.temperate, presets.desert] }),
    before = await w.digest(0, 0),
    full = new Uint8Array(256 * 256).fill(255),
    half = new Uint8Array(256 * 256).fill(128),
    rects = [];
  w.onChange((r) => rects.push(r));
  w.writeLayer('paint/desert', 0, 0, full);
  assert.deepEqual(rects.at(-1), [-257, -257, 1, 1]);
  assert.deepEqual(w.paint, [{ biome: 'desert', mode: 'replace' }]);
  let t = await w.tile(0, 0);
  assert.deepEqual(top(t, 10, 10), [1, 255]);
  w.writeLayer('paint/desert', 0, 0, half);
  t = await w.tile(0, 0);
  const [, weight] = top(t, 10, 10);
  assert.ok(weight >= 126 && weight <= 130, `half paint gives about half: ${weight}`);
  // A mask scales the paint: mask 0 means no effect.
  w.update({ paint: [{ biome: 'desert', mode: 'replace', mask: 'mask/dunes' }] });
  w.writeLayer('paint/desert', 0, 0, full);
  w.writeLayer('mask/dunes', 0, 0, new Uint8Array(256 * 256));
  t = await w.tile(0, 0);
  assert.equal(top(t, 10, 10)[0], 0, 'masked out');
  w.writeLayer('mask/dunes', 0, 0, full);
  assert.equal(top(await w.tile(0, 0), 10, 10)[0], 1, 'mask on');
  // Multiply by 0 removes a biome; max raises it.
  w.update({ paint: [{ biome: 'temperate', mode: 'multiply' }] });
  w.writeLayer('paint/temperate', 0, 0, new Uint8Array(256 * 256));
  t = await w.tile(0, 0);
  assert.deepEqual(
    top(t, 40, 40),
    [1, 255],
    'temperate multiplied away: the next nearest envelope, desert, takes the cell',
  );
  w.update({ paint: [{ biome: 'desert', mode: 'max' }] });
  w.writeLayer('paint/temperate', 0, 0, undefined);
  w.writeLayer('paint/desert', 0, 0, half);
  assert.ok(top(await w.tile(0, 0), 40, 40)[1] < 255);
  // Clearing everything gives the original bytes back.
  w.writeLayer('paint/desert', 0, 0, undefined);
  w.writeLayer('mask/dunes', 0, 0, undefined);
  w.update({ paint: [] });
  assert.equal(await w.digest(0, 0), before);
  assert.equal(w.readLayer('paint/desert', 0, 0), undefined);
  assert.throws(() => w.writeLayer('paint/jungle', 0, 0, full), RangeError);
  assert.throws(() => w.writeLayer('paint/desert', 0, 0, new Uint8Array(3)), RangeError);
  assert.throws(() => w.writeLayer('other', 0, 0, full), RangeError);
  // Painting one tile changes its neighbours' edge cells only through the blur: their digests still change.
  const n = await w.digest(1, 0);
  w.writeLayer('mask/x', 0, 0, full);
  assert.equal(await w.digest(1, 0), n, 'an unused mask changes nothing');
});

test('Holdridge zones of known climates, and the holdridge classifier uses zones', async () => {
  assert.equal(holdridgeZone(800, 1500), 'cool-temperate-perhumid');
  assert.equal(holdridgeZone(2600, 3000), 'tropical-humid');
  assert.equal(holdridgeZone(2600, 6500), 'tropical-perhumid');
  assert.equal(holdridgeZone(2600, 120), 'tropical-perarid');
  assert.equal(holdridgeZone(200, 200), 'subpolar-humid');
  const w = await BiomeWorld.create({
    size: [512, 512],
    biomes: ALL,
    classifier: 'holdridge',
    climate: presetWorlds.tropical.climate,
  });
  const t = await w.tile(0, 0);
  assert.equal(w.biomes[top(t, 50, 50)[0]].id, 'tropical');
  const wh = await BiomeWorld.create({
    size: [512, 512],
    biomes: ALL,
    classifier: 'whittaker',
    climate: presetWorlds.desert.climate,
  });
  assert.equal(wh.biomes[top(await wh.tile(1, 1), 50, 50)[0]].id, 'desert');
});

test('Koppen labels of known climates (Beck 2018 rules)', () => {
  const k = (temperature, coldest, warmest, rainfall, rainSeason = 'uniform') =>
    KOPPEN[
      koppenClass({
        temperature: temperature * 100,
        coldest: coldest * 100,
        warmest: warmest * 100,
        rainfall,
        rainSeason,
      })
    ];
  assert.equal(k(27, 26, 28, 2600), 'Af');
  assert.equal(k(26, 24, 28, 1000, 'summer'), 'Aw');
  assert.equal(k(26, 24, 28, 3000, 'summer'), 'Am');
  assert.equal(k(25, 15, 34, 60), 'BWh');
  assert.equal(k(8, -8, 22, 120), 'BWk');
  assert.equal(k(22, 16, 28, 400), 'BSh');
  assert.equal(k(11, 5, 17, 700), 'Cfb');
  assert.equal(k(17, 10, 25, 600, 'winter'), 'Csa');
  assert.equal(k(16, 4, 27, 1200), 'Cfa');
  assert.equal(k(18, 9, 27, 1300, 'summer'), 'Cwa');
  assert.equal(k(5, -9, 18, 700), 'Dfb');
  assert.equal(k(-3, -20, 15, 400), 'Dfc');
  assert.equal(k(-10, -42, 18, 300), 'Dfd');
  assert.equal(k(-8, -20, 5, 300), 'ET');
  assert.equal(k(-30, -40, -10, 100), 'EF');
  assert.equal(KOPPEN.length, 30);
});

test('koppen labels a whole tile from its layers', async () => {
  const w = await BiomeWorld.create({ size: [512, 512] }),
    codes = koppen(await w.tile(0, 0), w.climate.rainSeason);
  assert.equal(codes.length, 256 * 256);
  assert.ok(codes.every((c) => c < 30));
  assert.throws(() => koppen({ layer: () => undefined }, 'uniform'), TypeError);
});

test('presets: eight frozen definitions, each common in its own world', async () => {
  assert.deepEqual(Object.keys(presets).sort(), [
    'alpine',
    'boreal',
    'desert',
    'savanna',
    'temperate',
    'tropical',
    'tundra',
    'wetland',
  ]);
  for (const [id, def] of Object.entries(presets)) {
    assert.ok(Object.isFrozen(def) && Object.isFrozen(def.climate), id);
    assert.equal(def.id, id);
    assert.deepEqual(defineBiome(JSON.parse(JSON.stringify(def))), def, `${id} round-trips through JSON`);
  }
  for (const [id, pw] of Object.entries(presetWorlds)) {
    const w = await BiomeWorld.create({
      size: [1024, 1024],
      biomes: ALL,
      climate: pw.climate,
      height: { relief: pw.relief },
    });
    let mine = 0,
      cells = 0;
    for (const [tx, tz] of [
      [0, 0],
      [2, 1],
      [3, 3],
    ]) {
      const t = await w.tile(tx, tz);
      for (let k = 0; k < t.cells * t.cells; k += 37) {
        cells++;
        mine += +(w.biomes[t.layer('biome').data[k * 4]].id === id);
      }
    }
    assert.ok(
      mine / cells > (id === 'wetland' ? 0.05 : 0.5),
      `${id}: ${((100 * mine) / cells).toFixed(1)} % of its world`,
    );
  }
});

test('golden digests of every preset world at seeds 1, 2 and 0xFFFFFFFF', async () => {
  for (const [id, pw] of Object.entries(presetWorlds))
    for (const seed of [1, 2, 0xffffffff]) {
      const w = await BiomeWorld.create({
        seed,
        size: [1024, 1024],
        biomes: ALL,
        climate: pw.climate,
        height: { relief: pw.relief },
      });
      assert.equal(await w.digest(2, 1), golden[`${id}:${seed}`], `${id} seed ${seed}`);
    }
});

test('sample returns the biomes of the tile cell, and region samples classify too', async () => {
  const w = await BiomeWorld.create({ size: [1024, 1024], biomes: ALL }),
    s0 = w.sample(10, 10);
  assert.ok(s0.biomes.length >= 1 && Math.abs(s0.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  const t = await w.tile(2, 2),
    s = w.sample(t.origin[0] + 3, t.origin[1] + 4),
    [id, weight] = top(t, 3, 4);
  assert.equal(s.biomes[0], w.biomes[id].id);
  assert.equal(s.weights[0], weight / 255);
});

test('defineBiome validates shape and values and freezes a copy', () => {
  const def = { id: 'heath', climate: { moistureIndex: [0.4, 0.8] }, ground: [{ material: 'heather' }] },
    out = defineBiome(def);
  assert.notEqual(out, def);
  assert.ok(Object.isFrozen(out.ground[0]));
  for (const bad of [
    null,
    { ...def, id: 'Bad Id' },
    { ...def, climate: undefined },
    { ...def, ground: [{}] },
    { ...def, zones: [3] },
  ])
    assert.throws(() => defineBiome(bad), TypeError, JSON.stringify(bad));
  for (const bad of [
    { ...def, climate: { temperature: [5, 1] } },
    { ...def, climate: { wobble: [0, 1] } },
    { ...def, climate: { blend: 0 } },
    { ...def, ground: [] },
    { ...def, plants: [{ id: 'x', mesh: 'y', density: -1, radius: 1 }] },
  ])
    assert.throws(() => defineBiome(bad), RangeError, JSON.stringify(bad));
});
