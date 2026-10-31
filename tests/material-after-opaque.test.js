// MaterialExtension.afterOpaque: the primitive's beauty draw moves after the opaque capture (transmission reads it)
// while its authored alpha mode, blending and depth writes stay as they are. CPU recording only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { parseGLTF, PBRModel } from '../packages/gltf-pro/dist/index.js';
import { install, installNodeMaterial, nodeMaterial } from '../packages/materials/dist/index.js';
import { transmission } from '../packages/materials/dist/transmission.js';
import { optionalGPU, uniformBytes } from './support/optional-gpu.js';
import { materialQuad } from './support/materials-fixture.js';

const scalar = (value) => ({ type: 'scalar', value });
const graph = (factor = 0.75) => ({
  nodes: [
    {
      type: 'emit',
      color: { type: 'color', value: [0.125, 0.25, 0.5, 0.5] },
      transmission: { type: 'transmission', factor: scalar(factor), ior: scalar(1.5) },
    },
  ],
});

async function scene(modes = ['OPAQUE'], sharedMaterial = false) {
  const harness = optionalGPU(),
    store = await TransformStore.create(32),
    device = harness.engine.gpu;
  device.limits.maxTextureDimension2D = 8192;
  device.limits.maxUniformBufferBindingSize = 65536;
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  const fixture = materialQuad(),
    primitive = fixture.doc.meshes[0].primitives[0];
  fixture.doc.materials = modes.map((alphaMode) => ({
    ...fixture.doc.materials[0],
    alphaMode,
    alphaCutoff: 0.5,
    pbrMetallicRoughness: {
      ...fixture.doc.materials[0].pbrMetallicRoughness,
      baseColorFactor: [0.08, 0.08, 0.08, 0.25],
    },
  }));
  fixture.doc.meshes = modes.map((_, material) => ({
    primitives: [{ ...primitive, material: sharedMaterial ? 0 : material }],
  }));
  fixture.doc.nodes = modes.map((_, mesh) => ({ mesh, translation: [0, 0, mesh] }));
  const model = parseGLTF(engine, fixture.doc, fixture.buffers);
  engine.camera.update(128 / 96, true);
  store.tick(false);
  const draws = [];
  let passes = 0;
  const context = {
    ...harness.context,
    camera: engine.camera,
    encoder: {
      beginRenderPass() {
        passes++;
        let pipeline;
        const groups = new Map();
        return {
          setPipeline(value) {
            pipeline = value;
            groups.clear();
          },
          setBindGroup(index, value) {
            groups.set(index, value);
          },
          setVertexBuffer() {},
          setIndexBuffer() {},
          drawIndexed(count) {
            // The uniforms reach the GPU when draw() returns (before the frame is submitted), so the frame bytes are
            // read when a test asks for them.
            const binding = groups.get(0).entries[0].resource;
            const frame = () => uniformBytes(binding).slice();
            draws.push({
              count,
              pipeline,
              get frame() {
                return frame();
              },
              get settings() {
                return new Float32Array(frame().buffer)[88];
              },
              get z() {
                return new Float32Array(frame().buffer)[30];
              },
              groups: [...groups.keys()],
            });
          },
          end() {},
        };
      },
    },
  };
  return {
    ...harness,
    engine,
    model,
    context,
    draws,
    get passes() {
      return passes;
    },
    draw(phase = 'all', mode = 'beauty') {
      model.draw(context, mode, context.color, context.depth, phase);
    },
    destroy() {
      PBRModel.cancelOpaquePass(context);
      engine.dispose();
    },
  };
}

for (const [mode, setting] of [
  ['OPAQUE', 0],
  ['MASK', 1],
]) {
  test('afterOpaque true defers ' + mode + ' without changing authored pipeline state', async () => {
    const s = await scene([mode]);
    try {
      const p = s.model.primitives[0];
      p.extension = { afterOpaque: true };
      PBRModel.beginOpaquePass(s.context);
      s.draw();
      assert.equal(s.draws.length, 0, mode + ' must not enter the opaque snapshot');
      PBRModel.endOpaquePass(s.context);
      assert.equal(s.draws.length, 1);
      assert.equal(p.material.settings[0], setting);
      assert.equal(s.draws[0].settings, setting);
      assert.equal(s.draws[0].pipeline.depthStencil.depthWriteEnabled, true);
      assert.equal(s.draws[0].pipeline.fragment.targets[0].blend, undefined);
      assert.equal(s.draws[0].pipeline.fragment.constants.margoAlphaTest, setting);
    } finally {
      s.destroy();
    }
  });
}

test('afterOpaque true defers BLEND once and preserves authored blending and depth', async () => {
  const s = await scene(['BLEND']);
  try {
    s.model.primitives[0].extension = { afterOpaque: true };
    PBRModel.beginOpaquePass(s.context);
    s.draw();
    assert.equal(s.draws.length, 0);
    PBRModel.endOpaquePass(s.context);
    assert.equal(s.draws.length, 1);
    assert.equal(s.draws[0].settings, 2);
    assert.ok(s.draws[0].pipeline.fragment.targets[0].blend);
    assert.equal(s.draws[0].pipeline.depthStencil.depthWriteEnabled, false);
  } finally {
    s.destroy();
  }
});

