// attribute(): named per-vertex values of a mesh in node materials. The pixels are checked on a real GPU by
// attribute-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { beginDraw, endDraw } from '../../shared/frame-resources.js';
import { NodeMaterial, attribute, positionLocal, storage, uniform, vec3 } from '../dist/index.js';

const { pbrShader } = await import('../../gltf/src/shader.ts');

globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8, COPY_SRC: 4, STORAGE: 128, VERTEX: 32, INDIRECT: 256 };
const device = () => {
  const made = [],
    writes = [];
  return {
    made,
    writes,
    createBuffer(d) {
      const buffer = { ...d, destroyed: false, destroy: () => (buffer.destroyed = true) };
      made.push(buffer);
      return buffer;
    },
    createBindGroupLayout: (d) => d,
    queue: {
      writeBuffer: (buffer, offset, data, from = 0, count) => {
        if (buffer.label !== 'shader:storage') return;
        const words = new Uint32Array(data.buffer, data.byteOffset + from * 4, count ?? data.length - from);
        writes.push({ buffer, offset, words: [...words] });
      },
    },
  };
};
// The program's entries alone: a material's own bindings make default textures, which need a real device.
const storageOf = (material, gpu, data) =>
  material.program
    .entries(gpu, { width: 1, height: 1, meshData: data })
    .find((e) => e.resource.buffer.label === 'shader:storage').resource.buffer;
const geometry = (attributes, vertices = 4) => ({
  positions: new Float32Array(vertices * 3),
  normals: new Float32Array(vertices * 3),
  attributes,
});
const heat = { data: [1, 2, 3, 4], type: 'f32' },
  flow = { data: [0, -1, 2, -3, 4, -5, 6, -7], type: 'vec2i' },
  floats = (...v) => [...new Uint32Array(new Float32Array(v).buffer)];

test('attribute() reads one storage buffer by vertex index in the vertex stage and a varying in the fragment', () => {
  const m = new NodeMaterial({
      emissiveNode: vec3(attribute('heat', 'f32'), attribute('flow', 'vec2i').y.toFloat(), 0),
      positionNode: positionLocal.add(vec3(0, attribute('heat', 'f32'), 0)),
      positionNormals: 'keep',
    }),
    code = m.shader(pbrShader, 2);
  assert.equal(code.split('var<storage, read> ndat').length, 2, 'one binding for every attribute');
  assert.match(code, /const ndat0Stride:u32=3u;/);
  assert.match(m.vertexCode, /bitcast<f32>\(ndat0\[[\w.]+\*ndat0Stride\+ndat0_heat\]\)/);
  assert.match(m.vertexCode, /vec2i\(bitcast<i32>\(ndat0\[[^\]]+\]\),bitcast<i32>\(ndat0\[[^\]]+\+1u\]\)\)/);
  assert.doesNotMatch(m.fragmentCode, /ndat0/, 'the fragment stage reads interpolated values');
  assert.match(code, /@interpolate\(flat\) ndv\d:vec2i/, 'integers take the first vertex');
});

test('a mesh gets its own interleaved buffer, written whole and then by range, and released with it', () => {
  const m = new NodeMaterial({
      emissiveNode: vec3(attribute('heat', 'f32'), attribute('flow', 'vec2i').x.toFloat(), 0),
    }),
    gpu = device(),
    data = m.meshData(geometry({ heat, flow })),
    binding = () => storageOf(m, gpu, data);
  const buffer = binding(),
    words = () => gpu.writes.filter((w) => w.buffer === buffer);
  const order = words()[0].words.length;
  assert.equal(order, 12, 'three words a vertex');
  // heat then flow, vertex after vertex (the order the graph first reads them).
  assert.deepEqual(words()[0].words.slice(3, 6), [...floats(2), 2, 4294967293]);
  assert.equal(binding(), buffer);
  assert.equal(words().length, 1, 'a steady mesh uploads once');
  data.prepare(geometry({ heat: { data: [9, 8, 7, 6], type: 'f32' }, flow }), { start: 1, count: 2 })();
  assert.deepEqual(
    words()[1],
    { buffer, offset: 12, words: [...floats(8), 2, 4294967293, ...floats(7), 4, 4294967291] },
    'only the two vertices of the range',
  );
  data.prepare(
    geometry({ heat: { data: [1, 2, 3, 4, 5], type: 'f32' }, flow: { data: new Int32Array(10), type: 'vec2i' } }, 5),
  )();
  const grown = binding();
  assert.notEqual(grown, buffer, 'a new vertex count takes a new buffer');
  assert.equal(buffer.destroyed, true);
  data.dispose();
  assert.equal(grown.destroyed, true);
});

// Regression (2026-11-28, KB1867b): the loaders give extra per-vertex scalars as bare arrays (`attributes: {intensity:
// Float32Array}`, LoadedGeometry), while MeshGeometry took only {data, type}: the loaders README's COLLADA example failed
// its type check, and a node material reading such a channel threw. A bare array is one f32 per vertex.
test('a bare per-vertex array, as the loaders give it, is read as one f32 a vertex', () => {
  const m = new NodeMaterial({ emissiveNode: vec3(attribute('intensity', 'f32'), 0, 0) }),
    gpu = device(),
    data = m.meshData(geometry({ intensity: new Float32Array([0.5, 1, 1.5, 2]) }));
  const buffer = storageOf(m, gpu, data);
  assert.deepEqual(gpu.writes.find((w) => w.buffer === buffer).words, floats(0.5, 1, 1.5, 2));
  data.dispose();
  const wide = new NodeMaterial({ emissiveNode: vec3(attribute('intensity', 'vec2f').x, 0, 0) });
  assert.throws(
    () => wide.meshData(geometry({ intensity: [1, 2, 3, 4] })),
    /attribute 'intensity' is f32, and its material reads it as vec2f/,
  );
});

