import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { wgsl } from '../../core/dist/shaders.js';
import { ARDepth, ARLight, ARPlanes, DEPTH_SENSING, planeGeometry, triangulate } from '../dist/ar.js';

async function engine(t) {
  const store = await TransformStore.create(256),
    context = {
      backend: 'webgpu',
      shader: wgsl,
      descriptor: { vertex: { entryPoint: 'vertex', buffers: [] } },
      draw() {},
    };
  const e = new Engine(
    { width: 1, height: 1, getContext() {} },
    store,
    {
      backend: 'webgpu',
      add() {},
      remove() {},
      dispose() {},
      render(camera, light, batches, graph) {
        graph.execute(context);
      },
    },
    undefined,
    null,
  );
  t.after(() => e.dispose());
  return e;
}
/** A stand-in XR: its session, reference space and frame hook. */
function host(session) {
  const listeners = new Set();
  return {
    session,
    referenceSpace: { name: 'local' },
    onFrame(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    step(frame) {
      for (const listener of listeners) listener({ frame });
    },
    get listening() {
      return listeners.size;
    },
  };
}
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const pose = (x, y, z, q = [0, 0, 0, 1]) => {
  const matrix = identity();
  matrix.set([x, y, z], 12);
  return { transform: { position: { x, y, z, w: 1 }, orientation: { x: q[0], y: q[1], z: q[2], w: q[3] }, matrix } };
};
/** The y of each triangle's right-hand normal over (x, 0, z) points, and the triangles' total area. */
function faces(points, indices) {
  const ys = [];
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]].map((k) => [points[k * 2], points[k * 2 + 1]]);
    // (b - a) x (c - a) with y = 0: its y component is (bz - az)(cx - ax) - (bx - ax)(cz - az).
    const y = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
    ys.push(y);
    area += Math.abs(y) / 2;
  }
  return { ys, area };
}
/** The outline's points in the other order. */
const reverse = (outline) => {
  const out = [];
  for (let i = outline.length - 2; i >= 0; i -= 2) out.push(outline[i], outline[i + 1]);
  return out;
};

test('triangulate covers a convex and a concave outline, either winding, with every face looking up +y', () => {
  const square = [-1, -1, 1, -1, 1, 1, -1, 1],
    // An L of area 3: a 2 x 2 square missing its top right unit square.
    ell = [0, 0, 2, 0, 2, 1, 1, 1, 1, 2, 0, 2];
  for (const [outline, area] of [
    [square, 4],
    [reverse(square), 4],
    [ell, 3],
    [reverse(ell), 3],
  ]) {
    const indices = triangulate(outline),
      found = faces(outline, indices);
    assert.equal(indices.length, (outline.length / 2 - 2) * 3, 'n - 2 triangles');
    assert.ok(Math.abs(found.area - area) < 1e-12, `area ${found.area}, want ${area}`);
    assert.ok(
      found.ys.every((y) => y > 0),
      `every face looks up +y: ${found.ys}`,
    );
  }
  assert.throws(() => triangulate([0, 0, 1, 0]), /3 or more x, z points/);
  assert.throws(() => triangulate([0, 0, 1, 0, Number.NaN, 1]), /finite points/);
});

test('planeGeometry lays the outline flat at y = 0 with +y normals and the faces of triangulate', () => {
  const outline = [0, 0, 2, 0, 2, 1, 1, 1, 1, 2, 0, 2],
    geometry = planeGeometry(outline);
  // Core interleaves position and normal, six floats a vertex.
  assert.deepEqual(
    Array.from(geometry.vertices).filter((_, i) => i % 6 === 1),
    [0, 0, 0, 0, 0, 0],
  );
  assert.deepEqual(
    Array.from(geometry.vertices).filter((_, i) => i % 6 === 4),
    [1, 1, 1, 1, 1, 1],
  );
  assert.deepEqual(
    Array.from(geometry.vertices).filter((_, i) => i % 6 === 0 || i % 6 === 2),
    outline,
  );
  assert.deepEqual(Array.from(geometry.indices), Array.from(triangulate(outline)));
});

