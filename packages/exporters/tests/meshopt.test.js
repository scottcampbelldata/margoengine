// compressMeshopt: every stream goes through the decoder @margoengine/decoders ships, which this encoder shares no code
// with, and the file through the Khronos validator's structure checks. gltfpack and gltf-transform read real files by hand
// (LIM row, docs/whitepaper/reproduce.md), so they are not repeated here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { meshoptDecodeGltfBuffer } from '@margoengine/decoders/meshopt';
import { exportGLB, joinGLB, readAccessor, splitGLB } from '@margoengine/exporters';
import { compressMeshopt, encodeTriangles, encodeVertexBuffer } from '@margoengine/exporters/meshopt';
import { encodePNG } from '@margoengine/exporters/capture';
import { compressTextures } from '@margoengine/exporters/ktx2';
import { validate } from './helpers.js';

const file = (path) => new Uint8Array(readFileSync(new URL(path, import.meta.url)));

const MESHOPT = 'EXT_meshopt_compression';

/** The file with every meshopt view decoded into a plain BIN chunk, so `readAccessor` reads it as any other GLB. */
function decodedParts(glb) {
  const parts = splitGLB(glb),
    { json, bin } = parts,
    chunks = [];
  let length = 0;
  json.bufferViews = json.bufferViews.map((view) => {
    const stream = view.extensions?.[MESHOPT],
      start = (stream ?? view).byteOffset ?? 0,
      source = bin.subarray(start, start + (stream ?? view).byteLength),
      data = stream
        ? meshoptDecodeGltfBuffer(source, stream.count, stream.byteStride, stream.mode, stream.filter ?? 'NONE')
        : source;
    length = (length + 3) & ~3;
    chunks.push([length, data]);
    const plain = { ...view, buffer: 0, byteOffset: length, byteLength: data.length };
    delete plain.extensions;
    length += data.length;
    return plain;
  });
  const flat = new Uint8Array(length);
  for (const [at, data] of chunks) flat.set(data, at);
  json.buffers = [{ byteLength: length }];
  return { json, bin: flat, chunks: [] };
}

/** The float value of a stored accessor element. */
const unpacked = ({ values, componentType, normalized }) => {
  if (!normalized) return Float64Array.from(values);
  const most = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[componentType];
  return Float64Array.from(values, (v) => Math.max(v / most, -1));
};

const multiply = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const local = ({ matrix, translation: t = [0, 0, 0], rotation: [x, y, z, w] = [0, 0, 0, 1], scale: s = [1, 1, 1] }) =>
  matrix ?? [
    s[0] * (1 - 2 * (y * y + z * z)),
    s[0] * 2 * (x * y + z * w),
    s[0] * 2 * (x * z - y * w),
    0,
    s[1] * 2 * (x * y - z * w),
    s[1] * (1 - 2 * (x * x + z * z)),
    s[1] * 2 * (y * z + x * w),
    0,
    s[2] * 2 * (x * z + y * w),
    s[2] * 2 * (y * z - x * w),
    s[2] * (1 - 2 * (x * x + y * y)),
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];

/** World position of every triangle corner of every drawn primitive, one row of `[x, y, z]` per corner, in draw order. */
function worldCorners(parts) {
  const { json } = parts,
    out = [],
    visit = (index, parent) => {
      const node = json.nodes[index],
        world = multiply(parent, local(node));
      for (const primitive of json.meshes[node.mesh]?.primitives ?? []) {
        const p = unpacked(readAccessor(parts, primitive.attributes.POSITION)),
          indices = readAccessor(parts, primitive.indices).values;
        for (const v of indices) {
          const [x, y, z] = p.subarray(v * 3, v * 3 + 3);
          out.push([0, 1, 2].map((r) => world[r] * x + world[4 + r] * y + world[8 + r] * z + world[12 + r]));
        }
      }
      for (const child of node.children ?? []) visit(child, world);
    },
    identity = local({});
  for (const index of json.scenes[json.scene ?? 0].nodes) visit(index, identity);
  return out;
}

