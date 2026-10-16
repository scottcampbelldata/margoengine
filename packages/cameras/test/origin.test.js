import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineKernel, PbrMaterial, box, CADCameraControls } from '../../core/dist/index.js';
import { OrbitControls } from '../../controls/dist/index.js';
import { Raycaster } from '../../bvh/dist/index.js';
import { FloatingOrigin } from '../dist/origin.js';

// Core engine on a fake WebGPU device (as tests/core-material-setters.test.js): onPreUpdate, kernel and camera are real.
async function engine(t, capacity = 16) {
  const saved = Object.fromEntries(
    ['navigator', 'GPUBufferUsage', 'GPUTextureUsage'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const context = { configure() {}, unconfigure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) },
    canvas = { width: 400, height: 200, clientWidth: 400, clientHeight: 200, getContext: () => context };
  const resource = (d) => Object.assign({ destroy() {} }, d);
  const device = {
    features: new Set(),
    limits: { maxBufferSize: 2 ** 30 },
    lost: new Promise(() => {}),
    addEventListener() {},
    destroy() {},
    queue: { writeBuffer() {}, submit() {} },
    createShaderModule: (d) => d,
    createBindGroup: () => ({}),
    createBuffer: resource,
    createTexture: (d) => Object.assign(resource(d), { createView: () => ({}) }),
    async createRenderPipelineAsync() {
      return { getBindGroupLayout: () => ({}) };
    },
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({
        setPipeline() {},
        setBindGroup() {},
        setVertexBuffer() {},
        setIndexBuffer() {},
        drawIndexed() {},
        end() {},
      }),
      finish: () => ({}),
    }),
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: '',
      gpu: {
        requestAdapter: async () => ({ features: new Set(), requestDevice: async () => device }),
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    },
  });
  globalThis.GPUBufferUsage = {
    UNIFORM: 1,
    COPY_DST: 2,
    VERTEX: 4,
    STORAGE: 8,
    INDEX: 16,
    INDIRECT: 32,
    COPY_SRC: 64,
    MAP_READ: 128,
  };
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 1, COPY_SRC: 2 };
  const e = await EngineKernel.create(canvas, { capacity, backend: 'webgpu', camera: { near: 0.001, far: 1000 } });
  t.after(() => {
    e.dispose();
    for (const [key, d] of Object.entries(saved))
      if (d) Object.defineProperty(globalThis, key, d);
      else delete globalThis[key];
  });
  return e;
}
const FAR = [2_880_000.123456, 3_600_000.654321, 3_840_000.314159]; // 6,000 km from the origin
const add = (a, b) => a.map((v, i) => v + b[i]),
  close = (a, b, eps) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
const ndc = (m, p) => {
  const c = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
  return [c[0] / c[3], c[1] / c[3]];
};

test('placed roots keep float64 world positions; a rebase moves origin, camera and roots together so nothing moves on screen', async (t) => {
  const e = await engine(t),
    o = FloatingOrigin.attach(e),
    part = e
      .createMesh()
      .setGeometry(box(0.01, 0.01, 0.01))
      .setMaterial(new PbrMaterial());
  const child = e
    .createMesh(part)
    .setGeometry(box(0.001, 0.001, 0.001))
    .setPosition([0.004, 0, 0]);
  o.place(part, FAR);
  o.lookAt(add(FAR, [0, 0.03, 0.04]), FAR);
  assert.equal(o.rebases, 1, 'lookAt 6,000 km out rebases at once');
  assert.deepEqual(o.worldPosition(part), FAR);
  assert.ok(close(o.cameraPosition, add(FAR, [0, 0.03, 0.04]), 1e-9) && close(o.cameraTarget, FAR, 1e-9));
  e.render();
  const before = ndc(e.camera.matrix, child.matrix.slice(12, 15));
  assert.ok(Math.hypot(...e.camera.position) < 1e-6, 'origin at the camera');
  assert.throws(() => o.place(child, FAR), /root meshes/);
  const shifts = [];
  o.onRebase((shift, origin) => shifts.push([shift, origin]));
  o.rebase(add(FAR, [-30, 5, 12]));
  e.render();
  assert.deepEqual(shifts[0][1], add(FAR, [-30, 5, 12]));
  assert.ok(close(shifts[0][0], [-30, 5 - 0.03, 12 - 0.04], 1e-6));
  assert.deepEqual(o.worldPosition(part), FAR, 'world position exact after rebase');
  assert.deepEqual([part.position.x, part.position.y, part.position.z], [30, -5, -12].map(Math.fround));
  assert.ok(
    close(ndc(e.camera.matrix, child.matrix.slice(12, 15)), before, 2e-4),
    'child projects to the same place (float32 at 32 m: ~0.01 px)',
  );
  assert.ok(close(o.toWorld(o.toLocal(FAR)), FAR, 1e-9));
});

test('rebases only when the camera is farther from the origin than ratio x view distance', async (t) => {
  const e = await engine(t),
    o = FloatingOrigin.attach(e, { ratio: 100 });
  o.lookAt([10, 0, 0.5], [10, 0, 0]);
  e.render();
  assert.equal(o.rebases, 0, '10 m out, 0.5 m away: under 50 m');
  e.camera.position = [60, 0, 0.5];
  e.camera.target = [60, 0, 0];
  e.render();
  assert.equal(o.rebases, 1);
  assert.ok(close(o.cameraPosition, [60, 0, 0.5], 1e-12) && close(e.camera.position, [0, 0, 0], 1e-12));
  assert.throws(() => new FloatingOrigin({ ratio: 0 }), /ratio/);
});

