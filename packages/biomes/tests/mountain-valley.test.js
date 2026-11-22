// Mountain valleys of createRelief (scenes plan push 12, M6, the 1910 Big Burn film): a northern Rockies valley round
// Wallace, Idaho, with a level floor falling to its outlet, a creek and a rail grade on the floor, and walls cut into
// side gulches and ridges by stream-power drainage under threshold hillslopes. Bounds: the floor falls all the way to
// the outlet; the median wall slope is 25 to 40 degrees (slopes of 50 to 65 percent, 27 to 33 degrees, are common on
// the Coeur d'Alene National Forest, Deitschman 1973, INT-GTR-11); the rail grade is at most 1.7 percent (the
// Milwaukee Road over St. Paul Pass, Haugan to Avery, 1908) and stays out of the creek; the same settings give the same
// bytes. Without the option every relief is byte-identical to before (pinned below).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BiomeWorld } from '../dist/index.js';
import { createRelief } from '../dist/relief.js';
import '../dist/valley.js'; // the entry that makes mountain valleys (BiomeWorld.create loads it itself)
import { hydrology } from '../dist/hydrology.js';
import { presetWorlds, rockiesValleyWorld, rockiesWorld } from '../dist/presets.js';

const valley = (extra = {}, mv = {}) => createRelief({ base: 870, relief: 1000, ...extra, mountainValley: { ...mv } });
const DX = [1, 1, 0, -1, -1, -1, 0, 1],
  DZ = [0, 1, 1, 1, 0, -1, -1, -1];

/** sha256 (16 hex) of relief heights on a 64 x 64 lattice over the default 4 km world. */
function lattice(r) {
  const h = new Int32Array(64 * 64);
  for (let j = 0; j < 64; j++)
    for (let i = 0; i < 64; i++) h[j * 64 + i] = r.height(-2_048_000 + i * 64_997, -2_048_000 + j * 64_013);
  return createHash('sha256').update(new Uint8Array(h.buffer)).digest('hex').slice(0, 16);
}

/** Wall slopes in degrees on a 16 m lattice (offset 8 m), outside the floor and 64 m in from the border. */
function wallSlopes(r) {
  const v = r.mountainValley,
    out = [];
  for (let z = -1_976_000; z < 1_984_000; z += 16_000)
    for (let x = -1_976_000; x < 1_984_000; x += 16_000) {
      const [along, across] = v.frame(x, z);
      if (Math.abs(across) <= v.floorWidth(along) + 24_000) continue;
      const gx = (r.height(x + 8000, z) - r.height(x - 8000, z)) / 16000, // float division: test slopes
        gz = (r.height(x, z + 8000) - r.height(x, z - 8000)) / 16000;
      out.push((Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI);
    }
  return out.sort((a, b) => a - b);
}
const median = (a) => a[Math.floor(a.length / 2)];

test('mountain valley: the floor, the creek bed and the rail fall all the way to the outlet', () => {
  for (const [seed, outlet] of [
    [1, 'west'],
    [2, 'south'],
    [0xffffffff, 'east'],
    [7, 'north'],
  ]) {
    const r = valley({ seed }, { outlet }),
      v = r.mountainValley;
    for (const [name, line, drop] of [
      ['axis', v.axis, 0],
      ['creek', v.creek, 1500],
      ['rail', v.rail, 0],
    ]) {
      assert.ok(line.length >= 2 * 250, `${name}: ${line.length / 2} points over 4 km`);
      for (let k = 0; k + 3 < line.length; k += 2) {
        const here = r.height(line[k], line[k + 1]),
          up = r.height(line[k + 2], line[k + 3]);
        assert.ok(up > here, `seed ${seed} ${outlet} ${name} rises upstream at point ${k / 2}: ${here} then ${up} mm`);
        assert.equal(here, v.floorHeight(v.frame(line[k], line[k + 1])[0]) - drop, `${name} at point ${k / 2}`);
      }
    }
    // The outlet is on the named edge and the floor there is `base`.
    const [x0, z0] = [v.axis[0], v.axis[1]],
      edge = { west: x0 === -2_048_000, east: x0 === 2_048_000, north: z0 === -2_048_000, south: z0 === 2_048_000 };
    assert.ok(edge[outlet], `${outlet} outlet at ${x0}, ${z0}`);
    assert.equal(r.height(x0, z0), 870_000);
  }
});

test('mountain valley: every cell of the drainage grid drains down to the floor, and the relief has no closed basin', () => {
  for (const seed of [1, 2, 3]) {
    const r = valley({ seed }),
      { height, direction, nx, nz, step } = r.mountainValley.grid;
    let floor = 0;
    for (let c = 0; c < nx * nz; c++) {
      if (direction[c] < 0) {
        floor++;
        continue;
      }
      const p = c + DZ[direction[c]] * nx + DX[direction[c]];
      assert.ok(height[p] < height[c], `seed ${seed}: cell ${c} drains to a cell no lower`);
    }
    assert.ok(floor > 0.05 * nx * nz && floor < 0.2 * nx * nz, `seed ${seed}: ${floor} floor cells of ${nx * nz}`);
    // The relief itself on an 8 m grid: no depression of 1 m or more, the depth hydrology takes for a lake (the wall
    // detail of +-1.5 m stays off the channels, and no bilinear square dams a diagonal step).
    const n = 257,
      grid = new Int32Array(n * n);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) grid[j * n + i] = r.height(-1_024_000 + i * 8000, -1_024_000 + j * 8000);
    const h = hydrology({ height: grid, nx: n, nz: n, step: 8000 });
    let deepest = 0;
    for (let c = 0; c < n * n; c++) deepest = Math.max(deepest, h.filled[c] - grid[c]);
    assert.ok(deepest < 1000, `seed ${seed}: deepest closed depression ${deepest} mm`);
  }
});

