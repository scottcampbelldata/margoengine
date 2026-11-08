// Convex hulls from points on the own solver. The oracle is brute force: every point lies inside every face, every
// direction finds the same farthest point in the hull as in the points, and the kernel takes the faces it is given.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { KernelWorld, Physics, convexHull, loadKernel } from '../dist/next.js';

await Physics.load();

/** The same numbers every run: a linear congruential generator. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Points rounded to f32, as mesh data is. */
const f32 = (points) => Array.from(Float32Array.from(points));

function clouds() {
  const sets = {};
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = random(seed);
    for (const count of [4, 5, 12, 100, 2000]) {
      const cube = [],
        ball = [],
        sphere = [];
      for (let i = 0; i < count; i++) {
        cube.push(r() * 2 - 1, r() * 3 - 1.5, r() - 0.5);
        let x, y, z, l;
        do {
          [x, y, z] = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
          l = x * x + y * y + z * z;
        } while (l > 1 || l < 1e-2);
        ball.push(x, y, z);
        l = Math.sqrt(l);
        sphere.push(x / l, y / l, z / l);
      }
      sets[`cube ${count} #${seed}`] = f32(cube);
      sets[`ball ${count} #${seed}`] = f32(ball);
      sets[`sphere ${count} #${seed}`] = f32(sphere);
    }
  }
  const grid = [];
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) for (let k = 0; k <= 8; k++) grid.push(i / 8, j / 8, k / 8);
  sets.grid = grid;
  // The grid turned and rounded, so its faces hold points a rounding off their planes.
  const [c, s] = [Math.cos(0.3), Math.sin(0.3)];
  sets['turned grid'] = f32(grid.flatMap((_, i) => (i % 3 ? [] : [c * grid[i] - s * grid[i + 1], s * grid[i] + c * grid[i + 1], grid[i + 2]])));
  sets['far grid'] = f32(grid.map((value) => value + 1000));
  sets['tiny grid'] = f32(grid.map((value) => value * 1e-3));
  for (const sides of [3, 7, 64, 255, 256]) {
    const ring = [];
    for (let i = 0; i < sides; i++) {
      const t = (2 * Math.PI * i) / sides;
      ring.push(Math.cos(t), -1, Math.sin(t), Math.cos(t), 1, Math.sin(t));
    }
    sets[`cylinder ${sides}`] = f32(ring);
  }
  const box = [];
  for (const x of [-1, 1]) for (const y of [-2, 2]) for (const z of [-0.5, 0.5]) box.push(x, y, z);
  sets['box with repeats and its middle'] = [...box, ...box, 0, 0, 0, 1, 2, 0.5];
  return sets;
}

/** How far the worst point lies outside a face, as a share of the cloud's size, and the worst gap in support. */
function check(points, hull) {
  const count = points.length / 3,
    low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i++) {
    low[i % 3] = Math.min(low[i % 3], points[i]);
    high[i % 3] = Math.max(high[i % 3], points[i]);
  }
  const size = Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]),
    center = low.map((value, axis) => (value + high[axis]) / 2),
    at = (i) => [points[i * 3] - center[0], points[i * 3 + 1] - center[1], points[i * 3 + 2] - center[2]],
    corner = (v) => hull.vertices[v].map((value, axis) => value - center[axis]);
  // Every corner is one of the points.
  const given = new Set();
  for (let i = 0; i < count; i++) given.add(`${points[i * 3]},${points[i * 3 + 1]},${points[i * 3 + 2]}`);
  for (const vertex of hull.vertices) assert.ok(given.has(vertex.join(',')), `corner ${vertex} is not a given point`);
  const edges = hull.faces.reduce((sum, face) => sum + face.length, 0);
  assert.equal(hull.vertices.length + hull.faces.length - edges / 2, 2, 'Euler: one closed surface');
  let outside = 0;
  for (const face of hull.faces) {
    const n = [0, 0, 0],
      mean = [0, 0, 0];
    for (let i = 0; i < face.length; i++) {
      const a = corner(face[i]),
        b = corner(face[(i + 1) % face.length]);
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
      for (let k = 0; k < 3; k++) mean[k] += a[k] / face.length;
    }
    const length = Math.hypot(...n),
      unit = n.map((value) => value / length),
      offset = unit[0] * mean[0] + unit[1] * mean[1] + unit[2] * mean[2];
    for (let i = 0; i < count; i++) {
      const p = at(i);
      outside = Math.max(outside, (unit[0] * p[0] + unit[1] * p[1] + unit[2] * p[2] - offset) / size);
    }
  }
  // Support: in every direction the farthest corner reaches the farthest point.
  const r = random(99);
  let gap = 0;
  for (let d = 0; d < 200; d++) {
    const u = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1],
      dot = (p) => u[0] * p[0] + u[1] * p[1] + u[2] * p[2];
    let points_ = -Infinity,
      corners = -Infinity;
    for (let i = 0; i < count; i++) points_ = Math.max(points_, dot(at(i)));
    for (let v = 0; v < hull.vertices.length; v++) corners = Math.max(corners, dot(corner(v)));
    gap = Math.max(gap, (points_ - corners) / (Math.hypot(...u) * size));
  }
  return { outside, gap };
}