test('ARPlanes reports planes as they come, change and go, with their pose, outline and label, and draws them', async (t) => {
  const e = await engine(t),
    events = [],
    xr = host({ enabledFeatures: ['plane-detection'] }),
    floor = {
      planeSpace: { name: 'floor' },
      polygon: [
        { x: -1, y: 0, z: -1 },
        { x: 1, y: 0, z: -1 },
        { x: 1, y: 0, z: 1 },
        { x: -1, y: 0, z: 1 },
      ],
      orientation: 'horizontal',
      lastChangedTime: 10,
      semanticLabel: 'floor',
    },
    detectedPlanes = new Set([floor]);
  let located = pose(0, -1.4, -2);
  const frame = {
    detectedPlanes,
    getPose: (space, base) => (space === floor.planeSpace && base === xr.referenceSpace ? located : null),
  };
  const { PbrMaterial } = await import('@margoengine/core');
  const planes = ARPlanes.create(xr, {
    onAdd: (p) => events.push(['add', p.label]),
    onChange: (p) => events.push(['change', p.polygon.length]),
    onRemove: (p) => events.push(['remove', p.label]),
    show: { engine: e, material: new PbrMaterial({ color: '#ffffff' }) },
  });
  const meshes = e.scene.meshes.size;
  xr.step(frame);
  const entry = planes.planes.get(floor);
  assert.deepEqual(events, [['add', 'floor']]);
  assert.equal(entry.orientation, 'horizontal');
  assert.deepEqual(Array.from(entry.polygon), [-1, -1, 1, -1, 1, 1, -1, 1]);
  assert.deepEqual(
    Array.from(entry.matrix.subarray(12, 15)).map((v) => +v.toFixed(5)),
    [0, -1.4, -2],
  );
  assert.equal(entry.tracked, true);
  assert.equal(e.scene.meshes.size, meshes + 1, 'one mesh per plane');
  // A pose change alone is not a change of the plane (Plane Detection Module, lastChangedTime).
  located = pose(0, -1.3, -2);
  xr.step(frame);
  assert.deepEqual(events, [['add', 'floor']]);
  assert.ok(Math.abs(entry.matrix[13] + 1.3) < 1e-6);
  floor.polygon = [...floor.polygon, { x: -1.5, y: 0, z: 0 }];
  floor.lastChangedTime = 20;
  xr.step(frame);
  assert.deepEqual(events.at(-1), ['change', 10]);
  located = null;
  xr.step(frame);
  assert.equal(planes.planes.get(floor).tracked, false, 'a tracked plane whose pose is unknown stays, untracked');
  detectedPlanes.clear();
  xr.step(frame);
  assert.deepEqual(events.at(-1), ['remove', 'floor']);
  assert.equal(planes.planes.size, 0);
  assert.equal(e.scene.meshes.size, meshes, 'its mesh goes with it');
  planes.dispose();
  assert.equal(xr.listening, 0);
  assert.throws(() => ARPlanes.create(host(null)), /await xr.requestSession first/);
  assert.throws(() => ARPlanes.create(host({ enabledFeatures: [] })), /ask for it when starting the session/);
});

