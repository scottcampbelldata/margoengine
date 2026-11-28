// Skinning about optimized centres of rotation (Le and Hodgins 2016): the centres, the CPU blend, and the Animation wiring.
// Regression for the old man's coat ballooning at a raised shoulder and over bent hips under dual quaternion skinning
// (KB-SKIN-BULGE1): a bend neither bulges (dual quaternion) nor collapses (linear), and a twist keeps its volume.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeDualQuaternions, skinDualQuaternion } from '../dist/dqs.js';
import { centerOfRotationSkinning, rotationCentres, skinCenterOfRotation } from '../dist/cor.js';
import { Animation } from '../dist/index.js';
import { skinnedStrip } from '../test/fixture.js';
import { model } from './support/models.js';
import { cloneModel } from '../dist/skeleton-utils.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

/** Column-major translate(t) * rotate(axis, degrees about pivot) * uniform scale. */
function bone(axis, degrees, pivot = [0, 0, 0], scale = 1) {
  const h = (degrees * Math.PI) / 180,
    c = Math.cos(h),
    s = Math.sin(h),
    t = 1 - c,
    [x, y, z] = axis,
    r = [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c],
    out = new Float32Array(16);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[j * 4 + i] = r[i * 3 + j] * scale;
  // M p = R S (p - pivot) + pivot
  for (let i = 0; i < 3; i++)
    out[12 + i] = pivot[i] - (r[i * 3] * pivot[0] + r[i * 3 + 1] * pivot[1] + r[i * 3 + 2] * pivot[2]) * scale;
  out[15] = 1;
  return out;
}

/** A tube along +x from 0 to 2, radius 0.25, on bone 0 (x < 1) and bone 1 (x > 1), blended over x in [0.6, 1.4]. */
function tube(rings = 41, sides = 16, radius = 0.25) {
  const positions = [],
    normals = [],
    joints = [],
    weights = [],
    triangles = [];
  for (let r = 0; r < rings; r++) {
    const x = (r / (rings - 1)) * 2,
      w1 = Math.min(1, Math.max(0, (x - 0.6) / 0.8)),
      w = w1 * w1 * (3 - 2 * w1);
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      positions.push(x, Math.cos(a) * radius, Math.sin(a) * radius);
      normals.push(0, Math.cos(a), Math.sin(a));
      joints.push(0, 1, 0, 0);
      weights.push(1 - w, w, 0, 0);
    }
  }
  for (let r = 0; r + 1 < rings; r++)
    for (let s = 0; s < sides; s++) {
      const a = r * sides + s,
        b = r * sides + ((s + 1) % sides);
      triangles.push(a, b, a + sides, b, b + sides, a + sides);
    }
  return { positions, normals, joints, weights, triangles, influences: 4, radius };
}

/** Each vertex's distance to the posed bones (segment 0 to the joint, the joint to bone 1's end), over the radius. */
function radii(points, palette1, radius) {
  const end = [0, 1, 2].map((i) => palette1[i] * 2 + palette1[4 + i] * 0 + palette1[12 + i]),
    joint = [1, 0, 0],
    segments = [
      [[0, 0, 0], joint],
      [joint, end],
    ];
  let low = Infinity,
    high = 0;
  for (const p of points) {
    let best = Infinity;
    for (const [a, b] of segments) {
      const d = b.map((v, i) => v - a[i]),
        t = Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / (d[0] ** 2 + d[1] ** 2 + d[2] ** 2)));
      best = Math.min(best, Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1], p[2] - a[2] - t * d[2]));
    }
    low = Math.min(low, best / radius);
    high = Math.max(high, best / radius);
  }
  return [low, high];
}

function pose(mesh, palette, method, centres) {
  const encoded = encodeDualQuaternions(palette.slice()),
    out = [];
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    const j = mesh.joints.slice(v * 4, v * 4 + 2),
      w = mesh.weights.slice(v * 4, v * 4 + 2),
      p = mesh.positions.slice(v * 3, v * 3 + 3);
    if (method === 'linear') {
      const q = [0, 0, 0];
      for (let k = 0; k < 2; k++)
        for (let i = 0; i < 3; i++)
          q[i] += w[k] * (palette[j[k] * 16 + i] * p[0] + palette[j[k] * 16 + 4 + i] * p[1] + palette[j[k] * 16 + 8 + i] * p[2] + palette[j[k] * 16 + 12 + i]);
      out.push(q);
    } else if (method === 'dq') out.push(skinDualQuaternion(encoded, j, w, p).position);
    else out.push(skinCenterOfRotation(encoded, j, w, p, [0, 0, 1], centres.subarray(v * 4, v * 4 + 3)).position);
  }
  return out;
}

