// Dune height fields (KB-TERRAIN-DUNE1): the windward side tops out at `stoss`, the slip face at the angle of repose
// `lee`, crests run across the wind, barchans point their horns downwind, and the same seed gives the same heights.
import test from 'node:test';
import assert from 'node:assert/strict';
import { barchan, duneField, duneHill, duneLengths, duneProfile, slopeAt } from '@margoengine/terrain/dunes';

const deg = (t) => (Math.atan(t) * 180) / Math.PI;
/** Steepest slopes along the wind (+z), split into windward (rising) and lee (falling downwind), in degrees. */
function slopes(h, width, depth, cell) {
  let stoss = 0,
    lee = 0,
    steep = 0;
  for (let j = 1; j < depth - 1; j++)
    for (let i = 1; i < width - 1; i++) {
      const g = (h[(j + 1) * width + i] - h[(j - 1) * width + i]) / (2 * cell);
      if (g > 0) stoss = Math.max(stoss, deg(g));
      else lee = Math.max(lee, deg(-g));
      if (slopeAt(h, width, i, j, cell) > 36) steep++;
    }
  return { stoss, lee, steep };
}

test('a dune profile rises at most at the stoss slope and falls at the angle of repose', () => {
  const tanS = Math.tan((12 * Math.PI) / 180),
    tanL = Math.tan((32 * Math.PI) / 180),
    { stoss, total } = duneLengths(5, 12, 32);
  let steepUp = 0,
    steepDown = 0;
  for (let p = 0.01; p < total + 2; p += 0.01) {
    const g = (duneProfile(p + 0.005, 5, tanS, tanL) - duneProfile(p - 0.005, 5, tanS, tanL)) / 0.01;
    if (g > 0) steepUp = Math.max(steepUp, deg(g));
    else steepDown = Math.max(steepDown, deg(-g));
  }
  assert.ok(Math.abs(steepUp - 12) < 0.2, `stoss ${steepUp}`);
  assert.ok(Math.abs(steepDown - 32) < 0.2, `lee ${steepDown}`);
  assert.ok(Math.abs(duneProfile(stoss, 5, tanS, tanL) - 5) < 1e-9, 'the crest is the height');
  assert.equal(duneProfile(total + 1, 5, tanS, tanL), 0);
  // The long gentle side and the short steep face (Bagnold 1941): a 5 m dune is about 37 m upwind and 8 m downwind.
  assert.ok(stoss > 4 * duneLengths(5).lee);
});

test('transverse ridges run across the wind with windward and lee slopes in range', () => {
  const width = 320,
    depth = 320,
    cell = 0.5,
    h = duneField({ width, depth, cellSize: cell, height: 5, spacing: 70, wind: 90, seed: 4 }),
    s = slopes(h, width, depth, cell);
  assert.ok(s.stoss > 10 && s.stoss < 14, `windward ${s.stoss}`);
  assert.ok(s.lee > 30 && s.lee < 34, `lee ${s.lee}`);
  assert.equal(s.steep, 0, 'nothing stands past the angle of repose');
  // Across the wind (along x) the ground changes far less than along it: the crests run across the wind.
  let along = 0,
    across = 0;
  for (let j = 1; j < depth; j++)
    for (let i = 1; i < width; i++) {
      along += Math.abs(h[j * width + i] - h[(j - 1) * width + i]);
      across += Math.abs(h[j * width + i] - h[j * width + i - 1]);
    }
  assert.ok(along > 2.5 * across, `along ${along} across ${across}`);
  // The same seed gives the same heights, another seed others.
  assert.deepEqual(duneField({ width: 64, depth: 64, seed: 4 }), duneField({ width: 64, depth: 64, seed: 4 }));
  assert.notDeepEqual(duneField({ width: 64, depth: 64, seed: 4 }), duneField({ width: 64, depth: 64, seed: 5 }));
});

test('a wind toward +x turns the ridges with it', () => {
  const h = duneField({ width: 200, depth: 200, height: 4, spacing: 60, wind: 0, irregularity: 0 });
  let along = 0,
    across = 0;
  for (let j = 1; j < 200; j++)
    for (let i = 1; i < 200; i++) {
      across += Math.abs(h[j * 200 + i] - h[(j - 1) * 200 + i]);
      along += Math.abs(h[j * 200 + i] - h[j * 200 + i - 1]);
    }
  assert.ok(along > 10 * across, 'with no irregularity the crests are straight lines across the wind');
});

