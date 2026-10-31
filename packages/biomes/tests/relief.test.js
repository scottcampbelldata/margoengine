// Islands and relief options (biome look plan 3, item C1): `coast: 'island'` with sea on every side, an irregular
// outline, a beach ring and a peak; `shelf` and `valley: { width, floor, mouth }` for every coast; the beach preset and
// the island preset world. The default and R16 digests stay in fixed.test.js (they must not move).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeWorld } from '../dist/index.js';
import { defineBiome } from '../dist/index.js';
import { presets, presetWorlds } from '../dist/presets.js';
import { createRelief } from '../dist/relief.js';

const island = (extra = {}) => createRelief({ ...presetWorlds.island.relief, ...extra });

/** Height (mm) along a ray from (x, z) at angle `a`, every `step` mm out to `far` mm. */
function ray(relief, [x, z], a, far, step) {
  const out = [];
  for (let r = 0; r <= far; r += step)
    out.push(relief.height(Math.round(x + r * Math.cos(a)), Math.round(z + r * Math.sin(a)))); // float trig: test rays
  return out;
}

test('island: every border sample is the sea floor and the centre is a peak above 100 m', () => {
  for (const seed of [1, 2, 3, 0xffffffff])
    for (const count of [1, 3]) {
      const r = island({ seed, islands: { count } }),
        half = 2_048_000;
      assert.equal(r.islands.length, count);
      for (let k = -half; k <= half; k += 4000)
        for (const [x, z] of [
          [k, -half],
          [k, half],
          [-half, k],
          [half, k],
        ])
          assert.equal(r.height(x, z), -40_000, `seed ${seed}, ${count} islands, border (${x}, ${z})`);
      for (const c of r.islands)
        assert.ok(r.height(c.x, c.z) > 100_000, `seed ${seed} centre ${r.height(c.x, c.z)} mm`);
    }
});

test('island: the coastline radius varies by at least 15 percent round the island (bays and headlands, no circle)', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = island({ seed }),
      [c] = r.islands,
      radii = [];
    for (let i = 0; i < 48; i++) {
      const h = ray(r, [c.x, c.z], (2 * Math.PI * i) / 48, 2_000_000, 4000);
      radii.push(4000 * h.findIndex((v) => v < 0));
    }
    assert.ok(
      Math.max(...radii) >= 1.15 * Math.min(...radii),
      `seed ${seed} coast radii ${Math.min(...radii)}..${Math.max(...radii)} mm`,
    );
  }
});

test('island: a beach ring of 0 to 4 m over at least 40 m on each of 24 rays', () => {
  for (const seed of [1, 2, 3]) {
    const r = island({ seed }),
      [c] = r.islands;
    for (let i = 0; i < 24; i++) {
      const h = ray(r, [c.x, c.z], (2 * Math.PI * i) / 24, 2_000_000, 2000);
      let run = 0,
        best = 0;
      for (const v of h) {
        run = v >= 0 && v <= 4000 ? run + 2000 : 0;
        best = Math.max(best, run);
      }
      assert.ok(best >= 40_000, `seed ${seed} ray ${i}: beach ${best} mm`);
    }
  }
});

test('island: rivers run from the peak out to the sea, and the settings report the island', () => {
  const r = island({ seed: 4, rivers: 3 }),
    [c] = r.islands;
  assert.equal(r.rivers.length, 3);
  for (const line of r.rivers) {
    const mouth = Math.hypot(line[0] - c.x, line[1] - c.z), // float division: test distances
      head = Math.hypot(line[16] - c.x, line[17] - c.z);
    assert.ok(head < mouth / 4, `head ${head} mouth ${mouth}`);
    assert.ok(r.height(line[0], line[1]) < 0, 'the mouth is in the sea');
    assert.ok(r.height(line[16], line[17]) < r.height(c.x, c.z), 'the valley is cut below the peak');
  }
  assert.equal(r.settings.coast, 'island');
  assert.deepEqual(r.settings.islands, { count: 1, radius: 1_365_333, shelf: 409_600 });
  assert.equal(r.valleyWidth, 227_555);
  assert.equal(createRelief().islands.length, 0);
  assert.equal(createRelief().settings.islands, null);
});

test('valley width: 800 m makes the wall at 3/8 of the half width under a third as steep as the default 250 m', () => {
  // A 1,500 m relief over a 400 m lowland: the bed rises only 40 m, so the carved wall drops about 1 km in either case;
  // a wider valley spreads that drop over more ground. Slopes as tangents, median over the line's upper 6 segments.
  const opts = { seed: 3, relief: 1500, base: 400, rivers: 1, coast: 'south' };
  const median = (relief, dist) => {
    const line = relief.rivers[0],
      tans = [];
    for (let k = 2; k < 8; k++)
      for (let s = 1; s < 8; s++) {
        const ax = line[2 * k],
          az = line[2 * k + 1],
          bx = line[2 * k + 2] - ax,
          bz = line[2 * k + 3] - az,
          len = Math.hypot(bx, bz),
          nx = -bz / len, // float division: test geometry
          nz = bx / len; // float division
        for (const side of [-1, 1]) {
          const at = (d) =>
            relief.height(Math.round(ax + (bx * s) / 8 + side * nx * d), Math.round(az + (bz * s) / 8 + side * nz * d));
          tans.push(Math.abs(at(dist + 5000) - at(dist - 5000)) / 10_000); // float division
        }
      }
    return tans.sort((a, b) => a - b)[tans.length >> 1];
  };
  const narrow = median(createRelief(opts), 93_750),
    wide = median(createRelief({ ...opts, valley: { width: 800 } }), 300_000);
  assert.ok(narrow > 3, `default wall tangent ${narrow}`);
  assert.ok(wide < narrow / 3, `wide wall tangent ${wide}, default ${narrow}`);
  // A flat floor: the bed holds across it.
  const floored = createRelief({ ...opts, valley: { width: 800, floor: 200 } }),
    line = floored.rivers[0],
    bed = (x, z) => floored.height(x, z);
  for (let k = 3; k < 7; k++) {
    const x = line[2 * k],
      z = line[2 * k + 1];
    assert.ok(Math.abs(bed(x + 100_000, z) - bed(x, z)) < 2000 || Math.abs(bed(x, z + 100_000) - bed(x, z)) < 2000);
  }
});

