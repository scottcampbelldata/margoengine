// instanceAttributes() on a mock device: the values and their checks, dirty-range uploads, the shader a plugin composes
// to read them, the shadow and TAA caster, disposal, a device restore, serialization and the cullers that must leave
// these instances in place. instance-attributes-browser.mjs checks the rendered pixels on WebGPU and the WebGL2 layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { shadowDepth } from '../../shadows/src/shader.ts';
import { objectVelocity } from '../../taa/src/shader.ts';
import { displacedDepth } from '../../shared/displacement.js';
import { instancedDepth, readsRows } from '../../shared/instances.js';
import { PbrMaterial, Texture, createInstancedMesh, createMesh } from '../dist/index.js';
import { materialPlugin, materialPluginCodec } from '../dist/plugins.js';
import { instanceAttributes, instanceAttributesCodec } from '../dist/instance-attributes.js';
import { captureMaterialLibrary, restoreMaterialLibrary } from '../dist/serialization.js';

const triangle = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] };
const link = /margoengine\.com\/errors#instance-attributes/;
/** A device that logs every upload as {offset, values} (offset in floats). */
function recording() {
  const { device } = mockGPU(),
    writes = [];
  device.queue.writeBuffer = (_buffer, offset, data, start = 0, count = data.length - start) =>
    writes.push({ offset: offset / 4, values: Array.from(data.subarray(start, start + count)) });
  return { device, writes };
}
/** One frame of a mesh of `material` on a mock device: the beauty shader and every shader of the frame. */
async function drawn(material, count) {
  const gpu = mockGPU(),
    store = await TransformStore.create(64),
    renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    renderer,
    { position: [0, 0, 6], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(4 / 3, true);
  const view = context(gpu, { samples: 1, format: 'bgra8unorm', depthFormat: 'depth32float', shader: wgsl });
  const mesh = count ? createInstancedMesh(engine, triangle, material, count) : createMesh(engine, triangle, material);
  const frame = gpu.record(() => {
    store.tick(false);
    view.begin(0);
    engine.frameGraph.execute(view.c);
  });
  const code = frame.flatMap((e) => (e[0] === 'module' ? [e[2].code] : [])).find((c) => c.includes('fn surface('));
  return { code, frame, mesh, gpu, engine };
}
const swarm = (data, extra = {}) =>
  materialPlugin({
    name: 'swarm',
    instanceAttributes: data,
    vertex: 'position += swarm_offset;',
    light: 'color += vec3f(swarm_glow);',
    ...extra,
  });
const attributes = (capacity = 4) =>
  instanceAttributes(capacity, { glow: 'f32', offset: { type: 'vec3f', default: [0, 0.5, 0] } });

test('capacity, names, types, defaults and every setter are checked with coded messages', () => {
  const bad = (make, type = TypeError) => assert.throws(make, (e) => e instanceof type && link.test(e.message));
  for (const capacity of [0, -1, 1.5, 1_000_001, Number.NaN, '4'])
    bad(() => instanceAttributes(capacity, { a: 'f32' }), RangeError);
  bad(() => instanceAttributes(1, {}), RangeError);
  bad(() => instanceAttributes(1), RangeError);
  bad(
    () => instanceAttributes(1, Object.fromEntries(Array.from({ length: 17 }, (_, k) => ['a' + k, 'f32']))),
    RangeError,
  );
  for (const name of ['', '1a', 'a_b', 'a b']) bad(() => instanceAttributes(1, { [name]: 'f32' }));
  bad(() => instanceAttributes(1, { a: 'u32' }));
  bad(() => instanceAttributes(1, { a: null }));
  bad(() => instanceAttributes(1, { a: { type: 'vec2f', default: [1] } }));
  bad(() => instanceAttributes(1, { a: { type: 'f32', default: Infinity } }));

  const data = instanceAttributes(3, {
    f: 'f32',
    two: 'vec2f',
    three: { type: 'vec3f', default: [1, 2, 3] },
    four: 'vec4f',
    tint: 'color',
    basis: 'mat3x3f',
    pose: { type: 'mat4x4f' },
    // Any attribute name works: the WGSL name carries the plugin's prefix.
    color: { type: 'color', default: '#000000' },
  });
  assert.equal(data.capacity, 3);
  assert.deepEqual(data.types, {
    f: 'f32',
    two: 'vec2f',
    three: 'vec3f',
    four: 'vec4f',
    tint: 'color',
    basis: 'mat3x3f',
    pose: 'mat4x4f',
    color: 'color',
  });
  assert.equal(data.get('f', 2), 0);
  assert.deepEqual(Array.from(data.get('three', 2)), [1, 2, 3]);
  assert.deepEqual(Array.from(data.get('tint', 0)), [1, 1, 1]);
  assert.deepEqual(Array.from(data.get('color', 0)), [0, 0, 0]);
  assert.deepEqual(Array.from(data.get('basis', 1)), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(Array.from(data.get('pose', 1)), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  data
    .set('f', 1, 2.5)
    .set('two', 0, [4, 5])
    .set('tint', 2, '#ff0000')
    .set('four', 1, new Float32Array([1, 2, 3, 4]));
  assert.equal(data.get('f', 1), 2.5);
  assert.deepEqual(Array.from(data.get('tint', 2)), [1, 0, 0]);
  const out = [0, 0];
  assert.equal(data.get('two', 0, out), out);
  assert.deepEqual(out, [4, 5]);
  data.set('tint', 0, [0.25, 0.5, 2]);
  assert.deepEqual(Array.from(data.get('tint', 0)), [0.25, 0.5, 2]);

  bad(() => data.set('nope', 0, 1));
  bad(() => data.get('nope', 0));
  bad(() => data.array('nope'));
  bad(() => data.reset('nope'));
  for (const row of [-1, 3, 0.5]) bad(() => data.set('f', row, 1), RangeError);
  bad(() => data.set('f', 0, [1]));
  bad(() => data.set('f', 0, Number.NaN));
  bad(() => data.set('f', 0, 1e39));
  bad(() => data.set('two', 0, 1));
  bad(() => data.set('two', 0, [1, 2, 3]));
  bad(() => data.set('two', 0, [7, '8']));
  assert.deepEqual(Array.from(data.get('two', 0)), [4, 5], 'a refused row writes nothing');

  data.setBuffer('two', [1, 2, 3, 4], 1);
  assert.deepEqual(Array.from(data.array('two')), [4, 5, 1, 2, 3, 4]);
  data.setBuffer('f', new Float32Array([7, 8, 9]));
  assert.equal(data.get('f', 2), 9);
  data.setBuffer('f', []);
  bad(() => data.setBuffer('two', [1, 2, 3]));
  bad(() => data.setBuffer('two', [1, 2, 3, 4], 2), RangeError);
  bad(() => data.setBuffer('two', [1, 2, 3, 4], -1), RangeError);
  bad(() => data.setBuffer('two', [9, 9, 9, Infinity]), RangeError);
  assert.deepEqual(Array.from(data.array('two')), [4, 5, 1, 2, 3, 4], 'a refused buffer writes nothing');
  assert.equal(data.array('two'), data.array('two'), 'one live view per attribute');
  assert.equal(data.array('two').length, 6);
  bad(() => data.update('two', 2, 2), RangeError);
  bad(() => data.update(undefined, 4), RangeError);

  data.reset('two', 1);
  assert.deepEqual(Array.from(data.array('two')), [4, 5, 0, 0, 3, 4]);
  data.reset('three').set('three', 0, [9, 9, 9]).reset();
  assert.deepEqual(Array.from(data.array('three')), [1, 2, 3, 1, 2, 3, 1, 2, 3]);
  assert.equal(data.get('f', 2), 0);
});

test('uploads are the rows that changed, per attribute; a steady frame uploads nothing', () => {
  const { device, writes } = recording(),
    data = attributes(),
    entry = data.entry(device, 309);
  // One buffer: each attribute a block of capacity rows and its default row.
  assert.equal(writes.length, 1);
  assert.equal(writes[0].offset, 0);
  assert.deepEqual(writes[0].values, [0, 0, 0, 0, 0, ...Array(5).fill([0, 0.5, 0]).flat()]);
  assert.equal(entry.binding, 309);
  assert.equal(data.entry(device, 309), entry, 'a steady draw allocates no entry');
  assert.equal(writes.length, 1);
  data.set('glow', 2, 3);
  data.entry(device, 309);
  assert.deepEqual(writes.slice(1), [{ offset: 2, values: [3] }]);
  // Two edits of one attribute upload one range; another attribute uploads its own.
  data.set('offset', 1, [1, 1, 1]).set('offset', 3, [2, 2, 2]).set('glow', 0, 1);
  data.entry(device, 309);
  assert.deepEqual(writes.slice(2), [
    { offset: 0, values: [1] },
    { offset: 8, values: [1, 1, 1, 0, 0.5, 0, 2, 2, 2] },
  ]);
  // In place: write the view, then say which rows.
  data.array('glow')[1] = 6;
  data.entry(device, 309);
  assert.equal(writes.length, 4, 'a direct write waits for update()');
  data.update('glow', 1, 1);
  data.entry(device, 309);
  assert.deepEqual(writes.at(-1), { offset: 1, values: [6] });
  data.update();
  data.entry(device, 309);
  assert.deepEqual(
    writes.slice(5).map((w) => [w.offset, w.values.length]),
    [
      [0, 4],
      [5, 12],
    ],
  );
  data.reset('glow', 1);
  data.entry(device, 309);
  assert.deepEqual(writes.at(-1), { offset: 1, values: [0] });
});

test('a second device gets the current values, a lost device is forgotten, the device limit is checked', async () => {
  const a = recording(),
    b = recording(),
    data = attributes();
  let lose;
  a.device.lost = new Promise((done) => (lose = done));
  const first = data.entry(a.device, 309).resource.buffer;
  data.set('glow', 0, 4);
  const second = data.entry(b.device, 309).resource.buffer;
  assert.notEqual(first, second);
  assert.equal(b.writes[0].values[0], 4);
  data.entry(a.device, 309);
  assert.deepEqual(a.writes.at(-1), { offset: 0, values: [4] }, 'the first device still gets its dirty row');
  lose();
  await a.device.lost;
  assert.notEqual(data.entry(a.device, 309).resource.buffer, first);
  const small = recording();
  small.device.limits.maxStorageBufferBindingSize = 32;
  assert.throws(
    () => data.entry(small.device, 309),
    (e) => e instanceof RangeError && link.test(e.message),
  );
});

test('the last detach frees the buffers, values stay; dispose ends the object', () => {
  const { device } = mockGPU(),
    data = attributes(),
    p = swarm(data),
    other = materialPlugin({ name: 'more', instanceAttributes: data, light: 'color *= more_glow + 1.0;' }),
    a = new PbrMaterial({ features: [p] }),
    b = new PbrMaterial({ features: [other] });
  assert.equal(p.instanceAttributes, data);
  assert.equal(p.instanceRows, true);
  assert.equal(materialPlugin({ name: 'a', light: 'x' }).instanceRows, false);
  data.set('glow', 0, 5);
  const buffer = p.bindings(device, {}, a)[0].resource.buffer;
  assert.deepEqual(
    p.bindings(device, {}, a).map((e) => e.binding),
    [309],
  );
  let destroyed = 0;
  const destroy = buffer.destroy.bind(buffer);
  buffer.destroy = () => (destroyed++, destroy());
  a.features = [];
  assert.equal(destroyed, 0, 'another plugin still reads it');
  b.features = [];
  assert.equal(destroyed, 1);
  assert.equal(data.get('glow', 0), 5);
  a.features = [p];
  assert.notEqual(p.bindings(device, {}, a)[0].resource.buffer, buffer);
  data.dispose();
  data[Symbol.dispose]?.();
  const disposed = (e) => e.code === 'disposed' && link.test(e.message);
  assert.throws(() => data.set('glow', 0, 1), disposed);
  assert.throws(() => data.array('glow'), disposed);
  assert.throws(() => data.reset(), disposed);
  assert.throws(() => p.bindings(device, {}, a), disposed);
  assert.throws(() => (new PbrMaterial({ features: [swarm(data)] }), 0), disposed);
});

test('plugin options are checked', () => {
  assert.throws(
    () => materialPlugin({ name: 'a', light: 'x', instanceAttributes: {} }),
    /instanceAttributes must come/,
  );
  const mask = new Texture({ data: new Uint8Array(4), width: 1, height: 1 });
  for (const name of ['mask', 'maskSampler'])
    assert.throws(
      () =>
        materialPlugin({
          name: 'a',
          light: 'x',
          textures: { mask },
          instanceAttributes: instanceAttributes(1, { [name]: 'f32' }),
        }),
      /a texture's or the PBR shader's name/,
    );
  mask.dispose();
  // `mat_baseMap` is one of this package's own textures.
  assert.throws(
    () => materialPlugin({ name: 'mat', light: 'x', instanceAttributes: instanceAttributes(1, { baseMap: 'f32' }) }),
    /reads as 'mat_baseMap'/,
  );
});

test('the colour pass loads the row in the vertex stage and, through a flat varying, in the fragment stage', async () => {
  const data = instanceAttributes(4, { glow: 'f32', offset: 'vec3f', basis: 'mat3x3f' }),
    { code, engine, frame } = await drawn(new PbrMaterial({ features: [swarm(data)] }), 4);
  try {
    assert.match(code, /@group\(2\) @binding\(309\) var<storage,read> margoInstanceData_swarm:array<f32>;/);
    assert.match(
      code,
      /var<private> swarm_glow:f32;\nvar<private> swarm_offset:vec3f;\nvar<private> swarm_basis:mat3x3f;/,
    );
    assert.match(code, /fn margoInstanceLoad_swarm\(row:u32\)\{let k=min\(row,4u\);/);
    assert.match(code, /swarm_glow=margoInstanceData_swarm\[0u\+k\*1u\];/);
    assert.match(code, /swarm_offset=vec3f\(margoInstanceData_swarm\[5u\+k\*3u\],/);
    assert.match(code, /swarm_basis=mat3x3f\(margoInstanceData_swarm\[20u\+k\*9u\],/);
    assert.match(code, /struct Input \{[^}]*@builtin\(instance_index\) ndInstance:u32/);
    assert.match(code, /margoInstanceLoad_swarm\(i\.ndInstance\);margoPV=margoPlugin_swarm_vertex/);
    assert.match(code, /@location\(6\) @interpolate\(flat\) margoRow:u32/);
    assert.match(code, /o\.margoRow=i\.ndInstance;return o;/);
    assert.match(code, /fn surface\(i:Out,front:bool\)->Surface \{margoInstanceLoad_swarm\(i\.margoRow\);/);
    assert.equal(code.match(/@builtin\(instance_index\)/g).length, 1);
    const group = frame.find((e) => e[0] === 'group' && e[2].entries.some((x) => x.binding === 309));
    assert.ok(group, 'the material group binds the instance buffer');
  } finally {
    engine.dispose();
  }
});

test('vertex-only attributes take no varying; fragment-only ones add no vertex move', async () => {
  const only = await drawn(
    new PbrMaterial({
      features: [
        materialPlugin({ name: 'swarm', instanceAttributes: attributes(), vertex: 'position += swarm_offset;' }),
      ],
    }),
    2,
  );
  assert.doesNotMatch(only.code, /margoRow:u32|margoInstanceLoad_swarm\(i\.margoRow\)/);
  assert.match(only.code, /_=f\.model;/);
  only.engine.dispose();
  const lit = await drawn(
    new PbrMaterial({
      features: [materialPlugin({ name: 'swarm', instanceAttributes: attributes(), light: 'color *= swarm_glow;' })],
    }),
    2,
  );
  assert.doesNotMatch(lit.code, /MargoPluginVertex/);
  assert.match(lit.code, /margoInstanceLoad_swarm\(i\.margoRow\);/);
  assert.equal(lit.mesh.primitives[0].material.displacement, undefined);
  lit.engine.dispose();
});

test('shadow casters and TAA velocity load the same row before the same vertex chain', async () => {
  const data = attributes(),
    { mesh, engine, gpu } = await drawn(new PbrMaterial({ features: [swarm(data)] }), 3);
  try {
    const record = mesh.primitives[0].material.displacement,
      depth = instancedDepth(displacedDepth(shadowDepth(true), 1, record));
    assert.match(depth, /@vertex fn vertex\(@builtin\(instance_index\) margoRow:u32,/);
    assert.match(depth, /margoInstanceLoad_swarm\(margoRow\);margoPV=margoPlugin_swarm_vertex/);
    assert.match(depth, /@group\(1\) @binding\(309\) var<storage,read> margoInstanceData_swarm/);
    assert.deepEqual(
      record.entries().map((e) => e.binding),
      [309],
    );
    const layout = gpu.record(() => record.layout()).find((e) => e[0] === 'layout');
    assert.deepEqual(layout[2].entries, [{ binding: 309, buffer: { type: 'read-only-storage' }, visibility: 3 }]);
    const velocity = objectVelocity(true, false, false, false, true, false, record.velocity);
    assert.match(velocity, /@vertex fn vertex\(@builtin\(instance_index\) margoRow:u32,i:Input/);
    assert.match(velocity, /margoInstanceLoad_swarm\(margoRow\);margoPV=margoPlugin_swarm_vertex/);
  } finally {
    engine.dispose();
  }
});

test('a plugin taken off and put back casts through its new buffers', async () => {
  // The caster record binds the plugin's buffers, which the last detach destroys: keeping the record would hand a
  // shadow pass a destroyed buffer. Uniforms were affected as well as instance attributes.
  const material = new PbrMaterial({
      features: [materialPlugin({ name: 'a', uniforms: { k: 1 }, vertex: 'position *= a.k;' })],
    }),
    [plugin] = material.features,
    { mesh, engine } = await drawn(material);
  try {
    const before = mesh.primitives[0].material.displacement,
      buffer = before.entries()[0].resource.buffer;
    material.features = [];
    material.features = [plugin];
    const after = mesh.primitives[0].material.displacement;
    assert.notEqual(after, before, 'a new record, so a shadow pass binds again');
    assert.notEqual(after.entries()[0].resource.buffer, buffer);
  } finally {
    engine.dispose();
  }
});

test('GPU cullers and sorters leave these instances in their rows', async () => {
  const material = new PbrMaterial({ features: [swarm(attributes())] }),
    { mesh, engine } = await drawn(material, 2);
  try {
    const [primitive] = mesh.primitives;
    assert.equal(primitive.material.shading.instanceRows, true);
    assert.equal(readsRows(primitive), true);
    material.features = [materialPlugin({ name: 'a', light: 'color *= 0.5;' })];
    assert.equal(readsRows(primitive), false);
    assert.equal(readsRows({}), false);
  } finally {
    engine.dispose();
  }
});

test('a saved material restores its instance attributes through the codecs', async () => {
  const data = instanceAttributes(3, { glow: { type: 'f32', default: 2 }, tint: 'color' });
  data.set('glow', 1, 7).set('tint', 2, [0, 0.5, 1]);
  const codecs = [materialPluginCodec, instanceAttributesCodec],
    library = await captureMaterialLibrary(
      {
        swarm: new PbrMaterial({
          features: [materialPlugin({ name: 'a', instanceAttributes: data, light: 'color *= a_glow;' })],
        }),
      },
      { codecs },
    ),
    [restored] = (await restoreMaterialLibrary(JSON.parse(JSON.stringify(library)), { codecs })).swarm.features,
    copy = restored.instanceAttributes;
  assert.notEqual(copy, data);
  assert.deepEqual(copy.types, data.types);
  assert.deepEqual(Array.from(copy.array('glow')), [2, 7, 2]);
  assert.deepEqual(Array.from(copy.get('tint', 2)), [0, 0.5, 1]);
  assert.equal(copy.reset('glow').get('glow', 1), 2, 'the default travels');
  await assert.rejects(
    captureMaterialLibrary(
      { swarm: new PbrMaterial({ features: [materialPlugin({ name: 'a', instanceAttributes: data, light: 'x' })] }) },
      { codecs: [materialPluginCodec] },
    ),
    'without the codec the values are not saved in silence',
  );
});