/** A panel hanging below a hip joint at the origin (y from -1 to -0.5), every vertex half on a still bone and half on one
 * turning about the joint: the old man's coat skirt and side panel, whose cloth is weighed so (KB-SKIN-BULGE1). */
function panel(n = 9) {
  const positions = [],
    joints = [],
    weights = [],
    triangles = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      positions.push(-0.2 + (0.4 * c) / (n - 1), -1 + (0.5 * r) / (n - 1), 0.1);
      joints.push(0, 1, 0, 0);
      weights.push(0.5, 0.5, 0, 0);
    }
  for (let r = 0; r + 1 < n; r++)
    for (let c = 0; c + 1 < n; c++) {
      const a = r * n + c;
      triangles.push(a, a + 1, a + n, a + 1, a + n + 1, a + n);
    }
  return { positions, joints, weights, triangles, influences: 4 };
}
const area = (points, triangles) => {
  let sum = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [points[triangles[t]], points[triangles[t + 1]], points[triangles[t + 2]]],
      u = b.map((v, i) => v - a[i]),
      w = c.map((v, i) => v - a[i]);
    sum += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
  }
  return sum;
};

test('cloth weighed half on a turning bone keeps its size and stays in, where linear shrinks it and dual quaternions swing it out (KB-SKIN-BULGE1)', () => {
  const mesh = panel(),
    [centres] = rotationCentres([mesh]),
    count = mesh.positions.length / 3,
    rest = Array.from({ length: count }, (_, v) => mesh.positions.slice(v * 3, v * 3 + 3)),
    restArea = area(rest, mesh.triangles),
    reach = (points) => Math.max(...points.map((p) => Math.hypot(...p)));
  // Every vertex has the same weights: one centre, the panel's middle.
  for (let v = 0; v < count; v++) {
    assert.equal(centres[v * 4 + 3], 1);
    assert.ok(Math.abs(centres[v * 4]) < 1e-6 && Math.abs(centres[v * 4 + 1] + 0.75) < 1e-6, `${centres.subarray(v * 4, v * 4 + 3)}`);
  }
  for (const degrees of [45, 90, 140]) {
    const palette = new Float32Array(32);
    palette.set(bone([1, 0, 0], 0), 0);
    palette.set(bone([1, 0, 0], degrees), 16);
    const cor = pose(mesh, palette, 'cor', centres),
      linear = pose(mesh, palette, 'linear'),
      dq = pose(mesh, palette, 'dq'),
      half = Math.cos((degrees * Math.PI) / 360);
    assert.ok(Math.abs(area(cor, mesh.triangles) / restArea - 1) < 1e-3, `${degrees}: the cloth keeps its size`);
    assert.ok(area(linear, mesh.triangles) / restArea < 1 - 0.5 * (1 - half), `${degrees}: a linear blend shrinks it`);
    // The panel's middle goes where the linear blend takes it, half the way round the turn's chord.
    assert.ok(reach(cor) < reach(dq) - 0.6 * (1 - half), `${degrees}: no swing out (${reach(cor).toFixed(3)} against ${reach(dq).toFixed(3)})`);
  }
});

test('a twist keeps its radius where a linear blend pinches', () => {
  const mesh = tube(),
    [centres] = rotationCentres([mesh]),
    palette = new Float32Array(32);
  palette.set(bone([1, 0, 0], 0), 0);
  palette.set(bone([1, 0, 0], 160, [1, 0, 0]), 16);
  const [cl, ch] = radii(pose(mesh, palette, 'cor', centres), palette.subarray(16), mesh.radius),
    [ll] = radii(pose(mesh, palette, 'linear'), palette.subarray(16), mesh.radius);
  assert.ok(cl > 0.97 && ch < 1.03, `the twist keeps the radius (${cl.toFixed(3)} to ${ch.toFixed(3)})`);
  assert.ok(ll < 0.5, `the linear blend pinches (${ll.toFixed(3)})`);
});

