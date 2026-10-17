// Launch gate 11a, part 1: one regression per parser fuzz finding (scripts/fuzz/targets-formats.js, `npm run fuzz`;
// results in HANDOFF gate 11). Each input once crashed a parser with an engine-internal error (TypeError: Cannot read
// properties..., SyntaxError, RangeError: Invalid typed array length, Maximum call stack size exceeded, a DOMException
// or a Wasm trap), hung, read outside its input or allocated far more than its size allows. Each must now end in the
// package's own error, judged by the fuzzer's own oracle (isNamed). Fuzz-found binary inputs are in tests/fixtures/fuzz/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isNamed } from '../scripts/fuzz/harness.js';
import { headless, margoWithScene, toGLB } from '../scripts/fuzz/formats.js';
import { fakeJPEG, ultraSeeds, wasm } from '../scripts/fuzz/targets-formats.js';
import { parseGLTF as parseLight } from '../packages/gltf/dist/index.js';
import { parseGLTFAsync } from '../packages/gltf-pro/dist/index.js';
import { prepareGLTF } from '../packages/gltf-pro/dist/prepare.js';
import { modelFromPrepared } from '../packages/gltf-pro/dist/worker.js';
import { instancing } from '../packages/gltf-pro/dist/instancing.js';
import { parseMargo } from '../packages/blender/dist/index.js';
import { decodeMeshoptBuffer } from '../packages/decoders/dist/index.js';
import { decodeDraco, isDecoderCrash, transcodeKTX2 } from '../packages/decoders/dist/codec.js';
import { parseEXR, parseHDR, decodeUltraHDR } from '../packages/environment/dist/index.js';
import { transferables } from '../packages/shared/worker.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`fixtures/fuzz/${name}`, import.meta.url)));
const kernel = await headless(); // createImageBitmap stubbed as in the fuzzer
const encode = (text) => new TextEncoder().encode(text);
// The loaders' own message that quotes the JSON parser's detail (the error position), as the fuzzer's targets declare.
const OWN = { own: /^Invalid glTF JSON: / };

/** Asserts `run` throws (or rejects with) a deliberate package error whose `name: message` matches `pattern`. */
async function named(run, pattern) {
  let error;
  try {
    await run();
  } catch (e) {
    error = e;
  }
  assert.ok(error, 'expected an error');
  assert.ok(isNamed(error, OWN), `not a package error: ${error?.stack ?? error}`);
  assert.match(`${error.name}: ${error.message}`, pattern);
  return error;
}
// One triangle: POSITION in buffer 0. `edit(doc)` mutates the document before it is written as a GLB.
function triangle(edit = () => {}, bin = new Uint8Array(Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0).buffer)) {
  const doc = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36 }],
  };
  edit(doc);
  return toGLB(doc, bin);
}
/** gltf-pro on the main thread and through its parse-worker job (prepareGLTF, cloned like postMessage, then the model). */
async function bothPaths(bytes, pattern, options = {}) {
  await named(() => parseGLTFAsync(kernel, bytes.slice(), options), pattern);
  await named(async () => {
    const prepared = await prepareGLTF(undefined, bytes.slice(), undefined, options.maxDownloadBytes);
    modelFromPrepared(kernel, structuredClone(prepared), undefined, options.decoders);
  }, pattern);
}
// A GLB whose JSON chunk is `text` (any bytes).
const glbWithJSON = (text) => {
  const glb = toGLB({}, undefined, ' '.repeat((text.length + 3) & ~3));
  glb.set(text, 20);
  return glb;
};

