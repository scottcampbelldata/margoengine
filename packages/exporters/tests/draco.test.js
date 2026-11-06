// compressDraco: real files through Google's own Draco decoder (the Wasm @margoengine/decoders ships) and the Khronos
// validator. The two tools are not ours, so a stream either of them refuses fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { exportGLB, joinGLB, readAccessor, splitGLB } from '@margoengine/exporters';
import { compressDraco } from '@margoengine/exporters/draco';
import { decodeDraco } from '../../decoders/dist/codec.js';
import { validate } from './helpers.js';

// Emscripten's wrappers take their Node path from these two globals.
globalThis.require ??= createRequire(import.meta.url);
globalThis.__dirname ??= fileURLToPath(new URL('.', import.meta.url));
const file = (path) => new Uint8Array(readFileSync(new URL(path, import.meta.url))),
  decoderDist = '../../decoders/dist/draco/';
(0, eval)(readFileSync(new URL(decoderDist + 'draco_wasm_wrapper.js', import.meta.url), 'utf8'));
const { module: google } = await new Promise((resolve, reject) => {
  globalThis
    .DracoDecoderModule({ wasmBinary: file(decoderDist + 'draco_decoder.wasm') })
    .then((module) => resolve({ module }), reject);
});

/** One primitive's stream through Google's decoder, with the attributes keyed by semantic. */
function decoded(glb, primitive) {
  const { json, bin } = splitGLB(glb),
    extension = primitive.extensions.KHR_draco_mesh_compression,
    view = json.bufferViews[extension.bufferView],
    stream = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength),
    componentTypes = Object.fromEntries(
      Object.entries(primitive.attributes).map(([name, id]) => [name, json.accessors[id].componentType]),
    );
  return decodeDraco(google, stream, { attributeIds: extension.attributes, componentTypes });
}

const primitives = (glb) => splitGLB(glb).json.meshes.flatMap((mesh) => mesh.primitives);
const attribute = (result, name) => ({
  array: name === 'POSITION' ? result.positions : name === 'NORMAL' ? result.normals : result.attributes[name].array,
});

/** Corners of every triangle as `key(vertex)`, sorted inside each triangle and across them. */
const triangles = (indices, key) => {
  const out = [];
  for (let i = 0; i + 2 < indices.length; i += 3)
    out.push([key(indices[i]), key(indices[i + 1]), key(indices[i + 2])].sort().join('|'));
  return out.sort();
};

/** Grid level of each axis of a vertex, on the grid the file's defaults give: 2^14 - 1 steps across the widest axis. */
const levels = (values, origin, range) => (vertex) =>
  [0, 1, 2].map((axis) => Math.round(((values[vertex * 3 + axis] - origin[axis]) * (2 ** 14 - 1)) / range)).join(',');

const quad = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

test('Box.glb keeps every triangle on its grid and passes the Khronos validator', async () => {
  const source = file('./fixtures/Box.glb'),
    parts = splitGLB(source),
    original = parts.json.meshes[0].primitives[0],
    { glb, compressed, skipped } = await compressDraco(source);
  assert.equal(compressed, 1);
  assert.deepEqual(skipped, []);
  const report = await validate(glb);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
  assert.equal(report.warnings, 0, JSON.stringify(report.messages));

  const { json } = splitGLB(glb),
    primitive = json.meshes[0].primitives[0],
    result = decoded(glb, primitive),
    position = readAccessor(parts, original.attributes.POSITION).values,
    indices = readAccessor(parts, original.indices).values,
    min = parts.json.accessors[original.attributes.POSITION].min,
    max = parts.json.accessors[original.attributes.POSITION].max,
    range = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  assert.deepEqual(json.extensionsRequired, ['KHR_draco_mesh_compression']);
  const out = attribute(result, 'POSITION').array;
  assert.deepEqual(
    triangles(result.indices, levels(out, min, range)),
    triangles(indices, levels(position, min, range)),
    'every triangle of the input is in the stream, on the grid',
  );

  // Normals: an octahedron cell of 10 bits has a half step h = 1 / 1023 per axis. The point before normalizing moves
  // at most h * sqrt(6) (x, y and |x| + |y|), and normalizing a vector of length at least 1 / sqrt(3) multiplies a move
  // by at most sqrt(3), so a stored normal lies within h * sqrt(18) of the input, plus float rounding.
  const bound = (Math.sqrt(18) / 1023) * (1 + 1e-5),
    inputNormals = readAccessor(parts, original.attributes.NORMAL).values,
    normals = attribute(result, 'NORMAL').array;
  for (let v = 0; v < normals.length; v += 3) {
    let best = Infinity;
    for (let w = 0; w < inputNormals.length; w += 3)
      best = Math.min(
        best,
        Math.hypot(
          normals[v] - inputNormals[w],
          normals[v + 1] - inputNormals[w + 1],
          normals[v + 2] - inputNormals[w + 2],
        ),
      );
    assert.ok(best <= bound, `normal ${v / 3} is ${best} from every input normal, past ${bound}`);
  }
});

