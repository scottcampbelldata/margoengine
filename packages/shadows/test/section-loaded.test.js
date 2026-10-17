import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { wgsl } from '../../core/src/shaders.ts';
import { parseGLTF } from '../../gltf-pro/dist/index.js';
import { SectionPlanes } from '../../machinery/dist/section.js';
import { Shadows } from '../dist/index.js';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

// The GPU boundary is mocked; the asset parser, native caster records and both
// optional plugins are real. Pixel coverage is checked by the browser regression.
async function fixture(t, { node = false, section = true } = {}) {
  const gpu = mockGPU(),
    modules = new WeakMap(),
    pipelines = new WeakMap(),
    groups = new WeakMap(),
    draws = [];
  for (const [name, target, snapshot] of [
    ['createShaderModule', modules, (descriptor) => descriptor.code],
    ['createRenderPipeline', pipelines, (descriptor) => descriptor],
    [
      'createBindGroup',
      groups,
      (descriptor) => ({
        ...descriptor,
        entries: descriptor.entries.map((entry) => ({ ...entry })),
      }),
    ],
  ]) {
    const create = gpu.device[name];
    gpu.device[name] = (descriptor) => {
      const value = create(descriptor);
      target.set(value, snapshot(descriptor));
      return value;
    };
  }
  const begin = gpu.encoder.beginRenderPass;
  gpu.encoder.beginRenderPass = (descriptor) => {
    const pass = begin(descriptor);
    let pipeline, group, vertex, index;
    return {
      ...pass,
      setPipeline(value) {
        pipeline = value;
        pass.setPipeline(value);
      },
      setBindGroup(slot, value) {
        if (slot === 0) group = value;
        pass.setBindGroup(slot, value);
      },
      setVertexBuffer(slot, value) {
        if (slot === 0) vertex = value;
        pass.setVertexBuffer(slot, value);
      },
      setIndexBuffer(value, format) {
        index = value;
        pass.setIndexBuffer(value, format);
      },
      drawIndexed(count, instances) {
        if (descriptor.colorAttachments.length === 0)
          draws.push({
            pipeline: pipelines.get(pipeline),
            code: modules.get(pipelines.get(pipeline).vertex.module),
            group: groups.get(group),
            vertex,
            index,
            count,
            instances,
          });
        pass.drawIndexed(count, instances);
      },
    };
  };
  const store = await TransformStore.create(32),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 2, 4], target: [0, 0, 0] },
      null,
    ),
    model = parseGLTF(engine, await readFile(new URL('../../exporters/tests/fixtures/Box.glb', import.meta.url))),
    planes = [[1, 0, 0, 0]],
    sections = new SectionPlanes({ planes, cap: false }),
    shadows = new Shadows({ resolution: 64, bounds: { min: [-2, -2, -2], max: [2, 2, 2] } }),
    view = context(gpu, { samples: 1, shader: wgsl });
  t.after(() => engine.dispose());
  if (section) engine.use(sections);
  engine.use(shadows);
  shadows.add(node ? model.primitives[0].node : model, { static: true });
  store.tick(false);
  engine.camera.update(128 / 96, true);
  return {
    engine,
    model,
    planes,
    sections,
    shadows,
    view,
    frame() {
      draws.length = 0;
      const log = gpu.record(() => {
        view.begin(0);
        view.c.camera = engine.camera;
        store.tick(false);
        engine.frameGraph.execute(view.c);
      });
      return { draws: [...draws], log, shader: view.c.shader, bindings: [...view.c.bindings] };
    },
  };
}

function sectionBuffer(frame) {
  const match = /@group\(0\) @binding\((\d+)\) var<uniform> section:Section;/.exec(frame.shader);
  assert.ok(match, 'the actual SectionPlanes pass declares its uniform');
  return frame.bindings.find((entry) => entry.binding === Number(match[1])).resource.buffer;
}

for (const node of [false, true]) {
  test(`loaded Box ${node ? 'node' : 'model'} shadow records bind and clip the section in world space`, async (t) => {
    const f = await fixture(t, { node }),
      frame = f.frame(),
      draw = frame.draws[0],
      primitive = f.model.shadowPrimitives[0];
    assert.equal(frame.draws.length, 1, 'one native Box primitive reaches the fixed shadow map');
    assert.equal(draw.vertex, primitive.vertex);
    assert.equal(draw.index, primitive.index);
    assert.equal(draw.count, primitive.count);
    assert.match(draw.code, /@group\(0\) @binding\(3\) var<uniform> section:Section;/);
    assert.match(draw.code, /@location\(\d+\) position:vec3f/);
    assert.match(draw.code, /o\.position\s*=/, 'the depth vertex exposes world-space position');
    assert.match(draw.code, /dot\(section\.planes\[p\]\.xyz,i\.position\)/);
    assert.match(draw.code, /section\.settings\.x/);
    assert.equal(draw.group.entries.find((entry) => entry.binding === 3)?.resource.buffer, sectionBuffer(frame));
  });
}

test('loaded Box cached shadows invalidate for plane edits, enable changes, removal and replacement buffers', async (t) => {
  const f = await fixture(t);
  assert.equal(f.frame().draws.length, 1);
  f.frame();
  f.planes[0][3] = 0.25;
  assert.equal(f.frame().draws.length, 1, 'a plane edit changes the cached caster coverage');
  f.sections.enabled = false;
  const off = f.frame();
  assert.equal(off.draws.length, 1, 'turning sections off restores the complete cached shadow');
  assert.equal(off.draws[0].group.entries.find((entry) => entry.binding === 3)?.resource.buffer, sectionBuffer(off));
  f.sections.enabled = true;
  assert.equal(f.frame().draws.length, 1, 'turning sections on redraws the cut shadow');
  const previous = sectionBuffer(f.frame());
  f.engine.removePlugin('section-planes');
  const removed = f.frame();
  assert.equal(removed.draws.length, 1, 'removal restores the complete cached shadow');
  assert.doesNotMatch(removed.draws[0].code, /var<uniform> section:/);
  assert.equal(removed.draws[0].group.entries.length, 3);
  assert.equal(f.frame().draws.length, 0, 'the absent-section path still caches unchanged casters');
  const replacement = new SectionPlanes({ planes: f.planes, cap: false });
  f.engine.use(replacement);
  const replaced = f.frame(),
    buffer = sectionBuffer(replaced);
  assert.equal(replaced.draws.length, 1, 'reattachment invalidates the cached map');
  assert.notEqual(buffer, previous);
  assert.equal(replaced.draws[0].group.entries.find((entry) => entry.binding === 3)?.resource.buffer, buffer);
});

test('sections and directional shadow sampling use distinct core binding declarations and resources', async (t) => {
  const f = await fixture(t),
    frame = f.frame(),
    declarations = [...frame.shader.matchAll(/@group\(0\) @binding\((\d+)\) var(?:<uniform>)?\s+(\w+):/g)],
    seen = new Map();
  for (const [, binding, name] of declarations) {
    assert.equal(seen.has(binding), false, `core binding ${binding} collides between ${seen.get(binding)} and ${name}`);
    seen.set(binding, name);
    if (name !== 'frame')
      assert.equal(frame.bindings.filter((entry) => entry.binding === Number(binding)).length, 1, name);
  }
  assert.ok([...seen.values()].includes('section'));
  assert.ok([...seen.values()].includes('shadowFrame'));
});