test('glTF JSON that is not UTF-8 or not JSON: named TypeError, not TextDecoder TypeError or SyntaxError', async () => {
  const notUtf8 = glbWithJSON(Uint8Array.of(0x7b, 0xff, 0x7d)),
    notJson = glbWithJSON(encode('{"asset":{"version":"2.0"},')),
    text = encode('{"asset": [}');
  await named(() => parseLight(kernel, notUtf8), /^TypeError: Invalid glTF JSON: not UTF-8$/);
  await named(() => parseLight(kernel, notJson), /^TypeError: Invalid glTF JSON: /);
  await named(() => parseLight(kernel, new TextDecoder().decode(text)), /^TypeError: Invalid glTF JSON: /);
  await bothPaths(notUtf8, /^TypeError: Invalid glTF JSON: not UTF-8$/);
  await bothPaths(notJson, /^TypeError: Invalid glTF JSON: /);
  await bothPaths(text, /^TypeError: Invalid glTF JSON: /);
});

test('glTF lists with null or non-object entries: named TypeError at the trust boundary', async () => {
  // Fuzz: TypeError: Cannot read properties of null (reading 'byteLength' / 'primitives' / 'pbrMetallicRoughness').
  await named(
    () =>
      parseLight(
        kernel,
        triangle((d) => (d.buffers = [null])),
      ),
    /^TypeError: Invalid glTF buffers entry$/,
  );
  await named(
    () =>
      parseLight(
        kernel,
        triangle((d) => (d.meshes = [null])),
      ),
    /^TypeError: Invalid glTF meshes entry$/,
  );
  await named(
    () =>
      parseLight(
        kernel,
        triangle((d) => (d.meshes[0].primitives = [7])),
      ),
    /^TypeError: Missing glTF primitives$/,
  );
  await bothPaths(
    triangle((d) => (d.images = [null])),
    /^TypeError: Invalid glTF images$/,
  );
  await bothPaths(
    triangle((d) => (d.materials = [null])),
    /^TypeError: Invalid glTF materials$/,
  );
  await bothPaths(
    triangle((d) => (d.buffers = 7)),
    /^TypeError: Invalid glTF buffers$/,
  );
  // Fuzz: TypeError: number 65536 is not iterable / object is not iterable (primitives, morph targets, samplers).
  await bothPaths(
    triangle((d) => (d.meshes[0].primitives = 65536)),
    /^TypeError: Invalid glTF primitives$/,
  );
  await bothPaths(
    triangle((d) => (d.meshes[0].primitives[0].targets = 5)),
    /^TypeError: Invalid glTF primitives$/,
  );
  await bothPaths(
    triangle((d) => (d.animations = [{ samplers: {}, channels: [] }])),
    /^TypeError: Invalid glTF animation$/,
  );
  // Fuzz: TypeError: doc.extensionsUsed?.includes is not a function.
  await bothPaths(
    triangle((d) => (d.extensionsUsed = 'KHR_mesh_quantization')),
    /^TypeError: Invalid glTF extensionsUsed$/,
  );
  // Review: TypeError: def.uri.startsWith is not a function.
  await bothPaths(
    triangle((d) => (d.buffers[0].uri = 5)),
    /^TypeError: Invalid glTF (buffer uri|data URI)$/,
  );
});

test('a base64 data URI whose length the pattern accepts but atob rejects: named TypeError, not DOMException', async () => {
  // Fuzz: InvalidCharacterError: Invalid character (atob).
  const uri = (d) => (d.buffers[0].uri = 'data:application/octet-stream;base64,A');
  await named(() => parseLight(kernel, triangle(uri, undefined)), /^TypeError: Invalid glTF data URI$/);
  await bothPaths(triangle(uri, undefined), /^TypeError: Invalid glTF data URI$/);
});

test('glTF JSON nested thousands deep: named TypeError before a recursive reader or structured clone overflows', async () => {
  // Fuzz: RangeError: Maximum call stack size exceeded (the worker's transfer-list walk).
  const deep = encode(`{"extras":${'['.repeat(100_000)}${']'.repeat(100_000)},"asset":{"version":"2.0"}}`);
  await bothPaths(deep, /^TypeError: Invalid glTF JSON: nested deeper than 256 levels$/);
  let nested = [];
  for (let i = 0; i < 100_000; i++) nested = [nested];
  assert.equal(transferables({ nested, bytes: new Uint8Array(4) }).size, 1);
});

