// The cloth render bridge's CPU half: the packed vertices follow the particles, the normals and tangents are recomputed
// from the triangles, and the texture coordinates come from the cloth's grid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics } from '@margoengine/physics';
import { SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';
import { SoftSurface } from '../dist/soft-mesh.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

const STRIDE = 20;
const create = async () => {
  const physics = new Physics(null, {});
  return { physics, soft: await SoftBodies.attach(physics) };
};
const steps = (physics, count) => {
  for (let i = 0; i < count; i++) physics.step();
};
const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} not within ${tolerance} of ${expected}`);

/** The area-weighted vertex normals of a mesh, computed here on their own. */
const referenceNormals = (positions, indices, count) => {
  const n = new Float64Array(count * 3);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
    const e1 = [0, 1, 2].map((k) => positions[b * 3 + k] - positions[a * 3 + k]);
    const e2 = [0, 1, 2].map((k) => positions[c * 3 + k] - positions[a * 3 + k]);
    const f = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) n[v * 3 + k] += f[k];
  }
  for (let v = 0; v < count; v++) {
    const l = Math.hypot(n[v * 3], n[v * 3 + 1], n[v * 3 + 2]);
    for (let k = 0; k < 3; k++) n[v * 3 + k] /= l;
  }
  return n;
};
const checkFrame = (surface, label) => {
  const v = surface.vertices;
  for (let i = 0; i < surface.vertexCount; i++) {
    const o = i * STRIDE,
      n = [v[o + 4], v[o + 5], v[o + 6]],
      t = [v[o + 8], v[o + 9], v[o + 10]];
    near(Math.hypot(...n), 1, 1e-5, `${label}: normal ${i} is a unit vector`);
    near(Math.hypot(...t), 1, 1e-5, `${label}: tangent ${i} is a unit vector`);
    near(n[0] * t[0] + n[1] * t[1] + n[2] * t[2], 0, 1e-5, `${label}: tangent ${i} lies across its normal`);
    assert.ok(v[o + 11] === 1 || v[o + 11] === -1, `${label}: tangent ${i} has a handedness`);
    assert.equal(v[o + 3], 1, 'w of the position is 1');
  }
};

test('a cloth surface copies its particles, points its normals off the sheet and takes the grid as its UVs', async () => {
  const { physics, soft } = await create();
  const nu = 6,
    nv = 4;
  const cloth = soft.create(
    SoftBodyDesc.cloth([-0.5, 2, -0.3], [0.2, 0, 0], [0, 0, 0.2], nu, nv).setPinnedParticles([0, nv - 1]),
  );
  const surface = new SoftSurface(cloth);
  assert.equal(surface.vertexCount, nu * nv);
  assert.deepEqual([...surface.indices], [...cloth.triangles()]);
  const v = surface.vertices;
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const k = i * nv + j,
        o = k * STRIDE;
      near(v[o + 12], i / (nu - 1), 1e-7, `u of particle (${i}, ${j})`);
      near(v[o + 13], j / (nv - 1), 1e-7, `v of particle (${i}, ${j})`);
      // The sheet lies flat in x and z with its triangles wound to face +y.
      near(v[o + 5], 1, 1e-6, `normal of particle (${i}, ${j}) points up`);
      // u runs along +x, so the tangent does.
      near(v[o + 8], 1, 1e-6, `tangent of particle (${i}, ${j}) runs along u`);
    }
  checkFrame(surface, 'at rest');
  // Hung by two corners, the cloth falls and folds: the vertices are where the particles are and the normals are the
  // area-weighted ones of the triangles as they now stand.
  steps(physics, 40);
  surface.update();
  const p = cloth.particlePositions(),
    reference = referenceNormals(p, surface.indices, nu * nv);
  let bent = 0;
  for (let k = 0; k < nu * nv; k++) {
    const o = k * STRIDE;
    for (let a = 0; a < 3; a++) {
      assert.equal(v[o + a], p[k * 3 + a], `vertex ${k} is at its particle`);
      near(v[o + 4 + a], reference[k * 3 + a], 1e-5, `normal ${k}`);
    }
    bent = Math.max(bent, 1 - v[o + 5]);
  }
  assert.ok(bent > 0.1, `the falling cloth bends its normals (${bent})`);
  checkFrame(surface, 'after 40 steps');
});

test('a tube doubles its seam so u runs 0 to 1 around it without a jump', async () => {
  const { soft } = await create();
  const around = 8,
    along = 5;
  const tube = soft.create(SoftBodyDesc.clothTube([0, 0, 0], [0, 2, 0], 0.5, 0.5, around, along));
  const surface = new SoftSurface(tube);
  assert.equal(surface.vertexCount, (around + 1) * along);
  const v = surface.vertices;
  for (let j = 0; j < along; j++) {
    const first = j * STRIDE,
      seam = (around * along + j) * STRIDE;
    for (let a = 0; a < 3; a++) {
      assert.equal(v[seam + a], v[first + a], 'the seam copy stands on the first ring');
      // One point of the surface, lit alike from both sides of the seam.
      near(v[seam + 4 + a], v[first + 4 + a], 1e-6, 'and has its normal');
      near(v[seam + 8 + a], v[first + 8 + a], 1e-6, 'and its tangent');
    }
    near(v[first + 12], 0, 1e-7, 'u starts at 0');
    near(v[seam + 12], 1, 1e-7, 'and ends at 1 on the seam');
  }
  for (let t = 0; t < surface.indices.length; t += 3) {
    const u = [0, 1, 2].map((k) => v[surface.indices[t + k] * STRIDE + 12]);
    assert.ok(Math.max(...u) - Math.min(...u) < 0.5, `triangle ${t / 3} does not span the seam backwards: ${u}`);
  }
  // Every normal points out of the tube's axis.
  for (let k = 0; k < surface.vertexCount; k++) {
    const o = k * STRIDE,
      out = Math.hypot(v[o], v[o + 2]);
    const radial = (v[o + 4] * v[o] + v[o + 6] * v[o + 2]) / out;
    assert.ok(Math.abs(radial) > 0.9, `normal ${k} is across the axis (${radial})`);
  }
  checkFrame(surface, 'tube');
});

test('a closed surface has outward normals and flat UVs; given UVs are used; append drops the grid', async () => {
  const { soft } = await create();
  const ball = soft.create(SoftBodyDesc.sphere([0, 3, 0], 1, 1));
  const surface = new SoftSurface(ball);
  const v = surface.vertices;
  for (let k = 0; k < surface.vertexCount; k++) {
    const o = k * STRIDE,
      d = [v[o], v[o + 1] - 3, v[o + 2]],
      l = Math.hypot(...d);
    assert.ok((d[0] * v[o + 4] + d[1] * v[o + 5] + d[2] * v[o + 6]) / l > 0.9, `normal ${k} points out of the ball`);
    assert.ok(v[o + 12] >= 0 && v[o + 12] <= 1 && v[o + 13] >= 0 && v[o + 13] <= 1, 'flat UVs lie in 0..1');
  }
  const count = ball.numParticles();
  const own = Float32Array.from({ length: count * 2 }, (_, k) => k / (count * 2));
  const given = new SoftSurface(ball, { uvs: own });
  assert.equal(given.vertices[STRIDE + 12], own[2]);
  assert.throws(() => new SoftSurface(ball, { uvs: own.subarray(2) }), RangeError);
  // Two sheets merged are not one grid: their UVs are laid flat instead, still in 0..1.
  const two = soft.create(
    SoftBodyDesc.cloth([0, 0, 0], [0.1, 0, 0], [0, 0, 0.1], 3, 3).append(
      SoftBodyDesc.cloth([1, 0, 0], [0.1, 0, 0], [0, 0, 0.1], 3, 3),
    ),
  );
  const flat = new SoftSurface(two);
  near(flat.vertices[(9 + 8) * STRIDE + 12], 1, 1e-6, 'the far corner of the second sheet is at u = 1');
});

test('a surface needs triangles and a body that is still there; particlePositions fills a target', async () => {
  const { soft } = await create();
  const rope = soft.create(SoftBodyDesc.rope([0, 1, 0], [1, 1, 0], 5));
  assert.throws(() => new SoftSurface(rope), TypeError);
  const cloth = soft.create(SoftBodyDesc.cloth([0, 0, 0], [0.1, 0, 0], [0, 0, 0.1], 3, 3));
  const target = new Float32Array(27);
  assert.equal(cloth.particlePositions(target), target);
  assert.deepEqual([...target], [...cloth.particlePositions()]);
  assert.throws(() => cloth.particlePositions(new Float32Array(3)), RangeError);
  const surface = new SoftSurface(cloth);
  soft.remove(cloth);
  assert.throws(
    () => surface.update(),
    (error) => error.name === 'MargoError' && error.code === 'state',
  );
  assert.throws(
    () => new SoftSurface(cloth),
    (error) => error.name === 'MargoError' && error.code === 'state',
  );
});
