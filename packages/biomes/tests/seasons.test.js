// The seasons entry (B9): per-cell green-up, senescence, snow and wetness for a day of the year, from the partial-year
// degree-day integral; its colour curve; golden state digests; and proof that it changes no tile or placement bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BiomeWorld, degreeDays } from '../dist/index.js';
import { canonicalBytes, sha256 } from '../dist/digest.js';
import { BiomePlacement } from '../dist/placement.js';
import { presets, presetWorlds } from '../dist/presets.js';
import { BiomeSeasons, degreeDaysSince, seasonalColor } from '../dist/seasons.js';

const golden = JSON.parse(readFileSync(new URL('./golden/seasons.json', import.meta.url), 'utf8'));
const fields = JSON.parse(readFileSync(new URL('./golden/fields.json', import.meta.url), 'utf8'));
const placed = JSON.parse(readFileSync(new URL('./golden/placement.json', import.meta.url), 'utf8'));
const PI = 205887;

const temperate = (seed = 1) =>
  BiomeWorld.create({
    seed,
    size: [512, 512],
    biomes: Object.values(presets).filter((b) => b.id !== 'beach'),
    climate: presetWorlds.temperate.climate,
    height: { relief: presetWorlds.temperate.relief },
  });

/** A flat world 1,000 m up at a latitude: winters below 0 C and summers above 5 C at 45 degrees either side. */
const flat = (latitude) =>
  BiomeWorld.create({ size: [256, 256], height: { field: () => 1000 }, climate: { latitude } });

const cell = (layer, i = 128 * 256 + 128) => [...layer.data.subarray(4 * i, 4 * i + 4)];

test('the partial-year integral at the end of the year equals the full-year degree days', () => {
  const out = [0, 0];
  for (const [mean, half, base] of [
    [1000, 1200, 500], // a season above 5 C
    [550, 2000, 500],
    [-300, 900, 0], // a short thaw
    [2600, 800, 500], // above 5 C all year
    [500, 0, 0], // no swing, above
    [-2000, 700, 500], // below all year
    [500, 0, 500], // on the base, no swing
    [0, 1, 0],
  ]) {
    const full = degreeDays(mean, half, base, out)[0];
    assert.equal(degreeDaysSince(mean, half, base, PI), full, `${mean} ${half} ${base}`);
    assert.equal(degreeDaysSince(mean, half, base, -PI), 0, 'nothing before the coldest day');
    // Monotone over the year.
    let last = 0;
    for (let p = -PI; p <= PI; p += 4096) {
      const v = degreeDaysSince(mean, half, base, p);
      assert.ok(v >= last, `${mean} ${half} ${base} at ${p}`);
      last = v;
    }
  }
  // Half the season above the base lies before the warmest day (the sinusoid is symmetric about it).
  const whole = degreeDaysSince(1000, 1200, 500, PI),
    first = degreeDaysSince(1000, 1200, 500, 0);
  assert.ok(Math.abs(2 * first - whole) <= 2, `${first} of ${whole}`);
});

test('golden state digests at days 1, 180 and 365 of a temperate preset world', async () => {
  const w = await temperate(),
    seasons = BiomeSeasons.attach(w, { dayOfYear: 1 }),
    got = {};
  for (const day of [1, 180, 365]) {
    seasons.set({ dayOfYear: day });
    const state = await seasons.tile(1, 0);
    assert.equal(state.format, 'rgba8');
    assert.equal(state.data.length, 256 * 256 * 4);
    got[`temperate-1-day${day}`] = await sha256(canonicalBytes([state]));
  }
  if (process.env.MARGO_RECORD) console.log(JSON.stringify(got, null, 2));
  assert.deepEqual(got, Object.fromEntries(Object.keys(got).map((k) => [k, golden[k]])));
  // Same world, same day: same bytes, whether made from a tile or read by point.
  const again = BiomeSeasons.attach(await temperate(), { dayOfYear: 365 });
  assert.ok(Buffer.from((await again.tile(1, 0)).data).equals(Buffer.from((await seasons.tile(1, 0)).data)));
});

