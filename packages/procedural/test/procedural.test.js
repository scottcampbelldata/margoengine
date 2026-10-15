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
    assert.ok(Math.abs(Math.hypot(v[i], v[i + 1], v[i + 2]) - 0.5) < 0.02);
    assert.ok(v[i] * v[i + 3] + v[i + 1] * v[i + 4] + v[i + 2] * v[i + 5] > 0.45);
  }
  assert.equal(
    marchingCubes(() => 1, { resolution: [3, 3, 3] }),
    null,
  );
  assert.throws(() => marchingCubes(() => NaN), /finite/);
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
