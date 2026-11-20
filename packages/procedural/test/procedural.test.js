import test from 'node:test';
import assert from 'node:assert/strict';
import { Noise, marchingCubes } from '../dist/index.js';
test('seeded 3D noise is deterministic, continuous at cell boundaries and finite', () => {
  const a = new Noise(13),
    b = new Noise(13),
    c = new Noise(14);
  for (const kind of ['simplex', 'perlin', 'worley']) {
    assert.equal(a[kind](0.25, 1.5, -2.7), b[kind](0.25, 1.5, -2.7));
    assert.notEqual(a[kind](0.25, 1.5, -2.7), c[kind](0.25, 1.5, -2.7));
    assert.ok(Math.abs(a[kind](1 - 1e-6, 0.2, 0.3) - a[kind](1 + 1e-6, 0.2, 0.3)) < 1e-3);
    assert.throws(() => a[kind](NaN, 0, 0), /finite/);
  }
});
test('Marching Cubes extracts a sphere with radial normals and returns null for an empty field', () => {
  const geometry = marchingCubes((x, y, z) => x * x + y * y + z * z - 0.25, { resolution: [16, 16, 16] });
  assert.ok(geometry.indices.length > 100);
  for (let i = 0; i < geometry.vertices.length; i += 6) {
    const v = geometry.vertices;
    assert.ok(Math.abs(Math.hypot(v[i], v[i + 1], v[i + 2]) - 0.5) < 1e-6);
    assert.ok(v[i] * v[i + 3] + v[i + 1] * v[i + 4] + v[i + 2] * v[i + 5] > 0.45);
  }
  assert.equal(
    marchingCubes(() => 1, { resolution: [3, 3, 3] }),
    null,
  );
  assert.throws(() => marchingCubes(() => NaN), /finite/);
});
test('Marching Cubes takes a sampled grid: same polygons as the function, grid-gradient normals, length checked', () => {
  const field = (x, y, z) => Math.hypot(x - 0.1, y, z * 1.3) - 0.6,
    resolution = [24, 20, 28],
    bounds = [
      [-1, -0.9, -1.1],
      [0.9, 1, 1],
    ];
  const grid = new Float64Array(resolution[0] * resolution[1] * resolution[2]);
  for (let z = 0, i = 0; z < resolution[2]; z++)
    for (let y = 0; y < resolution[1]; y++)
      for (let x = 0; x < resolution[0]; x++, i++)
        grid[i] = field(
          ...[x, y, z].map((c, a) => bounds[0][a] + ((bounds[1][a] - bounds[0][a]) * c) / (resolution[a] - 1)),
        );
  const a = marchingCubes(field, { resolution, bounds }),
    b = marchingCubes(grid, { resolution, bounds });
  assert.deepEqual(b.indices, a.indices);
  for (let i = 0; i < a.vertices.length; i += 6) {
    // The same grid edge: the grid's vertex is linear between its samples, the function's is the field's root on it.
    const moved = [0, 1, 2].filter((k) => b.vertices[i + k] !== a.vertices[i + k]);
    assert.ok(moved.length <= 1, `vertex ${i / 6} left its edge`);
    assert.ok(Math.abs(field(a.vertices[i], a.vertices[i + 1], a.vertices[i + 2])) < 1e-6);
    const dot =
      a.vertices[i + 3] * b.vertices[i + 3] +
      a.vertices[i + 4] * b.vertices[i + 4] +
      a.vertices[i + 5] * b.vertices[i + 5];
    assert.ok(dot > 0.97, `normal ${i / 6} off by ${Math.acos(Math.min(1, dot))} rad`);
  }
  assert.throws(() => marchingCubes(grid.subarray(1), { resolution, bounds }), /resolution\[0\]/);
  assert.throws(
    () => marchingCubes(Object.assign(new Float32Array(grid), { 5: NaN }), { resolution, bounds }),
    /finite/,
  );
});
test('Marching Cubes puts vertices on the surface: a function exactly, a grid within its axis-edge interpolation', () => {
  // A metaball, 2 / d^2 - 12 cut at 0, with its surface at level -80: radius sqrt(2 / 92) in a box of side 2. The
  // field is far from linear across a cell. Each grid cube used to be cut into six tetrahedra, whose face and body
  // diagonals (sqrt 2 and sqrt 3 cells long) put linearly interpolated vertices up to 1.229 times the radius out at
  // resolution 28; on the cube's own edges linear interpolation gives at most 1.073 times, and the function's roots
  // are exact.
  const ball = (x, y, z) => -Math.max(0, 2 / (x * x + y * y + z * z + 1e-6) - 12),
    exact = Math.sqrt(2 / 92 - 1e-6),
    n = 28,
    resolution = [n, n, n],
    grid = new Float64Array(n ** 3);
  for (let z = 0, i = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++, i++) grid[i] = ball(...[x, y, z].map((c) => -1 + (2 * c) / (n - 1)));
  const spread = (g) => {
    let lo = Infinity,
      hi = 0;
    for (let i = 0; i < g.vertices.length; i += 6) {
      const r = Math.hypot(g.vertices[i], g.vertices[i + 1], g.vertices[i + 2]) / exact;
      (lo = Math.min(lo, r)), (hi = Math.max(hi, r));
    }
    return [lo, hi];
  };
  const [flo, fhi] = spread(marchingCubes(ball, { resolution, level: -80 }));
  assert.ok(flo > 1 - 1e-6 && fhi < 1 + 1e-6, `function vertices at ${flo}..${fhi} of the radius`);
  const [glo, ghi] = spread(marchingCubes(grid, { resolution, level: -80 }));
  assert.ok(glo > 0.99 && ghi < 1.08, `grid vertices at ${glo}..${ghi} of the radius`);
});
test('Marching Cubes reuses its scratch safely: after a throw, and from inside a density function', () => {
  const sphere = (x, y, z) => Math.hypot(x, y, z) - 0.5,
    reference = marchingCubes(sphere, { resolution: [20, 20, 20] });
  // A throw part-way through leaves no stale shared vertices behind.
  let calls = 0;
  assert.throws(
    () =>
      marchingCubes(
        (x, y, z) => {
          if (++calls > 20 ** 3 + 50) throw new RangeError('stop');
          return sphere(x, y, z);
        },
        { resolution: [20, 20, 20] },
      ),
    /stop/,
  );
  assert.deepEqual(marchingCubes(sphere, { resolution: [20, 20, 20] }), reference);
  // A nested call (a field built from another surface) gets its own buffers.
  let inner;
  const outer = marchingCubes(
    (x, y, z) => {
      inner ??= marchingCubes(sphere, { resolution: [20, 20, 20] });
      return sphere(x, y, z);
    },
    { resolution: [20, 20, 20] },
  );
  assert.deepEqual(inner, reference);
  assert.deepEqual(outer, reference);
});
test('a surface through grid points exactly: one vertex per point, no zero-area or inward triangles, still closed', () => {
  // Radius 0.5 in the default bounds puts the six poles on grid points at resolutions 9, 13, 17 and 21; the field there
  // is exactly the level. Before, every edge from such a point made its own vertex on the point (36 to 252 zero-area
  // triangles), and a face whose outside corner was that point had no orientation reference.
  for (const [n, grid] of [
    [9, false],
    [13, false],
    [17, true],
    [21, false],
  ]) {
    const sphere = (x, y, z) => Math.hypot(x, y, z) - 0.5,
      resolution = [n, n, n];
    let field = sphere;
    if (grid) {
      field = new Float64Array(n * n * n);
      for (let z = 0, i = 0; z < n; z++)
        for (let y = 0; y < n; y++)
          for (let x = 0; x < n; x++, i++) field[i] = sphere(...[x, y, z].map((c) => -1 + (2 * c) / (n - 1)));
    }
    const g = marchingCubes(field, { resolution }),
      v = g.vertices,
      idx = g.indices,
      edges = new Map();
    for (let t = 0; t < idx.length; t += 3) {
      const corner = (k) => [0, 1, 2].map((a) => v[idx[t + k] * 6 + a]),
        [A, B, C] = [corner(0), corner(1), corner(2)],
        u = B.map((x, k) => x - A[k]),
        w = C.map((x, k) => x - A[k]),
        f = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      assert.ok(Math.hypot(...f) > 1e-9, `resolution ${n}: triangle ${t / 3} has zero area`);
      const centre = [0, 1, 2].map((k) => A[k] + B[k] + C[k]);
      assert.ok(
        f[0] * centre[0] + f[1] * centre[1] + f[2] * centre[2] > 0,
        `resolution ${n}: triangle ${t / 3} faces in`,
      );
      for (const [p, q] of [
        [idx[t], idx[t + 1]],
        [idx[t + 1], idx[t + 2]],
        [idx[t + 2], idx[t]],
      ])
        edges.set(p + ',' + q, (edges.get(p + ',' + q) ?? 0) + 1);
    }
    for (const [key, uses] of edges) {
      const [p, q] = key.split(',');
      assert.equal(uses, 1, `resolution ${n}: edge ${key} used ${uses} times`);
      assert.equal(edges.get(q + ',' + p), 1, `resolution ${n}: edge ${key} has no twin`);
    }
    assert.equal(v.length / 6 - edges.size / 2 + idx.length / 3, 2, `resolution ${n}: Euler characteristic`);
    // Each pole is one vertex, exactly on the sphere.
    for (const pole of [
      [0.5, 0, 0],
      [-0.5, 0, 0],
      [0, 0.5, 0],
      [0, -0.5, 0],
      [0, 0, 0.5],
      [0, 0, -0.5],
    ]) {
      let at = 0;
      for (let i = 0; i < v.length; i += 6) if (v[i] === pole[0] && v[i + 1] === pole[1] && v[i + 2] === pole[2]) at++;
      assert.equal(at, 1, `resolution ${n}: pole ${pole} held by ${at} vertices`);
    }
  }
});
test('surface extraction is closed, outward-wound and close to the true shape (sphere and torus SDFs)', () => {
  const check = (field, resolution, genus, volume, area) => {
    const g = marchingCubes(field, { resolution: [resolution, resolution, resolution] }),
      v = g.vertices,
      idx = g.indices,
      edges = new Map();
    let enclosed = 0,
      outward = 0,
      faces = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
      for (const [p, q] of [
        [a, b],
        [b, c],
        [c, a],
      ])
        edges.set(p + ',' + q, (edges.get(p + ',' + q) ?? 0) + 1);
      const A = [0, 1, 2].map((k) => v[a * 6 + k]),
        B = [0, 1, 2].map((k) => v[b * 6 + k]),
        C = [0, 1, 2].map((k) => v[c * 6 + k]);
      const u = B.map((x, k) => x - A[k]),
        w = C.map((x, k) => x - A[k]),
        n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      enclosed +=
        A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0]);
      if (Math.hypot(...n) > 1e-12) {
        faces++;
        if (n[0] * v[a * 6 + 3] + n[1] * v[a * 6 + 4] + n[2] * v[a * 6 + 5] > 0) outward++;
      }
    }
    // Closed and consistently wound: every directed edge once, and its reverse once.
    for (const [key, uses] of edges) {
      const [p, q] = key.split(',');
      assert.equal(uses, 1, `edge ${key} used ${uses} times`);
      assert.equal(edges.get(q + ',' + p), 1, `edge ${key} has no twin`);
    }
    const vertexCount = v.length / 6,
      triangles = idx.length / 3;
    assert.equal(vertexCount - edges.size / 2 + triangles, 2 - 2 * genus, 'Euler characteristic');
    assert.equal(outward, faces, 'every face winds toward the outside (along the field gradient)');
    assert.ok(Math.abs(enclosed / 6 - volume) < volume * 0.02, `volume ${enclosed / 6} vs ${volume}`);
    // Vertex count sane: about one vertex per grid edge the surface crosses, a few per surface cell.
    const cell = 2 / (resolution - 1),
      cells = area / (cell * cell);
    assert.ok(
      vertexCount > cells && vertexCount < cells * 8,
      `${vertexCount} vertices for ~${Math.round(cells)} surface cells`,
    );
  };
  check((x, y, z) => Math.hypot(x, y, z) - 0.7, 40, 0, (4 / 3) * Math.PI * 0.7 ** 3, 4 * Math.PI * 0.49);
  check(
    (x, y, z) => Math.hypot(Math.hypot(x, z) - 0.55, y) - 0.25,
    48,
    1,
    2 * Math.PI ** 2 * 0.55 * 0.25 ** 2,
    4 * Math.PI ** 2 * 0.55 * 0.25,
  );
});