test('every hull holds its points, reaches its farthest ones, and the kernel takes it', async () => {
  const kernel = new KernelWorld(await loadKernel());
  let worstOutside = 0,
    worstGap = 0;
  for (const [name, points] of Object.entries(clouds())) {
    const hull = convexHull(points),
      { outside, gap } = check(points, hull);
    worstOutside = Math.max(worstOutside, outside);
    worstGap = Math.max(worstGap, gap);
    // The kernel's own FLAT is 1e-4 of the size: what merges stays well inside it.
    assert.ok(outside <= 3e-5, `${name}: a point lies ${outside} of the size outside a face`);
    assert.ok(gap <= 3e-5, `${name}: the hull falls ${gap} of the size short of its points`);
    assert.ok(kernel.addHull(hull.vertices, hull.faces) >= 0, `${name}: the kernel refused it`);
  }
  console.log(`hulls: worst point outside ${worstOutside.toExponential(2)}, worst support gap ${worstGap.toExponential(2)} of the size`);
});

/** The points of `given` in an order drawn from `r`. */
function shuffled(given, count, r) {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.flatMap((i) => [given[i * 3], given[i * 3 + 1], given[i * 3 + 2]]);
}

// Regression (2026-11-07): on these two Thingi10K meshes (tests/fixtures/thingi10k/NOTICE.md) convexHull gave a hull that
// was not convex, a corner 5.5 m above a face, which the kernel then refused as "not convex". A face the eye was a hair
// below counted as seen by its rounded plane, and the cone folded over its neighbour; points in one plane met by rounding
// noise did the same in shuffled orders. Seen-ness now comes from the sign of the volume a point spans with the face's
// corners, beyond its error bound.
test('the hulls of two scanned meshes with large flat faces are convex, hold their points, and the kernel takes them', async () => {
  const kernel = new KernelWorld(await loadKernel());
  for (const id of ['40261', '41940']) {
    const bytes = readFileSync(new URL(`fixtures/thingi10k/${id}-points.bin`, import.meta.url)),
      given = Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)),
      count = given.length / 3,
      r = random(Number(id));
    // The file's order, then shuffled ones: which point comes first changes every step of the build.
    for (let order = 0; order < 8; order++) {
      const points = order ? shuffled(given, count, r) : given,
        hull = convexHull(points),
        { outside, gap } = check(points, hull);
      assert.ok(outside <= 3e-5, `${id} order ${order}: a point lies ${outside} of the size outside a face`);
      assert.ok(gap <= 3e-5, `${id} order ${order}: the hull falls ${gap} of the size short of its points`);
      assert.ok(kernel.addHull(hull.vertices, hull.faces) >= 0, `${id} order ${order}: the kernel refused it`);
    }
    const points = given;
    const physics = new Physics(null);
    physics.addBody(null, { type: 'fixed', colliders: { shape: 'convexHull', points } });
    physics.dispose();
  }
});

test('a box from its corners, repeats and middle has six faces of four', () => {
  const box = [];
  for (const x of [-1, 1]) for (const y of [-2, 2]) for (const z of [-0.5, 0.5]) box.push(x, y, z);
  const hull = convexHull([...box, ...box, 0, 0, 0, 0.5, 1, 0]);
  assert.equal(hull.vertices.length, 8);
  assert.deepEqual(
    hull.faces.map((face) => face.length),
    [4, 4, 4, 4, 4, 4],
  );
});

test('a 256 sided cylinder keeps each cap as one face', () => {
  const ring = [];
  for (let i = 0; i < 256; i++) {
    const t = (2 * Math.PI * i) / 256;
    ring.push(Math.cos(t), -1, Math.sin(t), Math.cos(t), 1, Math.sin(t));
  }
  const hull = convexHull(f32(ring));
  assert.equal(hull.faces.length, 258);
  assert.equal(Math.max(...hull.faces.map((face) => face.length)), 256);
  ring.push(Math.cos(0.01), 1, Math.sin(0.01));
  assert.throws(() => convexHull(ring), /257 corners and the solver takes 256; pass fewer points/);
});

test('points that span no volume are refused with the fix', () => {
  assert.throws(() => convexHull([0, 0, 0, 1, 0, 0, 0, 1, 0]), /at least four/);
  assert.throws(() => convexHull([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1]), /three \(x, y, z\) per point/);
  assert.throws(() => convexHull([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), /all coincide/);
  assert.throws(() => convexHull([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]), /one line/);
  assert.throws(() => convexHull([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 0.5, 0, 0.5]), /one plane/);
  assert.throws(() => convexHull([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, Number.NaN]), /point 3 is not finite/);
});

/** A floor and one hull body dropped onto it. */
function drop(points, options = {}) {
  const physics = new Physics(null),
    floor = physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [20, 0.5, 20] } }),
    body = physics.addBody(null, { position: [0, 3, 0], colliders: { shape: 'convexHull', points, ...options } });
  return { physics, floor, body };
}

