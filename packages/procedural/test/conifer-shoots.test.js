// KB-CABIN-FGTREE2: a spruce branch seen from 1 to 3 m. Cabin Hearth's foreground spruce drew each branch as one smooth,
// solid, tapered spray, so up close its branches crossed the frame as big dark blades; and its trunk stood on a flare
// twice its breast-height diameter. The package now builds a near conifer's sprays as shoots (a twig axis, lateral
// shoots and serrated needle fringes with the sky between them), switches to them within `shootDistance` of the camera,
// and gives a conifer the measured spruce butt flare.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { generateTreeMesh } from '../dist/index.js';
import { createTree, SPRUCE_FLARE } from '../dist/tree.js';

const CELL = 0.01;
// Top-down coverage of the lowest whorl (triangles centred below 3.1 m) on a 1 cm grid over [-2.6, 2.6] m.
function coverage(canopy) {
  const p = canopy.positions,
    I = canopy.indices,
    side = Math.round(5.2 / CELL),
    grid = new Uint8Array(side * side);
  for (let t = 0; t < I.length; t += 3) {
    const v = [I[t], I[t + 1], I[t + 2]].map((i) => [
      (p[i * 3] + 2.6) / CELL,
      (p[i * 3 + 2] + 2.6) / CELL,
      p[i * 3 + 1],
    ]);
    if ((v[0][2] + v[1][2] + v[2][2]) / 3 > 3.1) continue;
    const area = (v[1][0] - v[0][0]) * (v[2][1] - v[0][1]) - (v[1][1] - v[0][1]) * (v[2][0] - v[0][0]);
    if (!area) continue;
    const x0 = Math.max(0, Math.floor(Math.min(v[0][0], v[1][0], v[2][0]))),
      x1 = Math.min(side - 1, Math.ceil(Math.max(v[0][0], v[1][0], v[2][0]))),
      y0 = Math.max(0, Math.floor(Math.min(v[0][1], v[1][1], v[2][1]))),
      y1 = Math.min(side - 1, Math.ceil(Math.max(v[0][1], v[1][1], v[2][1])));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5,
          py = y + 0.5,
          a = ((v[1][0] - px) * (v[2][1] - py) - (v[1][1] - py) * (v[2][0] - px)) / area,
          b = ((v[2][0] - px) * (v[0][1] - py) - (v[2][1] - py) * (v[0][0] - px)) / area;
        if (a >= 0 && b >= 0 && a + b <= 1) grid[y * side + x] = 1;
      }
  }
  return { grid, side };
}
// Share of covered cells on the silhouette's edge (a 4-neighbour open): the edge length per area at the cell size.
function edgeShare({ grid, side }) {
  let covered = 0,
    edge = 0;
  for (let y = 1; y < side - 1; y++)
    for (let x = 1; x < side - 1; x++) {
      const i = y * side + x;
      if (!grid[i]) continue;
      covered++;
      if (!grid[i - 1] || !grid[i + 1] || !grid[i - side] || !grid[i + side]) edge++;
    }
  return edge / covered;
}

test('a near spray is a branch of shoots: sky inside its outline and a ragged, needle-edged silhouette', () => {
  const plain = coverage(generateTreeMesh('conifer', { branches: true }).canopy),
    shoots = coverage(generateTreeMesh('conifer', { branches: true, shoots: true }).canopy);
  let outline = 0,
    open = 0,
    outside = 0;
  for (let i = 0; i < plain.grid.length; i++) {
    if (plain.grid[i]) {
      outline++;
      if (!shoots.grid[i]) open++;
    } else if (shoots.grid[i]) outside++;
  }
  // The plain sprays are solid: none of their outline is sky. The shoots part, with lateral shoots 0.2 m apart on
  // each side of the axis and needle bands 4 to 8 cm wide, leave about half of it open; at least 30 percent, and the
  // branch still fills a fifth of its outline.
  const gaps = open / outline;
  assert.ok(gaps >= 0.3 && gaps <= 0.8, `sky inside the sprays' outline: ${gaps.toFixed(3)}`);
  assert.ok(outside / outline < 0.05, `the shoots stay inside the plain outline: ${(outside / outline).toFixed(3)}`);
  // A band of needles w wide puts about 2 cell / w of its cells on its edge; the widest band, the axis at the trunk,
  // is 2 x (12 + 30) mm. Half of that edge density is the floor; a smooth blade 0.6 m wide has about a tenth of it.
  const floor = (2 * CELL) / (2 * (0.012 + 0.03)) / 2,
    ragged = edgeShare(shoots),
    smooth = edgeShare(plain);
  assert.ok(ragged >= floor, `edge share of the shoots ${ragged.toFixed(3)} against ${floor.toFixed(3)}`);
  assert.ok(smooth < floor / 2, `edge share of the plain sprays ${smooth.toFixed(3)}`);
  // Detail 1 keeps shoots and gaps with fewer triangles.
  const mid = generateTreeMesh('conifer', { branches: true, shoots: true, detail: 1 }).canopy,
    full = generateTreeMesh('conifer', { branches: true, shoots: true }).canopy;
  assert.ok(mid.indices.length < full.indices.length / 2, 'detail 1 has under half the shoots triangles');
  assert.ok(edgeShare(coverage(mid)) >= floor, 'detail 1 keeps the needle edge');
  // Shoots apply to the branch whorls only.
  assert.deepEqual(generateTreeMesh('conifer', { shoots: true }), generateTreeMesh('conifer'));
  assert.deepEqual(generateTreeMesh('broadleaf', { shoots: true }), generateTreeMesh('broadleaf'));
});

