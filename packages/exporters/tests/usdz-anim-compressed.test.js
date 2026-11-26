// exportAnimatedUSDZ on GLBs that require meshopt or Draco: the USDZ is byte for byte the one the same file writes
// uncompressed. The uncompressed references are made here, not by the code under test: the Khronos sample's own fallback
// buffer, and Google's Draco decoder (the Wasm @margoengine/decoders ships), which shares no code with the native one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { meshoptDecodeGltfBuffer } from '@margoengine/decoders/meshopt';
import { joinGLB, splitGLB } from '@margoengine/exporters';
import { compressDraco } from '@margoengine/exporters/draco';
import { compressMeshopt } from '@margoengine/exporters/meshopt';
import { exportAnimatedUSDZ } from '@margoengine/exporters/usdz-anim';
import { decodeDraco } from '../../decoders/dist/codec.js';

// Emscripten's wrappers take their Node path from these two globals.
globalThis.require ??= createRequire(import.meta.url);
globalThis.__dirname ??= fileURLToPath(new URL('.', import.meta.url));
const file = (path) => new Uint8Array(readFileSync(new URL(path, import.meta.url))),
  asset = (path) => file(`../../../examples/${path}`),
  decoderDist = '../../decoders/dist/draco/';
(0, eval)(readFileSync(new URL(decoderDist + 'draco_wasm_wrapper.js', import.meta.url), 'utf8'));
const { module: google } = await new Promise((resolve, reject) => {
  globalThis
    .DracoDecoderModule({
      wasmBinary: file(decoderDist + 'draco_decoder.wasm'),
    })
    .then((module) => resolve({ module }), reject);
});

const align = (n) => (n + 3) & ~3;
const same = (actual, expected) =>
  assert.ok(Buffer.from(actual).equals(Buffer.from(expected)), 'the USDZ bytes differ');

/** Byte blocks joined on 4-byte boundaries, with where each starts. */
function pack(blocks) {
  const at = [];
  let length = 0;
  for (const block of blocks) {
    at.push(align(length));
    length = at.at(-1) + block.length;
  }
  const bin = new Uint8Array(length);
  blocks.forEach((block, i) => bin.set(block, at[i]));
  return { bin, at };
}

/** The GLB with a one second turn and rise of its first node added, for a real file that has no clip. */
function withClip(glb) {
  const { json, bin } = splitGLB(glb),
    half = Math.SQRT1_2,
    blocks = [
      bin,
      new Uint8Array(new Float32Array([0, 1]).buffer),
      new Uint8Array(new Float32Array([0, 0, 0, 1, 0, half, 0, half]).buffer),
    ],
    packed = pack(blocks),
    view = json.bufferViews.length,
    accessor = json.accessors.length;
  json.bufferViews.push(
    { buffer: 0, byteOffset: packed.at[1], byteLength: 8 },
    { buffer: 0, byteOffset: packed.at[2], byteLength: 32 },
  );
  json.accessors.push(
    {
      bufferView: view,
      componentType: 5126,
      count: 2,
      type: 'SCALAR',
      min: [0],
      max: [1],
    },
    { bufferView: view + 1, componentType: 5126, count: 2, type: 'VEC4' },
  );
  json.animations = [
    {
      name: 'Turn',
      samplers: [{ input: accessor, output: accessor + 1 }],
      channels: [
        {
          sampler: 0,
          target: {
            node: json.scenes[json.scene ?? 0].nodes[0],
            path: 'rotation',
          },
        },
      ],
    },
  ];
  json.buffers = [{ byteLength: packed.bin.length }];
  return joinGLB({ json, bin: packed.bin });
}

const ARRAYS = {
  5121: Uint8Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};

