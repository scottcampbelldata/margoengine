// What rounding does to an exact boolean's result: no triangle pair may cross in float32 output, and the repair of
// faces too thin for the numbers must leave the solid where it is. Crossings are judged here by a second method, exact
// rational clipping of one triangle by the other's plane and edges, so the test does not ask the code under test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { batchBooleanMeshes } from '@margoengine/mesh-edit/boolean-batch';
import { booleanMeshesExact } from '@margoengine/mesh-edit/boolean-exact';
import { compilePolygonMesh, createPrimitiveMesh, polygonMeshEdges } from '@margoengine/mesh-edit';

const ids = () => {
  let next = 0;
  return () => `new-${next++}`;
};

const buffer = new DataView(new ArrayBuffer(8));
/** A float64 as an integer count of the smallest float64 step. */
function integer(x) {
  buffer.setFloat64(0, x);
  const bits = buffer.getBigUint64(0),
    exponent = Number((bits >> 52n) & 2047n),
    fraction = bits & ((1n << 52n) - 1n),
    m = exponent ? fraction | (1n << 52n) : fraction;
  return (bits >> 63n ? -m : m) << BigInt(Math.max(exponent, 1) - 1);
}
const sub = (a, b) => a.map((x, k) => x - b[k]),
  dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A convex list of homogeneous points [x, y, z, w] cut down to where the linear form f is not negative. */
function clip(points, f) {
  const out = [];
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length],
      a = f(p),
      b = f(q);
    if (a >= 0n) out.push(p);
    if ((a > 0n && b < 0n) || (a < 0n && b > 0n)) out.push(p.map((x, k) => (a > 0n ? 1n : -1n) * (a * q[k] - b * x)));
  });
  return out;
}

/** Whether two triangles of corner indices meet anywhere but in the corner or edge they share. */
function meet(points, a, b) {
  const shared = a.filter((v) => b.includes(v));
  if (shared.length === 3) return true;
  const S = a.map((v) => points[v]),
    T = b.map((v) => points[v]),
    normal = cross(sub(T[1], T[0]), sub(T[2], T[0])),
    plane = (p) => dot(normal, p) - dot(normal, T[0]) * p[3];
  let part = clip(
    clip(
      S.map((p) => [...p, 1n]),
      plane,
    ),
    (p) => -plane(p),
  );
  for (let i = 0; i < 3 && part.length; i++) {
    const inward = cross(normal, sub(T[(i + 1) % 3], T[i]));
    part = clip(part, (p) => dot(inward, p) - dot(inward, T[i]) * p[3]);
  }
  const corners = shared.map((v) => points[v]);
  return part.some((p) => {
    if (!corners.length) return true;
    const r = sub(
      p.slice(0, 3),
      corners[0].map((x) => x * p[3]),
    );
    if (corners.length === 1) return r.some((x) => x !== 0n);
    const edge = sub(corners[1], corners[0]),
      along = dot(edge, r);
    return cross(edge, r).some((x) => x !== 0n) || along < 0n || along > dot(edge, edge) * p[3];
  });
}

/** The triangles the mesh renders as, and how many pairs of them meet outside what they share. */
function crossings(mesh) {
  const triangles = [];
  for (const face of mesh.faces)
    for (let i = 1; i < face.vertices.length - 1; i++)
      triangles.push([face.vertices[0], face.vertices[i], face.vertices[i + 1]]);
  const points = mesh.vertices.map((p) => p.map(integer)),
    boxes = triangles.map((t) =>
      [0, 1, 2].map((k) => {
        const values = t.map((v) => mesh.vertices[v][k]);
        return [Math.min(...values), Math.max(...values)];
      }),
    );
  let count = 0;
  for (let i = 0; i < triangles.length; i++)
    for (let j = i + 1; j < triangles.length; j++)
      if (
        boxes[i].every(([low, high], k) => low <= boxes[j][k][1] && boxes[j][k][0] <= high) &&
        meet(points, triangles[i], triangles[j])
      )
        count++;
  return count;
}

const volume = (mesh) => {
  let sum = 0;
  for (const face of mesh.faces) {
    const a = mesh.vertices[face.vertices[0]];
    for (let i = 1; i < face.vertices.length - 1; i++)
      sum += dot(a, cross(mesh.vertices[face.vertices[i]], mesh.vertices[face.vertices[i + 1]]));
  }
  return sum / 6;
};

/** `p` turned about x, then y, then z. */
const turned = (p, angles) => {
  const out = [...p];
  angles.forEach((angle, axis) => {
    const u = (axis + 1) % 3,
      v = (axis + 2) % 3,
      c = Math.cos(angle),
      s = Math.sin(angle),
      [x, y] = [out[u], out[v]];
    out[u] = x * c - y * s;
    out[v] = x * s + y * c;
  });
  return out;
};

const closed = (mesh) => {
  compilePolygonMesh(mesh);
  for (const edge of polygonMeshEdges(mesh))
    assert.equal(edge.incidences.filter((use) => use.from === edge.vertices[0]).length * 2, edge.incidences.length);
};