test('barchans: slip faces at the angle of repose and horns pointing downwind', () => {
  const width = 320,
    depth = 320,
    cell = 0.5,
    h = duneField({ width, depth, cellSize: cell, type: 'barchan', height: 5, spacing: 80, seed: 3 }),
    s = slopes(h, width, depth, cell);
  assert.ok(s.stoss > 10 && s.stoss < 14, `windward ${s.stoss}`);
  assert.ok(s.lee > 30 && s.lee < 34, `lee ${s.lee}`);
  assert.equal(s.steep, 0);
  // Behind the crest, the horns stand at the sides and the middle is the low floor of the slip face.
  const behind = 3 * 5;
  assert.ok(barchan(behind, 0.72 * 5.5 * 5, 5, 0.21, 0.62) > barchan(behind, 0, 5, 0.21, 0.62));
  assert.equal(barchan(0, 6 * 5, 5, 0.21, 0.62), 0, 'about 11 heights wide (Hersen et al. 2002)');
});

test('dunes build on given ground and only where amount lets them', () => {
  const base = new Float32Array(64 * 64).fill(2),
    h = duneField({ width: 64, depth: 64, base, amount: (x) => (x < 32 ? 0 : 1) });
  for (let j = 0; j < 64; j++) for (let i = 0; i < 32; i++) assert.equal(h[j * 64 + i], 2);
  assert.ok(h.some((v) => v > 2.5));
  assert.equal(base[0], 2, 'base is not changed');
  assert.throws(() => duneField({ width: 64, depth: 64, lee: 40 }), RangeError);
  assert.throws(() => duneField({ width: 64, depth: 64, stoss: 1 }), RangeError);
  assert.throws(() => duneField({ width: 64, depth: 64, base: new Float32Array(3) }), RangeError);
});

test('a rounded brink is level at the top and meets the slip face at its slope', () => {
  const tanS = Math.tan((12 * Math.PI) / 180),
    tanL = Math.tan((32 * Math.PI) / 180),
    { stoss } = duneLengths(5, 12, 32),
    slope = (p, r) =>
      (duneProfile(p + 0.005, 5, tanS, tanL, 0.6, r) - duneProfile(p - 0.005, 5, tanS, tanL, 0.6, r)) / 0.01;
  // Sharp: the slope jumps from level to the full face at the brink.
  assert.ok(slope(stoss + 0.02, 0) < -tanL * 0.99);
  // Rounded over 6 m: no slope step anywhere near the brink, the face reaches its slope 3 m past the crest.
  let worst = 0;
  for (let p = stoss - 5; p < stoss + 5; p += 0.05) worst = Math.max(worst, Math.abs(slope(p + 0.05, 6) - slope(p, 6)));
  assert.ok(worst < 0.06, `largest slope step ${worst}`);
  assert.ok(Math.abs(slope(stoss + 3.2, 6) + tanL) < 1e-3, 'on the straight face past the rounding');
  assert.ok(duneProfile(stoss, 5, tanS, tanL, 0.6, 6) < 5, 'the crest is blunted');
  assert.throws(() => duneField({ width: 8, depth: 8, round: -1 }), RangeError);
});

test('a dune hill peaks over its crest, is gentle upwind, steeper downwind and falls to its ends', () => {
  const opts = { crest: [0, 0], height: 30, wind: 90, stoss: 12, lee: 30 },
    at = (x, z) => duneHill(x, z, opts),
    top = at(0, 0);
  assert.ok(top > 27 && top <= 30, `crest ${top}`);
  // Along the wind (+z): the windward side runs about 222 m (30 m at 12 degrees on a half cosine), the lee side about
  // 52 m (30 m at 30 degrees).
  assert.ok(at(0, -215) > 0 && at(0, -225) === 0, 'windward length');
  assert.ok(at(0, 45) > 0 && at(0, 60) === 0, 'lee length');
  let up = 0,
    down = 0;
  for (let z = -160; z < 60; z += 0.5) {
    const g = (at(0, z + 0.25) - at(0, z - 0.25)) / 0.5;
    up = Math.max(up, g);
    down = Math.max(down, -g);
  }
  assert.ok(Math.atan(up) * 57.3 < 12.2 && Math.atan(up) * 57.3 > 11, `windward ${Math.atan(up) * 57.3}`);
  assert.ok(Math.atan(down) * 57.3 < 30.2 && Math.atan(down) * 57.3 > 29, `lee ${Math.atan(down) * 57.3}`);
  // Across the wind the crest falls to nothing at halfWidth (5 heights).
  assert.ok(at(75, 0) < top / 2 + 1 && at(75, 0) > top / 2 - 1);
  assert.equal(at(151, 0), 0);
  assert.throws(() => duneHill(0, 0, { crest: [0, 0], height: 0 }), RangeError);
  assert.throws(() => duneHill(0, 0, { crest: [0, 0], height: 5, lee: 40 }), RangeError);
});
