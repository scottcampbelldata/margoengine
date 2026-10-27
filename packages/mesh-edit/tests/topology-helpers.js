// Shared topology checks for the modeling tests: manifold closure, winding, Euler characteristic and volume.
import assert from 'node:assert/strict';

export const edgeId = (a, b) => `${Math.min(a, b)}:${Math.max(a, b)}`;

/** Deterministic createId option. */
export const ids = (prefix = 'n') => {
  let n = 0;
  return { createId: () => `${prefix}-${n++}` };
};

/** Seeded random numbers in [0, 1) (mulberry32). */
export const random = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Directed half-edge counts and the edge set of a mesh. */
export function halfEdges(mesh) {
  const half = new Map(),
    edges = new Map();
  for (const face of mesh.faces)
    face.vertices.forEach((a, i) => {
      const b = face.vertices[(i + 1) % face.vertices.length];
      half.set(`${a}>${b}`, (half.get(`${a}>${b}`) ?? 0) + 1);
      edges.set(edgeId(a, b), (edges.get(edgeId(a, b)) ?? 0) + 1);
    });
  return { half, edges };
}

/** Assert every edge has exactly two oppositely wound faces. */
export function assertClosed(mesh, label = 'mesh') {
  const { half, edges } = halfEdges(mesh);
  for (const [key, count] of half) {
    const [a, b] = key.split('>');
    assert.equal(count, 1, `${label}: half-edge ${key} used ${count} times`);
    assert.equal(half.get(`${b}>${a}`), 1, `${label}: half-edge ${key} has no twin`);
  }
  for (const [id, count] of edges) assert.equal(count, 2, `${label}: edge ${id} has ${count} faces`);
}

/** V - E + F over the vertices faces use. */
export function euler(mesh) {
  const used = new Set(mesh.faces.flatMap((face) => face.vertices)),
    { edges } = halfEdges(mesh);
  return used.size - edges.size + mesh.faces.length;
}

/** Signed volume of a closed mesh (fan triangles about the origin). */
export function volume(mesh) {
  let sum = 0;
  for (const { vertices } of mesh.faces) {
    const a = mesh.vertices[vertices[0]];
    for (let i = 1; i < vertices.length - 1; i++) {
      const b = mesh.vertices[vertices[i]],
        c = mesh.vertices[vertices[i + 1]];
      sum +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6;
    }
  }
  return sum;
}

/** Total area of all faces. */
export function area(mesh) {
  let sum = 0;
  for (const { vertices } of mesh.faces) {
    const n = [0, 0, 0],
      o = mesh.vertices[vertices[0]];
    for (let i = 1; i < vertices.length - 1; i++) {
      const b = mesh.vertices[vertices[i]].map((v, k) => v - o[k]),
        c = mesh.vertices[vertices[i + 1]].map((v, k) => v - o[k]);
      n[0] += b[1] * c[2] - b[2] * c[1];
      n[1] += b[2] * c[0] - b[0] * c[2];
      n[2] += b[0] * c[1] - b[1] * c[0];
    }
    sum += Math.hypot(...n) / 2;
  }
  return sum;
}

/** No face repeats a vertex, and every face has area. */
export function assertNoDegenerate(mesh, label = 'mesh') {
  for (const face of mesh.faces) {
    assert.equal(new Set(face.vertices).size, face.vertices.length, `${label}: face ${face.id} repeats a vertex`);
    assert.ok(area({ vertices: mesh.vertices, faces: [face] }) > 1e-12, `${label}: face ${face.id} has no area`);
  }
}

/** An n x m grid of unit quads in the XZ plane facing +Y, UVs spanning [0, 1]. */
export function grid(n, m = n) {
  const vertices = [];
  for (let j = 0; j <= m; j++) for (let i = 0; i <= n; i++) vertices.push([i, 0, j]);
  const faces = [];
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i,
        corners = [a, a + n + 1, a + n + 2, a + 1];
      faces.push({
        id: `g${i}-${j}`,
        vertices: corners,
        uv: corners.map((v) => [vertices[v][0] / n, vertices[v][2] / m]),
      });
    }
  return { vertices, faces };
}
