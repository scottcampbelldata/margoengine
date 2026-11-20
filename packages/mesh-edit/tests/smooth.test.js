import assert from 'node:assert/strict';
import test from 'node:test';
import { compilePolygonMesh, createPrimitiveMesh } from '@margoengine/mesh-edit';
import { smoothMesh, subdivideMesh } from '@margoengine/mesh-edit/modeling';

let next = 0;
const createId = () => `s${next++}`;

const volume = (mesh) => {
  let sum = 0;
  for (const face of mesh.faces) {
    const a = mesh.vertices[face.vertices[0]];
    for (let i = 1; i < face.vertices.length - 1; i++) {
      const b = mesh.vertices[face.vertices[i]],
        c = mesh.vertices[face.vertices[i + 1]];
      sum +=
        a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
  }
  return sum / 6;
};

/** Every face as a fan of triangles, so vertices can move freely and faces stay valid. */
const fans = (mesh) => ({
  vertices: mesh.vertices,
  faces: mesh.faces.flatMap((face) =>
    face.vertices.slice(1, -1).map((_, i) => ({
      id: `${face.id}.${i}`,
      vertices: [face.vertices[0], face.vertices[i + 1], face.vertices[i + 2]],
      uv: [face.uv[0], face.uv[i + 1], face.uv[i + 2]],
    })),
  ),
});

/** A round blob: the subdivided cube with every point pushed to radius 1. */
function sphere() {
  let mesh = createPrimitiveMesh('cube', 'box');
  for (let i = 0; i < 3; i++) mesh = subdivideMesh(mesh, { createId }).mesh;
  const vertices = mesh.vertices.map((p) => {
    const length = Math.hypot(...p);
    return p.map((x) => x / length);
  });
  return fans({ ...mesh, vertices });
}

const noisy = (mesh, amount) => {
  let seed = 12345;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  };
  return { ...mesh, vertices: mesh.vertices.map((p) => p.map((x) => x * (1 + random() * amount))) };
};

const radiusSpread = (mesh) => {
  const radii = mesh.vertices.map((p) => Math.hypot(...p)),
    mean = radii.reduce((a, b) => a + b) / radii.length;
  return { mean, spread: Math.sqrt(radii.reduce((sum, r) => sum + (r - mean) ** 2, 0) / radii.length) };
};

test('Taubin removes noise and keeps the size; Laplacian shrinks', () => {
  const clean = sphere(),
    rough = noisy(clean, 0.1),
    before = radiusSpread(rough),
    taubin = smoothMesh(rough, { iterations: 20 }),
    laplacian = smoothMesh(rough, { method: 'laplacian', iterations: 40 }),
    after = radiusSpread(taubin.mesh);
  assert.ok(after.spread < before.spread / 2, `spread ${before.spread} to ${after.spread}`);
  assert.ok(Math.abs(after.mean - before.mean) < 0.01, `mean ${before.mean} to ${after.mean}`);
  assert.ok(Math.abs(volume(taubin.mesh) / volume(rough) - 1) < 0.02);
  assert.ok(volume(laplacian.mesh) < volume(taubin.mesh) * 0.95);
  compilePolygonMesh(taubin.mesh);
});

test('a selection moves alone and the input is untouched', () => {
  const mesh = noisy(sphere(), 0.05),
    before = JSON.stringify(mesh),
    picked = [0, 1, 2, 3],
    { mesh: out, vertexMap } = smoothMesh(mesh, { vertices: picked, iterations: 3 });
  assert.equal(JSON.stringify(mesh), before);
  assert.equal(vertexMap.length, mesh.vertices.length);
  out.vertices.forEach((p, v) => {
    if (picked.includes(v)) assert.notDeepEqual(p, mesh.vertices[v]);
    else assert.deepEqual(p, mesh.vertices[v]);
  });
});

test('open edges hold still by default and move when asked', () => {
  const plane = subdivideMesh(subdivideMesh(createPrimitiveMesh('plane', 'tile'), { createId }).mesh, {
      createId,
    }).mesh,
    bumpy = fans({ ...plane, vertices: plane.vertices.map(([x, y, z], v) => [x, y + (v % 2) * 0.02, z]) }),
    pinned = smoothMesh(bumpy),
    loose = smoothMesh(bumpy, { pinBoundary: false }),
    extent = (mesh) => Math.max(...mesh.vertices.map((p) => Math.max(Math.abs(p[0]), Math.abs(p[2])))),
    edge = bumpy.vertices.findIndex((p) => Math.abs(p[0]) === extent(bumpy));
  assert.deepEqual(pinned.mesh.vertices[edge], bumpy.vertices[edge]);
  assert.ok(extent(loose.mesh) < extent(bumpy));
});

test('warped faces split and stay on their source face', () => {
  const cube = createPrimitiveMesh('cube', 'box'),
    { mesh, faceMap } = smoothMesh(cube, { vertices: [0], method: 'laplacian', iterations: 1 });
  compilePolygonMesh(mesh);
  assert.equal(Object.values(faceMap).flat().length, mesh.faces.length);
  assert.ok(mesh.faces.length > cube.faces.length);
});

test('bad options and abort', () => {
  const cube = createPrimitiveMesh('cube', 'box');
  assert.throws(() => smoothMesh(cube, { method: 'mean' }), TypeError);
  assert.throws(() => smoothMesh(cube, { iterations: 0 }), RangeError);
  assert.throws(() => smoothMesh(cube, { factor: 0 }), RangeError);
  assert.throws(() => smoothMesh(cube, { passBand: 1 }), RangeError);
  assert.throws(() => smoothMesh(cube, { vertices: [99] }), RangeError);
  assert.throws(() => smoothMesh(cube, { vertices: 1 }), TypeError);
  assert.throws(() => smoothMesh(cube, { signal: {} }), TypeError);
  assert.throws(() => smoothMesh(cube, { signal: AbortSignal.abort(new RangeError('stop')) }), { message: 'stop' });
});

test('Taubin rejects a factor whose filter amplifies the top frequency instead of blowing the mesh up', () => {
  // Taubin (1995): f(k) = (1 - lambda k)(1 - mu k) must stay within [-1, 1] up to k = 2. At factor 1 and the default
  // pass band, |f(2)| = 3.2, and 50 passes grew a 0.006 noise field to 36 units before the check.
  const n = 12,
    vertices = [],
    faces = [];
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.02;
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) vertices.push([x / n, y / n, noise()]);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x;
      faces.push(
        {
          id: `a${a}`,
          vertices: [a, a + 1, a + n + 2],
          uv: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        },
        {
          id: `b${a}`,
          vertices: [a, a + n + 2, a + n + 1],
          uv: [
            [0, 0],
            [1, 1],
            [0, 1],
          ],
        },
      );
    }
  const grid = { vertices, faces };
  assert.throws(() => smoothMesh(grid, { factor: 1, iterations: 50 }), RangeError);
  assert.throws(() => smoothMesh(grid, { factor: 0.75, iterations: 50 }), RangeError);
  const { mesh } = smoothMesh(grid, { factor: 0.69, iterations: 50 });
  assert.ok(mesh.vertices.every((p) => Math.abs(p[2]) < 0.01));
  // Laplacian steps alone never amplify: |1 - k| <= 1 for every factor up to 1.
  assert.doesNotThrow(() => smoothMesh(grid, { factor: 1, iterations: 5, method: 'laplacian' }));
});