const sorted = (rows) => rows.map((row) => row.join(' ')).sort();

const box = {
  positions: new Float32Array([0, 0, 0, 2, 0, 0, 2, 3, 0, 0, 3, 0, 0, 0, 4, 2, 0, 4]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0]),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0.25, 0.25, 0.75, 0.75]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 1, 5, 0, 5, 4]),
};
// Half the widest axis of `box`: its Z runs from 0 to 4.
const HALF = 2;

test('without quantizing, every stream decodes to the same triangles and only the extension is required', async () => {
  const source = exportGLB({ nodes: [{ translation: [1, 2, 3], geometry: box }] }),
    { glb, compressed, quantized, skipped } = await compressMeshopt(source, { quantize: false }),
    { json } = splitGLB(glb);
  assert.equal(quantized, 0);
  assert.deepEqual(skipped, []);
  assert.ok(compressed >= 4, 'POSITION, NORMAL, TEXCOORD_0 and the indices');
  assert.deepEqual(json.extensionsRequired, [MESHOPT]);
  assert.ok(!json.extensionsUsed.includes('KHR_mesh_quantization'));
  assert.deepEqual(sorted(worldCorners(decodedParts(glb))), sorted(worldCorners(splitGLB(source))));
  const primitive = json.meshes[0].primitives[0],
    position = json.accessors[primitive.attributes.POSITION];
  assert.deepEqual(position.min, [0, 0, 0], 'a POSITION accessor keeps its bounds');
  assert.deepEqual(position.max, [2, 3, 4]);
  assert.equal(json.bufferViews[position.bufferView].extensions[MESHOPT].mode, 'ATTRIBUTES');
  assert.equal(json.bufferViews[json.accessors[primitive.indices].bufferView].extensions[MESHOPT].mode, 'TRIANGLES');
});

test('the fallback buffer holds nothing and the BIN chunk only the streams', async () => {
  const source = exportGLB({ nodes: [{ geometry: box }] }),
    { glb } = await compressMeshopt(source),
    { json, bin } = splitGLB(glb),
    views = json.bufferViews,
    fallback = json.buffers[1];
  assert.deepEqual(fallback.extensions[MESHOPT], { fallback: true });
  assert.equal(fallback.uri, undefined);
  assert.equal(json.buffers.length, 2);
  for (const view of views) {
    assert.equal(view.buffer, 1, 'the views point at the fallback');
    const stream = view.extensions[MESHOPT];
    assert.equal(stream.buffer, 0);
    assert.ok(stream.byteOffset + stream.byteLength <= bin.length);
    assert.equal(stream.byteOffset % 4, 0);
    assert.ok(view.byteOffset + view.byteLength <= fallback.byteLength, 'inside the fallback');
    assert.equal(view.byteLength, stream.count * stream.byteStride);
  }
  assert.ok(json.buffers[0].byteLength <= bin.length && bin.length - json.buffers[0].byteLength < 4);
});

test('quantized vertices stay within half a step of their source, and the node undoes the grid', async () => {
  const source = exportGLB({
      nodes: [{ translation: [5, -1, 2], rotation: [0, 0.6, 0, 0.8], scale: [2, 2, 2], geometry: box }],
    }),
    { glb, quantized } = await compressMeshopt(source),
    parts = decodedParts(glb),
    { json } = parts,
    primitive = json.meshes[0].primitives[0],
    position = json.accessors[primitive.attributes.POSITION];
  assert.ok(quantized >= 3);
  assert.equal(position.componentType, 5122);
  assert.equal(position.normalized, true);
  assert.ok(json.extensionsRequired.includes('KHR_mesh_quantization'));
  // One grid step is HALF / 32767, half a step of rounding, times the node's scale of 2. Float32 stores the source's
  // coordinates exactly here, and the sum below runs in Float64, so 1e-9 covers what it adds.
  const bound = (2 * HALF) / 65534 + 1e-9,
    want = worldCorners(splitGLB(source)),
    got = worldCorners(parts);
  assert.equal(got.length, want.length);
  // Triangle order and vertex numbers change, so each corner finds its nearest source corner.
  for (const corner of got) {
    const nearest = Math.min(...want.map((w) => Math.max(...w.map((v, r) => Math.abs(v - corner[r])))));
    assert.ok(nearest <= bound, `${corner} is ${nearest} from its source, more than ${bound}`);
  }
});

