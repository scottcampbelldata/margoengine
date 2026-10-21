// Analytic mesh checks shared by the extras tests, written independently of the package's own utilities.
import assert from 'node:assert/strict';

export const vertexCount = (d) => d.positions.length / 3;
export const point = (d, i) => [d.positions[i * 3], d.positions[i * 3 + 1], d.positions[i * 3 + 2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (a) => Math.hypot(a[0], a[1], a[2]);
export const close = (actual, expected, tolerance, label = '') =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label} expected ${expected}, got ${actual} (tolerance ${tolerance})`,
  );

export function surfaceArea(d) {
  let s = 0;
  for (let t = 0; t < d.indices.length; t += 3) {
    const a = point(d, d.indices[t]);
    s += length(cross(sub(point(d, d.indices[t + 1]), a), sub(point(d, d.indices[t + 2]), a))) / 2;
  }
  return s;
}
export function signedVolume(d) {
  let v = 0;
  for (let t = 0; t < d.indices.length; t += 3)
    v += dot(point(d, d.indices[t]), cross(point(d, d.indices[t + 1]), point(d, d.indices[t + 2]))) / 6;
  return v;
}
/**
 * Welds by position (rounded to `digits` decimals), drops collapsed triangles, then requires every directed edge once
 * with its reverse once: closed, manifold and consistently wound. Returns V, E, F and the Euler characteristic.
 */
export function watertight(d, label, digits = 4) {
  const keys = new Map(),
    id = [],
    scale = 10 ** digits;
  for (let i = 0; i < vertexCount(d); i++) {
    const k = point(d, i)
      .map((x) => Math.round(x * scale) || 0)
      .join(',');
    if (!keys.has(k)) keys.set(k, keys.size);
    id.push(keys.get(k));
  }
  const directed = new Map();
  let kept = 0;
  for (let t = 0; t < d.indices.length; t += 3) {
    const w = [id[d.indices[t]], id[d.indices[t + 1]], id[d.indices[t + 2]]];
    if (w[0] === w[1] || w[1] === w[2] || w[0] === w[2]) continue;
    kept++;
    for (let k = 0; k < 3; k++) {
      const e = `${w[k]}>${w[(k + 1) % 3]}`;
      directed.set(e, (directed.get(e) ?? 0) + 1);
    }
  }
  assert.ok(kept > 0, `${label}: no triangles`);
  for (const [e, n] of directed) {
    assert.equal(n, 1, `${label}: directed edge ${e} used ${n} times`);
    const [a, b] = e.split('>');
    assert.equal(directed.get(`${b}>${a}`), 1, `${label}: edge ${e} has no opposite (open or inconsistently wound)`);
  }
  const V = new Set(id).size,
    E = directed.size / 2;
  return { V, E, F: kept, euler: V - E + kept };
}
export function assertValid(d, label) {
  assert.ok(
    d.positions instanceof Float32Array &&
      d.normals instanceof Float32Array &&
      d.uvs instanceof Float32Array &&
      d.indices instanceof Uint32Array,
    `${label} types`,
  );
  assert.equal(d.normals.length, d.positions.length, `${label} normal count`);
  assert.equal(d.uvs.length, (d.positions.length / 3) * 2, `${label} uv count`);
  assert.equal(d.indices.length % 3, 0, `${label} whole triangles`);
  for (const i of d.indices) assert.ok(i < vertexCount(d), `${label} index in range`);
  for (const x of d.positions) assert.ok(Number.isFinite(x), `${label} finite positions`);
  for (let i = 0; i < vertexCount(d); i++)
    close(Math.hypot(d.normals[i * 3], d.normals[i * 3 + 1], d.normals[i * 3 + 2]), 1, 1e-5, `${label} normal ${i}`);
}
export function assertUVRange(d, label) {
  for (const u of d.uvs) assert.ok(u >= -1e-6 && u <= 1 + 1e-6, `${label} uv ${u} outside [0, 1]`);
}
/** Every corner normal agrees with the winding of the triangles that use it. */
export function assertNormalsAgreeWithWinding(d, label) {
  let bad = 0;
  for (let t = 0; t < d.indices.length; t += 3) {
    const [a, b, c] = [d.indices[t], d.indices[t + 1], d.indices[t + 2]],
      n = cross(sub(point(d, b), point(d, a)), sub(point(d, c), point(d, a)));
    if (length(n) < 1e-9) continue;
    for (const v of [a, b, c]) if (dot(n, [d.normals[v * 3], d.normals[v * 3 + 1], d.normals[v * 3 + 2]]) <= 0) bad++;
  }
  assert.equal(bad, 0, `${label}: ${bad} corner normals oppose the winding`);
}
