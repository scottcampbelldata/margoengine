import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { parseGLTF } from '../packages/gltf-pro/dist/index.js';
import { PBRInstances } from '../packages/gltf-pro/dist/instancing.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';
import { optionalGPU } from './support/optional-gpu.js';

async function scene(count = 1) {
  const h = optionalGPU(),
    device = h.engine.gpu,
    store = await TransformStore.create(16);
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  const fixture = animatedTriangle();
  fixture.doc.nodes = Array.from({ length: count }, () => ({ mesh: 0 }));
  fixture.doc.materials[0].doubleSided = false;
  delete fixture.doc.skins;
  delete fixture.doc.animations;
  const model = parseGLTF(engine, fixture.doc, fixture.buffers);
  engine.camera.update(4 / 3, true);
  store.tick(false);
  const draws = [],
    create = device.createBindGroup;
  // WebGPU consumes descriptors synchronously. Copy entries at that boundary
  // so a reused CPU scratch array cannot rewrite this test's prior GPU groups.
  device.createBindGroup = (descriptor) => {
    const copy = {
      ...descriptor,
      entries: descriptor.entries.map(({ binding, resource }) => ({
        binding,
        resource: 'buffer' in resource ? { ...resource } : resource,
      })),
    };
    return create(copy);
  };
  const createPass = () => {
    let pipeline, lighting, uniform;
    return {
      setPipeline(value) {
        pipeline = value;
      },
      setBindGroup(slot, group) {
        if (slot === 2) lighting = group;
        if (slot === 0) uniform = group.entries.find((entry) => entry.binding === 0).resource.buffer;
      },
      setVertexBuffer() {},
      setIndexBuffer() {},
      drawIndexed() {
        draws.push({ pipeline, lighting, x: new Float32Array(uniform.data)[28] });
      },
      end() {},
    };
  };
  const context = { ...h.context, camera: engine.camera, encoder: { beginRenderPass: createPass } };
  const frame = (mode = 'beauty', target = context) => {
    const start = draws.length;
    model.draw(target, mode, target.color, target.depth);
    return draws.slice(start);
  };
  return { h, engine, device, model, context, draws, frame };
}