test('the second method calls touching, folding and piercing pairs, and not shared corners', () => {
  const vertices = [
      [0, 0, 0],
      [4, 0, 0],
      [0, 4, 0],
      [1, 1, 0],
      [1, 1, 2],
      [2, 1, -2],
      [4, 4, 0],
      [-1, -1, 3],
    ],
    count = (...faces) => crossings({ vertices, faces: faces.map((f) => ({ vertices: f })) });
  assert.equal(count([0, 1, 2], [1, 6, 2]), 0);
  assert.equal(count([0, 1, 2], [0, 7, 4]), 0);
  assert.equal(count([0, 1, 2], [3, 4, 7]), 1);
  assert.equal(count([0, 1, 2], [4, 5, 7]), 1);
  assert.equal(count([0, 1, 2], [0, 1, 3]), 1);
  assert.equal(count([0, 1, 2], [0, 4, 5]), 1);
});

test('regression: float32 output of nearly coincident solids has no crossing triangles', () => {
  const cube = createPrimitiveMesh('cube', 'c');
  // Turns that left 4, 3, 2 and 15 pairs crossing after each corner was rounded.
  for (const [step, base, turn, operation] of [
    [1e-7, [0.3, 0.5, 0.7], [1, -2, 3], 'difference'],
    [1e-6, [0.6, 0.1, 0.8], [1, 1, 1], 'union'],
    [1e-6, [0.6, 0.1, 0.8], [1, 1, 1], 'difference'],
    [1e-5, [0.2, 0.7, 0.3], [-1, 2, 1], 'difference'],
  ]) {
    const place = (prefix, angles) => ({
        vertices: cube.vertices.map((p) => turned(turned(p, angles), base)),
        faces: cube.faces.map((face) => ({ ...face, id: prefix + face.id })),
      }),
      a = place('a', [0, 0, 0]),
      b = place(
        'b',
        turn.map((x) => x * step),
      ),
      exact = booleanMeshesExact(a, b, operation, { createId: ids() });
    for (const result of [
      booleanMeshesExact(a, b, operation, { createId: ids(), precision: 'float32' }),
      batchBooleanMeshes([a, b], operation, { createId: ids(), precision: 'float32' }),
    ]) {
      const name = `${operation} at ${step}`;
      closed(result.mesh);
      assert.ok(result.mesh.vertices.every((p) => p.every((x) => Math.fround(x) === x)));
      assert.equal(crossings(result.mesh), 0, name);
      assert.equal(result.selfIntersections, 0, name);
      // A unit cube's surface moving 2^-16 changes its volume by less than 1e-4.
      assert.ok(Math.abs(volume(result.mesh) - volume(exact.mesh)) < 1e-4, name);
    }
    assert.equal(exact.selfIntersections, undefined);
  }
});

test('regression: repairing thin faces never moves a long edge (a nearly empty difference stays empty)', () => {
  // Two unit cubes about 1e-8 apart: the old repair merged edges up to 0.39 long and left a solid of volume 0.034.
  const points = [
      [-0.4972135779799053, -0.5352231679112883, -0.4650965689009384],
      [0.23140062004918943, 0.0422040748037768, -0.8334701968941708],
      [-0.10141443051167115, 0.8107499545213271, -0.2870533478774623],
      [-0.8300286285407659, 0.23332271180626202, 0.08132028011577004],
      [0.10141443051167115, -0.8107499545213271, 0.2870533478774623],
      [0.8300286285407659, -0.23332271180626202, -0.08132028011577004],
      [0.4972135779799053, 0.5352231679112883, 0.4650965689009384],
      [-0.23140062004918943, -0.0422040748037768, 0.8334701968941708],
    ],
    near = [
      [-0.49721358227811346, -0.5352231562736586, -0.46509658095051243],
      [0.23140061806982898, 0.04220409115351925, -0.8334701969709887],
      [-0.10141443479129363, 0.8107499633570919, -0.28705333878678285],
      [-0.8300286351392361, 0.2333227159299139, 0.08132027723369312],
      [0.10141442211223974, -0.8107499539676811, 0.28705333503173414],
      [0.8300286224601823, -0.23332270654050316, -0.08132028098874183],
      [0.49721356959905955, 0.5352231656630694, 0.4650965771954637],
      [-0.2314006307488829, -0.04220408176410853, 0.83347019321594],
    ],
    cube = createPrimitiveMesh('cube', 'c'),
    solid = (prefix, vertices) => ({ vertices, faces: cube.faces.map((f) => ({ ...f, id: prefix + f.id })) }),
    a = solid('a', points),
    b = solid('b', near),
    of = (operation) => {
      const { mesh } = booleanMeshesExact(a, b, operation, { createId: ids() });
      closed(mesh);
      return volume(mesh);
    },
    union = of('union'),
    difference = of('difference'),
    both = of('intersection');
  assert.ok(difference > 0 && difference < 1e-7, `difference ${difference}`);
  assert.ok(Math.abs(union - both - difference - (volume(b) - both)) < 1e-6, `union ${union}, both ${both}`);
});

test('regression: a needle triangle is planar', () => {
  // Its height is 1.3e-8 of its length: the normal's own rounding put the third corner 2e-8 off the plane.
  const mesh = {
    vertices: [
      [-0.4972135733929219, -0.5352231603631906, -0.46509656978665764],
      [0.2314006156619171, 0.04220408493498948, -0.8334701896911326],
      [0.23140062004918943, 0.0422040748037768, -0.8334701968941708],
    ],
    faces: [
      {
        id: 'needle',
        vertices: [0, 1, 2],
        uv: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
      },
    ],
  };
  assert.equal(compilePolygonMesh(mesh).indices.length, 3);
});
