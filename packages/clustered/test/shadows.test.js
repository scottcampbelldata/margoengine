import test from 'node:test';
import assert from 'node:assert/strict';
import { Clustered, clusteredSampling } from '../dist/index.js';
import { LocalShadows } from '../dist/shadows.js';
import { AreaLights } from '../dist/area.js';
import { wgsl } from '../../core/src/shaders.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

function harness() {
  const h = optionalGPU(),
    gpu = h.engine.gpu,
    passes = [];
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  globalThis.GPUTextureUsage = {
    ...globalThis.GPUTextureUsage,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    RENDER_ATTACHMENT: 16,
  };
  gpu.limits.maxTextureDimension2D = 8192;
  gpu.createBindGroupLayout = (d) => ({ ...d });
  gpu.createPipelineLayout = (d) => ({ ...d });
  const begin = h.context.encoder.beginRenderPass,
    drawn = [];
  h.context.encoder.beginRenderPass = (d) => {
    const pass = begin(d),
      layer = d.depthStencilAttachment.view;
    passes.push(layer);
    return {
      ...pass,
      drawIndexed(count, instances = 1) {
        drawn.push([layer, count, instances]);
        pass.drawIndexed();
      },
    };
  };
  const frame = () => {
    passes.length = drawn.length = 0;
    h.context.shader = wgsl;
    h.context.bindings.length = 0;
    h.engine.frameGraph.execute(h.context);
  };
  return { ...h, passes, drawn, frame };
}
const node = (engine, id = 0) => ({
  id,
  engine,
  matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  check() {},
});
const caster = (engine, extra = {}) => ({
  shadowPrimitives: [{ node: node(engine), vertex: {}, index: {}, count: 36, stride: 80, ...extra }],
});