test('primitive false overrides material true and malformed inactive metadata', async () => {
  for (const materialValue of [true, 'invalid']) {
    const s = await scene();
    try {
      const p = s.model.primitives[0];
      p.material.extension = { afterOpaque: materialValue };
      p.extension = { afterOpaque: false };
      PBRModel.beginOpaquePass(s.context);
      s.draw();
      assert.equal(s.draws.length, 1);
      PBRModel.endOpaquePass(s.context);
      assert.equal(s.draws.length, 1);
    } finally {
      s.destroy();
    }
  }
});

test('explicit deferred replacement is excluded from ordinary opaque shadow records', async () => {
  const s = await scene();
  try {
    const p = s.model.primitives[0];
    assert.equal(s.model.shadowPrimitives.length, 1);
    p.material.extension = { afterOpaque: true };
    assert.equal(s.model.shadowPrimitives.length, 0);
    p.extension = { afterOpaque: false };
    assert.equal(s.model.shadowPrimitives.length, 1, 'Effective primitive override also controls shadow membership');
  } finally {
    s.destroy();
  }
});

test('an existing static batch falls back to its actual parts when one part becomes deferred', async () => {
  const s = await scene(['OPAQUE', 'OPAQUE'], true);
  try {
    assert.equal(s.model.primitives.length, 2);
    s.draw();
    assert.equal(s.draws.length, 1, 'Precondition: actual public renderer has formed one static batch');
    assert.equal(s.draws[0].count, 12);
    s.draws.length = 0;
    s.model.primitives[0].extension = { afterOpaque: true };
    PBRModel.beginOpaquePass(s.context);
    s.draw();
    assert.deepEqual(
      s.draws.map((d) => [d.z, d.count]),
      [[1, 6]],
    );
    PBRModel.endOpaquePass(s.context);
    assert.deepEqual(
      s.draws.map((d) => [d.z, d.count]),
      [
        [1, 6],
        [0, 6],
      ],
    );
  } finally {
    s.destroy();
  }
});

test('positive caller transmission requests afterOpaque while factor zero keeps its exact empty shape', () => {
  assert.deepEqual(transmission({ factor: 0 }), {});
  assert.equal(transmission({ factor: 0.75, opaqueColor: {} }).afterOpaque, true);
});

test('positive node graph requests afterOpaque while constant zero has no new scheduling field', () => {
  assert.equal(Object.hasOwn(nodeMaterial(graph(0)), 'afterOpaque'), false);
  assert.equal(nodeMaterial(graph(), { opaqueColor: {} }).afterOpaque, true);
});

for (const mode of ['OPAQUE', 'MASK', 'BLEND'])
  for (const route of ['install', 'node']) {
    test(route + ' preserves authored ' + mode + ' settings for its entire installation', async () => {
      const s = await scene([mode]);
      let installation;
      try {
        const p = s.model.primitives[0],
          before = p.material.settings.slice();
        if (route === 'install') {
          p.material.transmission = { factor: 0.75, ior: 1.5 };
          installation = install(s.model);
        } else installation = installNodeMaterial(s.model, graph());
        assert.deepEqual(p.material.settings, before, 'Scheduling must not rewrite authored coverage settings');
        assert.equal((p.extension ?? p.material.extension).afterOpaque, true);
        installation.dispose();
        installation = undefined;
        assert.deepEqual(p.material.settings, before);
      } finally {
        installation?.dispose();
        s.destroy();
      }
    });
  }

test('a non-boolean afterOpaque is refused with the fix', async () => {
  const s = await scene();
  try {
    s.model.primitives[0].extension = { afterOpaque: 'true' };
    assert.throws(() => s.draw(), { name: 'TypeError', message: /afterOpaque must be a boolean/ });
  } finally {
    s.destroy();
  }
});

test('a live afterOpaque edit routes the next frame', async () => {
  const s = await scene();
  try {
    const p = s.model.primitives[0];
    p.extension = { afterOpaque: true };
    PBRModel.beginOpaquePass(s.context);
    s.draw();
    assert.equal(s.draws.length, 0, 'deferred');
    PBRModel.endOpaquePass(s.context);
    assert.equal(s.draws.length, 1);
    p.extension.afterOpaque = false;
    PBRModel.beginOpaquePass(s.context);
    s.draw();
    assert.equal(s.draws.length, 2, 'drawn in the opaque phase again');
    PBRModel.endOpaquePass(s.context);
    assert.equal(s.draws.length, 2);
  } finally {
    s.destroy();
  }
});

test('extension transmission dims diffuse and ambient light only, and adds the light behind', async () => {
  const s = await scene();
  try {
    const opaqueColor = s.engine.gpu.createTexture({ size: [1, 1], format: 'rgba16float' }).createView();
    s.model.primitives[0].extension = transmission({ factor: 0.75, opaqueColor });
    s.draw();
    const code = s.draws[0].pipeline.fragment.module.code;
    assert.match(code, /s\.tr=clamp\(materialFactors\[0\]\.x,0\.0,1\.0\);/, 'the transmitted share is the factor');
    assert.ok(code.includes('s.base.rgb*(1-s.metal)*(1-s.tr)+'), 'ambient diffuse scaled by 1 - tr');
    assert.ok(code.includes('(1-fresnel)*(1-s.metal)*(1-s.tr)*s.base.rgb/'), 'direct diffuse scaled by 1 - tr');
    assert.ok(code.includes('d*g*fresnel/max(4*nl*nv,0.0001)'), 'the specular lobe is untouched');
    assert.ok(code.includes('return color+materialTransmissionFilter(transmitted,materialTransmissionWeight(s,v,n,factor));'));
    assert.ok(!code.includes('mix(color,transmitted'), 'reflections are no longer faded out');
  } finally {
    s.destroy();
  }
});
