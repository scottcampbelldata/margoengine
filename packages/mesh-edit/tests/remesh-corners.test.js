import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remeshMesh } from '@margoengine/mesh-edit/remesh';

let next = 0;
const createId = () => `face-${next++}`;
const area = (mesh) =>
  mesh.faces.reduce((sum, { vertices }) => {
    for (let i = 1; i + 1 < vertices.length; i++) {
      const [a, b, c] = [vertices[0], vertices[i], vertices[i + 1]].map((v) => mesh.vertices[v]),
        u = b.map((x, k) => x - a[k]),
        w = c.map((x, k) => x - a[k]);
      sum += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
    }
    return sum;
  }, 0);
const flat = (vertices, faces) => ({
  vertices,
  faces: faces.map((corners, i) => ({
    id: `f${i}`,
    vertices: corners,
    uv: corners.map((v) => [vertices[v][0], vertices[v][1]]),
  })),
});
const square = () => flat([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], [[0, 1, 2], [0, 2, 3]]);

test('a target larger than an open patch leaves the patch whole', () => {
  for (const targetLength of [2, 5, 100]) {
    const { mesh } = remeshMesh(square(), { targetLength, createId });
    assert.ok(Math.abs(area(mesh) - 1) < 1e-12, `area ${area(mesh)} at target ${targetLength}`);
  }
});

test('the corners of an open border stay where they are', () => {
  const { mesh } = remeshMesh(square(), { targetLength: 2, createId });
  for (const corner of square().vertices) assert.ok(mesh.vertices.some((p) => p.every((x, k) => x === corner[k])));
});

test('a lone triangle survives, needle or not', () => {
  const needle = flat([[0, 0, 0], [1, 0, 0], [0.5, 1e-3, 0]], [[0, 1, 2]]);
  assert.equal(remeshMesh(needle, { targetLength: 4, createId }).mesh.faces.length, 1);
});

test('points on a straight border still collapse', () => {
  const strip = [],
    faces = [];
  for (let i = 0; i <= 20; i++) strip.push([i / 20, 0, 0], [i / 20, 1, 0]);
  for (let i = 0; i < 20; i++) faces.push([i * 2, i * 2 + 2, i * 2 + 3], [i * 2, i * 2 + 3, i * 2 + 1]);
  const { mesh } = remeshMesh(flat(strip, faces), { targetLength: 0.5, createId });
  assert.ok(mesh.vertices.length < strip.length / 2, `${mesh.vertices.length} vertices`);
  assert.ok(Math.abs(area(mesh) - 1) < 1e-9);
});