test('accessors match the stream: counts, index type and the bounds of the decoded positions', async () => {
  const { glb } = await compressDraco(file('../../../examples/assets/khronos/Fox/Fox.glb'));
  const { json } = splitGLB(glb);
  for (const primitive of primitives(glb)) {
    const result = decoded(glb, primitive),
      position = json.accessors[primitive.attributes.POSITION],
      values = attribute(result, 'POSITION').array;
    assert.equal(position.count, values.length / 3);
    assert.equal(position.bufferView, undefined);
    assert.equal(json.accessors[primitive.indices].count, result.indices.length);
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    values.forEach((value, i) => {
      min[i % 3] = Math.min(min[i % 3], value);
      max[i % 3] = Math.max(max[i % 3], value);
    });
    assert.deepEqual(position.min, min, 'min is what a decoder gets, to the last bit');
    assert.deepEqual(position.max, max, 'max is what a decoder gets, to the last bit');
  }
});

test('a skinned real model keeps exact joints and weights, its skin and its animations, and gets smaller', async () => {
  const source = file('../../../examples/assets/khronos/Fox/Fox.glb'),
    parts = splitGLB(source),
    original = parts.json.meshes[0].primitives[0],
    { glb } = await compressDraco(source),
    report = await validate(glb);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
  assert.ok(glb.length < source.length, `${glb.length} is under ${source.length}`);
  const { json } = splitGLB(glb),
    after = splitGLB(glb);
  assert.equal(json.animations.length, parts.json.animations.length);
  assert.equal(json.skins.length, parts.json.skins.length);
  for (const [a, b] of parts.json.animations.flatMap((animation, i) =>
    animation.samplers.map((sampler, s) => [sampler, json.animations[i].samplers[s]]),
  )) {
    assert.deepEqual(readAccessor(after, b.output).values, readAccessor(parts, a.output).values);
    assert.deepEqual(readAccessor(after, b.input).values, readAccessor(parts, a.input).values);
  }
  const result = decoded(glb, json.meshes[0].primitives[0]),
    joints = readAccessor(parts, original.attributes.JOINTS_0).values,
    weights = readAccessor(parts, original.attributes.WEIGHTS_0).values,
    sort = (values, width) => {
      const rows = [];
      for (let i = 0; i < values.length; i += width) rows.push([...values.subarray(i, i + width)].join(','));
      return [...new Set(rows)].sort();
    };
  assert.deepEqual(sort(attribute(result, 'JOINTS_0').array, 4), sort(joints, 4));
  assert.deepEqual(sort(attribute(result, 'WEIGHTS_0').array, 4), sort(weights, 4));
});

test('the primitives of a mesh share one grid, so a seam stays closed', async () => {
  // Alone, each primitive would take a grid of its own size and round the shared corner differently.
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    small = { positions: new Float32Array([0.1, 0.1, 0, 0.13, 0.1, 0, 0.13, 0.13, 0]), normals, indices: [0, 1, 2] },
    large = { positions: new Float32Array([0.13, 0.13, 0, 700, 0.1, 0, 700, 700, 0]), normals, indices: [0, 1, 2] },
    { json, bin } = splitGLB(
      exportGLB({
        nodes: [
          {
            primitives: [
              { geometry: small, material: { color: [1, 0, 0, 1] } },
              { geometry: large, material: { color: [0, 1, 0, 1] } },
            ],
          },
        ],
      }),
    ),
    { glb } = await compressDraco(joinGLB({ json, bin, chunks: [] }), { positionBits: 10 }),
    [a, b] = primitives(glb).map((primitive) => attribute(decoded(glb, primitive), 'POSITION').array),
    corner = (values, x) => {
      for (let i = 0; i < values.length; i += 3) if (Math.abs(values[i] - x) < 1) return [...values.subarray(i, i + 3)];
    };
  assert.deepEqual(corner(a, 0.13).slice(0, 2), corner(b, 0.13).slice(0, 2));
});