test('JSON bytes over the download budget fail on the budget before they are decoded', async () => {
  const big = new Uint8Array(4097).fill(0x20);
  big[0] = 0x7b;
  big[100] = 0xff; // decoding first would report "not UTF-8" instead of the budget
  await named(
    () => parseGLTFAsync(kernel, big, { maxDownloadBytes: 4096 }),
    /^RangeError: glTF JSON exceeds byte budget \(4096 bytes; raise the maxDownloadBytes option\)$/,
  );
});

test('an image the browser cannot decode: named error, not the DOMException', async () => {
  const bitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => {
    throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
  };
  try {
    const glb = triangle((d) => {
      d.images = [{ uri: 'data:image/png;base64,AAAA', mimeType: 'image/png' }];
    });
    await named(
      () => parseGLTFAsync(kernel, glb, {}),
      /^TypeError: glTF image 0 could not be decoded \(The source image could not be decoded\.\); check the file$/,
    );
    await named(
      () => decodeUltraHDR(ultraSeeds()[0]),
      /^MargoError: UltraHDR: the JPEG could not be decoded \(The source image could not be decoded\.\); check the file$/,
    );
    const margo = new Uint8Array(
      readFileSync(new URL('../packages/blender/tests/fixtures/triangle.margo', import.meta.url)),
    );
    await named(() => parseMargo(kernel, margo), /^TypeError: \.margo image 0 could not be decoded/);
  } finally {
    globalThis.createImageBitmap = bitmap;
  }
});

test('EXT_mesh_gpu_instancing: instance matrices count toward the decoded budget before they are allocated', async () => {
  // 200 instances: a 2,400-byte TRANSLATION accessor expands to 19,200 bytes of instance data (96 per instance).
  const count = 200,
    bin = new Uint8Array(36 + count * 12);
  bin.set(new Uint8Array(Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0).buffer));
  const glb = triangle((d) => {
    d.bufferViews.push({ buffer: 0, byteOffset: 36, byteLength: count * 12 });
    d.accessors.push({ bufferView: 1, componentType: 5126, count, type: 'VEC3' });
    d.buffers[0].byteLength = bin.length;
    d.nodes[0].extensions = { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1 } } };
    d.extensionsUsed = ['EXT_mesh_gpu_instancing'];
  }, bin);
  await named(
    () => parseGLTFAsync(kernel, glb, { maxDownloadBytes: 4096, decoders: { instancing } }),
    /^RangeError: Decoded glTF exceeds byte budget$/,
  );
  (await parseGLTFAsync(kernel, glb, { maxDownloadBytes: 8192, decoders: { instancing } })).dispose();
});

test('normals derived from huge (finite) positions stay finite on both paths', async () => {
  // Fuzz (seed 20261017, input 5155): a primitive without NORMAL whose coordinates reach ~1e19. The summed face cross
  // product (here 9e38) overflows Float32 to Infinity, and Infinity / Infinity left NaN normals in the packed vertices.
  const glb = triangle(() => {}, new Uint8Array(Float32Array.of(0, 0, 0, 3e19, 0, 0, 0, 0, 3e19).buffer));
  const prepared = await prepareGLTF(undefined, glb.slice());
  for (const model of [
    await parseGLTFAsync(kernel, glb.slice(), {}),
    modelFromPrepared(kernel, structuredClone(prepared)),
  ]) {
    const { vertices } = model.primitives[0];
    assert.ok(vertices.every(Number.isFinite), 'every packed value finite');
    // The overflowed normal takes the zero-length path: +Z. Positions are kept as the file gives them.
    for (let o = 0; o < vertices.length; o += 20) assert.deepEqual([...vertices.subarray(o + 4, o + 7)], [0, 0, 1]);
    assert.deepEqual([...vertices.subarray(20, 23)], [3e19, 0, 0].map(Math.fround));
    model.dispose();
  }
});