test('ARDepth reads metres at view points and turns them into reference-space points through the view', () => {
  const xr = host({ enabledFeatures: ['depth-sensing'], depthUsage: 'cpu-optimized' }),
    depth = ARDepth.create(xr),
    // A symmetric 90 degree projection, f = 1 on both axes; the view 1 m above the origin.
    view = {
      projectionMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0]),
      transform: pose(0, 1, 0).transform,
    },
    asked = [],
    frame = {
      getDepthInformation: (v) =>
        v === view
          ? {
              width: 4,
              height: 4,
              rawValueToMeters: 0.001,
              normDepthBufferFromNormView: { matrix: identity() },
              getDepthInMeters: (x, y) => {
                asked.push([x, y]);
                return 2;
              },
            }
          : null,
    };
  assert.equal(depth.depthAt(frame, view, 0.5, 0.5), 2);
  assert.deepEqual(depth.pointAt(frame, view, 0.5, 0.5), [0, 1, -2]);
  // The top right corner of a 90 degree view: x and y are as far out as the point is deep.
  assert.deepEqual(
    depth.pointAt(frame, view, 1, 0).map((v) => +v.toFixed(6)),
    [2, 3, -2],
  );
  assert.deepEqual(asked.at(-1), [1, 0]);
  assert.equal(depth.pointAt({}, view, 0.5, 0.5), null, 'no depth this frame');
  assert.throws(() => depth.depthAt(frame, view, 1.5, 0), /pass normalized coordinates/);
  assert.deepEqual(DEPTH_SENSING.usagePreference, ['cpu-optimized']);
  assert.throws(() => ARDepth.create(host({ enabledFeatures: [] })), /init: \{depthSensing\}/);
  assert.throws(
    () => ARDepth.create(host({ enabledFeatures: ['depth-sensing'], depthUsage: 'gpu-optimized' })),
    /usagePreference \['cpu-optimized'\]/,
  );
  const thrower = { enabledFeatures: ['depth-sensing'] };
  Object.defineProperty(thrower, 'depthUsage', {
    get() {
      throw new Error('InvalidStateError');
    },
  });
  assert.throws(
    () => ARDepth.create(host(thrower)),
    (error) => /DEPTH_SENSING/.test(error.message) && error.cause?.message === 'InvalidStateError',
  );
});

test("ARLight turns the room's estimate into the reference space and lights the engine with it", async () => {
  const probe = { probeSpace: { name: 'probe' } },
    // The probe is turned 90 degrees about +y, so its +x is the reference space's -z.
    turned = pose(0, 0, 0, [0, Math.SQRT1_2, 0, Math.SQRT1_2]);
  turned.transform.matrix.set([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
  const xr = host({ enabledFeatures: ['light-estimation'], requestLightProbe: async () => probe }),
    lighting = {
      direction: new Float32Array([3, 5, 4, 3]),
      radiance: new Float32Array([1, 1, 1, 0.15]),
      ambient: new Float32Array([1, 1, 1]),
    },
    light = await ARLight.create(xr, { lighting }),
    sh = new Float32Array(27);
  sh.set([0.8, 0.4, 0.2], 0);
  // Red light from the probe's +x: band 1, coefficient C11 (index 3).
  sh[9] = 0.5;
  let estimate = {
    sphericalHarmonicsCoefficients: sh,
    primaryLightDirection: { x: 1, y: 0, z: 0, w: 0 },
    primaryLightIntensity: { x: 4, y: 2, z: 1, w: 1 },
  };
  const frame = {
    getLightEstimate: (p) => (p === probe ? estimate : null),
    getPose: (space) => (space === probe.probeSpace ? turned : null),
  };
  xr.step(frame);
  const got = light.estimate;
  assert.ok(
    Math.abs(got.sh[2 * 3] + 0.5) < 1e-6 && Math.abs(got.sh[3 * 3]) < 1e-6,
    'light from probe +x comes from -z',
  );
  assert.ok(Math.abs(got.sh[0] - 0.8) < 1e-6, 'band 0 does not turn');
  assert.deepEqual(
    got.direction.map((v) => +v.toFixed(6) + 0),
    [0, 0, -1],
  );
  assert.deepEqual(
    Array.from(lighting.direction).map((v) => +v.toFixed(6) + 0),
    [0, 0, -1, 4],
  );
  assert.deepEqual(Array.from(lighting.radiance), [1, 0.5, 0.25, 1]);
  const Y00 = 0.28209479177387814;
  assert.deepEqual(
    Array.from(lighting.ambient).map((v) => +v.toFixed(5)),
    [0.8, 0.4, 0.2].map((c) => +(c * Y00).toFixed(5)),
  );
  estimate = null;
  xr.step(frame);
  assert.equal(light.estimate, null);
  light.dispose();
  assert.equal(xr.listening, 0);
  await assert.rejects(ARLight.create(host({ enabledFeatures: [] })), /ask for it when starting the session/);
  await assert.rejects(ARLight.create(host(null)), /await xr.requestSession first/);
});