test('meshes share the material and its depth pipeline key, each with its own depth record and buffer', () => {
  const m = new NodeMaterial({ positionNode: positionLocal.add(vec3(0, attribute('heat', 'f32'), 0)) }),
    gpu = device(),
    a = m.meshData(geometry({ heat })),
    b = m.meshData(geometry({ heat: { data: [5, 6, 7, 8], type: 'f32' } })),
    first = m.caster(gpu, undefined, undefined, a),
    second = m.caster(gpu, undefined, undefined, b);
  assert.notEqual(first, second);
  assert.equal(first, m.caster(gpu, undefined, undefined, a), 'kept while the mesh draws it');
  assert.equal(first.key, second.key, 'one shadow pipeline for the material');
  const buffers = [first, second].map((r) => r.entries().find((e) => e.resource.buffer.label === 'shader:storage'));
  assert.notEqual(buffers[0].resource.buffer, buffers[1].resource.buffer);
});

test('a depth pass whose move reads no attribute binds none', () => {
  const m = new NodeMaterial({
      emissiveNode: vec3(attribute('heat', 'f32'), 0, 0),
      positionNode: positionLocal.add(vec3(0, uniform(1), 0)),
    }),
    record = m.caster(device(), undefined, undefined, m.meshData(geometry({ heat })));
  assert.equal(record.entries().length, 1, 'the uniform block alone');
  assert.equal(record.layout().entries.length, 1);
});

test('attribute() and the geometry it reads are checked, naming the fix', () => {
  assert.throws(() => attribute('two words', 'f32'), /letters, digits and underscores/);
  assert.throws(() => attribute('a', 'vec3'), /not one to four of f32, i32 or u32/);
  assert.throws(() => attribute('a', 'mat4x4f'), /not one to four/);
  assert.throws(
    () => new NodeMaterial({ emissiveNode: vec3(attribute('a', 'f32'), attribute('a', 'u32').toFloat(), 0) }),
    /read as f32 and as u32|read as u32 and as f32/,
  );
  const m = new NodeMaterial({ emissiveNode: vec3(attribute('flow', 'vec2i').x.toFloat(), 0, 0) });
  assert.throws(
    () => m.meshData(geometry(undefined)),
    /no attribute 'flow'.*attributes: \{flow: \{data, type: 'vec2i'\}\}/,
  );
  assert.throws(
    () => m.meshData(geometry({ flow: { ...flow, type: 'vec2u' } })),
    /is vec2u, and its material reads it as vec2i/,
  );
  assert.throws(
    () => m.meshData(geometry({ flow: { data: [1, 2], type: 'vec2i' } })),
    /needs 8 values \(4 vertices of vec2i\), not 2/,
  );
  for (const bad of [0.5, 2147483648, Number.NaN])
    assert.throws(
      () => m.meshData(geometry({ flow: { data: [bad, 0, 0, 0, 0, 0, 0, 0], type: 'vec2i' } })),
      /whole numbers that fit i32/,
    );
  const data = m.meshData(geometry({ flow })),
    gpu = device();
  assert.ok(storageOf(m, gpu, data));
  assert.throws(() => data.prepare(geometry({}), { start: 0, count: 1 }), /no attribute 'flow'/);
  assert.throws(() => m.program.entries(gpu, { width: 1, height: 1 }), {
    code: 'state',
    message: /mesh from createMesh/,
  });
  assert.equal(new NodeMaterial({ emissiveNode: vec3(1, 0, 0) }).meshData(geometry()), undefined);
});

test('StorageBuffer.update with a range writes those elements alone and checks them', () => {
  const buffer = storage(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]), 'vec2f'),
    gpu = device();
  buffer.buffer(gpu);
  buffer.data.set([30, 40], 2);
  buffer.update({ start: 1, count: 1 });
  assert.deepEqual(gpu.writes.at(-1).words, floats(30, 40));
  assert.equal(gpu.writes.at(-1).offset, 8);
  buffer.buffer(gpu);
  assert.equal(gpu.writes.length, 2, 'no whole upload follows');
  for (const range of [
    { start: 4, count: 1 },
    { start: -1, count: 1 },
    { start: 0, count: 0 },
  ])
    assert.throws(() => buffer.update(range), RangeError);
});

test('a buffer released while a draw is recording is destroyed after that frame', async () => {
  const buffer = storage(new Uint32Array(4), 'u32'),
    gpu = device(),
    made = buffer.buffer(gpu);
  beginDraw(gpu, {});
  buffer.dispose();
  assert.equal(made.destroyed, false, 'the unsubmitted commands may still bind it');
  endDraw(gpu);
  await null;
  assert.equal(made.destroyed, true);
});