test('normals, texture coordinates, colours and weights take the sizes the extension allows, within their steps', async () => {
  const colored = { ...box, colors: new Float32Array(24).map((_, i) => (i % 8) / 7) },
    source = exportGLB({ nodes: [{ geometry: colored }] }),
    { glb } = await compressMeshopt(source),
    parts = decodedParts(glb),
    attributes = parts.json.meshes[0].primitives[0].attributes,
    type = (name) => parts.json.accessors[attributes[name]].componentType;
  assert.equal(type('NORMAL'), 5120);
  assert.equal(type('TEXCOORD_0'), 5123);
  assert.equal(type('COLOR_0'), 5121);
  const normals = unpacked(readAccessor(parts, attributes.NORMAL));
  for (let v = 0; v < normals.length; v += 3) {
    // Each component rounds to the nearest 1/127, half a step away; this box's normals are axis vectors, which are exact.
    assert.equal(Math.hypot(normals[v], normals[v + 1], normals[v + 2]), 1);
  }
  const high = await compressMeshopt(source, { normalBits: 16 }),
    wide = decodedParts(high.glb);
  assert.equal(wide.json.accessors[wide.json.meshes[0].primitives[0].attributes.NORMAL].componentType, 5122);
});

test('texture coordinates outside 0 to 1 stay floats, because a normalized integer cannot hold them', async () => {
  const tiled = { ...box, uvs: box.uvs.map((v) => v * 3) },
    { glb } = await compressMeshopt(exportGLB({ nodes: [{ geometry: tiled }] })),
    parts = decodedParts(glb),
    uv = parts.json.meshes[0].primitives[0].attributes.TEXCOORD_0;
  assert.equal(parts.json.accessors[uv].componentType, 5126);
});

test('a node something else depends on keeps its transform: the grid moves to a child', async () => {
  const mover = { name: 'mover', geometry: box, translation: [1, 0, 0] },
    parent = {
      name: 'parent',
      geometry: box,
      translation: [0, 2, 0],
      children: [{ name: 'child', translation: [0, 0, 1] }],
    },
    source = exportGLB({
      nodes: [mover, parent],
      animations: [
        {
          channels: [
            { node: mover, path: 'translation', times: [0, 1], values: [1, 0, 0, 2, 0, 0], interpolation: 'LINEAR' },
          ],
        },
      ],
    }),
    { glb } = await compressMeshopt(source),
    parts = decodedParts(glb),
    { json } = parts,
    original = splitGLB(source).json,
    byName = (name) => json.nodes.find((node) => node.name === name);
  assert.deepEqual(byName('mover').translation, [1, 0, 0], 'the animation still drives what it drove');
  assert.equal(byName('mover').mesh, undefined);
  assert.equal(byName('mover').scale, undefined);
  assert.equal(byName('parent').mesh, undefined);
  assert.deepEqual(byName('parent').translation, [0, 2, 0], 'its child keeps its place');
  assert.equal(json.nodes.length, original.nodes.length + 2);
  assert.equal(json.animations[0].channels[0].target.node, json.nodes.indexOf(byName('mover')));
  const bound = HALF / 65534 + 1e-9,
    want = worldCorners(splitGLB(source)),
    got = worldCorners(parts);
  for (const corner of got) {
    const nearest = Math.min(...want.map((w) => Math.max(...w.map((v, r) => Math.abs(v - corner[r])))));
    assert.ok(nearest <= bound, `${corner} is ${nearest} from its source`);
  }
});