test('a northern mid-latitude cell greens in summer, lies under snow in winter and runs smoothly into the new year', async () => {
  const w = await flat(45),
    seasons = BiomeSeasons.attach(w, { dayOfYear: 1 }),
    at = async (day) => {
      seasons.set({ dayOfYear: day });
      return cell(await seasons.tile(0, 0));
    },
    [d1, d180, d365] = [await at(1), await at(180), await at(365)];
  assert.ok(d180[0] > d1[0] && d180[0] > d365[0], `green-up ${d1[0]} ${d180[0]} ${d365[0]}`);
  assert.ok(d1[2] > d180[2] && d365[2] > d180[2], `snow ${d1[2]} ${d180[2]} ${d365[2]}`);
  // 31 December and 1 January differ by one day's change, never a reset.
  for (let c = 0; c < 4; c++) assert.ok(Math.abs(d1[c] - d365[c]) <= 16, `channel ${c}: ${d1[c]} ${d365[c]}`);
  // Through the year: leaves turn after midsummer and are bare in winter; no snow in summer.
  const d300 = await at(300);
  assert.ok(d300[1] > d180[1], `senescence ${d180[1]} ${d300[1]}`);
  assert.equal(d180[2], 0);
  // Over the year the snow builds once and melts once, wrapping through 1 January: it turns from rising to falling
  // (or back) exactly twice, and green-up rises once and drops once.
  const point = BiomeSeasons.attach(w, { dayOfYear: 1 }),
    year = [];
  for (let day = 1; day <= 365; day++) {
    point.set({ dayOfYear: day });
    year.push([...point.at(0, 0)]);
  }
  const turns = (c) => {
    const steps = year.map((s, i) => Math.sign(year[(i + 1) % 365][c] - s[c])).filter((d) => d !== 0);
    return steps.filter((d, i) => d !== steps[(i + 1) % steps.length]).length;
  };
  assert.equal(turns(2), 2, 'snow turns');
  assert.equal(turns(0), 2, 'green-up turns');
});

test('a southern-hemisphere world is half a year on', async () => {
  const north = BiomeSeasons.attach(await flat(45), { dayOfYear: 183 }),
    south = BiomeSeasons.attach(await flat(-45), { dayOfYear: 1 });
  // Green-up, senescence and snow match day for day half a year apart (flat ground: the same temperatures). Wetness
  // follows the soil moisture, whose evaporation sums the sun over each hemisphere's own year.
  const a = (await south.tile(0, 0)).data,
    b = (await north.tile(0, 0)).data;
  let differ = 0;
  for (let i = 0; i < a.length; i++) if ((i & 3) !== 3 && a[i] !== b[i]) differ++;
  assert.equal(differ, 0, 'state bytes that differ');
  const s1 = cell(await south.tile(0, 0));
  south.set({ dayOfYear: 180 });
  const s180 = cell(await south.tile(0, 0));
  assert.ok(s1[0] > s180[0], `southern green-up ${s1[0]} ${s180[0]}`);
  assert.ok(s180[2] > s1[2], `southern snow ${s1[2]} ${s180[2]}`);
});

test('weather: snowfall scales the snow, rain raises the wetness, point reads match the region', async () => {
  const w = await flat(45),
    dry = BiomeSeasons.attach(w, { dayOfYear: 20, weather: { snowfall: 0 } }),
    wet = BiomeSeasons.attach(w, { dayOfYear: 20, weather: { rain: 1 } }),
    plain = BiomeSeasons.attach(w, { dayOfYear: 20 });
  assert.deepEqual(plain.weather, { snowfall: 1, rain: 0 });
  assert.equal(cell(await dry.tile(0, 0))[2], 0);
  assert.ok(cell(await plain.tile(0, 0))[2] > 0);
  assert.equal(cell(await wet.tile(0, 0))[3], 255);
  assert.ok(cell(await plain.tile(0, 0))[3] < 255);
  const point = plain.at(0, 0);
  assert.equal(point.length, 4);
  assert.ok(point[2] > 0 && point[0] === 0, `${[...point]}`);
});

test('seasonalColor: summer gives the base, autumn turns orange, winter bare or white, wet ground darker', () => {
  const base = [0.14, 0.3, 0.05],
    near = (got, want) => got.forEach((c, i) => assert.ok(Math.abs(c - want[i]) < 1e-12, `${got} vs ${want}`));
  near(seasonalColor(base, [255, 0, 0, 100]), base);
  const autumn = seasonalColor(base, [255, 220, 0, 100]);
  assert.ok(autumn[0] > base[0] * 2 && autumn[1] > base[1], `${autumn}`);
  const bare = seasonalColor(base, [0, 255, 0, 100]);
  assert.ok(bare[0] > bare[2] && bare[0] > base[0], `${bare}`);
  const snow = seasonalColor(base, [0, 255, 255, 100]);
  assert.ok(
    snow.every((c) => c > 0.9),
    `${snow}`,
  );
  const soaked = seasonalColor(base, [255, 0, 0, 255]);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(soaked[c] - base[c] * 0.7) < 1e-9);
  // An offset reads a state out of a tile raster.
  near(seasonalColor(base, [9, 9, 9, 9, 255, 0, 0, 0], 4), base);
});