test('a hull body falls and rests on its flat face', () => {
  const box = [];
  for (const x of [-1, 1]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) box.push(x, y, z);
  const { physics, floor, body } = drop(box, { density: 2 });
  for (let i = 0; i < 300; i++) physics.step();
  assert.ok(Math.abs(body.position[1] - 0.5) < 0.01, `the box hull rests at ${body.position[1]}`);
  assert.ok(physics.touching(body, floor));
  assert.equal(physics.contactPoints(body).length, 4);
  // Its mass is its volume times its density, 2 by 1 by 1 times 2.
  assert.ok(Math.abs(body.mass - 4) < 1e-5, `mass ${body.mass}`);
  physics.dispose();
});

test('a 256 sided cylinder stands on its cap with four points', () => {
  const ring = [];
  for (let i = 0; i < 256; i++) {
    const t = (2 * Math.PI * i) / 256;
    ring.push(Math.cos(t), -1, Math.sin(t), Math.cos(t), 1, Math.sin(t));
  }
  const { physics, floor, body } = drop(f32(ring));
  for (let i = 0; i < 300; i++) physics.step();
  assert.ok(Math.abs(body.position[1] - 1) < 0.01, `it rests at ${body.position[1]}`);
  assert.equal(physics.contactPoints(body).length, 4);
  assert.ok(physics.touching(body, floor));
  physics.dispose();
});

test('mass sets the density from the hull volume, and the same points share one hull', () => {
  const tetra = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    physics = new Physics(null, { gravity: [0, 0, 0] }),
    a = physics.addBody(null, { colliders: { shape: 'convexHull', points: tetra, mass: 3 } }),
    b = physics.addBody(null, { position: [5, 0, 0], colliders: { shape: 'convexHull', points: tetra } });
  assert.ok(Math.abs(a.mass - 3) < 1e-5, `mass ${a.mass}`);
  // Volume 1/6 at the default density of 1.
  assert.ok(Math.abs(b.mass - 1 / 6) < 1e-6, `mass ${b.mass}`);
  assert.equal(physics.kernel.columns.colliderHull[a.colliders[0].handle], physics.kernel.columns.colliderHull[b.colliders[0].handle]);
  physics.dispose();
});

test('a hull without points is the hull of the given geometry, scaled with the mesh', () => {
  const vertices = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) vertices.push(x, y, z);
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    body = physics.addBody(null, { colliders: { shape: 'convexHull', geometry: { vertices } } });
  assert.ok(Math.abs(body.mass - 8) < 1e-5, `mass ${body.mass}`);
  physics.dispose();
});

// The seen test is Shewchuk's ORIENT3D stage A filter (1997, Table 3): (7e + 56e^2) times the permanent. The bound it
// replaced, 5e-15 times the product of the three L1 lengths, called a point 2e-15 above a face spanned by 4 by 4 in
// plane not above it, though its volume of 3.2e-14 is exact (every other product is zero); the paper bounds it by 2.5e-29.
test('a point a hair above a face counts as above it, and rounding noise never does', async () => {
  const { beyond } = await import('../src/next/hull.ts');
  assert.equal(beyond(4, 0, 0, 0, 4, 0, 3, 3, 2e-15), true, 'an exact volume of 3.2e-14 is above the bound');
  assert.equal(beyond(0, 4, 0, 4, 0, 0, 3, 3, 2e-15), false, 'the same corners the other way round are below');
  assert.equal(beyond(4, 0, 0, 0, 4, 0, 3, 3, 0), false, 'a point in the plane is not above');
  // Near coplanar points on a grid of 2^-20, so each coordinate and each difference is exact and the exact volume is a
  // BigInt; the products round. The filter may call a volume none, but a sign it gives must be the exact one.
  const r = random(126),
    grid = 2 ** 20,
    span = 2 ** 31,
    pick = () => Math.round((r() * 2 - 1) * span),
    exactVolume = (u, v, w) =>
      (u[1] * v[2] - u[2] * v[1]) * w[0] + (u[2] * v[0] - u[0] * v[2]) * w[1] + (u[0] * v[1] - u[1] * v[0]) * w[2];
  let decided = 0;
  for (let n = 0; n < 20000; n++) {
    const u = [pick(), pick(), pick()],
      v = [pick(), pick(), pick()],
      s = r(),
      t = r(),
      w = u.map((x, k) => Math.round(s * x + t * v[k]) + ((n % 3) - 1) * (n % 7 === 0 ? 1 : 0)),
      volume = exactVolume(u.map(BigInt), v.map(BigInt), w.map(BigInt)),
      [a, b, c] = [u, v, w].map((q) => q.map((x) => x / grid));
    if (beyond(...a, ...b, ...c)) {
      assert.ok(volume > 0n, `case ${n}: called above with an exact volume of ${volume}`);
      decided++;
    }
    if (beyond(...b, ...a, ...c)) {
      assert.ok(volume < 0n, `case ${n}: called below with an exact volume of ${volume}`);
      decided++;
    }
  }
  assert.ok(decided > 0, 'some near coplanar cases are decided');
});