test('local shadows: clustered shaders and bindings are unchanged until attached, and restored on dispose', () => {
  const h = harness(),
    lights = new Clustered({ grid: [2, 2, 2] });
  lights.setLights([{ position: [0, 2, 0], range: 6 }]);
  h.engine.use(lights);
  h.frame();
  const plain = h.context.shader,
    plainBindings = lights.bindings(),
    hooks = lights.pbr(2);
  assert.ok(!plain.includes('clusterShadow'));
  assert.equal(clusteredSampling(0), clusteredSampling(0, undefined));
  const shadows = LocalShadows.attach(h.engine, { lights });
  h.frame();
  assert.match(h.context.shader, /falloff\*cone\*clusterShadow\(light,position,n\);/);
  assert.match(h.context.shader, /@group\(0\) @binding\(14\) var<uniform> localShadowFrame/);
  assert.deepEqual(
    lights.bindings().map((e) => e.binding),
    [4, 5, 6, 7, 14, 15, 16],
  );
  assert.equal(lights.bindings(), lights.bindings(), 'stable joined bindings');
  const lit = lights.pbr(2);
  assert.notEqual(lit, hooks);
  assert.match(lit.declarations, /@group\(2\) @binding\(15\) var localShadowMap:texture_depth_2d_array;/);
  shadows.dispose();
  h.frame();
  assert.equal(h.context.shader, plain);
  assert.equal(lights.bindings(), plainBindings);
  assert.equal(lights.shadow, undefined);
  lights.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('local shadows: castShadow lights get dense 1-based ordinals in params.z', () => {
  const lights = new Clustered({ grid: [2, 2, 2] }),
    data = lights['data'];
  lights.setLights([
    { position: [0, 0, 0], range: 1, castShadow: true },
    { position: [0, 0, 0], range: 1 },
    { position: [0, 0, 0], range: 1, direction: [0, -1, 0], outerAngle: 0.5, castShadow: true },
  ]);
  assert.deepEqual([data[14], data[30], data[46]], [1, 0, 2]);
  assert.deepEqual(
    [...data.subarray(40, 48)].map((v) => +v.toFixed(4)),
    [0, -1, 0, +Math.cos(0.5).toFixed(4), 1, 1, 2, 0],
  );
  lights.setLights([{ position: [0, 0, 0], range: 1 }]);
  assert.equal(data[14], 0);
});

test('local shadows: point lights use six layers, spot lights one; maps re-render only for what changed', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    shadows = LocalShadows.attach(h.engine, { lights, maxLights: 2, resolution: 64 });
  const point = { position: [0, 3, 0], range: 10, castShadow: true },
    spot = { position: [4, 3, 0], range: 10, direction: [0, -1, 0], outerAngle: 0.6, castShadow: true };
  const third = { position: [-4, 3, 0], range: 10, castShadow: true },
    box = caster(h.engine);
  lights.setLights([point, spot, third]);
  shadows.add(box);
  h.frame();
  assert.equal(h.passes.length, 7, '6 cube faces + 1 spot; the third light is over budget');
  assert.equal(new Set(h.passes).size, 7);
  assert.equal(h.drawn.length, 7);
  const frameData = new Float32Array(shadows.bindings()[0].resource.buffer.data);
  assert.deepEqual(
    [...frameData.subarray(0, 4)].map((v) => +v.toFixed(4)),
    [2, 1, 1.5, +(1 / 64).toFixed(4)],
  );
  assert.deepEqual([...frameData.subarray(4, 7)], [0, 1, frameData[6]]);
  assert.deepEqual([...frameData.subarray(8, 10)], [6, 0]);
  h.frame();
  assert.equal(h.passes.length, 0);
  assert.equal(shadows.stats.cacheHits, 1);
  lights.setLights([point, { ...spot, position: [4, 3, 1] }, third]);
  h.frame();
  assert.equal(h.passes.length, 1, 'only the moved spot light');
  box.shadowPrimitives[0].node.matrix[13] = 1;
  h.frame();
  assert.equal(h.passes.length, 7, 'a moved caster re-renders every map');
  h.frame();
  assert.equal(h.passes.length, 0);
  const animated = caster(h.engine, { index: {} }),
    remove = shadows.add(animated, { dynamic: true });
  h.frame();
  assert.equal(h.passes.length, 7);
  assert.equal(h.drawn.length, 14);
  h.frame();
  assert.equal(h.passes.length, 7, 'dynamic casters re-render every frame');
  remove();
  h.frame();
  assert.equal(h.passes.length, 7);
  h.frame();
  assert.equal(h.passes.length, 0);
  h.engine.store.hidden[0] = 1;
  h.frame();
  assert.equal(h.passes.length, 7);
  assert.equal(h.drawn.length, 0, 'hidden casters are skipped');
  h.engine.store.hidden[0] = 0;
  h.frame();
  assert.equal(h.drawn.length, 7);
  lights.setLights([{ ...spot, castShadow: false }, point]);
  h.frame();
  assert.equal(h.passes.length, 0, 'the point light keeps slot 0 and its maps');
  shadows.dispose();
  lights.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('local shadows: instanced and masked casters choose their pipelines; instance edits re-render', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    shadows = LocalShadows.attach(h.engine, { lights, resolution: 32 });
  let pending = false;
  const instances = {
    count: 5,
    get needsUpdate() {
      return pending;
    },
    upload() {
      pending = false;
      return {};
    },
  };
  shadows.add(caster(h.engine, { instances, alphaTexture: {}, cutoff: 0.5 }));
  lights.setLights([{ position: [0, 2, 0], range: 5, direction: [0, -1, 0], outerAngle: 0.4, castShadow: true }]);
  h.frame();
  assert.deepEqual(
    h.drawn.map((d) => d.slice(1)),
    [[36, 5]],
  );
  const pipeline = h.pipelines.at(-1);
  assert.match(pipeline.vertex.module.code, /@location\(5\) m0:vec4f/);
  assert.equal(pipeline.fragment.entryPoint, 'fragment');
  assert.equal(pipeline.depthStencil.depthCompare, 'greater');
  h.frame();
  assert.equal(h.passes.length, 0);
  pending = true;
  h.frame();
  assert.equal(h.passes.length, 1);
  instances.count = 3;
  h.frame();
  assert.deepEqual(
    h.drawn.map((d) => d.slice(1)),
    [[36, 3]],
  );
  shadows.add(caster(h.engine, { index: {}, stride: 24 }));
  h.frame();
  assert.equal(h.pipelines.at(-1).fragment, undefined, 'opaque casters draw depth only');
  shadows.dispose();
  lights.dispose();
});

test('local shadows: light matrices put the light frustum in reversed depth and pick the right cube face', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    shadows = LocalShadows.attach(h.engine, { lights, resolution: 64 });
  lights.setLights([
    { position: [1, 2, 3], range: 8, castShadow: true },
    { position: [0, 5, 0], range: 10, direction: [0.2, -1, 0], outerAngle: 0.5, castShadow: true },
  ]);
  h.frame();
  const v = new Float32Array(shadows.bindings()[0].resource.buffer.data),
    matrix = (l) => v.subarray(4 + 64 + l * 16, 4 + 64 + l * 16 + 16);
  const project = (m, p) => {
    const c = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
    return [(c[0] / c[3]) * 0.5 + 0.5, 0.5 - (c[1] / c[3]) * 0.5, c[2] / c[3], c[3]];
  };
  const faces = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  faces.forEach((axis, face) => {
    const near = project(
        matrix(face),
        axis.map((a, k) => [1, 2, 3][k] + a * 0.008),
      ),
      far = project(
        matrix(face),
        axis.map((a, k) => [1, 2, 3][k] + a * 8),
      ),
      off = project(
        matrix(face),
        axis.map((a, k) => [1, 2, 3][k] + a * 4 + (k === (face < 2 ? 1 : 0) ? 3.9 : 0)),
      );
    assert.ok(Math.abs(near[2] - 1) < 1e-3 && Math.abs(far[2]) < 1e-4, `face ${face} depth`);
    assert.ok(Math.abs(near[0] - 0.5) < 1e-4 && Math.abs(near[1] - 0.5) < 1e-4);
    assert.ok(off[0] > 0 && off[0] < 1 && off[1] > 0 && off[1] < 1, `face ${face} covers 45 degrees off axis`);
  });
  const length = Math.hypot(0.2, -1),
    dir = [0.2 / length, -1 / length, 0],
    spot = project(matrix(6), [dir[0] * 5, 5 + dir[1] * 5, 0]);
  assert.ok(Math.abs(spot[0] - 0.5) < 1e-4 && Math.abs(spot[1] - 0.5) < 1e-4 && spot[2] > 0 && spot[2] < 1);
  assert.deepEqual([...v.subarray(8, 11)], [6, 0, v[10]]);
  assert.ok(Math.abs(v[10] - (2 * Math.tan(0.5) * 64) / 60 / 64) < 1e-6, 'texel size per unit distance');
  shadows.dispose();
  lights.dispose();
});

test('local shadows: a castShadow pi/2 spot (a hemisphere) takes the six cube layers of a point light', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    shadows = LocalShadows.attach(h.engine, { lights, maxLights: 2, resolution: 64 });
  const point = { position: [0, 3, 0], range: 10, castShadow: true };
  lights.setLights([point, { ...point, direction: [0, -1, 0], angle: Math.PI / 2, penumbra: 0.3 }]);
  shadows.add(caster(h.engine));
  h.frame();
  assert.equal(h.passes.length, 12);
  const v = new Float32Array(shadows.bindings()[0].resource.buffer.data),
    layers = (first) => v.subarray(4 + 64 + first * 16, 4 + 64 + (first + 6) * 16);
  assert.deepEqual([...v.subarray(8, 11)], [6, 1, v[6]], 'base layer 6, cube faces, the point texel size');
  assert.deepEqual(layers(6), layers(0), "the point light's face matrices");
  lights.setLights([point, { ...point, direction: [0, -1, 0], angle: 1.5 }]);
  h.frame();
  assert.equal(new Float32Array(shadows.bindings()[0].resource.buffer.data)[9], 0, 'a narrower cone is one map');
  shadows.dispose();
  lights.dispose();
});

