// MeshSurfaceSampler against distributions with known answers: even density by area, linear density from vertex
// weights, interpolated attributes, and the edges of the random range.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boxGeometry, planeGeometry, sphereGeometry } from '../dist/index.js';
import { MeshSurfaceSampler } from '../dist/sample.js';
import { close } from './support/mesh-checks.js';

/** A unit square in the z = 0 plane, x and y from 0 to 1, split into `n` by `n` quads. */
function square(n = 1) {
  const positions = [],
    normals = [],
    uvs = [],
    indices = [];
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      positions.push(i / n, j / n, 0);
      normals.push(0, 0, 1);
      uvs.push(i / n, j / n);
    }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      indices.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
    }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
  };
}

test('points spread evenly by area, even when triangles differ in size', () => {
  // One triangle of area 3 and one of area 1, sharing nothing.
  const mesh = {
      positions: Float32Array.of(0, 0, 0, 3, 0, 0, 0, 2, 0, 10, 0, 0, 11, 0, 0, 10, 2, 0),
      normals: new Float32Array(0),
      uvs: new Float32Array(0),
      indices: Uint32Array.of(0, 1, 2, 3, 4, 5),
    },
    sampler = new MeshSurfaceSampler(mesh),
    count = 40000,
    { triangles } = sampler.samplePoints(count);
  close(sampler.area, 4, 1e-12, 'area');
  const big = triangles.reduce((n, t) => n + (t === 0 ? 1 : 0), 0);
  close(big / count, 0.75, 0.01, 'share of the big triangle');
});

test('points are uniform inside a triangle and on a whole square', () => {
  const { positions } = new MeshSurfaceSampler(square(3)).samplePoints(60000),
    cells = new Array(16).fill(0);
  let x = 0,
    y = 0;
  for (let i = 0; i < positions.length; i += 3) {
    x += positions[i];
    y += positions[i + 1];
    cells[Math.min(3, Math.floor(positions[i] * 4)) * 4 + Math.min(3, Math.floor(positions[i + 1] * 4))]++;
  }
  close(x / 60000, 0.5, 0.005, 'mean x');
  close(y / 60000, 0.5, 0.005, 'mean y');
  // Chi-squared over 16 equal cells, 15 degrees of freedom: 37.7 is the 0.1 percent tail; the run is seeded.
  const expected = 60000 / 16,
    chi = cells.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
  assert.ok(chi < 37.7, `cells are even (chi-squared ${chi})`);
});

test('vertex weights give a density linear across each triangle, even on one big quad', () => {
  // Weight x on the unit square: density 2x, so the mean x is 2/3 and the mean y 1/2. With one weight per triangle the
  // two triangles of a single quad could not produce this.
  const mesh = square(1),
    weights = [0, 1, 0, 1],
    { positions } = new MeshSurfaceSampler(mesh, { weights }).samplePoints(80000);
  let x = 0,
    y = 0,
    x2 = 0;
  for (let i = 0; i < positions.length; i += 3) {
    x += positions[i];
    y += positions[i + 1];
    x2 += positions[i] ** 2;
  }
  close(x / 80000, 2 / 3, 0.004, 'mean x');
  close(y / 80000, 1 / 2, 0.004, 'mean y');
  close(x2 / 80000, 1 / 2, 0.004, 'mean x squared');
});

test('weight zero means no points: a triangle with no weight is never chosen', () => {
  const mesh = square(2),
    weights = Array.from({ length: 9 }, (_, v) => (v % 3 === 2 ? 1 : 0)),
    { positions } = new MeshSurfaceSampler(mesh, { weights }).samplePoints(5000);
  for (let i = 0; i < positions.length; i += 3) assert.ok(positions[i] > 0.5, 'only the weighted column');
});

test('attributes are interpolated: on a plane uv and colour follow position', () => {
  const mesh = square(4),
    colors = [];
  for (let i = 0; i < mesh.positions.length; i += 3) colors.push(mesh.positions[i], mesh.positions[i + 1], 0.25);
  const sampler = new MeshSurfaceSampler(mesh, { colors });
  for (let i = 0; i < 500; i++) {
    const s = sampler.sample();
    close(s.uv[0], s.position[0], 1e-6, 'u');
    close(s.uv[1], s.position[1], 1e-6, 'v');
    close(s.color[0], s.position[0], 1e-6, 'red');
    close(s.color[1], s.position[1], 1e-6, 'green');
    close(s.color[2], 0.25, 1e-6, 'blue');
    assert.equal(s.color[3], 1);
    close(s.barycentric[0] + s.barycentric[1] + s.barycentric[2], 1, 1e-12, 'barycentric sum');
    assert.ok(s.barycentric.every((b) => b >= 0));
    assert.ok(s.triangle < mesh.indices.length / 3);
    assert.deepEqual(s.normal, [0, 0, 1]);
  }
  const rgba = new MeshSurfaceSampler(mesh, { colors: new Float32Array(25 * 4).fill(0.5) }).sample();
  close(rgba.color[3], 0.5, 1e-6, 'alpha');
  assert.deepEqual(new MeshSurfaceSampler(mesh).sample().color, [1, 1, 1, 1]);
});

