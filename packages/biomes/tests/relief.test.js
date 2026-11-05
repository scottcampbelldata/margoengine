// Islands and relief options (biome look plan 3, item C1): `coast: 'island'` with sea on every side, an irregular
// outline, a beach ring and a peak; `shelf` and `valley: { width, floor, mouth }` for every coast; the beach preset and
// the island preset world. The default and R16 digests stay in fixed.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeWorld } from '../dist/index.js';
import { defineBiome } from '../dist/index.js';
import { presets, presetWorlds } from '../dist/presets.js';
import { createRelief } from '../dist/relief.js';
import { hydrology } from '../dist/hydrology.js';
import { hash3, ONE, ridged, valueNoise } from '../dist/toolkit.js';

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

// Bug found by look item L4: a CPU hill shade of the relief alone drew blocky rounded-square ridges. `ridged` took its
// crests from value noise, whose product of fades draws level lines as rounded squares round the lattice points, so
// gradients crowd onto the axes. Each octave turns by 14 degrees, which hides the bias from a plain histogram of the
// fine gradient (every octave adds the same gradient energy), hence the two measures below: one octave, and the heights
// with the fine octaves averaged away, the ones a viewer reads as the shape of a range.

/** The four-fold harmonic of the gradient directions, weighted by energy: 0 when isotropic, 1 when all lie on the axes. */
function fourFold(gradients) {
  let c = 0,
    s = 0,
    e = 0;
  for (const [gx, gz] of gradients) {
    const m = gx * gx + gz * gz,
      a = Math.atan2(gz, gx);
    c += m * Math.cos(4 * a);
    s += m * Math.sin(4 * a);
    e += m;
  }
  return { cos: c / e, sin: s / e, size: Math.hypot(c, s) / e }; // float division: test statistics
}

function* gridGradients(f) {
  const q = Math.round(0.004 * ONE);
  for (let b = 0; b < 300; b++)
    for (let a = 0; a < 300; a++) {
      const x = Math.round((a * 0.041 + 0.123) * ONE),
        z = Math.round((b * 0.041 + 0.377) * ONE);
      yield [f(x + q, z) - f(x - q, z), f(x, z + q) - f(x, z - q)];
    }
}

test('ridged: one octave has no axis bias, within what isotropic noise gives (value noise reads 0.5)', () => {
  // The controls show the measure can tell: the same ridge over value noise, and random waves in every direction.
  const overValue = (x, z) => {
      const r = ONE - Math.abs(2 * valueNoise(7, x, z) - ONE);
      return (r * r) / ONE; // float division: test control
    },
    waves = Array.from({ length: 64 }, (_, i) => {
      const a = (hash3(1, 2, i) / 2 ** 32) * 2 * Math.PI,
        w = (2 * Math.PI) / ONE;
      return [Math.cos(a) * w, Math.sin(a) * w, hash3(3, 4, i) / 2 ** 16];
    }),
    isotropic = (x, z) => waves.reduce((sum, [kx, kz, p]) => sum + Math.sin(kx * x + kz * z + p), 0) * 1000;
  assert.ok(fourFold(gridGradients(overValue)).size > 0.4, 'the measure sees value noise');
  const reference = fourFold(gridGradients(isotropic)).size;
  assert.ok(reference < 0.1, `isotropic reference ${reference}`);
  for (const seed of [1, 7, 42]) {
    const got = fourFold(gridGradients((x, z) => ridged(seed, x, z, 1))).size;
    assert.ok(got < 0.1, `seed ${seed}: four-fold ${got}, isotropic ${reference}`);
  }
});

test('relief: gradients of the heights at 200 m show no axis bias on any seed (before the fix +0.06 on each)', () => {
  // Block means of 200 m keep the 1.5 km and 750 m ridges, the forms a viewer reads as the shape of a range.
  const block = 200_000,
    sub = 4,
    n = 300;
  let sum = 0;
  const seeds = [1, 2, 3];
  for (const seed of seeds) {
    const r = createRelief({ seed, size: [65536, 65536] }),
      means = new Float64Array(n * n);
    for (let b = 0; b < n; b++)
      for (let a = 0; a < n; a++) {
        let s = 0;
        for (let j = 0; j < sub; j++)
          for (let i = 0; i < sub; i++)
            s += r.height(
              -30_000_000 + a * block + (i * block) / sub, // float division: whole millimetres
              -30_000_000 + b * block + (j * block) / sub, // float division: whole millimetres
            );
        means[b * n + a] = s;
      }
    const gradients = [];
    for (let b = 1; b < n - 1; b++)
      for (let a = 1; a < n - 1; a++)
        gradients.push([means[b * n + a + 1] - means[b * n + a - 1], means[(b + 1) * n + a] - means[(b - 1) * n + a]]);
    sum += fourFold(gradients).cos;
  }
  const mean = sum / seeds.length; // float division: test statistics
  assert.ok(mean < 0.03, `axis share ${mean} (isotropic 0)`);
});