test('local shadows: options are validated', () => {
  const lights = new Clustered();
  assert.throws(() => new LocalShadows({}), /Clustered/);
  for (const bad of [{ maxLights: 0 }, { maxLights: 17 }, { resolution: 8 }, { bias: -1 }, { normalBias: Number.NaN }])
    assert.throws(() => new LocalShadows({ lights, ...bad }), RangeError);
  const shadows = new LocalShadows({ lights });
  assert.throws(() => shadows.bindings(), /not attached/);
  shadows[Symbol.dispose]();
  assert.throws(() => shadows.add(caster({})), TypeError);
});

test('external, integrated and area lights compose with independent bindings and shadow ordinals', () => {
  const h = harness();
  Object.assign(h.engine.gpu.limits, { maxTextureArrayLayers: 256 });
  const lights = new Clustered({ grid: [1, 1, 1], shadows: { resolution: 16, maxLights: 2 } });
  lights.setLights([
    { position: [0, 2, 0], range: 6, castShadow: true },
    { position: [2, 2, 0], range: 6, shadow: true },
  ]);
  h.engine.use(lights);
  const local = LocalShadows.attach(h.engine, { lights, resolution: 16 }),
    area = AreaLights.attach(h.engine, { lights });
  area.setLights([{ position: [0, 2, 0], direction: [0, -1, 0], width: 1, height: 1 }]);
  try {
    h.frame();
    const bindings = lights.bindings(),
      ids = bindings.map((entry) => entry.binding);
    assert.deepEqual(ids, [4, 5, 6, 7, 28, 29, 30, 14, 15, 16, 17]);
    assert.equal(new Set(ids).size, ids.length);
    const data = new Float32Array(bindings.find((entry) => entry.binding === 5).resource.buffer.data);
    assert.deepEqual([data[14], data[15], data[30], data[31]], [1, 0, 0, 1]);
    const declarations = lights.pbr(2).declarations;
    const declared = [...declarations.matchAll(/@group\(2\) @binding\((\d+)\)/g)].map((match) => Number(match[1]));
    assert.equal(new Set(declared).size, declared.length, 'each declaration uses its own binding');
    assert.match(declarations, /clusterShadow\(light,position,n\)\*clusterShadowVisibility/);
    assert.match(declarations, /clusterAreaLighting\(position,n,v,nv/);
    local.dispose();
    area.dispose();
    h.frame();
    assert.deepEqual(
      lights.bindings().map((entry) => entry.binding),
      [4, 5, 6, 7, 28, 29, 30],
    );
  } finally {
    local.dispose();
    area.dispose();
    lights.dispose();
    assert.ok(h.resources.every((resource) => resource.destroyed));
  }
});

test('external shadow casters retain affine alpha UVs, instance transforms and primitive identity', () => {
  const h = harness(),
    lights = new Clustered({ grid: [1, 1, 1] });
  lights.setLights([{ position: [0, 2, 0], range: 6, direction: [0, -1, 0], outerAngle: 0.7, castShadow: true }]);
  h.engine.use(lights);
  const shadows = LocalShadows.attach(h.engine, { lights, resolution: 16 }),
    p = caster(h.engine, {
      primitive: {},
      cutoff: 0.3,
      texCoord: 1,
      alphaTransform: new Float32Array([0, 2, 0.25, 0, -3, 0, 0.75, 0]),
      instances: { count: 2, upload: () => ({}) },
    }).shadowPrimitives[0],
    second = { ...p, primitive: {}, cutoff: 0.7, alphaTransform: p.alphaTransform.slice() };
  shadows.add({ shadowPrimitives: [p, second] });
  try {
    h.frame();
    const uniforms = h.resources.filter((resource) => resource.size === 112);
    assert.equal(uniforms.length, 2, 'shared geometry keeps separate material uniforms');
    assert.equal(h.drawn.length, 2);
    assert.ok(h.drawn.every((draw) => draw[2] === 2));
    const pipeline = h.pipelines.find((p) => p.vertex);
    assert.equal(pipeline.vertex.buffers[1].arrayStride, 96);
    assert.match(pipeline.vertex.module.code, /sourceUV=o.uv/);
    for (const uniform of uniforms) assert.deepEqual(new Float32Array(uniform.data).slice(20), p.alphaTransform);
    h.frame();
    assert.equal(shadows.stats.layers, 0);
    p.alphaTransform[2] = 0.5;
    h.frame();
    assert.equal(shadows.stats.layers, 1, 'mutated texture transform invalidates the cached map');
  } finally {
    shadows.dispose();
    lights.dispose();
    assert.ok(h.resources.every((resource) => resource.destroyed));
  }
});

test('local shadows: wireframe topology invalidates cached maps and reuses depth pipelines', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [1, 1, 1] }),
    shadows = LocalShadows.attach(h.engine, { lights, resolution: 16 }),
    source = caster(h.engine, { primitive: {}, topology: 'line-list', count: 6, cutoff: 0.4 }),
    primitive = source.shadowPrimitives[0],
    draws = [],
    begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (descriptor) => {
    const pass = begin(descriptor);
    let pipeline, index;
    return {
      ...pass,
      setPipeline(value) {
        pipeline = value;
      },
      setIndexBuffer(value) {
        index = value;
      },
      drawIndexed(...args) {
        draws.push({ pipeline, index, args });
        pass.drawIndexed(...args);
      },
    };
  };
  const frame = () => {
    draws.length = 0;
    h.frame();
  };
  try {
    lights.setLights([{ position: [0, 2, 0], range: 6, direction: [0, -1, 0], outerAngle: 0.7, castShadow: true }]);
    shadows.add(source);
    frame();
    const lines = draws[0].pipeline;
    assert.equal(lines.primitive?.topology, 'line-list');
    assert.ok(!Object.keys(lines.depthStencil).some((key) => key.startsWith('depthBias')));
    assert.equal(lines.fragment.entryPoint, 'fragment', 'masked lines retain alpha testing');
    assert.equal(draws[0].index, primitive.index);
    assert.deepEqual(draws[0].args, [6]);
    frame();
    assert.equal(draws.length, 0);
    delete primitive.topology;
    frame();
    assert.equal(draws.length, 1, 'topology alone invalidates the cached spot map');
    const triangles = draws[0].pipeline;
    assert.equal(Object.hasOwn(triangles, 'primitive'), false);
    primitive.topology = 'line-list';
    frame();
    assert.equal(draws[0].pipeline, lines);
    delete primitive.topology;
    frame();
    assert.equal(draws[0].pipeline, triangles);
    primitive.topology = 'line-list';
    primitive.instances = { count: 2, upload: () => ({}) };
    frame();
    assert.deepEqual(draws[0].args, [6, 2]);
    assert.equal(draws[0].pipeline.primitive.topology, 'line-list');
    assert.equal(draws[0].pipeline.vertex.buffers[1].stepMode, 'instance');
  } finally {
    shadows.dispose();
    lights.dispose();
    h.cleanup();
  }
});

