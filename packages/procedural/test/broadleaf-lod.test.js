// Broadleaf levels of detail (@margoengine/procedural/broadleaves): the middle ring keeps the near tree's coverage and
// colour from every side, as the conifer rule has it (test/conifer-lod.test.js): within the near tree's own change when
// it is turned 45 degrees about its trunk. Aggregate geometry is simplified by stratified pruning on visibility: each
// foliage mass keeps cards in proportion to what it shows, one card a cell of equal visibility, its size solved so the
// mass shows as much as before (Cook, Halstead, Planck and Ryu 2007, "Stochastic simplification of aggregate detail";
// Neubert, Pirk, Deussen and Dachsbacher 2011). Every fourth card grown at one width failed it on the open-grown oak:
// at 2.25 times the side the coverage was 9.0 percent off, at 1.9 the coverage passed and the luminance was 7.5. The
// far ring is an
// imposter of three baked views (Behrendt, Colditz, Franzke, Kopf and Deussen 2005; Bruneton and Neyret 2012).
//
// KB-PROCEDURAL-OAKIMPOSTER1 (docs/known-bugs.md): the imposter does not meet that bound; its measured error is the
// ceiling asserted below, kept as a regression guard until it is fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { broadleafLevels } from '../dist/broadleaves.js';
import { AZIMUTHS, ELEVATIONS, view } from './fixtures/crown-view.js';

// Coverage and mean luminance inside the reference view's row span (its outline, row by row).
function measure(image, outline) {
  let inside = 0,
    covered = 0,
    sum = 0;
  for (let y = 0; y < outline.H; y++) {
    let lo = -1,
      hi = -1;
    for (let x = 0; x < outline.W; x++)
      if (outline.kind[y * outline.W + x]) {
        if (lo < 0) lo = x;
        hi = x;
      }
    for (let x = lo; lo >= 0 && x <= hi; x++) {
      inside++;
      const i = y * outline.W + x;
      if (image.kind[i]) {
        covered++;
        sum += image.lum[i];
      }
    }
  }
  return { coverage: covered / inside, luminance: sum / inside };
}

function measures(seed) {
  const l = broadleafLevels('english-oak', { seed }),
    f = l.form,
    radius = (f.crownWidth / 2) * 1.1,
    extent = Math.max(f.height / 2, radius) * 1.05,
    image = l.textures.baseColor,
    // Near and middle rings take the occlusion term the imposter has baked in.
    rings = [
      [
        { geometry: l.trunk[0], occlude: true },
        { geometry: l.canopy[0], atlas: image, occlude: true },
      ],
      [
        { geometry: l.trunk[1], occlude: true },
        { geometry: l.canopy[1], atlas: image, occlude: true },
      ],
      [{ geometry: l.canopy[2], atlas: image }],
    ];
  return ELEVATIONS.map((el) =>
    AZIMUTHS.map((az) => {
      const views = rings.map((parts) => view(parts, az, el, extent, f.height / 2, radius));
      return views.map((v) => measure(v, views[0]));
    }),
  );
}

test('the middle ring keeps the near coverage and colour from every side, within a 45 degree turn of the near tree', () => {
  // Measured 2026-11-28 (worst of 24 views, then the near tree's own 45 degree change): seed 1 coverage 2.19 of 5.28
  // percent, luminance 2.54 of 4.71; seed 2 2.41 of 4.48 and 1.76 of 4.81; seed 3 1.88 of 4.50 and 2.98 of 7.70.
  for (const seed of [1, 2, 3]) {
    const results = measures(seed);
    for (const key of ['coverage', 'luminance']) {
      // The tolerance is the near tree's own change when turned 45 degrees about its trunk, its largest over the eight
      // turns and three elevations.
      let own = 0;
      for (const views of results)
        views.forEach((each, k) => (own = Math.max(own, Math.abs(views[(k + 1) % 8][0][key] / each[0][key] - 1))));
      let worst = 0;
      for (const views of results)
        for (const each of views) worst = Math.max(worst, Math.abs(each[1][key] / each[0][key] - 1));
      assert.ok(
        worst <= own,
        `seed ${seed}: middle ${key} differs by ${(worst * 100).toFixed(2)}%, a 45 degree turn by ${(own * 100).toFixed(2)}%`,
      );
    }
  }
});

