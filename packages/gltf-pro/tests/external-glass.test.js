// KB2281: native glass drawn by createRenderer into a caller-owned, already-open pass on a display-encoded target.
// The package cannot end the caller's pass to snapshot the light behind a surface, so it used the native tint/add
// blend there (encoded values multiply and add: bright glass over a bright background came out too bright). A
// caller-supplied snapshot hook (PBRDeviceRenderer.draw options.snapshot) now ends and reopens the pass, and the
// glass composites in linear light from the snapshot, as graph-managed Engine scenes do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../dist/index.js';
import { extendedMaterials } from '../dist/extended.js';
import { instancedGLTF } from '../../../tests/support/instanced-gltf.js';

async function glassEye(format, layers = 1) {
  const gpu = mockGPU(),
    store = await TransformStore.create(16);
  const engine = new Engine(
    { width: 64, height: 48, clientWidth: 64, clientHeight: 48 },
    store,
    { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  const input = instancedGLTF(
    Array.from({ length: layers }, (_, i) => ({ t: [0, 0, -i * 0.1] })),
    {
      instanced: false,
      material: { extensions: { KHR_materials_transmission: { transmissionFactor: 1 }, KHR_materials_ior: { ior: 1 } } },
    },
  );
  const model = parseGLTF(engine, input.doc, input.buffers, [], { materials: extendedMaterials });
  engine.camera.update(4 / 3, true);
  store.tick(false);
  const view = context(gpu, { width: 64, height: 48, samples: 1, format, depthFormat: 'depth32float' });
  const renderer = model.createRenderer(gpu.device);
  const passes = [];
  const pass = () => {
    const record = { ended: false, draws: [], pipelines: [] };
    passes.push(record);
    return {
      record,
      setPipeline: (p) => record.pipelines.push(p),
      setBindGroup() {},
      setVertexBuffer() {},
      setIndexBuffer() {},
      setStencilReference() {},
      setViewport() {},
      setScissorRect() {},
      drawIndexed: (count) => record.draws.push(count),
      end() {
        assert.equal(record.ended, false, 'a pass ends once');
        record.ended = true;
      },
    };
  };
  return { gpu, engine, model, view, renderer, passes, pass };
}

test('without a snapshot hook the caller-owned pass is never ended and glass keeps the native blend', async () => {
  const eye = await glassEye('rgba8unorm');
  try {
    const open = eye.pass();
    let returned;
    eye.gpu.record(() => {
      eye.view.begin(0);
      eye.renderer.prepare(eye.view.c);
      returned = eye.renderer.draw(eye.view.c, open, eye.view.camera.matrix);
    });
    assert.equal(returned, open, 'draw returns the caller pass');
    assert.equal(eye.passes.length, 1);
    assert.equal(open.record.ended, false);
    assert.equal(open.record.draws.length, 2, 'the tint draw and the lit draw');
  } finally {
    eye.renderer.dispose();
    eye.engine.dispose();
  }
});

test('a snapshot hook ends and reopens the pass before each glass surface, which then draws once', async () => {
  for (const layers of [1, 2]) {
    const eye = await glassEye('rgba8unorm', layers);
    try {
      const calls = [];
      const snapshot = (current, target) => {
        calls.push({ current, target });
        current.end();
        return eye.pass();
      };
      const first = eye.pass();
      let returned;
      eye.gpu.record(() => {
        eye.view.begin(0);
        eye.renderer.prepare(eye.view.c);
        returned = eye.renderer.draw(eye.view.c, first, eye.view.camera.matrix, { snapshot });
      });
      assert.equal(calls.length, layers, 'one snapshot per glass surface');
      assert.equal(calls[0].current, first, 'the first snapshot receives the caller pass');
      const { target } = calls[0];
      assert.deepEqual(
        [target.width, target.height, target.format, target.sampleCount],
        [64, 48, 'rgba8unorm', 1],
        'the snapshot texture matches the context',
      );
      assert.ok(target.usage & GPUTextureUsage.COPY_DST && target.usage & GPUTextureUsage.RENDER_ATTACHMENT);
      assert.equal(eye.passes.length, layers + 1);
      assert.equal(returned.record, eye.passes.at(-1), 'draw returns the reopened pass');
      assert.equal(returned.record.ended, false, 'the reopened pass stays open for the caller');
      // Each glass surface is one linear-light draw (no tint multiply) on the pass its snapshot reopened.
      for (let i = 1; i <= layers; i++) assert.equal(eye.passes[i].draws.length, 1);
      assert.equal(eye.passes[0].draws.length, 0);
      for (const call of calls) assert.equal(call.target, target, 'the snapshot texture is reused');
    } finally {
      eye.renderer.dispose();
      eye.engine.dispose();
    }
  }
});

test('a linear rgba16float target keeps the exact native blend and never calls the hook', async () => {
  const eye = await glassEye('rgba16float');
  try {
    let calls = 0;
    const open = eye.pass();
    eye.gpu.record(() => {
      eye.view.begin(0);
      eye.renderer.prepare(eye.view.c);
      eye.renderer.draw(eye.view.c, open, eye.view.camera.matrix, {
        snapshot: () => {
          calls++;
          return eye.pass();
        },
      });
    });
    assert.equal(calls, 0);
    assert.equal(open.record.draws.length, 2);
  } finally {
    eye.renderer.dispose();
    eye.engine.dispose();
  }
});

test('a snapshot hook that returns no pass is refused with the fix', async () => {
  const eye = await glassEye('bgra8unorm');
  try {
    assert.throws(
      () =>
        eye.gpu.record(() => {
          eye.view.begin(0);
          eye.renderer.prepare(eye.view.c);
          eye.renderer.draw(eye.view.c, eye.pass(), eye.view.camera.matrix, { snapshot: () => undefined });
        }),
      /returned no render pass; end the pass, write the colour into target, then return the reopened pass/,
    );
  } finally {
    eye.renderer.dispose();
    eye.engine.dispose();
  }
});