test('local shadows: replacing indices behind stable primitive identity refreshes the cached map', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [1, 1, 1] }),
    shadows = LocalShadows.attach(h.engine, { lights, resolution: 16 }),
    source = caster(h.engine, { primitive: {} }),
    primitive = source.shadowPrimitives[0],
    original = primitive.index;
  try {
    lights.setLights([{ position: [0, 2, 0], range: 6, direction: [0, -1, 0], outerAngle: 0.7, castShadow: true }]);
    shadows.add(source);
    h.frame();
    h.frame();
    assert.equal(h.drawn.length, 0);
    primitive.index = {};
    h.frame();
    assert.equal(h.drawn.length, 1, 'index replacement refreshes a stable primitive without a version bump');
    h.frame();
    assert.equal(h.drawn.length, 0);
    primitive.index = original;
    h.frame();
    assert.equal(h.drawn.length, 1);
    primitive.count = 6;
    h.frame();
    assert.deepEqual(h.drawn[0].slice(1), [6, 1]);
  } finally {
    shadows.dispose();
    lights.dispose();
    h.cleanup();
  }
});

test('local shadows: castShadow lights take shadow resolution, near and far; a full-size map uploads what plain lights do', () => {
  const h = harness(),
    viewports = [],
    begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (d) => ({ ...begin(d), setViewport: (...args) => viewports.push(args) });
  const lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    shadows = LocalShadows.attach(h.engine, { lights, resolution: 64 }),
    point = { position: [0, 3, 0], range: 10, castShadow: true },
    upload = () => new Uint8Array(shadows.bindings()[0].resource.buffer.data).slice();
  try {
    for (const [shadow, type] of [
      [{ resolution: 15 }, RangeError],
      [{ resolution: [16] }, RangeError],
      [{ resolution: [16, 32.5] }, RangeError],
      [{ near: 0 }, RangeError],
      [{ near: 10 }, RangeError],
      [{ near: 5, far: 4 }, RangeError],
      [{ far: Infinity }, RangeError],
      [{ far: '8' }, TypeError],
      [{ bias: 1 }, TypeError],
      [true, RangeError],
    ])
      assert.throws(() => lights.setLights([{ ...point, shadow }]), type, JSON.stringify(shadow));
    assert.throws(() => lights.setLights([{ ...point, castShadow: false, shadow: { far: 5 } }]), /ClusteredOptions/);
    assert.throws(() => lights.setLights([{ ...point, range: 0 }]), /finite range/);
    lights.setLights([point]);
    h.frame();
    const plain = upload();
    for (const shadow of [{}, { resolution: 64 }, { resolution: [64, 64] }]) {
      lights.setLights([{ ...point, shadow }]);
      shadows.invalidate();
      h.frame();
      assert.deepEqual(upload(), plain, `${JSON.stringify(shadow)} is today's light`);
    }
    assert.equal(viewports.length, 0, 'full-size maps set no viewport');
    lights.setLights([{ ...point, shadow: { resolution: 128 } }]);
    assert.throws(() => h.frame(), /exceeds LocalShadows resolution 64/);
    // Unlimited range with an explicit far: depth 0 (reversed) at far, 1 at far / 1000.
    lights.setLights([{ ...point, range: 0, shadow: { far: 8 } }]);
    h.frame();
    const v = new Float32Array(shadows.bindings()[0].resource.buffer.data),
      depth = (d) => {
        const m = v.subarray(4 + 64, 4 + 64 + 16),
          p = [d, 3, 0],
          z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
          w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
        return z / w;
      };
    assert.ok(Math.abs(depth(8)) < 1e-5 && Math.abs(depth(0.008) - 1) < 1e-3, `${depth(8)} ${depth(0.008)}`);
  } finally {
    shadows.dispose();
    lights.dispose();
  }
});