test('isSeasonal follows color.seasonal and tint.seasonal; colorAt tints by the local state', async () => {
  const forest = {
      ...presets.temperate,
      plants: [{ ...presets.temperate.plants[0], color: { seasonal: true } }, ...presets.temperate.plants.slice(1)],
    },
    w = await BiomeWorld.create({ size: [256, 256], biomes: [forest], height: { field: () => 100 } }),
    seasons = BiomeSeasons.attach(w, { dayOfYear: 290 });
  assert.equal(seasons.isSeasonal('temperate', forest.plants[0].id), true);
  assert.equal(seasons.isSeasonal('temperate', forest.plants[1]?.id ?? 'none'), false);
  assert.equal(seasons.isSeasonal('temperate'), false);
  assert.equal(seasons.isSeasonal('nowhere', forest.plants[0].id), false);
  const tinted = await BiomeWorld.create({
    size: [256, 256],
    biomes: [{ ...presets.temperate, tint: { seasonal: true } }],
    height: { field: () => 100 },
  });
  assert.equal(BiomeSeasons.attach(tinted, { dayOfYear: 1 }).isSeasonal('temperate'), true);
  // colorAt is seasonalColor of the state at the point.
  assert.deepEqual(seasons.colorAt([0.2, 0.4, 0.1], 0, 0), seasonalColor([0.2, 0.4, 0.1], seasons.at(0, 0)));
});

test('seasons change no tile or placement bytes: climate and instance digests stay on their goldens', async () => {
  const plain = await BiomeWorld.create(),
    seasons = BiomeSeasons.attach(plain, { dayOfYear: 40, weather: { rain: 0.5 } });
  await seasons.tile(8, 8);
  seasons.set({ dayOfYear: 200 });
  await seasons.tile(0, 15);
  assert.equal(await plain.digest(8, 8), fields.default88);
  assert.equal(await plain.digest(0, 15), fields.default015);
  for (const seed of [1, 0xffffffff]) {
    const w = await temperate(seed),
      s = BiomeSeasons.attach(w, { dayOfYear: 300 });
    await s.tile(1, 0);
    s.at(0, 0);
    assert.equal(await BiomePlacement.attach(w).digest(1, 0), placed[`temperate-${seed}`], `temperate-${seed}`);
  }
});

test('BiomeSeasons checks its options, notifies listeners and disposes', async () => {
  const w = await flat(45);
  assert.throws(() => BiomeSeasons.attach(w, { dayOfYear: 0 }), RangeError);
  assert.throws(() => BiomeSeasons.attach(w, { dayOfYear: 366 }), RangeError);
  assert.throws(() => BiomeSeasons.attach(w, { dayOfYear: 10.5 }), RangeError);
  assert.throws(() => BiomeSeasons.attach(w, {}), RangeError);
  assert.throws(() => BiomeSeasons.attach(w, { dayOfYear: 1, weather: { rain: 2 } }), RangeError);
  assert.throws(() => BiomeSeasons.attach(w, { dayOfYear: 1, weather: { snowfall: -1 } }), RangeError);
  assert.throws(() => BiomeSeasons.attach(w, { dayOfYear: 1, weather: 3 }), TypeError);
  assert.throws(() => BiomeSeasons.attach(null, { dayOfYear: 1 }), TypeError);
  assert.throws(() => BiomeSeasons.attach(w), TypeError);
  const seasons = BiomeSeasons.attach(w, { dayOfYear: 1 });
  let calls = 0;
  const off = seasons.onChange(() => calls++);
  seasons.set({ dayOfYear: 2 });
  assert.throws(() => seasons.set({ dayOfYear: 400 }), RangeError);
  assert.equal(seasons.dayOfYear, 2, 'a bad set changes nothing');
  assert.equal(calls, 1);
  off();
  seasons.set({ weather: { rain: 1 } });
  assert.equal(calls, 1);
  assert.equal(seasons.dayOfYear, 2);
  assert.deepEqual(seasons.weather, { snowfall: 1, rain: 1 });
  assert.throws(() => seasons.stateOf({ cells: 1, layer: () => undefined }), RangeError);
  {
    using scoped = BiomeSeasons.attach(w, { dayOfYear: 5 });
    assert.equal(scoped.dayOfYear, 5);
  }
  seasons.dispose();
  seasons.dispose();
  assert.throws(
    () => seasons.at(0, 0),
    (e) => e.code === 'disposed',
  );
});
