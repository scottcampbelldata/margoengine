import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../dist/index.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { mockGPU, context as recordedContext } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

async function fixture(
  t,
  { depthFormat = 'depth32float-stencil8', topology = 4, materialCount = 2, staticParts = false } = {},
) {
  const gpu = optionalGPU(),
    device = gpu.engine.gpu,
    store = await TransformStore.create(32),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    ),
    { doc, buffers } = animatedTriangle();
  delete doc.skins;
  delete doc.animations;
  delete doc.nodes[0].skin;
  const definition = doc.meshes[0].primitives[0];
  definition.mode = topology;
  for (let material = 1; material < materialCount; material++) {
    doc.materials.push(structuredClone(doc.materials[0]));
    doc.meshes[0].primitives.push({ ...definition, material });
  }
  if (staticParts) {
    delete definition.targets;
    delete definition.attributes.JOINTS_0;
    delete definition.attributes.WEIGHTS_0;
    delete doc.meshes[0].weights;
    doc.nodes = [
      { mesh: 0, translation: [-1, 0, 0] },
      { mesh: 0, translation: [1, 0, 0], scale: [-1, 1, 1] },
    ];
  }
  const model = parseGLTF(engine, doc, buffers),
    primitives = [...model.primitives, ...model.pointsAndLines],
    context = {
      ...gpu.context,
      camera: engine.camera,
      descriptor: {
        ...gpu.context.descriptor,
        depthStencil: { ...gpu.context.descriptor.depthStencil, format: depthFormat },
      },
    },
    draws = [],
    references = [];
  let passes = 0,
    eyeRenderer;
  context.encoder.beginRenderPass = () => {
    const pass = ++passes;
    let pipeline,
      reference = 0,
      uniform,
      vertex;
    return {
      setPipeline(value) {
        pipeline = value;
      },
      setStencilReference(value) {
        reference = value;
        references.push({ pass, value });
      },
      setBindGroup(index, group) {
        if (index === 0) uniform = group.entries.find((entry) => entry.binding === 0).resource.buffer;
      },
      setVertexBuffer(index, value) {
        if (index === 0) vertex = value;
      },
      setIndexBuffer() {},
      drawIndexed() {
        draws.push({
          pipeline,
          reference,
          pass,
          uniform,
          vertex,
          matrix: new Float32Array(uniform.data).slice(16, 32),
        });
      },
      end() {},
    };
  };
  t.after(() => {
    eyeRenderer?.dispose();
    engine.dispose();
    gpu.cleanup();
  });
  engine.camera.update(128 / 96, true);
  store.tick(false);
  return {
    ...gpu,
    model,
    materials: primitives.map((primitive) => primitive.material),
    draws,
    references,
    frame(mode = 'beauty') {
      passes = 0;
      draws.length = 0;
      references.length = 0;
      model.draw(context, mode, context.color, context.depth);
      return draws;
    },
    forwardFrame() {
      eyeRenderer ??= model.createRenderer(device);
      passes = 0;
      draws.length = 0;
      references.length = 0;
      eyeRenderer.prepare(context);
      eyeRenderer.draw(context, context.encoder.beginRenderPass(), engine.camera.matrix);
      return draws;
    },
  };
}

test('default and polygon-only draws emit no stencil-reference command', async (t) => {
  const f = await fixture(t);
  f.frame();
  assert.deepEqual(f.references, []);
  f.materials[0].renderState = { depthBias: 2 };
  f.frame();
  assert.deepEqual(f.references, []);
});

test('legacy custom render state preserves the original depth descriptor own keys', async (t) => {
  const f = await fixture(t);
  f.materials[0].renderState = { blend: null, depthWrite: false, depthCompare: 'always' };
  const [custom] = f.frame();
  assert.deepEqual(Object.keys(custom.pipeline.depthStencil).sort(), ['depthCompare', 'depthWriteEnabled', 'format']);
  assert.deepEqual(custom.pipeline.depthStencil, {
    format: 'depth32float-stencil8',
    depthWriteEnabled: false,
    depthCompare: 'always',
  });
  f.materials[0].renderState = {
    depthBias: 0,
    depthBiasSlopeScale: 0,
    depthBiasClamp: 0,
    stencilReadMask: 0,
    stencilWriteMask: 0,
  };
  const zero = f.frame()[0].pipeline.depthStencil;
  for (const key of ['depthBias', 'depthBiasSlopeScale', 'depthBiasClamp', 'stencilReadMask', 'stencilWriteMask']) {
    assert.equal(Object.hasOwn(zero, key), true, key);
    assert.equal(zero[key], 0, key);
  }
});