test('mountain valley: the median wall slope is 25 to 40 degrees, and rounded ridges are gentler at the crest than sharp ones', () => {
  for (const seed of [1, 2, 3]) {
    const rounded = wallSlopes(valley({ seed })),
      sharp = wallSlopes(valley({ seed }, { ridges: 'sharp' }));
    for (const [name, s] of [
      ['rounded', rounded],
      ['sharp', sharp],
    ])
      assert.ok(
        median(s) >= 25 && median(s) <= 40,
        `seed ${seed} ${name}: median wall ${median(s).toFixed(1)} degrees`,
      );
    // Creep rounds the crests: more of the wall is gentle (under 25 degrees) with rounded ridges.
    const gentle = (s) => s.filter((d) => d < 25).length / s.length;
    assert.ok(gentle(rounded) > gentle(sharp) + 0.03, `seed ${seed}: ${gentle(rounded)} vs ${gentle(sharp)}`);
  }
  // A steeper critical angle makes steeper walls.
  assert.ok(median(wallSlopes(valley({}, { wall: 40 }))) > median(wallSlopes(valley({}, { wall: 26 }))) + 5);
});

test('mountain valley: side gulches of a quarter square kilometre or more reach the floor from both walls', () => {
  for (const seed of [1, 2, 3]) {
    const r = valley({ seed }),
      v = r.mountainValley,
      { flow, direction, nx, nz, step } = v.grid,
      cells = Math.ceil(250_000 / (step / 1000) ** 2),
      sides = [0, 0];
    for (let c = 0; c < nx * nz; c++) {
      const d = direction[c];
      if (d < 0 || flow[c] < cells) continue;
      const p = c + DZ[d] * nx + DX[d];
      if (direction[p] >= 0) continue; // not a gulch mouth on the floor
      const [, across] = v.frame(-2_048_000 + (c % nx) * step, -2_048_000 + Math.floor(c / nx) * step);
      sides[across > 0 ? 1 : 0]++;
    }
    assert.ok(sides[0] >= 3 && sides[1] >= 3, `seed ${seed}: gulch mouths ${sides}`);
  }
});

test('mountain valley: the rail grade is at most 1.7 percent, level across its bed and clear of the creek', () => {
  for (const seed of [1, 2, 3, 4]) {
    const r = valley({ seed }),
      v = r.mountainValley,
      rail = v.rail,
      creek = v.creek;
    let steepest = 0,
      nearest = Infinity;
    for (let k = 0; k + 3 < rail.length; k += 2) {
      const run = Math.hypot(rail[k + 2] - rail[k], rail[k + 3] - rail[k + 1]),
        rise = r.height(rail[k + 2], rail[k + 3]) - r.height(rail[k], rail[k + 1]);
      steepest = Math.max(steepest, Math.abs(rise) / run); // float division: test grade
    }
    assert.ok(steepest <= 0.017, `seed ${seed}: steepest rail grade ${steepest}`);
    for (let k = 0; k < rail.length; k += 2) {
      // Level across the 6 m bed: 3 m either side of the centre line, parallel to the outlet edge.
      const mid = r.height(rail[k], rail[k + 1]);
      for (const side of [-3000, 3000])
        assert.equal(r.height(rail[k], rail[k + 1] + side), mid, `seed ${seed} rail ${k / 2}`);
      for (let q = 0; q < creek.length; q += 2)
        nearest = Math.min(nearest, Math.hypot(creek[q] - rail[k], creek[q + 1] - rail[k + 1]));
    }
    // 10 m clear of the creek's banks: half the rail bed, the creek's half width and its 1 in 2 banks.
    assert.ok(nearest >= 3000 + 4000 + 3000 + 10_000, `seed ${seed}: rail ${nearest} mm from the creek`);
  }
  assert.equal(valley({}, { rail: false }).mountainValley.rail, null);
});

