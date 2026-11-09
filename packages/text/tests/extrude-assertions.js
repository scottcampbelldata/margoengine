import assert from 'node:assert/strict';
// Positional welding intentionally ignores attribute splits between caps and walls.
export function closed(mesh) {
  const edges = new Map();
  const p = (i) => Array.from(mesh.positions.slice(i * 3, i * 3 + 3)).join(',');
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const tri = Array.from(mesh.indices.slice(i, i + 3), p);
    assert.equal(new Set(tri).size, 3, 'nondegenerate positional triangle');
    for (let j = 0; j < 3; j++) {
      const a = tri[j],
        b = tri[(j + 1) % 3],
        key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const edge = edges.get(key) ?? [0, 0];
      edge[0]++;
      edge[1] += a < b ? 1 : -1;
      edges.set(key, edge);
    }
  }
  for (const [key, [count, direction]] of edges) {
    assert.equal(count, 2, `edge incidence ${key}`);
    assert.equal(direction, 0, `edge orientation ${key}`);
  }
}
export function volume(mesh) {
  let result = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = Array.from(mesh.indices.slice(i, i + 3), (j) => mesh.positions.slice(j * 3, j * 3 + 3));
    result +=
      a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return result / 6;
}