test('normals on a sphere point outward and stay unit length; a flat box keeps its face normal', () => {
  const { positions, normals } = new MeshSurfaceSampler(sphereGeometry(2, 48, 24)).samplePoints(2000);
  for (let i = 0; i < positions.length; i += 3) {
    close(Math.hypot(normals[i], normals[i + 1], normals[i + 2]), 1, 1e-6, 'unit');
    const r = Math.hypot(positions[i], positions[i + 1], positions[i + 2]),
      along = (positions[i] * normals[i] + positions[i + 1] * normals[i + 1] + positions[i + 2] * normals[i + 2]) / r;
    assert.ok(along > 0.999, 'radial');
  }
  const box = new MeshSurfaceSampler(boxGeometry(2, 2, 2));
  close(box.area, 24, 1e-5, 'box area');
  for (let i = 0; i < 200; i++) {
    const { position, normal } = box.sample(),
      axis = normal.findIndex((n) => n !== 0);
    close(position[axis], normal[axis], 1e-6, 'the point lies on the face its normal names');
  }
});

test('without vertex normals, and where they cancel out, the face normal is used', () => {
  const flat = {
    positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
    normals: new Float32Array(0),
    uvs: new Float32Array(0),
    indices: Uint32Array.of(0, 1, 2),
  };
  assert.deepEqual(new MeshSurfaceSampler(flat).sample().normal, [0, 0, 1]);
  assert.deepEqual(new MeshSurfaceSampler(flat).sample().uv, [0, 0]);
  const opposed = { ...flat, normals: new Float32Array(9) };
  assert.deepEqual(new MeshSurfaceSampler(opposed).sample().normal, [0, 0, 1]);
});

test('the same seed repeats, a new seed differs, and a caller generator is used', () => {
  const plane = planeGeometry(1, 1, 4, 4),
    a = new MeshSurfaceSampler(plane).samplePoints(50).positions,
    b = new MeshSurfaceSampler(plane).samplePoints(50).positions,
    c = new MeshSurfaceSampler(plane, { seed: 2 }).samplePoints(50).positions;
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  let calls = 0;
  new MeshSurfaceSampler(plane, {
    random: () => {
      calls++;
      return 0.5;
    },
  }).sample();
  assert.equal(calls, 3, 'one for the triangle, two for the point');
});

test('the ends of the random range stay on the mesh, with and without weights', () => {
  const mesh = square(2),
    weights = new Array(9).fill(1);
  weights[8] = 0;
  for (const value of [0, 0.999999999999, 1 - 2 ** -53])
    for (const options of [{}, { weights }]) {
      const { position, barycentric } = new MeshSurfaceSampler(mesh, { ...options, random: () => value }).sample();
      assert.ok(position.every(Number.isFinite), 'finite');
      assert.ok(
        position.every((p) => p >= -1e-12 && p <= 1 + 1e-12),
        'on the square, to rounding',
      );
      assert.ok(barycentric.every((b) => b >= 0 && b <= 1));
    }
});

test('sample reuses a target, and samplePoints(0) is empty', () => {
  const sampler = new MeshSurfaceSampler(square()),
    target = sampler.sample();
  assert.equal(sampler.sample(target), target);
  assert.equal(sampler.samplePoints(0).positions.length, 0);
});

test('invalid input is refused with the fix in the message', () => {
  const mesh = square(1);
  assert.throws(() => new MeshSurfaceSampler({ ...mesh, positions: new Float32Array(4) }), /whole triangles/);
  assert.throws(() => new MeshSurfaceSampler({ ...mesh, indices: Uint32Array.of(0, 1) }), /whole triangles/);
  assert.throws(() => new MeshSurfaceSampler({ ...mesh, indices: Uint32Array.of(0, 1, 9) }), /indexes past/);
  assert.throws(() => new MeshSurfaceSampler({ ...mesh, normals: new Float32Array(3) }), /normals/);
  assert.throws(() => new MeshSurfaceSampler({ ...mesh, uvs: new Float32Array(3) }), /uvs/);
  assert.throws(() => new MeshSurfaceSampler(mesh, { weights: [1] }), /one per vertex/);
  assert.throws(() => new MeshSurfaceSampler(mesh, { weights: [1, -1, 1, 1] }), />= 0/);
  assert.throws(() => new MeshSurfaceSampler(mesh, { weights: [1, NaN, 1, 1] }), />= 0/);
  assert.throws(() => new MeshSurfaceSampler(mesh, { weights: [0, 0, 0, 0] }), /no area/);
  assert.throws(() => new MeshSurfaceSampler(mesh, { colors: [1] }), /colors/);
  assert.throws(() => new MeshSurfaceSampler(mesh, { random: 1 }), TypeError);
  assert.throws(() => new MeshSurfaceSampler(mesh, { seed: NaN }), /seed/);
  assert.throws(() => new MeshSurfaceSampler({ ...mesh, indices: new Uint32Array(0) }), /no area/);
  assert.throws(
    () => new MeshSurfaceSampler({ ...mesh, positions: Float32Array.of(0, 0, 0, NaN, 0, 0, 1, 1, 0, 0, 1, 0) }),
    /finite/,
  );
  assert.throws(() => new MeshSurfaceSampler(mesh).samplePoints(-1), /count/);
  assert.throws(() => new MeshSurfaceSampler(mesh).samplePoints(1.5), /count/);
});