test('PBR draw cache follows current target, material, shader and instancing fields, then reuses old variants', async (t) => {
  const f = await scene();
  t.after(() => f.engine.dispose());
  const primitive = f.model.primitives[0],
    material = primitive.material;
  const original = f.frame()[0].pipeline,
    initial = f.h.pipelines.length;
  for (let i = 0; i < 20; i++) assert.equal(f.frame()[0].pipeline, original);
  assert.equal(f.h.pipelines.length, initial);
  f.context.format = 'rgba16float';
  assert.equal(f.frame()[0].pipeline.fragment.targets[0].format, 'rgba16float');
  f.context.descriptor = { multisample: { count: 1 }, depthStencil: { format: 'depth24plus' } };
  const changedTarget = f.frame()[0].pipeline;
  assert.equal(changedTarget.multisample.count, 1);
  assert.equal(changedTarget.depthStencil.format, 'depth24plus');
  f.context.format = 'bgra8unorm';
  f.context.descriptor = { multisample: { count: 4 }, depthStencil: { format: 'depth32float' } };
  assert.equal(f.frame()[0].pipeline, original);
  material.settings[0] = 1;
  const masked = f.frame()[0].pipeline;
  assert.equal(masked.fragment.constants.margoAlphaTest, 1);
  material.settings[0] = 2;
  assert.ok(f.frame()[0].pipeline.fragment.targets[0].blend);
  material.settings[0] = 0;
  assert.equal(f.frame()[0].pipeline, original);
  material.renderState = { depthCompare: 'always', blend: null };
  assert.equal(f.frame()[0].pipeline.depthStencil.depthCompare, 'always');
  material.renderState.depthCompare = 'never';
  assert.equal(f.frame()[0].pipeline.depthStencil.depthCompare, 'never');
  delete material.renderState;
  assert.equal(f.frame()[0].pipeline, original);
  const remove = f.model.addLighting({ shader: (source) => `// dynamic lighting\n${source}`, bindings: () => [] });
  assert.notEqual(f.frame()[0].pipeline, original);
  remove();
  assert.equal(f.frame()[0].pipeline, original);
  const instances = new PBRInstances(1);
  t.after(() => instances.dispose());
  primitive.instances = instances;
  const instanced = f.frame()[0].pipeline;
  assert.equal(instanced.vertex.buffers.length, 2);
  assert.equal(instanced.fragment.constants.margoFaceTest, 0);
  instances.setMatrixAt(0, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const mirrored = f.frame()[0].pipeline;
  assert.equal(mirrored.fragment.constants.margoFaceTest, 1);
  assert.equal(mirrored.primitive.cullMode, 'none');
  primitive.instances = undefined;
  assert.equal(f.frame()[0].pipeline, original);
  for (const [mode, entry] of [
    ['gbuffer', 'gbuffer'],
    ['ambient', 'ambientFragment'],
  ]) {
    const pipeline = f.frame(mode)[0].pipeline;
    assert.equal(pipeline.fragment.entryPoint, entry);
    assert.equal(f.frame(mode)[0].pipeline, pipeline);
    assert.equal(f.frame()[0].pipeline, original);
  }
});

test('alternating main and probe targets reuse warmed pipeline records and bound changing material state', async (t) => {
  const f = await scene();
  t.after(() => f.engine.dispose());
  const main = f.context,
    probe = { ...main, descriptor: { multisample: { count: 1 }, depthStencil: { format: 'depth32float' } } };
  const hdr = { ...probe, format: 'rgba16float' };
  const targets = [main, probe, hdr],
    pipelines = targets.map((target) => f.frame('beauty', target)[0].pipeline);
  assert.deepEqual(
    pipelines.map((value) => value.multisample.count),
    [4, 1, 1],
  );
  assert.deepEqual(
    pipelines.map((value) => value.fragment.targets[0].format),
    ['bgra8unorm', 'bgra8unorm', 'rgba16float'],
  );
  // Pipeline creation alone missed this regression: the old implementation
  // reused GPU pipelines while rebuilding a CPU key and record every switch.
  const records = f.model.resources[0].pipelineHistories.get('beauty'),
    identities = new Set(records);
  assert.equal(identities.size, 3);
  const count = f.h.pipelines.length;
  for (let i = 0; i < 120; i++) {
    const index = i % targets.length;
    assert.equal(f.frame('beauty', targets[index])[0].pipeline, pipelines[index]);
    assert.equal(f.model.resources[0].pipelineHistories.get('beauty'), records);
    assert.deepEqual(new Set(records), identities);
  }
  assert.equal(f.h.pipelines.length, count);
  const material = f.model.primitives[0].material;
  material.renderState = { depthCompare: 'always' };
  for (let i = 0; i < 80; i++) {
    material.renderState.label = i;
    assert.equal(f.frame()[0].pipeline.depthStencil.depthCompare, 'always');
    assert.ok(records.length <= 32, 'Animated states must not retain an unbounded record history');
  }
  delete material.renderState;
  assert.equal(f.frame()[0].pipeline, pipelines[0], 'Eviction must still reuse the original GPU pipeline');
});

test('PBR lighting snapshots each primitive effect set and consumes binding callbacks every draw', async (t) => {
  const f = await scene(2);
  t.after(() => f.engine.dispose());
  const calls = [],
    buffer = f.device.createBuffer({ size: 512, usage: GPUBufferUsage.UNIFORM });
  t.after(() => buffer.destroy());
  const effect = (name, binding) => ({
    shader: (source) => source,
    bindings() {
      calls.push(name);
      return [{ binding, resource: { buffer, offset: 0, size: 16 } }];
    },
  });
  const second = effect('second', 2),
    third = effect('third', 3);
  let changed = false,
    removeSecond;
  f.model.addLighting({
    shader: (source) => source,
    bindings() {
      calls.push('first');
      if (!changed) {
        changed = true;
        removeSecond();
        f.model.addLighting(third);
      }
      return [{ binding: 1, resource: { buffer, offset: 0, size: 16 } }];
    },
  });
  removeSecond = f.model.addLighting(second);
  const rendered = f.frame();
  assert.deepEqual(calls, ['first', 'second', 'first', 'third']);
  assert.deepEqual(
    rendered.map((draw) => draw.lighting.entries.map((entry) => entry.binding)),
    [
      [1, 2],
      [1, 3],
    ],
  );
  const groups = f.h.counts.groups;
  calls.length = 0;
  f.frame();
  assert.deepEqual(calls, ['first', 'third', 'first', 'third']);
  assert.equal(f.h.counts.groups, groups, 'Stable bindings should reuse the last GPU lighting group');
});

test('PBR lighting scratch is isolated when a binding callback reenters the same model draw', async (t) => {
  const f = await scene(2);
  t.after(() => f.engine.dispose());
  const buffer = f.device.createBuffer({ size: 512, usage: GPUBufferUsage.UNIFORM });
  t.after(() => buffer.destroy());
  let nested = false,
    first = true,
    calls = 0;
  f.model.addLighting({
    shader: (source) => source,
    bindings() {
      calls++;
      if (first) {
        first = false;
        nested = true;
        f.frame();
        nested = false;
      }
      return [{ binding: 1, resource: { buffer, offset: nested ? 256 : 0, size: 16 } }];
    },
  });
  f.frame();
  assert.equal(calls, 4, 'Both inner and outer invocations should visit both primitives');
  assert.deepEqual(
    f.draws.map((draw) => draw.lighting.entries[0].resource.offset),
    [256, 256, 0, 0],
  );
  const groups = f.h.counts.groups;
  f.frame();
  assert.equal(calls, 6);
  assert.equal(f.h.counts.groups, groups);
});

test('PBR lighting scratch trims removed effects and changing binding counts without stale entries', async (t) => {
  const f = await scene(2);
  t.after(() => f.engine.dispose());
  const buffer = f.device.createBuffer({ size: 512, usage: GPUBufferUsage.UNIFORM });
  t.after(() => buffer.destroy());
  const entries = [1, 2, 3].map((binding) => ({ binding, resource: { buffer, size: 16 } }));
  let length = 3,
    calls = 0;
  const remove = f.model.addLighting({
    shader: (source) => source,
    bindings() {
      calls++;
      return entries.slice(0, length);
    },
  });
  for (const count of [3, 1, 0, 2, 3]) {
    length = count;
    assert.deepEqual(
      f.frame().map((draw) => draw.lighting.entries.map((entry) => entry.binding)),
      [entries.slice(0, count).map((entry) => entry.binding), entries.slice(0, count).map((entry) => entry.binding)],
    );
  }
  assert.equal(calls, 10, 'Every primitive retains its live bindings callback');
  remove();
  const replacement = f.model.addLighting({ shader: (source) => source, bindings: () => [entries[1]] });
  assert.deepEqual(
    f.frame().map((draw) => draw.lighting.entries.map((entry) => entry.binding)),
    [[2], [2]],
  );
  replacement();
});

test('PBR pooled snapshots preserve opaque order and mutable transparent distance sorting', async (t) => {
  const f = await scene(4);
  t.after(() => f.engine.dispose());
  const x = [-1, 2, 0, 2];
  f.model.primitives.forEach((primitive, i) => {
    primitive.node.setPosition([x[i], 0, 0]);
    primitive.material = { ...primitive.material, settings: [...primitive.material.settings] };
  });
  f.engine.store.tick(false);
  assert.deepEqual(
    f.frame().map((draw) => draw.x),
    x,
  );
  f.model.primitives[0].material.settings[0] = 2;
  f.model.primitives[1].material.settings[0] = 2;
  f.model.primitives[3].material.settings[0] = 2;
  assert.deepEqual(
    f.frame().map((draw) => draw.x),
    [0, 2, 2, -1],
  );
  f.context.camera.position = [-4, 0, 4];
  assert.deepEqual(
    f.frame().map((draw) => draw.x),
    [0, 2, 2, -1],
  );
  f.context.camera.position = [4, 0, 4];
  assert.deepEqual(
    f.frame().map((draw) => draw.x),
    [0, -1, 2, 2],
  );
  for (const primitive of f.model.primitives) primitive.material.settings[0] = 0;
  assert.deepEqual(
    f.frame().map((draw) => draw.x),
    x,
    'Switching back to opaque restores authored order',
  );
});

test('PBR pooled resources and live shader effects remain isolated through nested draws', async (t) => {
  const f = await scene(3);
  t.after(() => f.engine.dispose());
  f.model.primitives.forEach((primitive, i) => {
    primitive.node.setPosition([[-1, 2, 0][i], 0, 0]);
    primitive.material = { ...primitive.material, settings: [...primitive.material.settings] };
  });
  f.engine.store.tick(false);
  let first = true,
    nested = false,
    removeSecond;
  const calls = [],
    third = {
      shader(source) {
        calls.push('third');
        return source;
      },
      bindings: () => [],
    };
  f.model.addLighting({
    shader(source) {
      calls.push(nested ? 'nested' : 'first');
      if (first) {
        first = false;
        removeSecond();
        f.model.addLighting(third);
        f.model.primitives[1].material.settings[0] = 2;
        nested = true;
        f.frame();
        nested = false;
      }
      return source;
    },
    bindings: () => [],
  });
  removeSecond = f.model.addLighting({
    shader(source) {
      calls.push('removed');
      return source;
    },
    bindings: () => [],
  });
  f.frame();
  assert.deepEqual(
    f.draws.map((draw) => draw.x),
    [-1, 0, 2, -1, 2, 0],
    'The inner sort cannot rewrite the outer resource snapshot',
  );
  assert.equal(calls.includes('removed'), false, 'Shader iteration retains live Set removal/addition behavior');
  assert.equal(calls.filter((value) => value === 'third').length, 6);
});

test('PBR pooled invocation state recovers after a lighting callback throws', async (t) => {
  const f = await scene(2);
  t.after(() => f.engine.dispose());
  let fail = true;
  f.model.addLighting({
    shader: (source) => source,
    bindings() {
      if (fail) throw new Error('binding failure');
      return [];
    },
  });
  assert.throws(() => f.frame(), /binding failure/);
  fail = false;
  assert.equal(f.frame().length, 2);
  assert.equal(f.frame().length, 2);
});