test('local shadows: a smaller castShadow map renders into its layer corner with a guard band and matching UVs', () => {
  const h = harness(),
    size = 512,
    passes = [],
    begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (d) => {
    const record = { viewport: null };
    passes.push(record);
    return { ...begin(d), setViewport: (...args) => (record.viewport = args) };
  };
  const lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    shadows = LocalShadows.attach(h.engine, { lights, maxLights: 3, resolution: size }),
    position = [2, 3, 4],
    spot = { position, range: 10, direction: [0, 0, -1], outerAngle: Math.PI / 6, castShadow: true };
  lights.setLights([
    { position, range: 10, castShadow: true, shadow: { near: 0.25, resolution: [128, 64] } },
    spot,
    { ...spot, shadow: { far: 3, resolution: 32 } },
  ]);
  shadows.add(caster(h.engine));
  const close = (actual, expected, label) =>
    assert.ok(Math.abs(actual - expected) < 1e-3, `${label}: ${actual} != ${expected}`);
  try {
    h.frame();
    assert.equal(passes.length, 8);
    const frame = new Float32Array(shadows.bindings()[0].resource.buffer.data),
      cameras = new Float32Array(shadows['cameras'].data),
      clip = (m, o, p) =>
        [0, 1, 2, 3].map((r) => m[o + r] * p[0] + m[o + 4 + r] * p[1] + m[o + 8 + r] * p[2] + m[o + 12 + r]);
    // Layer texel a receiver samples (frame matrix, whole layer) and the texel the depth pass drew (camera + viewport).
    const texels = (layer, p) => {
      const s = clip(frame, 4 + 64 + layer * 16, p),
        r = clip(cameras, layer * 64, p),
        [width, height] = passes[layer].viewport?.slice(2, 4) ?? [size, size];
      return {
        sampled: [(s[0] / s[3]) * 0.5 + 0.5, 0.5 - (s[1] / s[3]) * 0.5].map((uv) => uv * size),
        drawn: [((r[0] / r[3]) * 0.5 + 0.5) * width, (0.5 - (r[1] / r[3]) * 0.5) * height],
        depth: [s[2] / s[3], r[2] / r[3]],
      };
    };
    const axes = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (let face = 0; face < 6; face++) {
      assert.deepEqual(passes[face].viewport, [0, 0, 128, 64, 0, 1], `face ${face} renders its corner`);
      for (const perpendicular of axes.filter((axis) => axis.every((v, i) => v * axes[face][i] === 0)))
        for (const lateral of [0.3, 1]) {
          const t = texels(
            face,
            position.map((v, i) => v + axes[face][i] * 2 + perpendicular[i] * 2 * lateral),
          );
          close(t.sampled[0], t.drawn[0], `face ${face} u`);
          close(t.sampled[1], t.drawn[1], `face ${face} v`);
          close(t.depth[0], t.depth[1], `face ${face} depth`);
          const inset = Math.min(t.drawn[0], 128 - t.drawn[0], t.drawn[1], 64 - t.drawn[1]);
          // The cube face's 90-degree edge lands two texels inside the corner: the 3x3 filter never leaves it.
          if (lateral === 1) close(inset, 2, `face ${face} guard band`);
          else assert.ok(inset > 2, `face ${face} interior`);
        }
      close(
        texels(
          face,
          position.map((v, i) => v + axes[face][i] * 0.25),
        ).depth[0],
        1,
        `face ${face} near`,
      );
    }
    close(frame[6], 2 / (64 - 4), "the bias texel is the smaller map's");
    assert.equal(passes[6].viewport, null, 'the full-size spot renders its whole layer');
    assert.deepEqual(frame.subarray(4 + 64 + 6 * 16, 4 + 64 + 7 * 16), cameras.subarray(6 * 64, 6 * 64 + 16));
    // The third light (slot 2, layer 7) has far 3: reversed depth 0 three units down its cone, centred in its corner.
    assert.deepEqual(passes[7].viewport, [0, 0, 32, 32, 0, 1]);
    const axis = texels(7, [2, 3, 1]);
    close(axis.depth[0], 0, 'far plane');
    axis.sampled.forEach((v) => close(v, 16, 'cone axis at the corner centre'));
  } finally {
    shadows.dispose();
    lights.dispose();
  }
});

