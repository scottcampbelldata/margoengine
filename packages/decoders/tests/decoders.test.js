import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {extname, resolve} from 'node:path';
import {createRequire} from 'node:module';
import * as decoders from '../dist/index.js';
import {WorkerPool, payload} from '../dist/pool.js';
import {decodeDraco, dracoTransferables, initBasis, initDraco, transcodeKTX2} from '../dist/codec.js';

// Emscripten detects Node and reaches for CommonJS `require` while initializing.
globalThis.require ??= createRequire(import.meta.url);
globalThis.__dirname ??= fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = name => readFile(resolve(root, 'tests/fixtures', name));
const types = {'.js': 'text/javascript', '.wasm': 'application/wasm'};
const server = createServer(async (request, response) => {
  try {const file = resolve(root, 'dist', '.' + new URL(request.url, 'http://x').pathname); response.writeHead(200, {'content-type': types[extname(file)] ?? 'application/octet-stream'}); response.end(await readFile(file));}
  catch {response.writeHead(404); response.end();}
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}/`;
test.after(() => server.close());

test('module evaluation and construction are SSR-safe; decoding rejects clearly without workers', async () => {
  assert.equal(typeof globalThis.window, 'undefined');
  const draco = new decoders.DracoDecoder(), ktx2 = new decoders.KTX2Decoder();
  assert.ok(draco.workerLimit >= 1 && draco.workerLimit <= 4);
  assert.equal(ktx2.target, 'rgba8');
  await assert.rejects(draco.decode(new Uint8Array(4)), /SSR/);
  await assert.rejects(ktx2.transcode(new Uint8Array(4)), /SSR/);
  assert.throws(() => new decoders.DracoDecoder({workerLimit: 0}), RangeError);
  draco.dispose(); ktx2.dispose();
});

test('transcode target negotiation follows BC7, ASTC, ETC2, RGBA8', () => {
  const device = (...features) => ({features: new Set(features)});
  assert.equal(decoders.getSupportedTranscodeFormat(device('texture-compression-bc', 'texture-compression-astc')), 'bc7');
  assert.equal(decoders.getSupportedTranscodeFormat(device('texture-compression-astc', 'texture-compression-etc2')), 'astc-4x4');
  assert.equal(decoders.getSupportedTranscodeFormat(device('texture-compression-etc2')), 'etc2');
  assert.equal(decoders.getSupportedTranscodeFormat(device()), 'rgba8');
  assert.equal(decoders.getSupportedTranscodeFormat(), 'rgba8');
  assert.equal(new decoders.KTX2Decoder({device: device('texture-compression-astc')}).target, 'astc-4x4');
});

test('bytesPerRow counts 4x4 blocks for compressed formats and pixels for RGBA8', () => {
  assert.equal(decoders.getBytesPerRow('bc7-rgba-unorm', 256), 1024);
  assert.equal(decoders.getBytesPerRow('astc-4x4-unorm-srgb', 2), 16);
  assert.equal(decoders.getBytesPerRow('etc2-rgba8unorm', 9), 48);
  assert.equal(decoders.getBytesPerRow('rgba8unorm', 3), 12);
  assert.throws(() => decoders.getBytesPerRow('r8unorm', 4), TypeError);
});

test('createKTX2Texture allocates the compressed format and writes each mip at its physical size', () => {
  globalThis.GPUTextureUsage = {TEXTURE_BINDING: 4, COPY_DST: 2};
  const writes = [], created = [];
  const device = {
    createTexture: descriptor => {const texture = {descriptor, destroyed: false, destroy() {this.destroyed = true;}}; created.push(texture); return texture;},
    queue: {writeTexture: (destination, data, layout, size) => writes.push({mipLevel: destination.mipLevel, data, layout, size})},
  };
  const buffer = new Uint8Array(16 * 16 + 16 * 4 + 16 + 16);
  const mipmaps = [[8, 8, 64], [4, 4, 16], [2, 2, 16], [1, 1, 16]].reduce((list, [width, height, byteLength], i) => {
    const offset = list.reduce((total, mip) => total + mip.byteLength, 0);
    list.push({data: buffer.subarray(offset, offset + byteLength), width, height, byteLength}); return list;
  }, []);
  const texture = decoders.createKTX2Texture(device, {width: 8, height: 8, mipmaps, format: 'bc7-rgba-unorm-srgb', target: 'bc7', hasAlpha: false, srgb: true}, {label: 'base'});
  assert.deepEqual(texture.descriptor, {label: 'base', size: [8, 8, 1], mipLevelCount: 4, format: 'bc7-rgba-unorm-srgb', usage: 6});
  assert.deepEqual(writes.map(w => [w.mipLevel, w.layout.bytesPerRow, w.layout.rowsPerImage, w.size]), [[0, 32, 8, [8, 8, 1]], [1, 16, 4, [4, 4, 1]], [2, 16, 4, [4, 4, 1]], [3, 16, 4, [4, 4, 1]]]);
  assert.ok(writes.every((w, i) => w.data === mipmaps[i].data), 'mip views are written without copying');
  const failing = {...device, queue: {writeTexture() {throw new Error('lost');}}};
  assert.throws(() => decoders.createKTX2Texture(failing, {width: 4, height: 4, mipmaps: mipmaps.slice(1, 2), format: 'bc7-rgba-unorm', target: 'bc7'}), /lost/);
  assert.equal(created.at(-1).destroyed, true, 'a failed upload releases its texture');
});

class FakeWorker {
  static created = [];
  constructor(handler) {this.handler = handler; this.terminated = false; this.received = []; FakeWorker.created.push(this);}
  postMessage(message, transfer = []) {
    const cloned = structuredClone(message, {transfer});
    this.received.push({message: cloned, transfer});
    queueMicrotask(() => this.handler(this, cloned));
  }
  reply(data, transfer = []) {if (!this.terminated) this.onmessage?.({data: structuredClone(data, {transfer})});}
  terminate() {this.terminated = true;}
}

test('worker pool grows to its limit, reuses idle workers and balances load', async () => {
  FakeWorker.created = [];
  const pool = new WorkerPool(2, () => new FakeWorker((worker, message) => setTimeout(() => worker.reply({id: message.id, result: message.value}), 5)));
  const results = await Promise.all([1, 2, 3, 4, 5].map(value => pool.run({value}, [])));
  assert.deepEqual(results, [1, 2, 3, 4, 5]);
  assert.equal(pool.size, 2);
  assert.equal(FakeWorker.created.length, 2);
  assert.deepEqual(FakeWorker.created.map(w => w.received.length).sort(), [2, 3]);
  assert.equal(pool.pending, 0);
  pool.dispose();
  assert.ok(FakeWorker.created.every(w => w.terminated));
  await assert.rejects(pool.run({}, []), /disposed/);
});

test('inputs and results move by transfer, never by copy', async () => {
  FakeWorker.created = [];
  const pool = new WorkerPool(1, () => new FakeWorker((worker, message) => {
    const positions = new Float32Array(new Uint8Array(message.buffer).length);
    worker.reply({id: message.id, result: {positions}}, [positions.buffer]);
  }));
  const source = new ArrayBuffer(12);
  const result = await pool.run({buffer: source}, [source]);
  assert.equal(source.byteLength, 0, 'the input buffer was transferred, not cloned');
  assert.equal(result.positions.length, 12);
  const kept = new Uint8Array(32), copied = payload(kept.subarray(8, 24), true);
  assert.equal(copied.byteLength, 16, 'a view into a larger buffer is copied out');
  assert.equal(kept.byteLength, 32, 'the caller keeps its buffer');
  const whole = new ArrayBuffer(8);
  assert.equal(payload(whole, false).byteLength, 8); assert.equal(whole.byteLength, 8, 'copy by default');
  assert.equal(payload(whole, true), whole, 'transfer only on opt-in');
  pool.dispose();
});

test('worker errors, crashes, aborts and disposal reject only the affected jobs', async () => {
  FakeWorker.created = [];
  const pool = new WorkerPool(2, () => new FakeWorker((worker, message) => {
    if (message.mode === 'error') worker.reply({id: message.id, error: 'Draco: bad data'});
    else if (message.mode === 'crash') worker.onerror({message: 'out of memory', preventDefault() {}});
    else if (message.mode === 'ok') worker.reply({id: message.id, result: 'fine'});
  }));
  await assert.rejects(pool.run({mode: 'error'}, []), /Draco: bad data/);
  await assert.rejects(pool.run({mode: 'crash'}, []), /out of memory/);
  assert.ok(FakeWorker.created.some(w => w.terminated), 'crashed worker terminated');
  assert.equal(await pool.run({mode: 'ok'}, []), 'fine', 'pool recovers with a fresh worker');
  const controller = new AbortController(), hanging = pool.run({mode: 'hang'}, [], controller.signal);
  controller.abort(new Error('user cancelled'));
  await assert.rejects(hanging, /user cancelled/);
  await assert.rejects(pool.run({mode: 'ok'}, [], controller.signal), /user cancelled/);
  const pending = pool.run({mode: 'hang'}, []);
  pool.dispose();
  await assert.rejects(pending, /disposed/);
  assert.equal(pool.pending, 0);
});

/** Records every Draco handle and allocation so release can be asserted. */
function mockDraco({kind = 1, ok = true, attributes = {POSITION: 3}, points = 4, faces = 2} = {}) {
  const log = {created: [], destroyed: [], malloc: [], free: []}, heap = new ArrayBuffer(4096);
  let top = 8;
  const handle = name => {const h = {ptr: 1, name}; log.created.push(h); return h;};
  const draco = {
    TRIANGULAR_MESH: 1, POINT_CLOUD: 2, POSITION: 0, NORMAL: 1, TEX_COORD: 2, COLOR: 3,
    DT_INT8: 1, DT_UINT8: 2, DT_INT16: 3, DT_UINT16: 4, DT_INT32: 5, DT_UINT32: 6, DT_FLOAT32: 9,
    HEAPU8: new Uint8Array(heap),
    Decoder: function () {
      const d = handle('decoder');
      Object.assign(d, {
        GetEncodedGeometryType: () => kind,
        DecodeBufferToMesh: () => ({ok: () => ok, error_msg: () => 'corrupt'}),
        DecodeBufferToPointCloud: () => ({ok: () => ok, error_msg: () => 'corrupt'}),
        GetAttributeId: (_g, type) => Object.keys(attributes).indexOf(['POSITION', 'NORMAL', 'TEXCOORD_0', 'COLOR_0'][type]),
        GetAttribute: (_g, id) => ({ptr: 1, num_components: () => Object.values(attributes)[id], data_type: () => 9}),
        GetAttributeByUniqueId: (_g, id) => id === 99 ? {ptr: 0} : {ptr: 1, num_components: () => 3, data_type: () => 9},
        GetAttributeDataArrayForAllPoints: (_g, _a, _t, bytes, ptr) => {new Float32Array(heap, ptr, bytes / 4).fill(0.5); return true;},
        GetTrianglesUInt16Array: (_g, bytes, ptr) => {new Uint16Array(heap, ptr, bytes / 2).forEach((_, i, a) => {a[i] = i % points;}); return true;},
        GetTrianglesUInt32Array: () => true,
      });
      return d;
    },
    DecoderBuffer: function () {return Object.assign(handle('buffer'), {Init() {}});},
    Mesh: function () {return Object.assign(handle('mesh'), {num_points: () => points, num_faces: () => faces});},
    PointCloud: function () {return Object.assign(handle('cloud'), {num_points: () => points});},
    _malloc: bytes => {const ptr = top; top += Math.ceil(bytes / 8) * 8; log.malloc.push(ptr); return ptr;},
    _free: ptr => log.free.push(ptr),
    destroy: h => log.destroyed.push(h),
  };
  return {draco, log};
}

test('mock decode returns owned typed arrays and releases every Draco handle and allocation', () => {
  const {draco, log} = mockDraco({attributes: {POSITION: 3, NORMAL: 3}});
  const result = decodeDraco(draco, new Uint8Array(8));
  assert.equal(result.vertexCount, 4);
  assert.ok(result.positions instanceof Float32Array && result.positions.length === 12);
  assert.ok(result.normals instanceof Float32Array);
  assert.ok(result.indices instanceof Uint16Array && result.indices.length === 6, '16-bit indices when vertices fit');
  for (const array of [result.positions, result.normals, result.indices]) assert.equal(array.buffer.byteLength, array.byteLength, 'array owns its buffer, so transfer moves no extra bytes');
  assert.notEqual(result.positions.buffer, draco.HEAPU8.buffer, 'output is not a view of the Wasm heap');
  assert.equal(dracoTransferables(result).length, 3);
  assert.deepEqual(new Set(log.destroyed), new Set(log.created), 'decoder, buffer and mesh destroyed');
  assert.deepEqual([...log.free].sort(), [...log.malloc].sort(), 'every malloc freed');
});

test('mock decode releases memory on every failure path', () => {
  for (const [options, request, pattern] of [
    [{ok: false}, {}, /corrupt/],
    [{kind: 7}, {}, /unknown geometry/],
    [{}, {attributeIds: {POSITION: 99}}, /missing attribute POSITION/],
    [{attributes: {NORMAL: 3}}, {}, /no POSITION/],
  ]) {
    const {draco, log} = mockDraco(options);
    assert.throws(() => decodeDraco(draco, new Uint8Array(8), request), pattern);
    assert.deepEqual(new Set(log.destroyed), new Set(log.created));
    assert.deepEqual([...log.free].sort(), [...log.malloc].sort());
  }
});

test('mock transcode closes and deletes the KTX2 file on success and failure', () => {
  const calls = [];
  const basis = valid => ({KTX2File: function () {
    return {isValid: () => valid, isHDR: () => false, getFaces: () => 1, getLayers: () => 1, getWidth: () => 6, getHeight: () => 6, getLevels: () => 2, getHasAlpha: () => 1,
      getDFDTransferFunc: () => 2, startTranscoding: () => true, getImageTranscodedSizeInBytes: (level, _l, _f, format) => {calls.push(format); return level ? 36 : 144;},
      transcodeImage: dst => {dst.fill(7); return true;}, close: () => calls.push('close'), delete: () => calls.push('delete')};
  }});
  const result = transcodeKTX2(basis(true), new Uint8Array(4), 'bc7');
  assert.equal(result.target, 'rgba8', '6x6 is not block aligned, so the compressed target falls back');
  assert.equal(result.format, 'rgba8unorm-srgb');
  assert.deepEqual(result.mipmaps.map(m => [m.width, m.height, m.byteLength]), [[6, 6, 144], [3, 3, 36]]);
  assert.equal(result.mipmaps[0].data.buffer, result.mipmaps[1].data.buffer, 'mips share one transferable buffer');
  assert.deepEqual(calls.slice(-2), ['close', 'delete']);
  calls.length = 0;
  assert.throws(() => transcodeKTX2(basis(false), new Uint8Array(4), 'bc7'), /invalid/);
  assert.deepEqual(calls, ['close', 'delete']);
});

test('real Draco Wasm decodes the Khronos Box and Avocado and does not grow its heap across repeated decodes', async () => {
  const {module: draco} = await initDraco(base + 'draco/draco_wasm_wrapper.js', base + 'draco/draco_decoder.wasm', async url => {(0, eval)(await (await fetch(url)).text());});
  for (const name of ['Box', 'Avocado']) {
    const doc = JSON.parse(await fixture(`${name}.gltf`)), bin = await fixture(`${name}.bin`), primitive = doc.meshes[0].primitives[0], ext = primitive.extensions.KHR_draco_mesh_compression, view = doc.bufferViews[ext.bufferView];
    const result = decodeDraco(draco, bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength), {attributeIds: ext.attributes, componentTypes: {TANGENT: 5126}});
    const position = doc.accessors[primitive.attributes.POSITION];
    assert.equal(result.vertexCount, position.count);
    assert.equal(result.indices.length, doc.accessors[primitive.indices].count);
    assert.ok(result.indices instanceof Uint16Array);
    assert.ok(result.indices.every(i => i < result.vertexCount));
    for (let i = 0; i < result.positions.length; i++) {const axis = i % 3; assert.ok(result.positions[i] >= position.min[axis] - 1e-4 && result.positions[i] <= position.max[axis] + 1e-4, `${name} position inside accessor bounds`);}
    assert.equal(result.normals.length, position.count * 3);
    for (let i = 0; i < result.normals.length; i += 3) assert.ok(Math.abs(Math.hypot(result.normals[i], result.normals[i + 1], result.normals[i + 2]) - 1) < 0.02, 'unit normals');
    if (name === 'Avocado') {assert.equal(result.uvs.length, position.count * 2); assert.equal(result.attributes.TANGENT.itemSize, 4); assert.ok(result.attributes.TANGENT.array instanceof Float32Array);}
  }
  const doc = JSON.parse(await fixture('Avocado.gltf')), bin = await fixture('Avocado.bin'), ext = doc.meshes[0].primitives[0].extensions.KHR_draco_mesh_compression;
  for (let i = 0; i < 20; i++) decodeDraco(draco, bin, {attributeIds: ext.attributes});
  const settled = draco.HEAPU8.length;
  for (let i = 0; i < 200; i++) decodeDraco(draco, bin, {attributeIds: ext.attributes});
  assert.equal(draco.HEAPU8.length, settled, 'Wasm heap stays flat, so handles and buffers are released');
});

test('real Basis transcoder decodes a Khronos UASTC + Zstandard texture into each target format', async () => {
  const {module: basis} = await initBasis(base + 'basis/basis_transcoder.js', base + 'basis/basis_transcoder.wasm', async url => {(0, eval)(await (await fetch(url)).text());});
  const bytes = await fixture('AnisotropyBarnLamp_normalbump.ktx2');
  for (const target of ['rgba8', 'bc7', 'astc-4x4', 'etc2']) {
    const result = transcodeKTX2(basis, bytes, target);
    assert.equal(result.target, target);
    assert.equal(result.width, 2048); assert.equal(result.mipmaps.length, 1, 'fixture stores one level; multi-level packing is covered by the mock');
    assert.equal(result.srgb, false, 'normal maps are linear');
    result.mipmaps.forEach((mip, level) => {
      assert.equal(mip.width, Math.max(1, result.width >> level));
      const expected = target === 'rgba8' ? mip.width * mip.height * 4 : Math.ceil(mip.width / 4) * Math.ceil(mip.height / 4) * 16;
      assert.equal(mip.byteLength, expected, `${target} level ${level} size`);
      assert.equal(mip.data.byteLength, expected);
    });
    assert.equal(new Set(result.mipmaps.map(m => m.data.buffer)).size, 1, 'one transferable buffer');
    assert.ok(result.mipmaps[0].data.some(v => v !== 0));
  }
});

test('meshopt decoding is bit-exact with the meshoptimizer reference decoder', async () => {
  const vectors = JSON.parse(await fixture('meshopt-vectors.json')), bytes = b64 => new Uint8Array(Buffer.from(b64, 'base64'));
  for (const c of vectors.cases) {
    const decoded = decoders.decodeMeshoptBuffer(bytes(c.encoded), c.count, c.stride, c.mode, c.filter);
    assert.deepEqual(decoded, bytes(c.expected), c.name);
    const target = new Uint8Array(c.count * c.stride);
    decoders.MeshoptDecoder.decodeGltfBuffer(target, c.count, c.stride, bytes(c.encoded), c.mode, c.filter);
    assert.deepEqual(target, bytes(c.expected), `${c.name} via the three-compatible MeshoptDecoder`);
  }
  assert.equal(vectors.cases.length, 8);
  assert.throws(() => decoders.decodeMeshoptBuffer(bytes(vectors.vertexCodecV1), 300, 16, 'ATTRIBUTES'), /version 1 is not supported/);
  const attributes = vectors.cases[0], encoded = bytes(attributes.encoded);
  for (const cut of [1, 17, encoded.length - 1]) assert.throws(() => decoders.decodeMeshoptBuffer(encoded.subarray(0, cut), attributes.count, attributes.stride, 'ATTRIBUTES'), /truncated|trailing|missing/);
  assert.throws(() => decoders.decodeMeshoptBuffer(encoded, attributes.count, attributes.stride, 'BOGUS'), /unknown mode/);
  assert.throws(() => decoders.decodeMeshoptBuffer(encoded, attributes.count, attributes.stride, 'ATTRIBUTES', 'BOGUS'), /unknown filter/);
});