test('a supplied non-finite NORMAL takes the zero-normal path: a named error, never NaN vertices', async () => {
  const normals = (d) => {
      d.meshes[0].primitives[0].attributes.NORMAL = 1;
      d.accessors.push({ bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' });
      d.bufferViews.push({ buffer: 0, byteOffset: 36, byteLength: 36 });
      d.buffers[0].byteLength = 72;
    },
    bin = new Uint8Array(Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1).buffer);
  // NaN in the file: refused when the accessor is read, before packing.
  const nan = bin.slice();
  new DataView(nan.buffer).setFloat32(36, Number.NaN, true);
  await bothPaths(triangle(normals, nan), /^RangeError: .*Non-finite glTF accessor$/);
  // NaN in a parse worker's reply: decoded accessors seed the main thread's cache as they are, and a primitive the
  // worker could not pack is packed again there, so the normal reaches the packer's own zero-length check.
  const prepared = await prepareGLTF(undefined, triangle(normals, bin));
  prepared.accessors = [
    ...prepared.accessors.filter(([i]) => i !== 1),
    [1, Float32Array.of(Number.NaN, 0, 1, 0, 0, 1, 0, 0, 1)],
  ];
  prepared.geometry = prepared.geometry.map((primitives) => primitives.map(() => null));
  await named(() => modelFromPrepared(kernel, prepared), /^RangeError: .*Zero or non-finite glTF normal$/);
});

test('the parse worker counts packed geometry toward the decoded budget, as the main thread does', async () => {
  // Fuzz: a document repeating its meshes made the worker pack every copy (344 MiB from a 337 KB input at an 8 MiB
  // budget); the main thread already counted the geometry it packs.
  const glb = triangle((d) => {
    d.meshes = Array.from({ length: 400 }, () => structuredClone(d.meshes[0]));
  });
  await named(
    () => prepareGLTF(undefined, glb, undefined, glb.length),
    new RegExp(
      `^RangeError: Decoded glTF geometry exceeds byte budget \\(${glb.length * 4} bytes; raise the maxDownloadBytes option\\)$`,
    ),
  );
  await prepareGLTF(undefined, glb, undefined, glb.length * 2);
});

test('.margo scene JSON that is not JSON, and null scene nodes or materials: named errors', async () => {
  const margo = new Uint8Array(
      readFileSync(new URL('../packages/blender/tests/fixtures/cad-triangle.margo', import.meta.url)),
    ),
    view = new DataView(margo.buffer),
    offset = view.getUint32(68, true);
  const broken = margo.slice();
  broken[offset] = 0x5b; // '[' where the document's '{' was
  await named(() => parseMargo(kernel, broken), /^TypeError: Invalid \.margo scene JSON$/);
  // Fuzz: TypeError: Cannot read properties of null (reading 'skin' / 'pbrMetallicRoughness').
  const doc = JSON.parse(new TextDecoder().decode(margo.subarray(offset, offset + view.getUint32(72, true))));
  for (const [key, list] of [
    ['nodes', [...doc.nodes, null]],
    ['materials', [null]],
  ])
    await named(
      () => parseMargo(kernel, margoWithScene(margo, encode(JSON.stringify({ ...doc, [key]: list })))),
      new RegExp(`^TypeError: Invalid (glTF|\\.margo) ${key}$`),
    );
});

test('meshopt: truncated v1 vertex groups and non-integer counts are named errors, never reads past the stream', async () => {
  const meta = JSON.parse(new TextDecoder().decode(fixture('meshopt-v1-truncated.json'))),
    stream = fixture('meshopt-v1-truncated.bin');
  // Every index read of the stream is checked: an out-of-range read throws instead of yielding undefined.
  const checked = new Proxy(stream, {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key) && +key >= target.length) throw new Error(`read src[${key}]`);
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await named(
    () => decodeMeshoptBuffer(checked, meta.count, meta.stride, meta.mode, meta.filter),
    /^(Range)?Error: EXT_meshopt_compression: truncated vertex stream$/,
  );
  // Fuzz: RangeError: Invalid typed array length: -6.
  for (const count of [-1, 1.5, 2 ** 53])
    await named(
      () => decodeMeshoptBuffer(stream, count, 16, 'ATTRIBUTES', 'EXPONENTIAL'),
      /^RangeError: EXT_meshopt_compression: invalid count or byteStride$/,
    );
  // Fuzz: Array buffer allocation failed, and 1-2 GiB allocated for 27-byte inputs: a count the stream cannot encode
  // is refused before its output is allocated.
  const before = process.memoryUsage().arrayBuffers;
  await named(
    () => decodeMeshoptBuffer(stream, 2 ** 26, 16, 'ATTRIBUTES', 'EXPONENTIAL'),
    /^(Range)?Error: EXT_meshopt_compression: /,
  );
  assert.ok(process.memoryUsage().arrayBuffers - before < 64 << 20, 'no output allocated for an impossible count');
});

test('Draco: a buffer without a Draco header fails the same way every time (no uninitialized Wasm read)', async () => {
  const draco = await wasm('draco'),
    garbage = fixture('draco-no-header.bin'),
    messages = new Set();
  for (let i = 0; i < 3; i++)
    messages.add(
      (await named(() => decodeDraco(draco, garbage.slice()), /^TypeError: Draco: invalid header$/)).message,
    );
  assert.equal(messages.size, 1);
});

test('KTX2: a level whose declared uncompressed size exceeds its blocks is refused before the transcoder reads it', async () => {
  // Two byte changes to the Khronos fixture: level 0 declares 0xFFFF0000 uncompressed (Zstandard) bytes for 512 x 512
  // blocks; after another file had been transcoded, the Basis transcoder read past its buffer and the raw
  // `RuntimeError: memory access out of bounds` escaped transcodeKTX2.
  const seed = new Uint8Array(
      readFileSync(new URL('../packages/decoders/tests/fixtures/AnisotropyBarnLamp_normalbump.ktx2', import.meta.url)),
    ),
    patch = (changes) => {
      const bytes = seed.slice();
      for (const [at, value] of changes) bytes[at] = value;
      return bytes;
    },
    warmup = patch([
      [41908, 2],
      [41910, 0],
      [41911, 0],
    ]),
    trap = patch([
      [98, 255],
      [99, 255],
    ]);
  let basis = await wasm('basis');
  await named(() => transcodeKTX2(basis, warmup, 'rgba8'), /^Error: KTX2: could not transcode level 0$/);
  await named(() => transcodeKTX2(basis, trap.slice(), 'bc7'), /^TypeError: KTX2: invalid file \(level 0 size\)$/);
  // The same calls transcodeKTX2 made before the check, on the same module state: the transcoder itself traps.
  const file = new basis.KTX2File(trap);
  assert.ok(file.isValid() && file.startTranscoding());
  let trapped;
  try {
    file.transcodeImage(new Uint8Array(file.getImageTranscodedSizeInBytes(0, 0, 0, 6)), 0, 0, 0, 6, 0, -1, -1);
  } catch (error) {
    trapped = error;
  }
  assert.ok(trapped instanceof WebAssembly.RuntimeError, `expected a Wasm trap, got ${trapped}`);
  // That trap, caught at the boundary, is the decoder's own error, and the worker drops the module (isDecoderCrash).
  const throwing = {
    KTX2File: function () {
      return {
        isValid() {
          throw trapped;
        },
        close() {},
        delete() {},
      };
    },
  };
  const crash = await named(
    () => transcodeKTX2(throwing, seed, 'bc7'),
    /^MargoError: KTX2: corrupt or unsupported data stopped the decoder \(memory access out of bounds\)$/,
  );
  assert.ok(isDecoderCrash(crash));
  assert.equal(crash.code, 'failed');
  basis = await wasm('basis'); // what the worker does for the next job
  assert.equal(transcodeKTX2(basis, seed, 'bc7').width, 2048);
});

/** A single-part scanline EXR: one HALF channel Y, ZIP, a size x size data window, `blocks` chunks of 1 byte. */
function exrClaim(size, blocks) {
  const parts = [],
    u8 = (...b) => parts.push(Uint8Array.from(b)),
    i32 = (...v) => parts.push(new Uint8Array(Int32Array.from(v).buffer)),
    text = (s) => parts.push(encode(`${s}\0`));
  i32(20000630, 2);
  text('channels');
  text('chlist');
  i32(19); // name, pixel type, pLinear + 3 reserved, x and y sampling, list terminator
  text('Y');
  i32(1); // HALF
  u8(0, 0, 0, 0);
  i32(1, 1);
  u8(0);
  text('compression');
  text('compression');
  i32(1);
  u8(3); // ZIP: 16 lines per chunk
  text('dataWindow');
  text('box2i');
  i32(16, 0, 0, size - 1, size - 1);
  u8(0); // end of header
  const header = parts.reduce((n, p) => n + p.length, 0),
    table = header + blocks * 8;
  for (let i = 0; i < blocks; i++) parts.push(new Uint8Array(BigUint64Array.of(BigInt(table + i * 9)).buffer));
  for (let i = 0; i < blocks; i++) {
    i32(i * 16, 1);
    u8(0);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
}

test('HDR and EXR headers that claim a large image fail before it is allocated', async () => {
  const before = () => process.memoryUsage().arrayBuffers;
  // Radiance: a 30-byte header for 8192 x 8192 pixels used to allocate 1 GiB first.
  const hdr = encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 8192 +X 8192\n'),
    a = before();
  await named(() => parseHDR(hdr), /^RangeError: Invalid HDR: truncated pixel data$/);
  assert.ok(process.memoryUsage().arrayBuffers - a < 1 << 20, 'no image allocated');
  // OpenEXR: a 4096 x 4096 HALF Y header whose 256 ZIP chunks hold one byte each used to allocate 256 MiB first.
  const exr = exrClaim(4096, 256),
    b = before();
  await named(() => parseEXR(exr), /^RangeError: Invalid EXR: chunks are too small for the image size$/);
  assert.ok(process.memoryUsage().arrayBuffers - b < 1 << 20, 'no image allocated');
});

test('EXR attributes: an empty compression value and a long part type are named errors', async () => {
  // Built from a valid file: the compression attribute's size field is zeroed / a 1 MiB "type" string attribute added.
  const file = new Uint8Array(
      readFileSync(new URL('../packages/environment/tests/fixtures/synthetic-half-y-none.exr', import.meta.url)),
    ),
    at = (name) => {
      const needle = encode(`${name}\0`);
      for (let i = 8; i < file.length; i++) if (needle.every((b, j) => file[i + j] === b)) return i;
      throw new Error(name);
    };
  const sizeAt = at('compression') + 'compression\0compression\0'.length,
    empty = file.slice();
  new DataView(empty.buffer).setInt32(sizeAt, 0, true);
  // With size 0 the parser read the next attribute's first byte as the compression.
  await named(() => parseEXR(empty), /^TypeError: Invalid EXR: bad compression$/);
  // String.fromCharCode(...1 MiB) overflowed the call stack.
  const value = new Uint8Array(1 << 20).fill(0x61),
    attribute = new Uint8Array([...encode('type\0string\0'), 0, 0, 0, 0, ...value]);
  new DataView(attribute.buffer).setInt32(12, value.length, true);
  const long = new Uint8Array([...file.subarray(0, 8), ...attribute, ...file.subarray(8)]);
  await named(() => parseEXR(long), /^Error: Unsupported EXR part type \(too long\)$/);
});

test('UltraHDR with the test JPEG decoder still parses (the stubs above are restored)', async () => {
  const image = await decodeUltraHDR(ultraSeeds()[0], { decode: fakeJPEG });
  assert.equal(image.data.length, image.width * image.height * 4);
});
