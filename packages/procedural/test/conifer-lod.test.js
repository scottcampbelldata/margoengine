// KB-CABIN-FGTREE3: Cabin Hearth's near spruce (its shoots, within `shootDistance`) and the spruces behind the cabin
// (the plain sprays) looked like two species: the plain sprays cover all of their outline where the shoots cover about
// half, so a tree changed as it crossed 30 m. A placed spruce's trunk was 0.55 m across at breast height on a 7.6 m tree,
// about seven times a measured spruce's. The far level is now the same branches coarse, keeping the shoots' coverage,
// normals and snow (the level of detail rule for aggregate geometry: Cook, Halstead, Planck and Ryu 2007; Lacewell,
// Edwards, Shirley and Thompson 2006; Bruneton and Neyret 2012; Deussen, Colditz, Stamminger and Drettakis 2002); the
// trunk follows Näslund's height curve for Norway spruce (Siipilehto 2000); and the shoots are as dense as a measured
// spruce crown's needle area leaves its gaps (Pokorný and Tomášková 2007; Smolander and Stenberg 2003; Nilson 1971).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { generateTreeMesh } from '../dist/index.js';
import { createTree, spruceDiameter, SPRUCE_HEIGHT_CURVE } from '../dist/tree.js';
import { view } from './fixtures/conifer-view.js';

const CELL = 0.02;
// Coverage and mean luminance inside the reference view's row span (its outline, row by row).
function measure(image, outline) {
  let inside = 0,
    covered = 0,
    sum = 0;
  for (let y = 0; y < outline.H; y++) {
    let lo = -1,
      hi = -1;
    for (let x = 0; x < outline.W; x++)
      if (outline.depth[y * outline.W + x] > -Infinity) {
        if (lo < 0) lo = x;
        hi = x;
      }
    for (let x = lo; lo >= 0 && x <= hi; x++) {
      inside++;
      const i = y * outline.W + x;
      if (image.depth[i] > -Infinity) {
        covered++;
        sum += image.shade[i];
      }
    }
  }
  return { coverage: covered / inside, luminance: sum / inside };
}
const ELEVATIONS = [-0.35, 0, 0.5, 1.5],
  AZIMUTHS = Array.from({ length: 8 }, (_, k) => (k * Math.PI) / 4);

test('the coarse far level keeps the shoots coverage, colour and snow from every side', () => {
  for (const detail of [2, 1]) {
    const near = generateTreeMesh('conifer', { branches: true, shoots: true, detail }).canopy,
      coarse = generateTreeMesh('conifer', { branches: true, shoots: 'coarse', detail }).canopy,
      plain = generateTreeMesh('conifer', { branches: true, detail }).canopy;
    const results = ELEVATIONS.map((el) =>
      AZIMUTHS.map((az) => {
        const reference = view(near, az, el);
        return {
          near: measure(reference, reference),
          coarse: measure(view(coarse, az, el), reference),
          plain: measure(view(plain, az, el), reference),
        };
      }),
    );
    for (const key of ['coverage', 'luminance']) {
      // The tolerance is the near tree's own change when it is turned 45 degrees about its trunk, its largest over the
      // eight turns and four elevations: a switch of level then changes the tree no more than walking an eighth of the
      // way round it does.
      let own = 0;
      for (const views of results)
        views.forEach((each, k) => (own = Math.max(own, Math.abs(views[(k + 1) % 8].near[key] / each.near[key] - 1))));
      results.forEach((views, e) => {
        let worst = 0,
          plainWorst = 0;
        for (const each of views) {
          worst = Math.max(worst, Math.abs(each.coarse[key] / each.near[key] - 1));
          plainWorst = Math.max(plainWorst, Math.abs(each.plain[key] / each.near[key] - 1));
        }
        const label = `detail ${detail}, elevation ${ELEVATIONS[e]}, ${key}`;
        assert.ok(
          worst <= own,
          `${label}: coarse differs by ${(worst * 100).toFixed(2)}%, a 45 degree turn by ${(own * 100).toFixed(2)}%`,
        );
        // The plain sprays fail the same bound many times over: what the coarse level replaces.
        assert.ok(plainWorst > 4 * own, `${label}: plain sprays differ by ${(plainWorst * 100).toFixed(1)}%`);
      });
    }
    // The coarse level costs under a sixth of the shoots' triangles at detail 2 (its laterals 1.5 times as far apart),
    // under 40 percent at detail 1 (the shoots' own laterals without their needle teeth).
    assert.ok(
      coarse.indices.length < near.indices.length / (detail === 2 ? 6 : 2.5),
      `detail ${detail}: ${coarse.indices.length / 3} triangles`,
    );
  }
  assert.throws(() => generateTreeMesh('conifer', { branches: true, shoots: 'far' }), RangeError);
});