test('mountain valley: the same settings give the same bytes, and a new seed a new valley (pinned digest)', () => {
  const a = valley({ seed: 5 }),
    b = valley({ seed: 5 });
  assert.equal(lattice(a), lattice(b));
  assert.deepEqual(a.mountainValley.grid.height, b.mountainValley.grid.height);
  assert.deepEqual(a.mountainValley.creek, b.mountainValley.creek);
  assert.notEqual(lattice(valley({ seed: 6 })), lattice(a));
  assert.equal(lattice(createRelief(rockiesValleyWorld.relief)), 'deccbe636b2cfa2c');
  assert.equal(a.rivers.length, 1);
  assert.equal(a.rivers[0], a.mountainValley.creek);
  assert.equal(a.settings.mountainValley.fall, 786);
  assert.equal(a.settings.mountainValley.railGrade, 1114);
});

test('mountain valley: without the option every relief is byte-identical to before', () => {
  const pins = {
    default: [{}, '1e7ebce667ba78a2'],
    coastRivers: [{ coast: 'east', rivers: 2, seed: 9 }, '736f0c5d42359aa6'],
    ria: [{ coast: 'east', base: 14, relief: 220, ria: {}, valley: { width: 40, mouth: 40 } }, '41ea4f592e8117c4'],
    island: [presetWorlds.island.relief, 'b9cc40d1fa648101'],
    rockies: [rockiesWorld.relief, '123a1014574e221d'],
  };
  for (const [name, [options, pin]] of Object.entries(pins)) {
    const r = createRelief(options);
    assert.equal(lattice(r), pin, name);
    assert.equal(r.mountainValley, undefined, name);
    assert.ok(!('mountainValley' in r.settings), name);
  }
});

test('mountain valley: options are validated', () => {
  for (const bad of [
    { outlet: 'up' },
    { center: 0.05 },
    { floor: 2 },
    { fall: 0.02 }, // steeper than the 1.7 percent rail grade
    { wall: 60 },
    { steepness: 0 },
    { ridges: 'jagged' },
    { gulches: 50 },
    { creek: { width: 80 } },
    { creek: null },
    { rail: { grade: 0.2 } },
    { rail: 1 },
    { floor: 12 }, // too narrow for the creek and the rail
    { step: 2 },
  ])
    assert.throws(() => valley({}, bad), RangeError, JSON.stringify(bad));
  assert.doesNotThrow(() => valley({}, { fall: 0.02, rail: false }));
  assert.throws(() => createRelief({ mountainValley: null }), RangeError);
  for (const bad of [
    { coast: 'west' },
    { rivers: 1 },
    { coast: 'island' },
    { coast: 'east', ria: {} },
    { erosion: {} },
  ])
    assert.throws(() => valley(bad), RangeError, JSON.stringify(bad));
  assert.throws(() => valley({ size: [200, 4096] }), RangeError, 'too small a world');
});

test('mountain valley: the rockies valley world builds a BiomeWorld with its creek as the river and all three conifer presets', async () => {
  const pw = rockiesValleyWorld;
  assert.equal(pw.biomes, rockiesWorld.biomes);
  const w = await BiomeWorld.create({ biomes: pw.biomes, climate: pw.climate, height: { relief: pw.relief } }),
    w2 = await BiomeWorld.create({ biomes: pw.biomes, climate: pw.climate, height: { relief: pw.relief } });
  assert.equal(w.rivers.length, 1);
  assert.equal(await w.digest(2, 1), await w2.digest(2, 1));
  const share = new Map();
  for (let z = -1900; z < 1900; z += 32)
    for (let x = -1900; x < 1900; x += 32) {
      const id = w.sampleRegion(x, z).biomes[0];
      share.set(id, (share.get(id) ?? 0) + 1);
    }
  for (const b of pw.biomes) assert.ok(share.get(b.id) > 50, `${b.id}: ${share.get(b.id)} of ${119 * 119} corners`);
});