test('a feature-off native draw preserves the proof recorder stream and legacy custom depth descriptor', async (t) => {
  const gpu = mockGPU(),
    store = await TransformStore.create(16),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    ),
    { doc, buffers } = animatedTriangle();
  delete doc.skins;
  delete doc.animations;
  delete doc.nodes[0].skin;
  const model = parseGLTF(engine, doc, buffers),
    view = recordedContext(gpu, { samples: 1, format: 'rgba16float', depthFormat: 'depth32float' });
  t.after(() => {
    model.dispose();
    engine.dispose();
  });
  engine.camera.update(4 / 3, true);
  store.tick(false);
  const log = gpu.record(() => {
    view.begin(0);
    model.draw(view.c, 'beauty', view.c.color, view.c.depth);
  });
  assert.equal(log.filter((event) => event[0] === 'pass.drawIndexed').length, 1);
  assert.equal(log.filter((event) => event[0] === 'pass.setStencilReference').length, 0);
  const originalDepth = log.find((event) => event[0] === 'renderPipeline')[2].depthStencil;
  model.primitives[0].material.renderState = { blend: null };
  const legacy = gpu.record(() => {
    view.begin(0);
    model.draw(view.c, 'beauty', view.c.color, view.c.depth);
  });
  assert.deepEqual(legacy.find((event) => event[0] === 'renderPipeline')[2].depthStencil, originalDepth);
});

test('a shared pass resets the first default reference and skips another redundant zero', async (t) => {
  const f = await fixture(t, { materialCount: 3 });
  f.materials[0].renderState = { stencilReference: 3 };
  const draws = f.frame();
  assert.deepEqual(
    draws.map((draw) => draw.reference),
    [3, 0, 0],
  );
  assert.deepEqual(
    f.references.map((reference) => reference.value),
    [3, 0],
  );
  f.materials[2].renderState = { stencilFront: { compare: 'always' } };
  f.frame();
  assert.deepEqual(
    f.references.map((reference) => reference.value),
    [3, 0, 0],
    'explicit stencil state restores its omitted reference to zero',
  );
});

test('native polygon bias reaches beauty pipelines without changing their shaders or default draws', async (t) => {
  const f = await fixture(t),
    material = f.materials[0];
  material.renderState = { depthBias: -2, depthBiasSlopeScale: -1.5, depthBiasClamp: -0.25 };
  const [biased, plain] = f.frame();
  assert.equal(biased.pipeline.depthStencil.depthBias, -2);
  assert.equal(biased.pipeline.depthStencil.depthBiasSlopeScale, -1.5);
  assert.equal(biased.pipeline.depthStencil.depthBiasClamp, -0.25);
  assert.equal(plain.pipeline.depthStencil.depthBias, undefined);
  assert.equal(biased.pipeline.fragment.module.code, plain.pipeline.fragment.module.code);
  material.renderState = { depthBias: 3, depthBiasSlopeScale: 0.5, depthBiasClamp: 1 };
  const changed = f.frame()[0];
  assert.notEqual(changed.pipeline, biased.pipeline);
  assert.equal(changed.pipeline.depthStencil.depthBias, 3);
  delete material.renderState;
  assert.equal(f.frame()[0].pipeline, plain.pipeline);
});

test('away polygon bias follows the normal reverse-Z view and a forward-Z device renderer', async (t) => {
  const f = await fixture(t),
    material = f.materials[0];
  material.renderState = {
    depthBiasMode: 'away',
    depthBias: 3,
    depthBiasSlopeScale: 1.5,
    depthBiasClamp: 0.25,
  };
  const reverse = f.frame()[0].pipeline.depthStencil,
    forward = f.forwardFrame()[0].pipeline.depthStencil;
  assert.equal(reverse.depthCompare, 'greater-equal');
  assert.equal(forward.depthCompare, 'less-equal');
  assert.deepEqual([reverse.depthBias, reverse.depthBiasSlopeScale, reverse.depthBiasClamp], [-3, -1.5, -0.25]);
  assert.deepEqual([forward.depthBias, forward.depthBiasSlopeScale, forward.depthBiasClamp], [3, 1.5, 0.25]);
  material.renderState.depthBiasMode = 'native';
  const nativeReverse = f.frame()[0].pipeline.depthStencil,
    nativeForward = f.forwardFrame()[0].pipeline.depthStencil;
  assert.deepEqual(
    [nativeReverse.depthBias, nativeReverse.depthBiasSlopeScale, nativeReverse.depthBiasClamp],
    [3, 1.5, 0.25],
  );
  assert.deepEqual(
    [nativeForward.depthBias, nativeForward.depthBiasSlopeScale, nativeForward.depthBiasClamp],
    [3, 1.5, 0.25],
  );
});