test('a mesh too small for a grid given as text takes full precision from the grids Draco works out', async () => {
  // Draco keeps an explicit grid as text with six decimals, so it could not span a mesh of a few hundredths of a micron:
  // the range would be a millionth, fifty times the mesh. Each primitive takes the grid Draco works out by itself.
  const size = 2e-8,
    normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    make = (x) => ({
      positions: new Float32Array([x, 0, 0, x + size, 0, 0, x + size, size, 0]),
      normals,
      indices: [0, 1, 2],
    }),
    { glb } = await compressDraco(
      exportGLB({ nodes: [{ primitives: [{ geometry: make(0) }, { geometry: make(size) }] }] }),
    ),
    { json } = splitGLB(glb);
  for (const primitive of json.meshes[0].primitives) {
    const values = attribute(decoded(glb, primitive), 'POSITION').array,
      xs = values.filter((_, i) => i % 3 === 0),
      accessor = json.accessors[primitive.attributes.POSITION],
      width = Math.max(...xs) - Math.min(...xs);
    // Quantizing each end moves it at most half a step of size / (2^14 - 1). The float steps here are near 1e-15.
    assert.ok(Math.abs(width - size) <= size / (2 ** 14 - 1), `the triangle is ${width} wide, not ${size}`);
    assert.equal(accessor.min[0], Math.min(...xs));
    assert.equal(accessor.max[0], Math.max(...xs));
  }
});

test('a mesh of several primitives keeps exact bounds on the grid they share', async () => {
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    make = (x) => ({
      positions: new Float32Array([x, 0.1234567, -7.654321, x + 3.3, 0.1234567, -7.654321, x + 3.3, 5.5, 1]),
      normals,
      indices: [0, 1, 2],
    }),
    { glb } = await compressDraco(
      exportGLB({ nodes: [{ primitives: [{ geometry: make(1.1111111) }, { geometry: make(2.2222222) }] }] }),
    ),
    { json } = splitGLB(glb);
  for (const primitive of json.meshes[0].primitives) {
    const values = attribute(decoded(glb, primitive), 'POSITION').array,
      accessor = json.accessors[primitive.attributes.POSITION];
    for (let axis = 0; axis < 3; axis++) {
      const column = values.filter((_, i) => i % 3 === axis);
      assert.equal(accessor.min[axis], Math.min(...column));
      assert.equal(accessor.max[axis], Math.max(...column));
    }
  }
});

test('primitives that share vertices with other indices stay whole; equal ones share one stream', async () => {
  const parts = splitGLB(
      exportGLB({
        nodes: [{ primitives: [{ geometry: quad }, { geometry: quad, material: { color: [1, 0, 0, 1] } }] }],
      }),
    ),
    twice = parts.json.meshes[0].primitives;
  assert.equal(twice.length, 2);
  twice[1].attributes = { ...twice[0].attributes };
  twice[1].indices = twice[0].indices;
  const equal = await compressDraco(joinGLB(parts)),
    [first, second] = primitives(equal.glb);
  assert.equal(equal.compressed, 2);
  assert.equal(
    first.extensions.KHR_draco_mesh_compression.bufferView,
    second.extensions.KHR_draco_mesh_compression.bufferView,
  );
  assert.equal((await validate(equal.glb)).errors, 0);

  // Two primitives over one POSITION accessor: each stream holds only the vertices its triangles use.
  const split = splitGLB(exportGLB({ nodes: [{ geometry: quad }] })),
    primitive = split.json.meshes[0].primitives[0],
    indices = split.json.accessors[primitive.indices],
    second2 = {
      ...indices,
      byteOffset: (indices.byteOffset ?? 0) + 3 * (indices.componentType === 5125 ? 4 : 2),
      count: 3,
    };
  indices.count = 3;
  split.json.accessors.push(second2);
  split.json.meshes[0].primitives.push({ ...primitive, indices: split.json.accessors.length - 1 });
  const { glb } = await compressDraco(joinGLB(split)),
    report = await validate(glb);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
  const [a, b] = primitives(glb);
  assert.notEqual(a.attributes.POSITION, b.attributes.POSITION, 'each stream has its own accessor');
  for (const one of [a, b]) {
    const result = decoded(glb, one);
    assert.equal(result.indices.length, 3);
    assert.equal(attribute(result, 'POSITION').array.length, 9);
  }
});