test('the middle ring is the same for the same seed and stays under 4,000 triangles with its wood', () => {
  const a = broadleafLevels('english-oak', { seed: 2 }),
    b = broadleafLevels('english-oak', { seed: 2 });
  assert.deepEqual(a.canopy[1].positions, b.canopy[1].positions);
  assert.deepEqual(a.canopy[1].uvs, b.canopy[1].uvs);
  assert.ok((a.canopy[1].indices.length + a.trunk[1].indices.length) / 3 <= 4000);
  // About one card in five of the near ring's (four triangles a card, both faces).
  const ratio = a.canopy[0].indices.length / a.canopy[1].indices.length;
  assert.ok(ratio > 4 && ratio < 6, `near over middle cards ${ratio}`);
});

test('the imposter keeps the near tree within its measured error from every side', () => {
  const results = measures(1);
  // Measured 2026-11-28: coverage -14 to +9 percent, luminance -22 to +9 percent against the near tree over the 24
  // views (a 45 degree turn of the near tree changes it by 9.3 and 9.9 percent). Three vertical cards, each with its
  // own baked view, show the union of oblique cards from between them and lose the dome from above.
  for (const [key, ceiling] of [
    ['coverage', 0.16],
    ['luminance', 0.25],
  ]) {
    let worst = 0;
    for (const views of results)
      for (const each of views) worst = Math.max(worst, Math.abs(each[2][key] / each[0][key] - 1));
    assert.ok(worst <= ceiling, `imposter ${key} differs by ${(worst * 100).toFixed(1)}%`);
  }
});

test('the imposter is three cards at 60 degrees, each on its own baked view, the near tree as tall', () => {
  const l = broadleafLevels('english-oak'),
    near = l.canopy[0],
    imp = l.canopy[2],
    top = (g) => {
      let y = 0;
      for (let k = 1; k < g.positions.length; k += 3) y = Math.max(y, g.positions[k]);
      return y;
    },
    image = l.textures.baseColor;
  assert.equal(imp.indices.length / 3, 72);
  // Cards as tall as the stem and crown together, and no wider than the crown.
  let stem = 0;
  for (let k = 1; k < l.trunk[0].positions.length; k += 3) stem = Math.max(stem, l.trunk[0].positions[k]);
  assert.ok(Math.abs(top(imp) - Math.max(stem, top(near))) < 1e-3, 'cards as tall as the tree');
  // Every card's uvs fall in its own tile of the lower half of the image (2 by 2 tiles); the baked views have both
  // covered and empty texels, with the stem drawn at the ground.
  const tiles = new Set();
  for (let k = 0; k < imp.uvs.length; k += 2) {
    const u = imp.uvs[k],
      v = imp.uvs[k + 1];
    assert.ok(v >= 0.5 && v <= 1 && u >= 0 && u <= 1);
    tiles.add(`${Math.floor(u * 2)},${Math.floor((v - 0.5) * 4)}`);
  }
  assert.equal(tiles.size, 3);
  const half = image.width / 2;
  for (const [tx, ty] of [
    [0, 0],
    [1, 0],
    [0, 1],
  ]) {
    let covered = 0,
      empty = 0;
    for (let y = 0; y < half; y++)
      for (let x = 0; x < half; x++) {
        const a = image.data[((image.width + ty * half + y) * image.width + tx * half + x) * 4 + 3];
        if (a === 255) covered++;
        else empty++;
      }
    assert.ok(covered > half * half * 0.1 && empty > half * half * 0.1, `tile ${tx},${ty}: ${covered} covered`);
  }
});