test('local shadows: a caster with bounds draws only into the maps whose frustum it reaches', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    shadows = LocalShadows.attach(h.engine, { lights, maxLights: 1, resolution: 64 });
  lights.setLights([{ position: [0, 3, 0], range: 10, castShadow: true }]);
  const below = caster(h.engine, { bounds: [0, 0, 0, 0.5] }),
    far = caster(h.engine, { bounds: [0, 0, 0, 0.5] }),
    unknown = caster(h.engine);
  far.shadowPrimitives[0].node.matrix[12] = 100;
  shadows.add(below);
  shadows.add(far);
  shadows.add(unknown);
  h.frame();
  assert.equal(h.passes.length, 6);
  const layers = [...new Set(h.passes)];
  // The box under the light reaches only the -y face (axes +x, -x, +y, -y, +z, -z); the far one no face; the one
  // without bounds every face.
  assert.deepEqual(
    h.drawn.map(([layer]) => layers.indexOf(layer)),
    [0, 1, 2, 3, 3, 4, 5].sort(),
  );
  assert.equal(h.drawn.length, 7);
  // Scaled up by 8 its sphere (radius 4, 3 m below) holds the light itself, so it reaches every face.
  const m = below.shadowPrimitives[0].node.matrix;
  m[0] = m[5] = m[10] = 8;
  h.frame();
  assert.equal(h.drawn.length, 12);
  shadows.dispose();
  lights.dispose();
});

// Ground truth for the per-map caster cull: does any point of the caster's local sphere, moved by its node matrix, land
// inside a layer's clip volume (WebGPU: -w <= x, y <= w, 0 <= z <= w)? Samples fill the ball and cover its surface.
const ballSamples = (() => {
  const out = [];
  for (let i = -6; i <= 6; i++)
    for (let j = -6; j <= 6; j++)
      for (let k = -6; k <= 6; k++) if (i * i + j * j + k * k <= 36) out.push([i / 6, j / 6, k / 6]);
  const n = 2000,
    golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n,
      r = Math.sqrt(1 - y * y);
    out.push([Math.cos(golden * i) * r, y, Math.sin(golden * i) * r]);
  }
  return out;
})();
function touches(layer, o, bounds, m) {
  for (const [u, v, w] of ballSamples) {
    const lx = bounds[0] + bounds[3] * u,
      ly = bounds[1] + bounds[3] * v,
      lz = bounds[2] + bounds[3] * w,
      p = [0, 1, 2].map((r) => m[r] * lx + m[4 + r] * ly + m[8 + r] * lz + m[12 + r]),
      [x, y, z, cw] = [0, 1, 2, 3].map(
        (r) => layer[o + r] * p[0] + layer[o + 4 + r] * p[1] + layer[o + 8 + r] * p[2] + layer[o + 12 + r],
      );
    if (cw > 0 && Math.abs(x) <= cw && Math.abs(y) <= cw && z >= 0 && z <= cw) return true;
  }
  return false;
}
/** The faces each caster (told apart by its index count) was drawn into, and any face it reaches but was culled from. */
function cullCheck(h, shadows, casters) {
  h.frame();
  const layers = [...new Set(h.passes)],
    matrices = shadows['matrices'],
    missing = [],
    faces = [];
  for (const { caster: c, bounds, count, label } of casters) {
    const m = c.shadowPrimitives[0].node.matrix,
      drawn = new Set(h.drawn.filter(([, n]) => n === count).map(([layer]) => layers.indexOf(layer)));
    faces.push([...drawn].sort());
    for (let l = 0; l < layers.length; l++)
      if (!drawn.has(l) && touches(matrices, l * 64, bounds, m)) missing.push(`${label}: face ${l}`);
  }
  return { missing, faces };
}

test('local shadows: the per-map cull keeps every caster that reaches a cube face (seams, corners, grazing)', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    shadows = LocalShadows.attach(h.engine, { lights, maxLights: 1, resolution: 64 });
  lights.setLights([{ position: [0, 0, 0], range: 10, castShadow: true }]);
  const list = [];
  const put = (label, bounds, [x, y, z], expect) => {
    const count = 3 * (list.length + 1),
      c = caster(h.engine, { bounds, count });
    c.shadowPrimitives[0].node.matrix.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
    shadows.add(c);
    list.push({ caster: c, bounds, count, label, expect });
  };
  // Faces in layer order: +x, -x, +y, -y, +z, -z.
  // The centre lies outside the +x face's frustum (above its x = y seam plane, in +y), the radius crosses into it.
  put('centre in +y, overlapping the +x seam', [0, 0, 0, 0.6], [2, 2.5, 0], [0, 2]);
  put('centre in +x, overlapping the +y seam', [0, 0, 0, 0.6], [2.5, 2, 0], [0, 2]);
  // On the edge where +x and +y meet, and on the corner where +x, +y and +z meet.
  put('on the +x/+y edge', [0, 0, 0, 0.1], [3, 3, 0], [0, 2]);
  put('on the +x/+y/+z corner', [0, 0, 0, 0.1], [2, 2, 2], [0, 2, 4]);
  // Grazing the far plane (range 10) from beyond it, and grazing -x across the -z seam at a shallow angle.
  put('grazing the far plane', [0, 0, 0, 0.5], [0, 10.3, 0], [2]);
  put('grazing -x across the -z seam', [0, 0, 0, 0.25], [-4.2, 0, -4.5], [1, 5]);
  // Wholly inside one face, and wholly beyond the range.
  put('inside +z', [0, 0, 0, 0.5], [0, 0, 5], [4]);
  put('beyond the range', [0, 0, 0, 0.5], [0, 0, 11], []);
  const { missing, faces } = cullCheck(h, shadows, list);
  assert.deepEqual(missing, []);
  assert.deepEqual(
    faces,
    list.map((c) => c.expect),
  );
  shadows.dispose();
  lights.dispose();
});