test('morph targets, points and lines stay as they were, and so does an accessor they share', async () => {
  const source = file('../../../examples/assets/khronos/MorphStressTest/MorphStressTest.glb'),
    morphs = await compressDraco(source);
  assert.ok(morphs.skipped.some(({ reason }) => reason === 'morph-targets'));
  assert.equal((await validate(morphs.glb)).errors, 0);

  const parts = splitGLB(exportGLB({ nodes: [{ geometry: quad }] })),
    primitive = parts.json.meshes[0].primitives[0];
  parts.json.meshes[0].primitives.push({ attributes: { POSITION: primitive.attributes.POSITION }, mode: 0 });
  const { glb, compressed, skipped } = await compressDraco(joinGLB(parts)),
    report = await validate(glb);
  assert.equal(compressed, 1);
  assert.deepEqual(skipped, [{ mesh: 0, primitive: 1, reason: 'not-triangles' }]);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
  const after = splitGLB(glb),
    points = after.json.meshes[0].primitives[1];
  assert.deepEqual(
    readAccessor(after, points.attributes.POSITION).values,
    quad.positions,
    'the points keep their data',
  );
});

test('images and everything else in the file survive the repacking of the BIN chunk', async () => {
  const source = file('./fixtures/BoxTextured.glb'),
    before = splitGLB(source),
    imageBytes = ({ json, bin }) => {
      const view = json.bufferViews[json.images[0].bufferView],
        start = view.byteOffset ?? 0;
      return bin.subarray(start, start + view.byteLength);
    },
    { glb } = await compressDraco(source),
    after = splitGLB(glb),
    report = await validate(glb);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
  assert.deepEqual(imageBytes(after), imageBytes(before));
  assert.deepEqual(after.json.materials, before.json.materials);
  assert.deepEqual(after.json.nodes, before.json.nodes);
});

test('a compressed file comes back unchanged, and meshopt buffers and bad options are refused', async () => {
  const { glb } = await compressDraco(file('./fixtures/Box.glb')),
    again = await compressDraco(glb);
  assert.equal(again.glb, glb);
  assert.equal(again.compressed, 0);
  assert.equal(again.skipped[0].reason, 'already-compressed');

  const parts = splitGLB(file('./fixtures/Box.glb'));
  parts.json.bufferViews[0].extensions = {
    EXT_meshopt_compression: { buffer: 0, byteLength: 4, count: 1, byteStride: 4, mode: 'ATTRIBUTES' },
  };
  await assert.rejects(compressDraco(joinGLB(parts)), /meshopt/);
  await assert.rejects(compressDraco(file('./fixtures/Box.glb'), { positionBits: 31 }), RangeError);
  await assert.rejects(compressDraco(file('./fixtures/Box.glb'), { encodeSpeed: -1 }), RangeError);
  await assert.rejects(compressDraco(file('./fixtures/Box.glb'), { signal: AbortSignal.abort() }), /aborted/i);
});

test('positionBits 0 keeps positions exact', async () => {
  const { glb } = await compressDraco(exportGLB({ nodes: [{ geometry: quad }] }), { positionBits: 0 }),
    values = attribute(decoded(glb, primitives(glb)[0]), 'POSITION').array,
    sorted = (list) => [...list].sort((a, b) => a - b);
  assert.deepEqual(sorted(values), sorted(quad.positions));
});

test('the entry stands alone: not in the package root, and no writer or Wasm is imported with it', async () => {
  const root = await import('@margoengine/exporters');
  assert.equal('compressDraco' in root, false);
  const entry = readFileSync(new URL('../dist/draco.js', import.meta.url), 'utf8');
  assert.doesNotMatch(entry, /from ['"]\.\/(?:index|gltf|scene|model)\.js['"]/);
});
