import assert from 'node:assert/strict';
import test from 'node:test';
import { bevelQuads } from '../dist/bevel.js';

const FACE = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

const normalOf = (mesh, triangle) => {
  const [a, b, c] = [0, 1, 2].map((k) => mesh.indices[triangle * 3 + k]);
  const p = (i) => [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
  const [ax, ay, az] = p(a),
    [bx, by, bz] = p(b),
    [cx, cy, cz] = p(c),
    ux = bx - ax,
    uy = by - ay,
    uz = bz - az,
    vx = cx - ax,
    vy = cy - ay,
    vz = cz - az;
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
};

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test('each face of a cube winds outward and its chamfer strips slope', () => {
  // A lone face has nothing across its edges, so it stays flat; the faces of a closed cube chamfer each other.
  const cube = [0, 1, 2, 3, 4, 5].map((face) => ({ x: 0, y: 0, z: 0, face, w: 1, h: 1, material: face + 1 }));
  const mesh = bevelQuads(cube, 0.2);
  for (let face = 0; face < 6; face++) {
    const lone = bevelQuads([cube[face]], 0.2);
    assert.equal(lone.indices.length / 3, 2, `lone face ${face} is not one flat panel`);
    const own = [];
    for (let triangle = 0; triangle < mesh.indices.length / 3; triangle++)
      if (mesh.materials[mesh.indices[triangle * 3]] === face + 1) own.push(triangle);
    let strips = 0;
    for (const triangle of own) {
      const geometric = normalOf(mesh, triangle);
      assert.ok(dot(geometric, FACE[face]) > 0, `face ${face} triangle ${triangle} winds inward`);
      const vertex = mesh.indices[triangle * 3];
      const stored = [mesh.normals[vertex * 3], mesh.normals[vertex * 3 + 1], mesh.normals[vertex * 3 + 2]];
      assert.ok(dot(stored, FACE[face]) > 0.2, `face ${face} triangle ${triangle} normal faces inward`);
      if (Math.abs(dot(stored, FACE[face]) - Math.SQRT1_2) < 1e-6) strips++;
    }
    assert.ok(strips >= 8, `face ${face} has ${strips} triangles on 45 degree strips, not its four half strips`);
  }
});

test('a closed cube and a concave corner stay outward', () => {
  const cube = [0, 1, 2, 3, 4, 5].map((face) => ({ x: 0, y: 0, z: 0, face, w: 1, h: 1 }));
  const closed = bevelQuads(cube, 0.15);
  for (let triangle = 0; triangle < closed.indices.length / 3; triangle++) {
    const geometric = normalOf(closed, triangle);
    const vertex = closed.indices[triangle * 3];
    const point = [
      closed.positions[vertex * 3] - 0.5,
      closed.positions[vertex * 3 + 1] - 0.5,
      closed.positions[vertex * 3 + 2] - 0.5,
    ];
    assert.ok(dot(geometric, point) > 0, `cube triangle ${triangle} points into the cube`);
  }
  const concave = bevelQuads(
    [
      { x: 0, y: 0, z: 0, face: 0, w: 1, h: 1 },
      { x: 1, y: 0, z: 0, face: 5, w: 1, h: 1 },
    ],
    0.15,
  );
  for (let triangle = 0; triangle < concave.indices.length / 3; triangle++) {
    const geometric = normalOf(concave, triangle);
    const vertex = concave.indices[triangle * 3];
    const stored = [concave.normals[vertex * 3], concave.normals[vertex * 3 + 1], concave.normals[vertex * 3 + 2]];
    assert.ok(dot(geometric, stored) > 0, `concave triangle ${triangle} disagrees with its normal`);
  }
});

test('adjacent faces weld across a chunk seam', () => {
  const mesh = bevelQuads(
    [
      { x: 31, y: 0, z: 0, face: 2, w: 1, h: 1 },
      { x: 32, y: 0, z: 0, face: 2, w: 1, h: 1 },
    ],
    0.1,
  );
  const points = [];
  for (let i = 0; i < mesh.positions.length; i += 3)
    points.push([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
  const shared = points.filter((p) => Math.abs(p[0] - 32) < 1e-4);
  assert.ok(shared.length >= 2, 'the seam has no shared corner');
});

test('bevel interpolates mesher AO and sky/block light over panels and strips', () => {
  const ao = [0, 1, 2, 3],
    sky = [0, 5, 10, 15],
    block = [15, 10, 5, 0],
    cube = [0, 1, 2, 3, 4, 5].map((face) => ({ x: 0, y: 0, z: 0, face, w: 1, h: 1 }));
  cube[4] = { ...cube[4], ao, sky, block };
  const mesh = bevelQuads(cube, 0.2);
  assert.equal(mesh.lighting.length, mesh.positions.length);
  // On the +z face a point (x, y) reads the corners (0,0), (1,0), (1,1), (0,1) bilinearly.
  const bilinear = (c, x, y) => (c[0] * (1 - x) + c[1] * x) * (1 - y) + (c[3] * (1 - x) + c[2] * x) * y;
  let checked = 0;
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    if (mesh.normals[v * 3 + 2] <= 0 || mesh.lighting[v * 3 + 1] === 15) continue;
    const x = Math.min(Math.max(mesh.positions[v * 3], 0), 1),
      y = Math.min(Math.max(mesh.positions[v * 3 + 1], 0), 1);
    // Strip middles and corner centres take the point of the face under them.
    for (const [k, c] of [ao, sky, block].entries())
      assert.ok(Math.abs(mesh.lighting[v * 3 + k] - bilinear(c, x, y)) < 1e-5, `vertex ${v} channel ${k}`);
    checked++;
  }
  assert.ok(checked > 8, 'the +z panel, strips and corners carry the face light');
  const open = bevelQuads([{ x: 0, y: 0, z: 0, face: 2, w: 2, h: 1 }], 0);
  assert.deepEqual([...open.lighting.subarray(0, 3)], [3, 15, 0], 'defaults: open AO, full sky, no block light');
  assert.equal(open.indices.length, 6, 'no bevel: two triangles');
});