test('away bias rejects signed overflow after reverse-Z conversion while native and forward values stay valid', async (t) => {
  const f = await fixture(t),
    material = f.materials[0];
  material.renderState = { depthBiasMode: 'away', depthBias: -0x80000000 };
  assert.throws(() => f.frame(), /signed 32-bit/);
  assert.equal(f.forwardFrame()[0].pipeline.depthStencil.depthBias, -0x80000000);
  material.renderState.depthBiasMode = 'native';
  assert.equal(f.frame()[0].pipeline.depthStencil.depthBias, -0x80000000);
});

test('stencil reference stays dynamic and default draws reset it within one shared pass', async (t) => {
  const f = await fixture(t),
    material = f.materials[0];
  material.renderState = {
    stencilFront: { compare: 'equal', failOp: 'zero', depthFailOp: 'increment-clamp', passOp: 'replace' },
    stencilBack: { compare: 'not-equal', failOp: 'invert', depthFailOp: 'decrement-wrap', passOp: 'keep' },
    stencilReadMask: 0x0f,
    stencilWriteMask: 0xf0,
    stencilReference: 3,
    colorWrite: false,
  };
  const [stencil, plain] = f.frame();
  assert.equal(stencil.pass, plain.pass);
  assert.deepEqual([stencil.reference, plain.reference], [3, 0]);
  assert.deepEqual(stencil.pipeline.depthStencil.stencilFront, {
    compare: 'equal',
    failOp: 'zero',
    depthFailOp: 'increment-clamp',
    passOp: 'replace',
  });
  assert.deepEqual(stencil.pipeline.depthStencil.stencilBack, {
    compare: 'not-equal',
    failOp: 'invert',
    depthFailOp: 'decrement-wrap',
    passOp: 'keep',
  });
  assert.equal(stencil.pipeline.depthStencil.stencilReadMask, 0x0f);
  assert.equal(stencil.pipeline.depthStencil.stencilWriteMask, 0xf0);
  assert.equal(stencil.pipeline.fragment.targets[0].writeMask, 0);
  assert.notEqual(plain.pipeline.fragment.targets[0].writeMask, 0);
  material.renderState.stencilReference = 8;
  const [updated, reset] = f.frame();
  assert.equal(updated.pipeline, stencil.pipeline, 'a dynamic reference never creates another pipeline');
  assert.deepEqual([updated.reference, reset.reference], [8, 0]);
  material.renderState.stencilReadMask = 3;
  assert.notEqual(f.frame()[0].pipeline, stencil.pipeline, 'pipeline stencil masks remain part of the cache key');
});