test('a node with a matrix takes the grid in its matrix, and a shared mesh in every node', async () => {
  const matrix = [0, 2, 0, 0, -2, 0, 0, 0, 0, 0, 2, 0, 7, 8, 9, 1],
    source = exportGLB({
      nodes: [
        { matrix, geometry: box },
        { translation: [4, 0, 0], geometry: box },
      ],
    }),
    { glb } = await compressMeshopt(source),
    parts = decodedParts(glb),
    { json } = parts;
  assert.equal(json.meshes.length, 1);
  assert.equal(json.nodes.filter((node) => node.mesh === 0).length, 2);
  const bound = (2 * HALF) / 65534 + 1e-9,
    want = worldCorners(splitGLB(source));
  for (const corner of worldCorners(parts)) {
    const nearest = Math.min(...want.map((w) => Math.max(...w.map((v, r) => Math.abs(v - corner[r])))));
    assert.ok(nearest <= bound, `${corner} is ${nearest} from its source`);
  }
});

test('a joint that draws a mesh keeps its transform, so the skin does not move', async () => {
  const joint = { name: 'joint', translation: [0, 1, 0], geometry: box },
    skinned = {
      ...box,
      joints: new Uint8Array(24),
      weights: new Float32Array(24).map((_, i) => (i % 4 === 0 ? 1 : 0)),
    },
    source = exportGLB({
      nodes: [
        joint,
        {
          name: 'body',
          geometry: skinned,
          skin: { joints: [joint], inverseBindMatrices: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
        },
      ],
    }),
    { glb } = await compressMeshopt(source),
    { json } = decodedParts(glb),
    node = json.nodes.find((n) => n.name === 'joint');
  assert.deepEqual(node.translation, [0, 1, 0]);
  assert.equal(node.scale, undefined);
  const body = json.meshes[json.nodes.find((n) => n.name === 'body').mesh].primitives[0];
  assert.equal(json.accessors[body.attributes.POSITION].componentType, 5126, 'a skin ignores its node, so no grid');
  assert.equal(json.accessors[body.attributes.NORMAL].componentType, 5120);
});

test('skin weights stay whole in 8 bits: the rounding goes on the largest', async () => {
  const third = 1 / 3,
    skinned = {
      ...box,
      joints: new Uint8Array(24),
      weights: new Float32Array(24).map((_, i) => (i % 4 === 3 ? 0 : third)),
    },
    joint = { name: 'joint' },
    source = exportGLB({
      nodes: [
        joint,
        {
          geometry: skinned,
          skin: { joints: [joint], inverseBindMatrices: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
        },
      ],
    }),
    { glb } = await compressMeshopt(source),
    parts = decodedParts(glb),
    mesh = parts.json.meshes[0].primitives[0],
    { values } = readAccessor(parts, mesh.attributes.WEIGHTS_0);
  for (let v = 0; v < values.length; v += 4)
    assert.equal(values[v] + values[v + 1] + values[v + 2] + values[v + 3], 255, 'a quantized weight set sums to one');
});

test('the rounding of a weight set lands on its largest weight, wherever that is', async () => {
  // 0.3, 0.4 and 0.3 round to 77, 102 and 77, one over 255, and the bound on a weight is largest for the largest.
  const skinned = {
      ...box,
      joints: new Uint8Array(24),
      weights: new Float32Array(24).map((_, i) => [0.3, 0.4, 0.3, 0][i % 4]),
    },
    joint = { name: 'joint' },
    { glb } = await compressMeshopt(
      exportGLB({
        nodes: [
          joint,
          {
            geometry: skinned,
            skin: { joints: [joint], inverseBindMatrices: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
          },
        ],
      }),
    ),
    parts = decodedParts(glb);
  assert.deepEqual(
    [...readAccessor(parts, parts.json.meshes[0].primitives[0].attributes.WEIGHTS_0).values.subarray(0, 4)],
    [77, 101, 77, 0],
  );
});

test('animation and inverse bind data ride as streams and read back exactly', async () => {
  const fox = file('../../../examples/assets/khronos/Fox/Fox.glb'),
    { glb } = await compressMeshopt(fox),
    parts = decodedParts(glb),
    before = splitGLB(fox);
  parts.json.animations.forEach((animation, a) =>
    animation.samplers.forEach((sampler, s) => {
      const old = before.json.animations[a].samplers[s];
      assert.deepEqual(readAccessor(parts, sampler.input).values, readAccessor(before, old.input).values);
      assert.deepEqual(readAccessor(parts, sampler.output).values, readAccessor(before, old.output).values);
    }),
  );
  assert.deepEqual(
    readAccessor(parts, parts.json.skins[0].inverseBindMatrices).values,
    readAccessor(before, before.json.skins[0].inverseBindMatrices).values,
  );
  assert.ok(glb.length < fox.length);
  const stored = splitGLB(glb).json;
  for (const sampler of stored.animations.flatMap((animation) => animation.samplers))
    for (const accessor of [sampler.input, sampler.output])
      assert.ok(stored.bufferViews[stored.accessors[accessor].bufferView].extensions?.[MESHOPT]);
  const report = await validate(joinGLB(parts));
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
});

test('morph targets keep floats and their streams follow the vertex order', async () => {
  const morphed = {
      ...box,
      morphs: [{ positions: new Float32Array(18).map((_, i) => i / 8), normals: new Float32Array(18) }],
    },
    source = exportGLB({ nodes: [{ geometry: morphed, morphWeights: [0.5] }] }),
    { glb, quantized } = await compressMeshopt(source),
    parts = decodedParts(glb),
    { json } = parts,
    primitive = json.meshes[0].primitives[0],
    base = readAccessor(parts, primitive.attributes.POSITION).values,
    delta = readAccessor(parts, primitive.targets[0].POSITION).values;
  assert.equal(quantized, 0);
  assert.ok(!(json.extensionsRequired ?? []).includes('KHR_mesh_quantization'));
  // Each source vertex has its own delta: vertex v moves by (3v, 3v + 1, 3v + 2) / 8.
  for (let v = 0; v < base.length / 3; v++) {
    const source_ = [...box.positions].findIndex(
      (_, i) => i % 3 === 0 && [0, 1, 2].every((k) => box.positions[i + k] === base[v * 3 + k]),
    );
    assert.deepEqual([...delta.subarray(v * 3, v * 3 + 3)], [source_ / 8, (source_ + 1) / 8, (source_ + 2) / 8]);
  }
});

test('triangles that repeat a vertex and vertices no triangle uses are gone', async () => {
  const messy = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 9, 9, 9]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 1, 1, 2]),
    },
    { glb } = await compressMeshopt(exportGLB({ nodes: [{ geometry: messy }] }), { quantize: false }),
    parts = decodedParts(glb),
    primitive = parts.json.meshes[0].primitives[0];
  assert.equal(readAccessor(parts, primitive.indices).count, 3);
  assert.equal(readAccessor(parts, primitive.attributes.POSITION).count, 3);
  assert.deepEqual(parts.json.accessors[primitive.attributes.POSITION].max, [1, 1, 0]);
});