// Nielson and Hamann 1991, section 2: on a face whose corners alternate, the bilinear interpolant's saddle value is
// B(S, T) = (B00 B11 - B01 B10) / (B00 + B11 - B01 - B10) (the paper prints a + in the numerator; the minus is what the
// interpolant gives at its asymptotes' crossing). Their test: "if alpha > B(S, T)" the corners below alpha are joined
// across the face, else the corners above it are (a tie joins the upper pair). Two inside corners on the face shared
// by two cubes: one tube through the face when they are joined, two separate caps when not.
test('the asymptotic decider joins an alternating face as the paper does, its tie included', () => {
  const components = (geometry) => {
    const parent = Array.from({ length: geometry.vertices.length / 6 }, (_, i) => i),
      find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let t = 0; t < geometry.indices.length; t += 3)
      for (const k of [1, 2]) parent[find(geometry.indices[t + k])] = find(geometry.indices[t]);
    return new Set(parent.map((_, i) => find(i))).size;
  };
  // 3 x 3 x 3 samples, x fastest; the face is x = 1 between the cubes bx = 0 and bx = 1. Inside (below the level 0)
  // are its corners (y, z) = (0, 0) and (1, 1), at -1; its other two corners are at p; every other sample is +3.
  const surface = (p) => {
    const grid = new Float32Array(27).fill(3);
    const at = (x, y, z) => x + 3 * (y + 3 * z);
    grid[at(1, 0, 0)] = grid[at(1, 1, 1)] = -1;
    grid[at(1, 1, 0)] = grid[at(1, 0, 1)] = p;
    return marchingCubes(grid, { resolution: [3, 3, 3] });
  };
  const saddle = (p) => (1 - p * p) / (-2 - 2 * p);
  // p = 0.5: saddle value -0.25, below the level, so the inside corners join: one surface.
  assert.ok(saddle(0.5) < 0);
  assert.equal(components(surface(0.5)), 1);
  // p = 2: saddle +0.5 above the level, so the outside corners join and the inside ones are cut off: two caps.
  // (With the printed + the saddle value would be negative for every p, and the corners always joined.)
  assert.ok(saddle(2) > 0);
  assert.equal(components(surface(2)), 2);
  // p = 1: the saddle value is the level itself; the paper's else branch joins the corners above it.
  assert.ok(saddle(1) === 0);
  assert.equal(components(surface(1)), 2);
});
test('the marching-cubes entry is the root marchingCubes and gives the same mesh', async () => {
  const entry = await import('../dist/marching-cubes.js');
  assert.equal(entry.marchingCubes, marchingCubes);
  const field = (x, y, z) => x * x + y * y + z * z - 0.2;
  const a = entry.marchingCubes(field, { resolution: [12, 12, 12] }),
    b = marchingCubes(field, { resolution: [12, 12, 12] });
  assert.ok(a.indices.length > 0);
  assert.deepEqual(a.vertices, b.vertices);
  assert.deepEqual(a.indices, b.indices);
});
