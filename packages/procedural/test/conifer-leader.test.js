// KB-CABIN-LEADER1: each spruce's crown top (its leader) was a solid, dark, snowless cone at both near and far detail,
// a black spike on every tree behind Cabin Hearth's cabin. A spruce's stem grows rhythmically from its terminal bud, one
// growth unit (a year's shoot) at a time, and sets a whorl of lateral buds at each unit's top, so its branches stand in
// tiers (Hallé, Oldeman and Tomlinson 1978; Fabrika et al. 2019, young Norway spruce growth units and branch angles):
// the crown top is the youngest whorl of side shoots and above it this year's leader, a needled shoot without side
// shoots yet. Both are now built from the crown's own shoots and material, near and coarse alike, and the top tenth of
// the crown reads as the tiers below it do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTreeMesh } from '../dist/index.js';
import { view, CELL } from './fixtures/conifer-view.js';

const ELEVATIONS = [-0.35, 0, 0.5, 1.5],
  AZIMUTHS = Array.from({ length: 8 }, (_, k) => (k * Math.PI) / 4),
  TENTHS = 10;

// The crown cut into tenths of its height, top first. Per tenth: the side gap fraction (the sky inside each row's own
// outline, eight level views) and, over the conifer-lod views (four elevations, eight sides), the mean snow cover and
// luminance of the surface seen there.
function tenths(canopy) {
  const p = canopy.positions;
  let low = Infinity,
    high = -Infinity;
  for (let i = 1; i < p.length; i += 3) {
    low = Math.min(low, p[i]);
    high = Math.max(high, p[i]);
  }
  const tenth = (y) => Math.min(TENTHS - 1, Math.floor(((high - y) / (high - low)) * TENTHS)),
    sums = Array.from({ length: TENTHS }, () => ({ inside: 0, covered: 0, cells: 0, snow: 0, luminance: 0 }));
  for (const az of AZIMUTHS)
    for (const el of ELEVATIONS) {
      const image = view(canopy, az, el);
      if (el === 0)
        for (let y = 0; y < image.H; y++) {
          const h = (y + 0.5) * CELL - 4;
          if (h < low || h > high) continue;
          let lo = -1,
            hi = -1;
          for (let x = 0; x < image.W; x++)
            if (image.depth[y * image.W + x] > -Infinity) {
              if (lo < 0) lo = x;
              hi = x;
            }
          const each = sums[tenth(h)];
          for (let x = lo; lo >= 0 && x <= hi; x++) {
            each.inside++;
            if (image.depth[y * image.W + x] > -Infinity) each.covered++;
          }
        }
      for (let i = 0; i < image.W * image.H; i++)
        if (image.depth[i] > -Infinity) {
          const each = sums[tenth(image.height[i])];
          each.cells++;
          each.snow += image.snow[i];
          each.luminance += image.shade[i];
        }
    }
  return {
    low,
    high,
    rows: sums.map((each) => ({
      gap: 1 - each.covered / each.inside,
      snow: each.snow / each.cells,
      luminance: each.luminance / each.cells,
      sums: each,
    })),
  };
}

// The largest triangle of `canopy` whose vertices all lie at or above `from` (or all below it with `below`).
function largestTriangle(canopy, from, below = false) {
  const { positions: p, indices: I } = canopy;
  let largest = 0;
  for (let t = 0; t < I.length; t += 3) {
    const [a, b, c] = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3];
    if ([a, b, c].some((v) => (p[v + 1] >= from) === below)) continue;
    const e = [0, 1, 2].map((k) => p[b + k] - p[a + k]),
      f = [0, 1, 2].map((k) => p[c + k] - p[a + k]);
    largest = Math.max(largest, Math.hypot(e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]) / 2);
  }
  return largest;
}

test('the top tenth of a spruce crown has the needle colour, snow and gaps of the tiers below, near and coarse', () => {
  for (const detail of [2, 1])
    for (const shoots of [true, 'coarse']) {
      const canopy = generateTreeMesh('conifer', { branches: true, shoots, detail }).canopy,
        { low, high, rows } = tenths(canopy),
        // The tiers: every tenth below the top but the lowest, where the bottom whorl's tips hang into open air.
        tiers = rows.slice(1, TENTHS - 1);
      for (const key of ['gap', 'snow', 'luminance']) {
        // The top tenth reads as one more tenth of the tiers: it lies within the range their tenths span, the crown's
        // own change from one tenth of its height to the next (the conifer-lod rule, a tree's own variation, applied
        // down the crown instead of round it).
        const values = tiers.map((row) => row[key]),
          least = Math.min(...values),
          most = Math.max(...values),
          top = rows[0][key];
        assert.ok(
          top >= least && top <= most,
          `detail ${detail}, shoots ${shoots}, ${key}: top tenth ${top.toFixed(3)}, the tiers' tenths ${least.toFixed(3)} to ${most.toFixed(3)}`,
        );
      }
      // No solid cone faces: no triangle of the top tenth is larger than the tiers' largest shoot triangle.
      const cut = high - (high - low) / TENTHS;
      assert.ok(largestTriangle(canopy, cut) <= largestTriangle(canopy, cut, true), `detail ${detail}, shoots ${shoots}: a solid face at the top`);
      // The leader reaches the crown top it reached before, so a tree's height and scale stay as they were.
      assert.ok(Math.abs(high - 8.55) < 0.01, `detail ${detail}, shoots ${shoots}: top ${high.toFixed(3)} m`);
    }
});

test('the plain sprays carry the same top: the leader is a shoot, not a cone', () => {
  for (const detail of [2, 1]) {
    const canopy = generateTreeMesh('conifer', { branches: true, detail }).canopy,
      { low, high, rows } = tenths(canopy),
      cut = high - (high - low) / TENTHS;
    assert.ok(rows[0].snow > 0.5, `detail ${detail}: top tenth snow ${rows[0].snow.toFixed(3)}`);
    assert.ok(largestTriangle(canopy, cut) <= largestTriangle(canopy, cut, true), `detail ${detail}: a solid face at the top`);
  }
});