test('asymmetric stencil faces draw original mirrored static nodes and symmetric state restores batching', async (t) => {
  const f = await fixture(t, { staticParts: true, materialCount: 1 }),
    material = f.materials[0],
    batch = f.model.resources.find((resource) => resource.batch),
    originalResources = f.model.resources.filter((resource) => !resource.batch);
  assert.ok(batch, 'the unchanged static mirrored nodes begin in a shared batch');
  const baseline = f.frame();
  assert.equal(baseline.length, 1);
  assert.equal(baseline[0].uniform, batch.uniform);
  const baselinePipeline = baseline[0].pipeline;
  material.renderState = {
    colorWrite: false,
    depthWrite: false,
    depthCompare: 'always',
    stencilFront: { compare: 'always', passOp: 'replace' },
    stencilBack: { compare: 'always', passOp: 'zero' },
    stencilReference: 9,
  };
  const separate = f.frame();
  assert.equal(separate.length, 2, 'literal raster front/back operations cannot use winding-normalized batch geometry');
  assert.deepEqual(
    separate.map((draw) => draw.matrix[0]),
    [1, -1],
  );
  assert.deepEqual(
    separate.map((draw) => draw.matrix[12]),
    [-1, 1],
  );
  assert.deepEqual(
    separate.map((draw) => draw.uniform),
    originalResources.map((resource) => resource.uniform),
  );
  assert.deepEqual(
    separate.map((draw) => draw.vertex),
    originalResources.map((resource) => resource.vertex),
  );
  for (const draw of separate) {
    assert.equal(draw.pipeline.depthStencil.stencilFront.passOp, 'replace');
    assert.equal(draw.pipeline.depthStencil.stencilBack.passOp, 'zero');
    assert.equal(draw.reference, 9);
  }
  assert.equal(f.frame('gbuffer').length, 1, 'auxiliary replay ignores beauty stencil state and retains batching');
  material.renderState.stencilBack = { compare: 'always', passOp: 'replace' };
  assert.equal(f.frame().length, 1, 'identical operations are safe with normalized winding');
  material.renderState.stencilFront = {};
  material.renderState.stencilBack = { compare: 'always', failOp: 'keep', depthFailOp: 'keep', passOp: 'keep' };
  assert.equal(f.frame().length, 1, 'omitted fields and their native defaults are symmetric');
  material.renderState.stencilBack.compare = 'never';
  assert.equal(f.frame().length, 2, 'different compares also require original raster faces');
  delete material.renderState;
  const restored = f.frame();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].uniform, batch.uniform);
  assert.equal(restored[0].pipeline, baselinePipeline);
});

test('native transmission gates both draws and writes stencil once while suppressing color writes', async (t) => {
  const f = await fixture(t),
    material = f.materials[0];
  Object.assign(material, {
    physical: [0, 0, 1, 0.75, 1, 1, 1, 1, 0, 0, 0, 0],
    tint: [0.5, 0.5, 0.5],
    volume: [0, 1, 1, 1],
  });
  for (const passOp of ['increment-wrap', 'invert']) {
    material.renderState = {
      colorWrite: false,
      stencilFront: { compare: 'always', passOp },
      stencilBack: { compare: 'always', passOp },
      stencilReadMask: 0x0f,
      stencilWriteMask: 0xff,
      stencilReference: 11,
    };
    const frame = f.frame(),
      materialUniform = f.model.resources[0].uniform,
      draws = frame.filter((draw) => draw.uniform === materialUniform);
    assert.equal(draws.length, 2);
    assert.deepEqual(
      draws.map((draw) => draw.pipeline.fragment.entryPoint),
      ['margoTint', 'fragment'],
    );
    assert.deepEqual(
      draws.map((draw) => draw.reference),
      [11, 11],
    );
    assert.deepEqual(
      draws.map((draw) => draw.pipeline.fragment.targets[0].writeMask),
      [0, 0],
    );
    assert.deepEqual(
      draws.map((draw) => draw.pipeline.depthStencil.stencilReadMask),
      [0x0f, 0x0f],
    );
    assert.deepEqual(
      draws.map((draw) => draw.pipeline.depthStencil.stencilWriteMask),
      [0, 0xff],
    );
    for (const draw of draws) {
      assert.deepEqual(draw.pipeline.depthStencil.stencilFront, { compare: 'always', passOp });
      assert.deepEqual(draw.pipeline.depthStencil.stencilBack, { compare: 'always', passOp });
    }
  }
});

test('stencil requests fail clearly on a target without a stencil aspect', async (t) => {
  const f = await fixture(t, { depthFormat: 'depth32float' });
  for (const renderState of [{ stencilReference: 0 }, { stencilFront: {} }, { stencilReadMask: 1 }]) {
    f.materials[0].renderState = renderState;
    assert.throws(() => f.frame(), /stencil.*(?:target|format|aspect)/i);
  }
});