test('local shadows: the per-map cull bounds sheared node matrices (rotated child of a non-uniformly scaled parent)', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    shadows = LocalShadows.attach(h.engine, { lights, maxLights: 1, resolution: 64 });
  lights.setLights([{ position: [0, 0, 0], range: 10, castShadow: true }]);
  // A parent rotation times a parent scale times a child rotation shears the child's axes: the longest column then
  // underestimates how far the sphere reaches (here 1.13 against 1.6 along x).
  const rotation = (a, b) => {
    const [ca, sa, cb, sb] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)];
    // About z by a, then about x by b; column-major 3x3.
    return [ca, sa * cb, sa * sb, -sa, ca * cb, ca * sb, 0, -sb, cb];
  };
  const mul = (a, b) => {
    const out = new Array(9).fill(0);
    for (let c = 0; c < 3; c++)
      for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) out[c * 3 + r] += a[k * 3 + r] * b[c * 3 + k];
    return out;
  };
  const list = [];
  const put = (label, outer, scale, inner, at) => {
    const m3 = mul(outer, mul([scale[0], 0, 0, 0, scale[1], 0, 0, 0, scale[2]], inner)),
      m = new Float32Array(16);
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] = m3[c * 3 + r];
    m.set(at, 12);
    m[15] = 1;
    const count = 3 * (list.length + 1),
      bounds = [0, 0, 0, 0.4],
      c = caster(h.engine, { bounds, count });
    c.shadowPrimitives[0].node.matrix.set(m);
    shadows.add(c);
    list.push({ caster: c, bounds, count, label });
  };
  const still = rotation(0, 0);
  // Stretched along x by 4 under a 45-degree child turn, 1.3 m beyond the range: its tip reaches 0.3 m inside +x.
  put('sheared, grazing the far plane', still, [4, 0.1, 1], rotation(Math.PI / 4, 0), [11.3, 0, 0]);
  // Seeded casters near the seams and the range, with their long axis in any direction.
  let seed = 12345;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  for (let i = 0; i < 120; i++) {
    const outer = rotation(Math.PI * rand(), Math.PI * rand()),
      inner = rotation(Math.PI * rand(), Math.PI * rand()),
      scale = [1 + 3 * Math.abs(rand()), 0.1 + 0.3 * Math.abs(rand()), 0.5 + Math.abs(rand())],
      d = 2 + 9 * Math.abs(rand());
    put(`sheared caster ${i}`, outer, scale, inner, [d, d * (1 + 0.5 * rand()), d * 0.5 * rand()]);
  }
  const { missing, faces } = cullCheck(h, shadows, list);
  assert.deepEqual(missing, []);
  assert.deepEqual(faces[0], [0]);
  shadows.dispose();
  lights.dispose();
});