test('the shoots face up and keep the needle tilt', () => {
  const n = generateTreeMesh('conifer', { branches: true, shoots: true }).canopy.normals;
  let up = 0;
  for (let i = 0; i < n.length; i += 3) {
    assert.ok(Math.abs(Math.hypot(n[i], n[i + 1], n[i + 2]) - 1) < 1e-5, 'unit normals');
    if (n[i + 1] > 0) up++;
  }
  assert.ok(up / (n.length / 3) > 0.85, `most normals face the sky (${(up / (n.length / 3)).toFixed(3)})`);
});

test('createTree shows the shoots near the camera and the coarse shoots far away, with hysteresis', async () => {
  const store = await TransformStore.create(256);
  using engine = new Engine({ width: 10, height: 10 }, store, {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
  const near = generateTreeMesh('conifer', { branches: true, shoots: true, flare: SPRUCE_FLARE }).canopy.indices.length,
    far = generateTreeMesh('conifer', { branches: true, shoots: 'coarse', flare: SPRUCE_FLARE }).canopy.indices.length,
    plain = generateTreeMesh('conifer', { branches: true, flare: SPRUCE_FLARE }).canopy.indices.length;
  engine.camera.position = [0, 1.7, 0];
  const a = createTree(engine, 'conifer', { position: [3, 0, 0], height: 11 }),
    b = createTree(engine, 'conifer', { position: [80, 0, 0], height: 11 });
  assert.equal(a.canopy.geometry.indices.length, near, 'a tree 3 m away shows its shoots');
  assert.equal(b.canopy.geometry.indices.length, far, 'a tree 80 m away shows the coarse shoots (KB-CABIN-FGTREE3)');
  // One geometry per shape, shared by every tree of that shape.
  assert.equal(a.trunk.geometry, b.trunk.geometry);
  // The camera walks to 31 m from a: still shoots (10 percent hysteresis), then 34 m: plain; b at 29 m: shoots.
  engine.camera.position = [34, 1.7, 0];
  engine.render();
  assert.equal(a.canopy.geometry.indices.length, near, 'hysteresis keeps the shoots at 31 m');
  assert.equal(b.canopy.geometry.indices.length, far, 'b is 46 m away');
  engine.camera.position = [37.1, 1.7, 0];
  engine.render();
  assert.equal(a.canopy.geometry.indices.length, far, 'beyond 33 m the coarse shoots');
  engine.camera.position = [51, 1.7, 0];
  engine.render();
  assert.equal(b.canopy.geometry.indices.length, near, 'b at 29 m shows its shoots');
  a.dispose();
  engine.camera.position = [200, 1.7, 0];
  engine.render();
  assert.equal(b.canopy.geometry.indices.length, far);
  b.dispose();
  // shootDistance 0 never and Infinity (or shoots: true) always; a broadleaf has no shoots.
  engine.camera.position = [0, 1.7, 0];
  using never = createTree(engine, 'conifer', { position: [1, 0, 0], shootDistance: 0 });
  assert.equal(never.canopy.geometry.indices.length, far);
  using always = createTree(engine, 'conifer', { position: [500, 0, 0], shootDistance: Infinity });
  assert.equal(always.canopy.geometry.indices.length, near);
  using forced = createTree(engine, 'conifer', { position: [1, 0, 0], shoots: false });
  assert.equal(forced.canopy.geometry.indices.length, plain, 'shoots: false keeps the plain sprays');
  using coarse = createTree(engine, 'conifer', { position: [1, 0, 0], shoots: 'coarse' });
  assert.equal(coarse.canopy.geometry.indices.length, far);
  for (const shootDistance of [-1, NaN, '30'])
    assert.throws(() => createTree(engine, 'conifer', { shootDistance }), { code: 'failed' });
  assert.equal(engine.meshes.size, 12);
});

// Trunk radius at height y of trunk positions [x, y, z][]: rings are polygons round the bent axis, straight between rings.
function radiusAt(points, y) {
  const rings = new Map();
  for (const [x, h0, z] of points) {
    const h = Math.round(h0 * 1e4) / 1e4,
      r = Math.hypot(x - h * h * 0.008, z - Math.sin(h * 0.7) * 0.1);
    rings.set(h, Math.max(rings.get(h) ?? 0, r));
  }
  const heights = [...rings.keys()].sort((u, v) => u - v),
    k = heights.findIndex((h) => h >= y - 1e-4);
  if (Math.abs(heights[k] - y) <= 1e-4) return rings.get(heights[k]);
  const lo = heights[k - 1],
    hi = heights[k];
  return rings.get(lo) + ((rings.get(hi) - rings.get(lo)) * (y - lo)) / (hi - lo);
}
const points = (d) =>
    Array.from({ length: d.positions.length / 3 }, (_, i) => [...d.positions.subarray(i * 3, i * 3 + 3)]),
  vertices = (g) => Array.from({ length: g.vertices.length / 6 }, (_, i) => [...g.vertices.subarray(i * 6, i * 6 + 3)]);

test('a conifer stands on the measured spruce butt flare, at every height', async () => {
  using engine = new Engine({ width: 10, height: 10 }, await TransformStore.create(64), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
  engine.store.tick();
  // Repola 2009 (stump diameter 2 + 1.25 d: 1.30 to 1.45) and Wharton 1984 (1.10 to 1.20 inside the bark at a 1 ft
  // stump): a spruce's diameter at the ground is 1.15 to 1.45 times its diameter at breast height, 1.3 m up.
  for (const height of [5, 8.24, 10.97, 12, 30]) {
    using tree = createTree(engine, 'conifer', { height });
    engine.store.tick();
    const scale = engine.store.matrices[tree.root.id * 16 + 5],
      trunk = vertices(tree.trunk.geometry),
      ratio = radiusAt(trunk, 0) / radiusAt(trunk, 1.3 / scale);
    assert.ok(
      Math.abs(ratio - SPRUCE_FLARE) < 0.02,
      `${height} m: ground over breast-height diameter ${ratio.toFixed(3)}`,
    );
    assert.ok(ratio >= 1.15 && ratio <= 1.45);
  }
  // The historical trunk, still generateTreeMesh's default, stands on about twice its breast-height diameter.
  const old = points(generateTreeMesh('conifer', { branches: true }).trunk);
  assert.ok(radiusAt(old, 0) / radiusAt(old, 1.3) > 2, 'the unflared default keeps its historical ring');
  assert.equal(SPRUCE_FLARE, 1.3);
  // Flare 1 has no swell; the swell is gone by breast height.
  const none = points(generateTreeMesh('conifer', { flare: 1 }).trunk),
    flared = points(generateTreeMesh('conifer', { flare: 1.3 }).trunk);
  assert.ok(Math.abs(radiusAt(none, 0) / radiusAt(none, 1.3) - 1) < 0.005, 'flare 1');
  assert.ok(radiusAt(flared, 1.3) / radiusAt(none, 1.3) < 1.01, 'the swell dies away below breast height');
  const at2 = points(generateTreeMesh('conifer', { flare: 1.3, breastHeight: 2 }).trunk);
  assert.ok(Math.abs(radiusAt(at2, 0) / radiusAt(at2, 2) - 1.3) < 0.005, 'breastHeight moves the reference');
  for (const flare of [0.9, 3, NaN]) assert.throws(() => generateTreeMesh('conifer', { flare }), RangeError);
  for (const breastHeight of [0.1, 7])
    assert.throws(() => generateTreeMesh('conifer', { flare: 1.3, breastHeight }), RangeError);
  // createTree takes the option; a broadleaf keeps its trunk unless asked.
  using wide = createTree(engine, 'conifer', { flare: 1.8 });
  const w = vertices(wide.trunk.geometry);
  assert.ok(Math.abs(radiusAt(w, 0) / radiusAt(w, 1.3) - 1.8) < 0.02);
  using oak = createTree(engine, 'broadleaf');
  assert.deepEqual(
    vertices(oak.trunk.geometry),
    points(generateTreeMesh('broadleaf').trunk).map((v) => v.map(Math.fround)),
  );
  for (const flare of [0.5, 9, '1.3'])
    assert.throws(() => createTree(engine, 'conifer', { flare }), { code: 'failed' });
});