test('a placed root moved through mesh.position (drag, gizmo, physics) is re-read, not snapped back', async (t) => {
  const e = await engine(t),
    o = FloatingOrigin.attach(e),
    part = e.createMesh().setGeometry(box());
  o.place(part, [1000, 0, 0]);
  part.position.x += 2;
  assert.deepEqual(o.worldPosition(part), [1002, 0, 0]);
  o.rebase([500, 0, 0]);
  assert.equal(part.position.x, 502);
  assert.deepEqual(o.worldPosition(part), [1002, 0, 0]);
  part.dispose();
  o.rebase([0, 0, 0]);
  assert.equal(o.worldPosition(part), undefined, 'disposed meshes are dropped');
});

test('controls, a running fit animation and bvh picks work across rebases; picks convert to float64 world', async (t) => {
  const e = await engine(t),
    o = FloatingOrigin.attach(e),
    part = e
      .createMesh()
      .setGeometry(box(0.01, 0.01, 0.01))
      .setMaterial(new PbrMaterial());
  o.place(part, FAR);
  o.lookAt(add(FAR, [0, 0, 0.05]), FAR);
  e.render();
  // bvh ray through the canvas centre hits the 10 mm box's front face at z + 5 mm.
  const hit = new Raycaster().setFromEngine(e, 200, 100).intersectEngine(e)[0];
  assert.equal(hit.mesh, part);
  assert.ok(close(o.toWorld(hit.point), add(FAR, [0, 0, 0.005]), 1e-6), `hit ${o.toWorld(hit.point)}`);
  // CAD orbit and Orbit dolly read the (rebased) camera each call.
  const cad = new CADCameraControls(e.camera, { style: {}, addEventListener() {}, removeEventListener() {} });
  cad.orbit(Math.PI / 2, 0);
  o.rebase(add(FAR, [1, 2, 3]));
  cad.orbit(-Math.PI / 2, 0);
  assert.ok(close(o.cameraPosition, add(FAR, [0, 0, 0.05]), 1e-9), 'orbit there and back across a rebase');
  cad.dispose();
  const orbit = new OrbitControls(e.camera);
  orbit.dollyIn(2);
  orbit.update(0);
  assert.ok(
    close(o.cameraPosition, add(FAR, [0, 0, 0.1]), 1e-9) && close(o.cameraTarget, FAR, 1e-9),
    'orbit dolly keeps the world target',
  );
  orbit.dispose();
  // A fitToBoundingBox animation in flight finishes at the same world position after a rebase mid-way.
  e.camera.fitToBoundingBox(o.toLocal(add(FAR, [-0.01, -0.01, -0.01])), o.toLocal(add(FAR, [0.01, 0.01, 0.01])), {
    duration: 1,
  });
  e.camera.advance(0.5);
  o.rebase(add(FAR, [7, 7, 7]));
  e.camera.advance(1);
  assert.ok(close(o.cameraTarget, FAR, 1e-9), 'fit target is the box centre in world space');
});

test('machinery measurement between two 1 mm bolts 7 mm apart, 6,000 km out: float32 world positions snap, measureDistance is exact with or without the origin', async (t) => {
  const { vertexAnchor, measureDistance, worldAnchor } = await import('../../machinery/dist/index.js');
  const measure = async (useOrigin) => {
    const e = await engine(t),
      root = e.createMesh(),
      bolts = [
        [0.0035, 0, 0],
        [-0.0035, 0, 0],
      ].map((p) =>
        e
          .createMesh(root)
          .setGeometry(box(0.001, 0.001, 0.001))
          .setPosition(p),
      );
    if (useOrigin) {
      const o = FloatingOrigin.attach(e);
      o.place(root, FAR);
      o.lookAt(add(FAR, [0, 0, 0.05]), FAR);
    } else {
      root.setPosition(FAR);
      e.camera.position = add(FAR, [0, 0, 0.05]);
      e.camera.target = FAR;
    }
    e.render();
    const [a, b] = bolts.map((n) => vertexAnchor(n, 0)),
      p = worldAnchor(a),
      q = worldAnchor(b);
    return { measured: measureDistance(a, b, 'mm'), world: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) * 1000 };
  };
  const origin = await measure(true),
    core = await measure(false);
  assert.ok(Math.abs(origin.measured - 7) < 1e-4 && Math.abs(origin.world - 7) < 1e-4);
  assert.ok(Math.abs(core.world - 7) > 0.1, 'core alone: world bolt positions snap to the 0.25 m float32 grid');
  // measureDistance composes the hierarchy in float64 below the common ancestor (HANDOFF 5l.d), so the far root cancels.
  assert.ok(Math.abs(core.measured - 7) < 1e-6, 'measureDistance stays exact without the origin');
});

test('section planes: world planes convert to local planes that still pass through the part', async (t) => {
  const e = await engine(t),
    o = FloatingOrigin.attach(e);
  o.lookAt(add(FAR, [0, 0, 1]), FAR);
  const plane = [0, 0, 1, -FAR[2]],
    local = o.toLocalPlane(plane),
    p = o.toLocal(FAR);
  assert.ok(Math.abs(local[0] * p[0] + local[1] * p[1] + local[2] * p[2] + local[3]) < 1e-9 && Math.abs(local[3]) < 2);
});

test('dispose detaches; [Symbol.dispose] calls dispose', async (t) => {
  const e = await engine(t),
    o = FloatingOrigin.attach(e);
  e.removePlugin(o.name);
  assert.equal(e.hasPlugin('floating-origin'), false);
  assert.throws(() => o.lookAt([0, 0, 1], [0, 0, 0]), /not attached/);
  if (Symbol.dispose) {
    const p = new FloatingOrigin();
    let called = false;
    p.dispose = () => {
      called = true;
    };
    p[Symbol.dispose]();
    assert.ok(called);
  }
});