test('images stay in the BIN chunk beside the streams', async () => {
  const image = await encodePNG({ width: 4, height: 4, data: new Uint8Array(64).fill(200) }),
    source = exportGLB({
      nodes: [{ geometry: box, material: { baseColorTexture: { image, mimeType: 'image/png' } } }],
    }),
    { glb } = await compressMeshopt(source),
    { json, bin } = splitGLB(glb),
    view = json.bufferViews[json.images[0].bufferView];
  assert.equal(view.extensions, undefined);
  assert.equal(view.buffer, 0);
  assert.deepEqual(bin.subarray(view.byteOffset, view.byteOffset + view.byteLength), image);
});

test('another pass on the file keeps its streams', async () => {
  const image = await encodePNG({ width: 4, height: 4, data: new Uint8Array(64).fill(200) }),
    source = exportGLB({
      nodes: [{ geometry: box, material: { baseColorTexture: { image, mimeType: 'image/png' } } }],
    }),
    { glb } = await compressMeshopt(source),
    { glb: both } = await compressTextures(glb),
    want = sorted(worldCorners(decodedParts(glb)));
  assert.deepEqual(sorted(worldCorners(decodedParts(both))), want);
});

test('a file that has other buffers keeps them in place', async () => {
  const parts = splitGLB(exportGLB({ nodes: [{ geometry: box }] }));
  parts.json.buffers.push({ uri: 'more.bin', byteLength: 4 });
  parts.json.bufferViews.push({ buffer: 1, byteLength: 4 });
  parts.json.images = [{ bufferView: parts.json.bufferViews.length - 1, mimeType: 'image/png' }];
  const { glb } = await compressMeshopt(joinGLB(parts)),
    { json } = splitGLB(glb),
    outside = json.bufferViews[json.images[0].bufferView];
  assert.equal(json.buffers[outside.buffer].uri, 'more.bin');
  assert.equal(json.buffers.length, 3);
  for (const view of json.bufferViews)
    if (view.extensions) assert.equal(json.buffers[view.buffer].extensions[MESHOPT].fallback, true);
});