test('valley mouth: 600 m widens the last kilometre and leaves the rest of the valley as it was', () => {
  const opts = { seed: 3, relief: 600, base: 200, rivers: 1, coast: 'south' },
    plain = createRelief(opts),
    wide = createRelief({ ...opts, valley: { mouth: 600 } }),
    line = plain.rivers[0];
  assert.deepEqual([...wide.rivers[0]], [...line]);
  // The last kilometre: 400 m from the line (outside the 250 m valley) is carved lower on land.
  let lower = 0,
    land = 0;
  for (let t = 0; t <= 1; t += 0.05) {
    const x = Math.round(line[0] + (line[2] - line[0]) * t),
      z = Math.round(line[1] + (line[3] - line[1]) * t);
    for (const side of [-400_000, 400_000]) {
      if (plain.height(x + side, z) <= 5000) continue;
      land++;
      lower += +(wide.height(x + side, z) < plain.height(x + side, z));
    }
    const along = Math.hypot(x - line[0], z - line[1]);
    if (along > 1_100_000)
      for (const side of [-400_000, 400_000]) assert.equal(wide.height(x + side, z), plain.height(x + side, z));
  }
  assert.ok(land > 4 && lower >= land * 0.6, `lower ${lower} of ${land} land samples`);
});

test('shelf: a wider straight-coast shelf moves the coastline inland, and 1500 m is the default', () => {
  const opts = { seed: 2, coast: 'west', relief: 300, base: 100 },
    plain = createRelief(opts),
    same = createRelief({ ...opts, shelf: 1500 }),
    wide = createRelief({ ...opts, shelf: 3000 });
  let deeper = 0;
  for (let z = -1_900_000; z < 1_900_000; z += 100_000) {
    assert.equal(same.height(-1_000_000, z), plain.height(-1_000_000, z));
    deeper += +(wide.height(-1_000_000, z) < plain.height(-1_000_000, z));
  }
  assert.ok(deeper > 30, `${deeper} of 38`);
  assert.equal(plain.settings.shelf, 1_500_000);
  assert.deepEqual(plain.settings.valley, { width: 250_000, floor: 0, mouth: 250_000 });
});

test('island and valley options are validated', () => {
  for (const bad of [
    { islands: { count: 2 } },
    { coast: 'island', islands: { count: 0 } },
    { coast: 'island', islands: { count: 9 } },
    { coast: 'island', islands: { radius: 50 } },
    { coast: 'island', islands: { radius: 1700 } },
    { coast: 'island', islands: null },
    { coast: 'island', islands: { shelf: 5000 } },
    { shelf: 0 },
    { shelf: 20000 },
    { valley: { width: 0 } },
    { valley: { width: 300, floor: 300 } },
    { valley: { mouth: 5000 } },
    { valley: 7 },
  ])
    assert.throws(() => createRelief(bad), RangeError, JSON.stringify(bad));
});

test('presets.beach and the island preset world: sand by the sea, every edge of the world under water', async () => {
  assert.deepEqual(defineBiome(JSON.parse(JSON.stringify(presets.beach))), presets.beach);
  assert.ok(Object.isFrozen(presets.beach));
  const { climate, relief, biomes } = presetWorlds.island,
    world = await BiomeWorld.create({ climate, height: { relief }, biomes });
  const [x0, z0, x1, z1] = world.bounds;
  for (let t = 0; t <= 1; t += 0.125)
    for (const [x, z] of [
      [x0 + (x1 - x0) * t, z0],
      [x0 + (x1 - x0) * t, z1 - 1],
      [x0, z0 + (z1 - z0) * t],
      [x1 - 1, z0 + (z1 - z0) * t],
    ])
      assert.ok(world.sample(x, z).height < -30, `edge (${x}, ${z}): ${world.sample(x, z).height} m`);
  // Along a ray from the centre the beach preset leads somewhere between the sea and the forest.
  const r = createRelief({ ...relief, seed: world.seed, origin: [x0, z0], size: [x1 - x0, z1 - z0] }),
    [c] = r.islands;
  let beach = 0;
  for (let i = 0; i < 8; i++)
    for (let d = 300; d < 1400; d += 4) {
      const a = (Math.PI * i) / 4,
        s = world.sample(c.x / 1000 + d * Math.cos(a), c.z / 1000 + d * Math.sin(a));
      if (s.height >= 0 && s.height <= 4 && s.biomes[0] === 'beach') {
        beach++;
        break;
      }
    }
  assert.ok(beach >= 6, `beach found on ${beach} of 8 rays`);
});