/** The file with each Draco primitive decoded by Google's decoder into ordinary accessors. */
function byGoogle(glb) {
  const { json, bin } = splitGLB(glb),
    blocks = [bin];
  const store = (accessor, values, componentType) => {
    const def = json.accessors[accessor];
    def.bufferView = json.bufferViews.length;
    def.componentType = componentType;
    def.byteOffset = 0;
    json.bufferViews.push({
      buffer: 0,
      block: blocks.length,
      byteLength: values.byteLength,
    });
    blocks.push(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
  };
  for (const primitive of json.meshes.flatMap((mesh) => mesh.primitives)) {
    const extension = primitive.extensions.KHR_draco_mesh_compression,
      view = json.bufferViews[extension.bufferView],
      start = view.byteOffset ?? 0,
      componentTypes = Object.fromEntries(
        Object.entries(primitive.attributes).map(([name, id]) => [name, json.accessors[id].componentType]),
      ),
      result = decodeDraco(google, bin.subarray(start, start + view.byteLength), {
        attributeIds: extension.attributes,
        componentTypes,
      }),
      fields = {
        POSITION: result.positions,
        NORMAL: result.normals,
        TEXCOORD_0: result.uvs,
        COLOR_0: result.colors,
      };
    for (const name of Object.keys(extension.attributes)) {
      const type = name === 'COLOR_0' ? 5126 : componentTypes[name],
        values = fields[name] ?? result.attributes[name].array;
      store(primitive.attributes[name], new ARRAYS[type](values), type);
      json.accessors[primitive.attributes[name]].count = result.vertexCount;
    }
    primitive.indices ??= json.accessors.push({ type: 'SCALAR' }) - 1;
    store(primitive.indices, result.indices, result.indices.BYTES_PER_ELEMENT === 2 ? 5123 : 5125);
    json.accessors[primitive.indices].count = result.indices.length;
    delete primitive.extensions;
  }
  const packed = pack(blocks);
  for (const view of json.bufferViews)
    if (view.block !== undefined) {
      view.byteOffset = packed.at[view.block];
      delete view.block;
    }
  json.buffers = [{ byteLength: packed.bin.length }];
  delete json.extensionsRequired;
  delete json.extensionsUsed;
  return joinGLB({ json, bin: packed.bin });
}

test('a Draco Fox writes the USDZ of the file Google’s decoder gives, skin and clip included', async () => {
  const { glb, compressed } = await compressDraco(asset('assets/khronos/Fox/Fox.glb'));
  assert.equal(compressed, 1);
  assert.ok(splitGLB(glb).json.extensionsRequired.includes('KHR_draco_mesh_compression'));
  for (const clip of ['Survey', 'Run']) {
    const actual = await exportAnimatedUSDZ(glb, { clip }),
      expected = await exportAnimatedUSDZ(byGoogle(glb), { clip });
    same(actual.usdz, expected.usdz);
    assert.deepEqual(actual.size, expected.size);
  }
});

test('a Draco file from Blender’s exporter writes the USDZ of its decoded self', async () => {
  const source = withClip(asset('orrery/orrery.glb'));
  const actual = await exportAnimatedUSDZ(source, { fps: 4 }),
    expected = await exportAnimatedUSDZ(byGoogle(source), { fps: 4 });
  same(actual.usdz, expected.usdz);
  assert.equal(actual.frames, 5);
});

/**
 * The triangle codec may turn a triangle's corners round (same face, same winding), so the fallback's triangles are turned
 * the same way here, after checking that each one is such a turn of the fallback's.
 */
function rotated({ byteOffset = 0, byteLength, count, byteStride }, main, fallback) {
  const stream = main.subarray(byteOffset, byteOffset + byteLength),
    out = meshoptDecodeGltfBuffer(stream, count, byteStride, 'TRIANGLES'),
    Index = byteStride === 2 ? Uint16Array : Uint32Array,
    got = new Index(out.buffer, 0, count),
    want = new Index(fallback.slice().buffer);
  for (let i = 0; i < count; i += 3) {
    const corners = [...want.subarray(i, i + 3)],
      turns = [0, 1, 2].map((k) => [0, 1, 2].map((c) => corners[(c + k) % 3]).join());
    assert.ok(turns.includes(got.subarray(i, i + 3).join()), `triangle ${i / 3} is not the fallback's`);
  }
  fallback.set(out);
}

/** The Khronos MeshoptCubeTest as two GLBs: its meshopt streams required, and its published uncompressed fallback. */
function cubeTest() {
  const folder = 'assets/khronos/MeshoptCubeTest/',
    // Its checker textures are files beside the glTF, which a GLB reader skips, on both sides alike.
    json = () => JSON.parse(new TextDecoder().decode(asset(`${folder}MeshoptCubeTest.gltf`))),
    main = asset(`${folder}MeshoptCubeTest.bin`),
    fallback = asset(`${folder}MeshoptCubeTestFallback.bin`);
  const compressed = json();
  delete compressed.buffers[0].uri;
  delete compressed.buffers[1].uri;
  compressed.extensionsRequired.push('KHR_meshopt_compression');
  const plain = json(),
    packed = pack([main, fallback]);
  for (const view of plain.bufferViews) {
    const stream = view.extensions?.KHR_meshopt_compression,
      at = (view.byteOffset ?? 0) + packed.at[view.buffer];
    if (stream?.mode === 'TRIANGLES') rotated(stream, main, packed.bin.subarray(at, at + view.byteLength));
    view.byteOffset = at;
    view.buffer = 0;
    delete view.extensions;
  }
  plain.buffers = [{ byteLength: packed.bin.length }];
  return {
    compressed: joinGLB({ json: compressed, bin: main }),
    plain: joinGLB({ json: plain, bin: packed.bin }),
  };
}

test('the Khronos KHR_meshopt_compression sample writes the USDZ its fallback buffer writes', async () => {
  const { compressed, plain } = cubeTest();
  same((await exportAnimatedUSDZ(compressed)).usdz, (await exportAnimatedUSDZ(plain)).usdz);
});

/** Every meshopt view decoded in place, as `meshopt.test.js` reads a file. */
function unpacked(glb) {
  const { json, bin } = splitGLB(glb),
    blocks = json.bufferViews.map((view) => {
      const stream = view.extensions?.EXT_meshopt_compression,
        from = stream ?? view,
        bytes = bin.subarray(from.byteOffset ?? 0, (from.byteOffset ?? 0) + from.byteLength);
      return stream
        ? meshoptDecodeGltfBuffer(bytes, stream.count, stream.byteStride, stream.mode, stream.filter ?? 'NONE')
        : bytes;
    }),
    packed = pack(blocks);
  json.bufferViews.forEach((view, i) => {
    view.buffer = 0;
    view.byteOffset = packed.at[i];
    delete view.extensions;
  });
  json.buffers = [{ byteLength: packed.bin.length }];
  json.extensionsRequired = json.extensionsRequired.filter((name) => name !== 'EXT_meshopt_compression');
  return joinGLB({ json, bin: packed.bin });
}

test('EXT_meshopt_compression files write the USDZ of their unpacked selves', async () => {
  const fox = (await compressMeshopt(asset('assets/khronos/Fox/Fox.glb'))).glb;
  // A skinned, quantized character as margo-convert wrote it.
  for (const source of [fox, asset('assets/boulder-robot.glb')]) {
    assert.ok(splitGLB(source).json.extensionsRequired.includes('EXT_meshopt_compression'));
    same((await exportAnimatedUSDZ(source)).usdz, (await exportAnimatedUSDZ(unpacked(source))).usdz);
  }
});

/** `glb` with one change to its JSON. */
function changed(glb, edit) {
  const parts = splitGLB(glb);
  edit(parts.json);
  return joinGLB(parts);
}

test('a broken compressed block or an abort is refused', async () => {
  const meshopt = asset('assets/boulder-robot.glb'),
    stream = (json) => json.bufferViews.find((v) => v.extensions).extensions.EXT_meshopt_compression,
    draco = (await compressDraco(asset('assets/khronos/Fox/Fox.glb'))).glb,
    primitive = (json) => json.meshes[0].primitives[0];
  for (const [source, edit, expected] of [
    [meshopt, (json) => stream(json).count++, /does not match its decoded size/],
    [meshopt, (json) => (stream(json).byteOffset = 1e9), /runs past the BIN chunk/],
    [meshopt, (json) => (stream(json).buffer = 1), /outside the GLB BIN chunk/],
    [draco, (json) => (primitive(json).mode = 5), /triangle lists/],
    [draco, (json) => (primitive(json).extensions.KHR_draco_mesh_compression.bufferView = 999), /buffer view outside/],
    [draco, (json) => json.accessors[primitive(json).attributes.POSITION].count--, /Draco/],
    [draco, (json) => delete primitive(json).extensions.KHR_draco_mesh_compression.attributes.POSITION, /POSITION/],
  ])
    await assert.rejects(exportAnimatedUSDZ(changed(source, edit)), expected);
  const stop = new AbortController(),
    pending = exportAnimatedUSDZ(draco, { signal: stop.signal });
  stop.abort(new Error('stop'));
  await assert.rejects(pending, /stop/);
});