test('a file with no vertex data comes back as it was', async () => {
  const source = exportGLB({ nodes: [{ name: 'empty' }] }),
    result = await compressMeshopt(source);
  assert.equal(result.glb, source);
  assert.equal(result.compressed, 0);
});

test('a Draco primitive is named in the report and its mesh stays as it was', async () => {
  const { compressDraco } = await import('@margoengine/exporters/draco'),
    { glb: draco } = await compressDraco(exportGLB({ nodes: [{ geometry: box }] })),
    { glb, skipped } = await compressMeshopt(draco),
    { json } = splitGLB(glb);
  assert.deepEqual(skipped, [{ mesh: 0, primitive: 0, reason: 'draco' }]);
  assert.ok(json.meshes[0].primitives[0].extensions.KHR_draco_mesh_compression);
});

test('options and inputs it cannot take are refused, and a signal stops it', async () => {
  const source = exportGLB({ nodes: [{ geometry: box }] }),
    { glb } = await compressMeshopt(source);
  await assert.rejects(compressMeshopt(glb), /already compressed/);
  await assert.rejects(compressMeshopt(source, { normalBits: 12 }), RangeError);
  await assert.rejects(compressMeshopt(new Uint8Array(8)), TypeError);
  const stop = new AbortController();
  stop.abort(new Error('stopped'));
  await assert.rejects(compressMeshopt(source, { signal: stop.signal }), /stopped/);
});

test('the streams decode with encodeVertexBuffer and encodeTriangles used on their own', () => {
  const data = Uint8Array.from({ length: 64 }, (_, i) => i * 3),
    stream = encodeVertexBuffer(data, 16, 4);
  assert.deepEqual(meshoptDecodeGltfBuffer(stream, 16, 4, 'ATTRIBUTES', 'NONE'), data);
  const { bytes, indices } = encodeTriangles([0, 1, 2, 2, 1, 3], 4),
    decoded = new Uint32Array(meshoptDecodeGltfBuffer(bytes, 6, 4, 'TRIANGLES', 'NONE').buffer);
  // The codec may rotate a triangle, and it says how in `indices`.
  assert.deepEqual([...decoded], [...indices]);
});