test('ridged: continuous far from the origin too, with no lattice drift and no wrapped coordinate', () => {
  // Guards the integer simplex lattice: an unskew constant's rounding carried by the cell index, or an octave offset near
  // 2^31, draws long straight steps in the heights. 1,000 km at 1.5 km cells is about 2^25.4.
  for (const [ax, az] of [
    [0, 0],
    [1 << 25, -(1 << 25)],
    [-(44 << 20), 44 << 20],
  ]) {
    let worst = 0;
    for (let k = 0; k < 40_000; k++) {
      const x = ax + k * 97,
        z = az + k * 61,
        here = ridged(1, x, z, 6);
      worst = Math.max(worst, Math.abs(ridged(1, x + 1, z, 6) - here), Math.abs(ridged(1, x, z + 1, 6) - here));
    }
    assert.ok(worst < 64, `at ${ax}, ${az}: ${worst} per unit`);
  }
});

test('relief: the foot of a mountain range starts level, with no crease', () => {
  // The mountain part is the height with relief less the height without. A linear mask ramp starts it at full slope, a
  // crease round each range: the rise over the first 20 m was a quarter of that over 80 m. An eased ramp starts level.
  const hills = createRelief({ seed: 2, relief: 0 }),
    range = createRelief({ seed: 2, relief: 900 }),
    part = (x, z) => range.height(x, z) - hills.height(x, z),
    shares = [];
  for (let z = -2_000_000; z < 2_000_000; z += 8000) {
    let was = part(-2_000_000, z);
    for (let x = -2_000_000 + 4000; x < 2_000_000 - 100_000; x += 4000) {
      const now = part(x, z);
      if (was === 0 && now > 0) {
        // Walk back to the last metre with no mountain.
        let foot = x;
        while (foot > x - 4000 && part(foot - 1000, z) > 0) foot -= 1000;
        const far = part(foot + 80_000, z);
        if (far > 500) shares.push(part(foot + 20_000, z) / far); // float division: test ratio
      }
      was = now;
    }
  }
  shares.sort((a, b) => a - b);
  assert.ok(shares.length > 30, `${shares.length} feet`);
  const median = shares[shares.length >> 1];
  assert.ok(median < 0.12, `median rise over 20 m is ${median} of that over 80 m`);
});

test('coastal rivers reach the sea: no shelf ridge between the mouth and the shore, no closed basin (bug from job E)', () => {
  // Before the fix the mouth sat a third of the shelf in from the world edge whatever the warped shore did: with these
  // settings it ended at z 1,548 m at 2 m high, a 73 m shelf ridge stood between it and the shore at z 1,990 m and the
  // hydrology filled the valley to 70.8 m.
  const cases = [
    { seed: 3, relief: 900, base: 300, rivers: 1, coast: 'south' },
    ...['west', 'east', 'north', 'south'].flatMap((coast) => [1, 2, 7].map((seed) => ({ seed, coast, rivers: 2 }))),
  ];
  for (const settings of cases) {
    const r = createRelief(settings),
      [ox, oz] = r.settings.origin,
      [sx, sz] = r.settings.size,
      step = 16000,
      nx = sx / step + 1,
      nz = sz / step + 1,
      height = new Int32Array(nx * nz);
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) height[j * nx + i] = r.height(ox + i * step, oz + j * step);
    const h = hydrology({ height, nx, nz, step }, { sea: 0 }),
      name = JSON.stringify(settings);
    for (const line of r.rivers) {
      // The mouth is in the sea (or on the world's edge where the shore lies beyond it).
      const [mx, mz] = [line[0], line[1]],
        edge = mx === ox || mx === ox + sx || mz === oz || mz === oz + sz;
      assert.ok(r.height(mx, mz) <= 0 || edge, `${name}: mouth in the sea or on the edge`);
      // Along the first two segments the valley floor stays at its bed (at most 12 m): no ridge across it.
      for (let k = 0; k < 2; k++)
        for (let s = 0; s <= 64; s++) {
          const x = line[2 * k] + Math.floor(((line[2 * k + 2] - line[2 * k]) * s) / 64),
            z = line[2 * k + 1] + Math.floor(((line[2 * k + 3] - line[2 * k + 1]) * s) / 64);
          assert.ok(r.height(x, z) <= 12000, `${name}: no ridge across the river at ${x}, ${z}`);
          // And no lake there: the region cell nearest the line drains to the sea.
          const c = Math.round((z - oz) / step) * nx + Math.round((x - ox) / step); // float division: test cell
          assert.ok(h.filled[c] - height[c] < 1000, `${name}: no closed basin at ${x}, ${z}`);
        }
    }
  }
});