test('transmission tint preserves depth for the lit draw when a strict depth test writes depth', async (t) => {
  const f = await fixture(t),
    material = f.materials[0];
  Object.assign(material, {
    physical: [0, 0, 1, 0.75, 1, 1, 1, 1, 0, 0, 0, 0],
    tint: [0.5, 0.5, 0.5],
    volume: [0, 1, 1, 1],
    renderState: {
      depthWrite: true,
      depthCompare: 'greater',
      stencilFront: { compare: 'always', passOp: 'increment-wrap', depthFailOp: 'decrement-wrap' },
      stencilBack: { compare: 'always', passOp: 'increment-wrap', depthFailOp: 'decrement-wrap' },
      stencilWriteMask: 0xff,
    },
  });
  const frame = f.frame(),
    uniform = f.model.resources[0].uniform,
    draws = frame.filter((draw) => draw.uniform === uniform);
  assert.deepEqual(
    draws.map((draw) => draw.pipeline.fragment.entryPoint),
    ['margoTint', 'fragment'],
  );
  assert.deepEqual(
    draws.map((draw) => draw.pipeline.depthStencil.depthCompare),
    ['greater', 'greater'],
  );
  assert.deepEqual(
    draws.map((draw) => draw.pipeline.depthStencil.depthWriteEnabled),
    [false, true],
  );
  assert.deepEqual(
    draws.map((draw) => draw.pipeline.depthStencil.stencilWriteMask),
    [0, 0xff],
  );
  assert.equal(draws[1].pipeline.depthStencil.stencilFront.passOp, 'increment-wrap');
  assert.equal(draws[1].pipeline.depthStencil.stencilFront.depthFailOp, 'decrement-wrap');
});

test('native render state rejects malformed bias, masks, references and stencil enums before drawing', async (t) => {
  const f = await fixture(t);
  const invalid = [
    { depthBiasMode: 'further' },
    { depthBias: 0.5 },
    { depthBias: 2 ** 31 },
    { depthBias: -(2 ** 31) - 1 },
    { depthBias: '1' },
    { depthBiasSlopeScale: NaN },
    { depthBiasClamp: Infinity },
    { depthBiasSlopeScale: Number.MAX_VALUE },
    { stencilReadMask: -1 },
    { stencilWriteMask: 2 ** 32 },
    { stencilReference: 1.5 },
    { stencilReference: '3' },
    { stencilFront: { compare: 'nearer' } },
    { stencilBack: { failOp: 'wrap' } },
    { stencilFront: null },
    { stencilBack: [] },
    { colorWrite: 1 },
  ];
  for (const renderState of invalid) {
    f.materials[0].renderState = renderState;
    assert.throws(() => f.frame(), { name: /^(TypeError|RangeError)$/ }, JSON.stringify(renderState));
    assert.equal(f.draws.length, 0);
  }
});

test('native raster numeric arguments distinguish wrong types from invalid ranges', async (t) => {
  const f = await fixture(t);
  for (const key of [
    'depthBias',
    'depthBiasSlopeScale',
    'depthBiasClamp',
    'stencilReadMask',
    'stencilWriteMask',
    'stencilReference',
  ]) {
    for (const value of [null, '1', true]) {
      f.materials[0].renderState = { [key]: value };
      assert.throws(() => f.frame(), { name: 'TypeError', message: new RegExp(key + '.*; set') });
    }
    f.materials[0].renderState = { [key]: Infinity };
    assert.throws(() => f.frame(), { name: 'RangeError', message: new RegExp(key + '.*; set') });
  }
});

test('points and lines ignore polygon bias while auxiliary replays ignore beauty render state', async (t) => {
  for (const topology of [0, 3]) {
    const f = await fixture(t, { topology });
    f.materials[0].renderState = { depthBias: 1, depthBiasSlopeScale: 2, depthBiasClamp: 3 };
    const [draw] = f.frame();
    for (const key of ['depthBias', 'depthBiasSlopeScale', 'depthBiasClamp'])
      assert.equal(draw.pipeline.depthStencil[key] ?? 0, 0);
  }
  const f = await fixture(t, { depthFormat: 'depth32float' });
  f.materials[0].renderState = {
    depthBias: 2,
    stencilFront: { compare: 'equal' },
    stencilReference: 7,
    colorWrite: false,
  };
  for (const mode of ['gbuffer', 'ambient', 'occlusion']) {
    const [draw] = f.frame(mode);
    assert.equal(draw.pipeline.depthStencil.depthBias, undefined);
    assert.equal(draw.pipeline.depthStencil.stencilFront, undefined);
    assert.notEqual(draw.pipeline.fragment.targets[0].writeMask, 0);
    assert.equal(draw.reference, 0);
  }
});