// Side-view gap fraction of a canopy inside its own crown envelope (the plain sprays' radius about the bent axis per
// 5 cm of height), and the gap Poisson's law gives through the same chords for a silhouette density k per metre.
function sideGap(canopy, envelopeOf, k) {
  const radius = new Map(),
    ep = envelopeOf.positions;
  for (let i = 0; i < ep.length; i += 3) {
    const y = ep[i + 1],
      band = Math.floor(y / 0.05);
    radius.set(
      band,
      Math.max(radius.get(band) ?? 0, Math.hypot(ep[i] - y * y * 0.008, ep[i + 2] - Math.sin(y * 0.7) * 0.1)),
    );
  }
  let cells = 0,
    covered = 0,
    poisson = 0;
  for (const az of AZIMUTHS) {
    const image = view(canopy, az, 0),
      [c, s] = [Math.cos(az), Math.sin(az)];
    for (let y = 0; y < image.H; y++)
      for (let x = 0; x < image.W; x++) {
        const wx = (x + 0.5) * CELL - 3,
          wy = (y + 0.5) * CELL - 4,
          r = radius.get(Math.floor(wy / 0.05)) ?? 0,
          // The axis's offset across this view at that height.
          off = wx - (wy * wy * 0.008 * c - Math.sin(wy * 0.7) * 0.1 * s);
        if (Math.abs(off) >= r) continue;
        cells++;
        if (image.depth[y * image.W + x] > -Infinity) covered++;
        poisson += Math.exp(-k * 2 * Math.sqrt(r * r - off * off));
      }
  }
  return { gap: 1 - covered / cells, poisson: poisson / cells };
}

test('the shoots leave the gaps a measured spruce crown leaves', () => {
  // A young Norway spruce (Pokorný and Tomášková 2007, 34 trees of 7.0 +- 0.2 m, 8.4 +- 0.4 cm): total needle area
  // 1.1083 H^1.9771 or 12.79 dbh - 50.65 m2, a conical crown 6.5 +- 0.5 m long and 2.5 +- 0.2 m across. Its shoots'
  // spherically averaged silhouette is STAR = (1 - p) / 4 of their needle area, p = 0.47 the shoot's photon recollision
  // probability (Smolander and Stenberg 2003). The silhouette density k = STAR x needle area / crown volume; through
  // a chord s the gap is e^(-k s) for shoots placed at random in the crown (Nilson 1971).
  const star = (1 - 0.47) / 4,
    densities = [];
  for (const area of [1.1083 * 7 ** 1.9771, 12.79 * 8.4 - 50.65])
    for (const across of [2.3, 2.7])
      for (const length of [6.0, 7.0]) densities.push((star * area) / ((Math.PI * (across / 2) ** 2 * length) / 3));
  const plain = generateTreeMesh('conifer', { branches: true }).canopy,
    near = generateTreeMesh('conifer', { branches: true, shoots: true }).canopy,
    coarse = generateTreeMesh('conifer', { branches: true, shoots: 'coarse' }).canopy,
    low = sideGap(near, plain, Math.max(...densities)).poisson,
    high = sideGap(near, plain, Math.min(...densities)).poisson;
  assert.ok(low > 0.2 && high < 0.5, `the measured range ${low.toFixed(3)} to ${high.toFixed(3)}`);
  for (const [name, canopy] of [
    ['shoots', near],
    ['coarse', coarse],
  ]) {
    const { gap } = sideGap(canopy, plain, densities[0]);
    assert.ok(
      gap >= low && gap <= high,
      `${name}: side gap ${gap.toFixed(3)} against ${low.toFixed(3)} to ${high.toFixed(3)}`,
    );
  }
  // The plain sprays are far denser than any measured crown.
  assert.ok(sideGap(plain, plain, densities[0]).gap < low);
});