test('one bone moves a vertex exactly as its matrix, scaled or not, wherever its centre is', () => {
  const m = bone([0.3, 0.8, 0.52].map((v) => v / Math.hypot(0.3, 0.8, 0.52)), 73, [0.4, -1, 2], 1.7);
  m[12] += 0.5;
  const slots = encodeDualQuaternions(m.slice()),
    p = [0.3, -0.7, 1.1],
    expected = [0, 1, 2].map((i) => m[i] * p[0] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[12 + i]);
  for (const centre of [p, [5, 5, 5], [0, 0, 0]]) {
    const got = skinCenterOfRotation(slots, [0], [1], p, [0, 0, 1], centre).position;
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(got[i] - expected[i]) < 1e-5, `centre ${centre}: ${got} against ${expected}`);
  }
});

test('rotationCentres: one bone keeps the vertex, like weights share the middle of their band, bad input is refused', () => {
  const mesh = tube(),
    [centres] = rotationCentres([mesh]),
    sides = 16;
  // Ring 0 is all bone 0: its own position, flagged 0.
  assert.deepEqual([...centres.subarray(0, 4)], [0, 0.25, 0, 0]);
  // The middle ring (x = 1, half and half) centres on the tube's axis at x = 1.
  const mid = 20 * sides * 4;
  assert.equal(centres[mid + 3], 1);
  assert.ok(Math.abs(centres[mid] - 1) < 0.02 && Math.hypot(centres[mid + 1], centres[mid + 2]) < 1e-3, `${centres.subarray(mid, mid + 3)}`);
  // Two parts of one surface agree with the surface in one part.
  const half = mesh.triangles.length / 2,
    split = rotationCentres([
      { ...mesh, triangles: mesh.triangles.slice(0, half) },
      { ...mesh, triangles: mesh.triangles.slice(half) },
    ]);
  for (let i = 0; i < centres.length; i++) assert.ok(Math.abs(split[0][i] - centres[i]) < 1e-5);
  assert.throws(() => rotationCentres([{ ...mesh, weights: [1] }]), /influences/);
  assert.throws(() => rotationCentres([mesh], { sigma: 0 }), /sigma/);
  assert.throws(() => rotationCentres([{ ...mesh, triangles: [0, 1] }]), /threes/);
});

/** A WebGPU-shaped engine, enough for Animation.setup to place a model and build its dispatches. */
async function gpuEngine(t) {
  const gpu = optionalGPU(),
    store = await TransformStore.create(64),
    e = new Engine(
      { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
      store,
      { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  t.after(() => {
    e.dispose();
    gpu.cleanup();
  });
  store.tick(false);
  return e;
}

test('Animation packs each vertex centre after its weights, once per mesh, and never in a linear slot block', async (t) => {
  const e = await gpuEngine(t),
    strip = model(e, skinnedStrip());
  e.use(strip);
  let calls = 0;
  const mode = { ...centerOfRotationSkinning, vertexData: (parts) => (calls++, centerOfRotationSkinning.vertexData(parts)) },
    animation = Animation.attach(strip, { skinning: mode }),
    clone = await cloneModel(strip),
    second = Animation.attach(clone, { skinning: mode }),
    linear = Animation.attach(await cloneModel(strip));
  assert.equal(calls, 1, 'the mesh centres are made once for the asset');
  const r = animation['resources'][0],
    ids = r.influences(),
    count = strip.primitives.find((p) => p.vertices.length).vertices.length / 20;
  assert.equal(ids.length, count * 12, 'joints, weights and the centre: 12 words per vertex');
  const floats = new Float32Array(ids.buffer, ids.byteOffset, ids.length),
    positions = strip.asset.accessor(strip.asset.doc.meshes[0].primitives[0].attributes.POSITION, 'VEC3');
  // The strip's vertices are each on one bone: every centre is the vertex itself.
  for (let i = 0; i < count; i++)
    for (let c = 0; c < 3; c++) assert.equal(floats[i * 12 + 8 + c], positions[i * 3 + c]);
  assert.equal(second['slots'][0].influences, animation['slots'][0].influences, 'one mode shares one block');
  assert.notEqual(linear['slots'][0].influences, animation['slots'][0].influences, 'linear slots keep their own');
  const plain = model(e, skinnedStrip());
  e.use(plain);
  assert.throws(() => new Animation(plain, { skinning: { ...centerOfRotationSkinning, vertexData: 1 } }), /dualQuaternionSkinning/);
  assert.throws(
    () => Animation.attach(plain, { skinning: { ...centerOfRotationSkinning, vertexData: () => [new Float32Array(1)] } }),
    /four numbers per vertex/,
  );
});