test('local shadows: a point or spot shadow radius turns on PCSS; radius 0 uploads and compiles what plain lights do', () => {
  const h = harness(),
    begin = h.context.encoder.beginRenderPass,
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    shadows = LocalShadows.attach(h.engine, { lights, maxLights: 2, resolution: 64 }),
    point = { position: [0, 3, 0], range: 10, castShadow: true },
    spot = { position: [4, 3, 0], range: 10, direction: [0, -1, 0], outerAngle: 0.6, castShadow: true },
    frame = () => new Float32Array(shadows.bindings()[0].resource.buffer.data);
  h.context.encoder.beginRenderPass = (d) => ({ ...begin(d), setViewport() {} });
  shadows.add(caster(h.engine));
  try {
    for (const radius of [-1, Infinity, Number.NaN, '1', 1e40])
      assert.throws(() => lights.setLights([{ ...point, shadow: { radius } }]), RangeError, `radius ${String(radius)}`);
    assert.throws(() => lights.setLights([{ ...point, castShadow: false, shadow: { radius: 1 } }]), /castShadow/);
    lights.setLights([point, spot]);
    h.frame();
    const plain = frame().slice(),
      plainShader = h.context.shader;
    assert.ok(!plainShader.includes('clusterSoftShadow'));
    lights.setLights([
      { ...point, shadow: { radius: 0 } },
      { ...spot, shadow: { radius: 0 } },
    ]);
    shadows.invalidate();
    h.frame();
    assert.deepEqual(frame(), plain, 'radius 0 is the 3x3 filter, byte for byte');
    assert.equal(h.context.shader, plainShader);
    // A point light of radius 0.5 and a spot of radius 0.2 at a full-size (64) map.
    const soft = { ...point, shadow: { radius: 0.5, near: 0.1 } };
    lights.setLights([soft, { ...spot, shadow: { radius: 0.2 } }]);
    h.frame();
    assert.equal(h.passes.length, 7, 'a new radius re-renders both lights');
    assert.match(h.context.shader, /if\(localShadowFrame\.soft\[slot\*2u-2u\]\.x>0\)\{return clusterSoftShadow\(/);
    assert.match(h.context.shader, /fn clusterSoftShadow\(/);
    assert.match(h.context.shader, /soft:array<vec4f,32>/);
    const v = frame(),
      at = v.length - 16 * 8,
      tanSpot = Math.tan(0.6) * 1.25,
      guard = 0.1 - 1.5 / 64;
    assert.equal(v.length, at + 128, 'the frame grows by two vec4f per slot');
    const close = (a, b, name) => assert.ok(Math.abs(a - b) < 1e-5, `${name}: ${a} vs ${b}`);
    close(v[at], 0.5 / 2.5, 'point UV per unit at unit depth: R / (2 tan), tan 1.25');
    close(v[at + 1], 0.5 / 2.5, 'point y');
    close(v[at + 2], guard, 'guard band');
    close(v[at + 4], 0.1, 'near');
    close(v[at + 5], 10, 'far: the range');
    close(v[at + 6], 0.5, 'radius');
    close(v[at + 8], 0.2 / (2 * tanSpot), 'spot UV per unit at unit depth');
    close(v[6], 2.5 / 64, 'texel size per unit distance of the wider face');
    // The first cube face's sampling matrix: x row r / tan with tan 1.25 (a 45-degree face plus the guard band).
    const m = v.subarray(4 + 64, 4 + 64 + 16);
    close(Math.hypot(m[0], m[4], m[8]), 1 / 1.25, 'face tangent 1.25');
    h.frame();
    assert.equal(h.passes.length, 0, 'unchanged soft lights stay cached');
    // The radius is the one setLights took: mutating the caller's object changes nothing until setLights.
    soft.shadow.radius = 0;
    h.frame();
    assert.equal(h.passes.length, 0);
    assert.match(h.context.shader, /clusterSoftShadow/);
    // A smaller map: its corner's UVs less the two-texel margins.
    lights.setLights([{ ...point, shadow: { radius: 0.5, resolution: [32, 16] } }]);
    h.frame();
    const w = frame();
    close(w[at], (0.5 * 28) / 64 / 2.5, 'x of a 32-wide corner');
    close(w[at + 1], (0.5 * 12) / 64 / 2.5, 'y of a 16-high corner');
    close(w[at + 2], Math.max(((0.5 - (0.5 * 12) / 16 / 1.25) * 16) / 64 - 1.5 / 64, 1.5 / 64), 'guard of the corner');
    lights.setLights([point, spot]);
    shadows.invalidate();
    h.frame();
    assert.equal(h.context.shader, plainShader, 'back to radius 0: the original shader');
    assert.deepEqual(frame(), plain, 'and the original frame');
  } finally {
    shadows.dispose();
    lights.dispose();
  }
});

test('local shadows: a drawLocalShadow source (terrain) draws into every re-rendered layer in reversed depth', () => {
  const h = harness(),
    lights = Clustered.attach(h.engine, { grid: [2, 2, 2] }),
    shadows = LocalShadows.attach(h.engine, { lights, maxLights: 2, resolution: 64 });
  const point = { position: [0, 3, 0], range: 10, castShadow: true },
    spot = { position: [4, 3, 0], range: 10, direction: [0, -1, 0], outerAngle: 0.6, castShadow: true };
  lights.setLights([point, spot]);
  const calls = [];
  const hook = (into) => (d) => into.push({ layer: d.layer, matrix: Float32Array.from(d.matrix), pass: d.pass });
  const ground = { drawLocalShadow: hook(calls) };
  assert.throws(() => shadows.add({}), TypeError, 'a source needs primitives or a hook');
  const remove = shadows.add(ground);
  h.frame();
  assert.equal(h.passes.length, 7);
  assert.deepEqual(
    calls.map((c) => c.layer),
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.equal(new Set(calls.map((c) => c.pass)).size, 7, 'each call gets its layer pass');
  // The spot layer (6) looks down from y = 3: nearer points get greater depth, all inside 0..1.
  const m = calls[6].matrix;
  const clip = (p) => {
    const v = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
    return v[2] / v[3];
  };
  const near = clip([4, 2, 0]),
    far = clip([4, -5, 0]);
  assert.ok(near > far && near < 1 && far > 0, `reversed depth: ${near} > ${far}`);
  calls.length = 0;
  h.frame();
  assert.equal(h.passes.length, 7, 'without shadowVersion a hook source re-renders every frame');
  assert.equal(calls.length, 7);
  remove();
  h.frame();
  calls.length = 0;
  h.frame();
  assert.equal(h.passes.length, 0, 'removed: maps cache again');
  const versioned = [],
    hill = { drawLocalShadow: hook(versioned), shadowVersion: 1 };
  shadows.add(hill);
  h.frame();
  assert.equal(versioned.length, 7);
  h.frame();
  assert.equal(h.passes.length, 0, 'a versioned hook source caches');
  hill.shadowVersion = 2;
  h.frame();
  assert.equal(versioned.length, 14);
  // A hook draws after the source primitives in the same pass.
  const box = caster(h.engine),
    order = [];
  shadows.add(box);
  const passHook = { drawLocalShadow: () => order.push(h.drawn.length) };
  shadows.add(passHook);
  h.frame();
  assert.ok(order.length === 7 && order.every((n, i) => n === i + 1), 'primitives draw before hooks');
  hill.disposed = true;
  versioned.length = 0;
  h.frame();
  assert.equal(versioned.length, 0, 'a disposed hook source is dropped');
  shadows.dispose();
  lights.dispose();
});