test('a placed spruce stands on the stem Näslund height curve gives its height', async () => {
  using engine = new Engine({ width: 10, height: 10 }, await TransformStore.create(64), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
  engine.store.tick();
  const { a, b } = SPRUCE_HEIGHT_CURVE;
  assert.deepEqual([a, b], [1.811, 0.308]);
  // The curve itself: h = 1.3 + d^3 / (a + b d)^3, d in cm.
  for (const height of [2, 5, 7.6, 12, 18, 25]) {
    const d = spruceDiameter(height) * 100;
    assert.ok(Math.abs(1.3 + d ** 3 / (a + b * d) ** 3 - height) < 1e-9, `${height} m`);
  }
  // The measured young spruces, 7.0 m and 8.4 cm (Pokorný and Tomášková 2007): the curve gives 7.2 cm, inside the
  // spread of their stand (dbh correlates with height at r2 0.73).
  assert.ok(Math.abs(spruceDiameter(7) - 0.072) < 0.001);
  // Outside the fitted heights, in proportion to the height.
  assert.ok(Math.abs(spruceDiameter(1) - spruceDiameter(2) / 2) < 1e-12);
  assert.ok(Math.abs(spruceDiameter(50) - 2 * spruceDiameter(25)) < 1e-12);
  for (const bad of [0, -1, NaN, Infinity]) assert.throws(() => spruceDiameter(bad), RangeError);
  // The placed tree's trunk at 1.3 m of its own height: its diameter on the bent axis, rings straight between.
  const diameterAt = (geometry, y) => {
    const rings = new Map(),
      g = geometry.vertices;
    for (let i = 0; i < g.length; i += 6) {
      const h = Math.round(g[i + 1] * 1e4) / 1e4;
      rings.set(h, Math.max(rings.get(h) ?? 0, Math.hypot(g[i] - h * h * 0.008, g[i + 2] - Math.sin(h * 0.7) * 0.1)));
    }
    const heights = [...rings.keys()].sort((u, v) => u - v),
      k = heights.findIndex((h) => h >= y - 1e-4);
    if (Math.abs(heights[k] - y) <= 1e-4) return 2 * rings.get(heights[k]);
    const lo = heights[k - 1],
      hi = heights[k];
    return 2 * (rings.get(lo) + ((rings.get(hi) - rings.get(lo)) * (y - lo)) / (hi - lo));
  };
  const { trunk, canopy } = generateTreeMesh('conifer', { branches: true }),
    top = Math.max(...[trunk, canopy].flatMap((part) => [...part.positions].filter((_, i) => i % 3 === 1)));
  for (const height of [undefined, 5, 7.6, 12, 20]) {
    using tree = createTree(engine, 'conifer', { height });
    engine.store.tick();
    const scale = engine.store.matrices[tree.root.id * 16 + 5],
      measured = diameterAt(tree.trunk.geometry, 1.3 / scale) * scale,
      want = spruceDiameter(height ?? top);
    // Trunks are shared to the millimetre of the mesh and the breast-height ring to the centimetre.
    assert.ok(
      Math.abs(measured / want - 1) < 0.03,
      `${height ?? top} m: ${measured.toFixed(4)} m against ${want.toFixed(4)} m`,
    );
  }
  // The default tree: under 9 cm, where the historical mesh trunk was 0.55 m.
  using standard = createTree(engine, 'conifer');
  engine.store.tick();
  assert.ok(diameterAt(standard.trunk.geometry, 1.3) < 0.09);
  // `diameter` sets it; generateTreeMesh's `breastDiameter` in mesh metres; a broadleaf keeps its trunk by default.
  using thick = createTree(engine, 'conifer', { height: 10, diameter: 0.3 });
  engine.store.tick();
  const s = engine.store.matrices[thick.root.id * 16 + 5];
  assert.ok(Math.abs(diameterAt(thick.trunk.geometry, 1.3 / s) * s - 0.3) < 0.005);
  for (const diameter of [0, 4, NaN, '0.2'])
    assert.throws(() => createTree(engine, 'conifer', { diameter }), { code: 'failed' });
  const mesh = generateTreeMesh('conifer', { flare: 1.3, breastDiameter: 0.1 }).trunk;
  const pts = { vertices: new Float32Array((mesh.positions.length / 3) * 6) };
  for (let i = 0; i < mesh.positions.length / 3; i++)
    pts.vertices.set(mesh.positions.subarray(i * 3, i * 3 + 3), i * 6);
  assert.ok(Math.abs(diameterAt(pts, 1.3) - 0.1) < 0.001);
  for (const breastDiameter of [0.001, 5])
    assert.throws(() => generateTreeMesh('conifer', { breastDiameter }), RangeError);
  using oak = createTree(engine, 'broadleaf');
  assert.equal(oak.trunk.geometry.vertices.length / 6, generateTreeMesh('broadleaf').trunk.positions.length / 3);
});
