import test from 'node:test';
import assert from 'node:assert/strict';
import { Splats } from '../dist/index.js';
import { Camera } from '../../core/dist/index.js';
import { CameraProjection } from '../../cameras/dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const data = {
  positions: new Float32Array([0, 0, 0, 1, 0.5, -1]),
  covariances: new Float32Array([0.1, 0, 0, 0.2, 0, 0.05, 0.3, 0.01, 0, 0.1, 0, 0.1]),
  colors: new Float32Array([1, 0, 0, 1, 0, 1, 0, 0.5]),
};
function harness() {
  const h = optionalGPU();
  h.context.width = 640;
  h.context.height = 360;
  h.engine.stats = { drawCalls: 0 };
  h.engine.gpu.limits = {
    ...h.engine.gpu.limits,
    maxComputeInvocationsPerWorkgroup: 256,
    maxComputeWorkgroupSizeX: 256,
    maxStorageBuffersPerShaderStage: 8,
  };
  const splats = new Splats(data);
  h.engine.use(splats);
  const uniform = h.resources.find((resource) => resource.size === 192);
  const frame = (camera) => {
    camera.update(h.context.width / h.context.height, true);
    Object.assign(h.context.camera, {
      matrix: camera.matrix,
      position: camera.position,
      target: camera.target,
      fov: camera.fov,
      near: camera.near,
      far: camera.far,
    });
    h.engine.frameGraph.execute(h.context);
    return new Float32Array(uniform.data).slice();
  };
  return { h, splats, frame };
}

test('splats: orthographic cameras use the affine Jacobian (pixels per world unit) and their signed depth range', () => {
  const { splats, frame } = harness();
  try {
    const camera = new Camera({ position: [2, 3, 9], target: [0, 0, 0], fov: 50 }),
      projection = new CameraProjection({ height: 4, zoom: 2, near: -3, far: 30 });
    projection.attach(camera);
    const v = frame(camera);
    // Height 4 at zoom 2 shows 2 world units over 360 px: 180 px per unit vertically, the same horizontally (square pixels).
    assert.ok(Math.abs(v[39] - 180) < 1e-3 && Math.abs(v[38] - 180) < 1e-3, `scale ${v[38]}, ${v[39]}`);
    assert.ok(Math.abs(v[40] + 3) < 1e-4 && Math.abs(v[41] - 30) < 1e-4 && v[43] === 1);
    // Dolly does not change an orthographic image, so the Jacobian stays the same.
    camera.position = [4, 6, 18];
    const moved = frame(camera);
    assert.ok(Math.abs(moved[38] - v[38]) < 1e-3 && Math.abs(moved[39] - v[39]) < 1e-3);
    // Back to perspective: identical to a camera that never had the projection.
    projection.dispose();
    const perspective = frame(camera);
    const fresh = harness(),
      plain = new Camera({ position: [4, 6, 18], target: [0, 0, 0], fov: 50 });
    assert.deepEqual(perspective, fresh.frame(plain));
    assert.equal(perspective[43], 0);
    fresh.splats.dispose();
  } finally {
    splats.dispose();
  }
});

// KB-COMPAT-READY1: on the WebGL2 layer the sort route loads by import(); until then the radix sort runs on the layer's
// CPU tier, so a caller that needs exact frames waits for ready, which settles with the route.
test('Splats.ready waits for the WebGL2 sort route and is settled at once on WebGPU', async () => {
  const pending = Symbol('pending'),
    sorts = (h) => h.pipelines.filter((p) => p.compute).length;
  for (const vendor of ['margo-webgl2', 'nvidia']) {
    const h = optionalGPU();
    h.engine.stats = { drawCalls: 0 };
    h.engine.gpu.adapterInfo = { vendor };
    h.engine.gpu.limits = {
      ...h.engine.gpu.limits,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupSizeX: 256,
      maxStorageBuffersPerShaderStage: 8,
    };
    const splats = new Splats(data);
    h.engine.use(splats);
    const before = sorts(h),
      state = await Promise.race([splats.ready, Promise.resolve(pending)]);
    if (vendor === 'nvidia') assert.notEqual(state, pending, 'settled at once on WebGPU');
    else {
      assert.equal(state, pending, 'ready waits for the route');
      await splats.ready;
      assert.ok(sorts(h) > before, 'the route built its sort pipeline by the time ready settles');
    }
    splats.dispose();
  }
});
