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

test('already aborted decoder jobs reject before copying input or starting workers', async () => {
  const globals = ['window', 'Worker'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  let copies = 0, workers = 0;
  globalThis.window = {};
  globalThis.Worker = class {constructor() {workers++; throw new Error('unexpected worker');}};
  const source = new ArrayBuffer(1024), slice = source.slice.bind(source);
  source.slice = (...args) => {copies++; return slice(...args);};
  const controller = new AbortController(), reason = new Error('cancelled before decoding');
  controller.abort(reason);
  const draco = new decoders.DracoDecoder(), ktx2 = new decoders.KTX2Decoder();
  try {
    for (const [decoder, method] of [[draco, 'decode'], [ktx2, 'transcode']]) {
      for (const input of [source, new Uint8Array(source, 128, 512)]) {
        await assert.rejects(decoder[method](input, {signal: controller.signal}), error => error === reason);
      }
      assert.equal(copies, 0, 'cancelled jobs must not duplicate large compressed payloads');
      assert.equal(workers, 0);
      assert.equal(source.byteLength, 1024);
      const nullReason = new AbortController();
      nullReason.abort(null);
      await assert.rejects(decoder[method](source, {signal: nullReason.signal, transfer: true}), error => error.name === 'AbortError');
    }
  } finally {
    draco.dispose(); ktx2.dispose();
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
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
function mockDraco({kind = 1, ok = true, attributes = {POSITION: 3}, points = 4, faces = 2, attributeTypes = {}, normalized = [], values = {}} = {}) {
  const log = {created: [], destroyed: [], malloc: [], free: [], reads: []}, heap = new ArrayBuffer(4096);
  let top = 8;
  const handle = name => {const h = {ptr: 1, name}; log.created.push(h); return h;};
  const attribute = id => {
    const semantic = Object.keys(attributes)[id];
    return semantic === undefined ? {ptr: 0} : {ptr: 1, semantic, num_components: () => attributes[semantic], data_type: () => attributeTypes[semantic] ?? 9, normalized: () => normalized.includes(semantic)};
  };
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
        GetAttribute: (_g, id) => attribute(id),
        GetAttributeByUniqueId: (_g, id) => attribute(id),
        GetAttributeDataArrayForAllPoints: (_g, a, type, bytes, ptr) => {
          log.reads.push('attribute');
          const Ctor = {1: Int8Array, 2: Uint8Array, 3: Int16Array, 4: Uint16Array, 6: Uint32Array, 9: Float32Array}[type];
          const array = new Ctor(heap, ptr, bytes / Ctor.BYTES_PER_ELEMENT), source = values[a.semantic] ?? [0.5];
          const scale = type === 9 && a.normalized() ? ({1: 127, 2: 255, 3: 32767, 4: 65535, 6: 4294967295}[a.data_type()] ?? 1) : 1;
          array.forEach((_, i) => {array[i] = source[i % source.length] / scale;});
          return true;
        },
        GetTrianglesUInt16Array: (_g, bytes, ptr) => {log.reads.push('indices16'); new Uint16Array(heap, ptr, bytes / 2).forEach((_, i, a) => {a[i] = i % points;}); return true;},
        GetTrianglesUInt32Array: () => {log.reads.push('indices32'); return true;},
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

test('Draco named channels honor accessor component types and normalize colors once', () => {
  const config = {attributes: {POSITION: 3, TEXCOORD_0: 2, COLOR_0: 4}, points: 3, faces: 1,
    attributeTypes: {TEXCOORD_0: 2, COLOR_0: 2}, normalized: ['TEXCOORD_0', 'COLOR_0'],
    values: {TEXCOORD_0: [0, 255], COLOR_0: [255, 128, 0, 255]}};
  const {draco} = mockDraco(config);
  const result = decodeDraco(draco, new Uint8Array(8), {attributeIds: {POSITION: 0, TEXCOORD_0: 1, COLOR_0: 2}, componentTypes: {POSITION: 5126, TEXCOORD_0: 5121, COLOR_0: 5121}});
  assert.ok(result.uvs instanceof Float32Array && result.colors instanceof Float32Array, 'named channel public types stay Float32');
  assert.deepEqual([...result.uvs], [0, 255, 0, 255, 0, 255], 'integer UVs remain raw for accessor normalization');
  assert.deepEqual([...result.colors.slice(0, 4)], [1, Math.fround(128 / 255), 0, 1]);
  const defaults = decodeDraco(draco, new Uint8Array(8));
  assert.deepEqual([...defaults.uvs], [0, 1, 0, 1, 0, 1], 'native float conversion already normalizes Draco integer UVs');
  assert.deepEqual([...defaults.colors.slice(0, 4)], [1, Math.fround(128 / 255), 0, 1], 'default colors are not normalized twice');
  const unnormalized = mockDraco({...config, normalized: []}).draco;
  assert.deepEqual([...decodeDraco(unnormalized, new Uint8Array(8)).colors.slice(0, 4)], [1, Math.fround(128 / 255), 0, 1], 'default integer colors retain normalized output');
});

test('Draco chooses triangle extraction below, at and above the native 65,536-vertex boundary', () => {
  for (const [points, IndexArray] of [[65535, Uint16Array], [65536, Uint32Array], [65537, Uint32Array]]) {
    const {draco} = mockDraco({points});
    const Decoder = draco.Decoder, expected = [0, 1, points - 1, points - 1, 1, 0];
    draco.Decoder = function () {
      const decoder = new Decoder();
      decoder.GetTrianglesUInt16Array = (_geometry, bytes, pointer) => {
        if (points >= 65536) return false;
        new Uint16Array(draco.HEAPU8.buffer, pointer, bytes / 2).set(expected); return true;
      };
      decoder.GetTrianglesUInt32Array = (_geometry, bytes, pointer) => {
        new Uint32Array(draco.HEAPU8.buffer, pointer, bytes / 4).set(expected); return true;
      };
      return decoder;
    };
    const result = decodeDraco(draco, new Uint8Array(8), {attributeIds: {}});
    assert.ok(result.indices instanceof IndexArray, `${points} vertices use ${IndexArray.name}`);
    assert.deepEqual([...result.indices], expected, 'the highest vertex index never wraps');
  }
});

test('Draco preflights every count, width and combined output budget before allocating or extracting output', () => {
  const cases = [
    [{points: 1_000_001}, {limits: {maxVertices: 1_000_000}}, /vertex/],
    [{points: 16_777_217}, {limits: {maxVertices: Number.MAX_SAFE_INTEGER}}, /vertex/],
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(points => [{points}, {}, /vertex/]),
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(faces => [{faces}, {}, /face/]),
    [{faces: Number.MAX_SAFE_INTEGER}, {}, /index/],
    [{faces: 3}, {limits: {maxIndices: 6}}, /index/],
    [{}, {limits: {maxIndices: 0}}, /index/],
    [{}, {limits: {maxDecodedBytes: 11}}, /byte/],
    [{attributes: {POSITION: 3, NORMAL: 3}}, {limits: {maxDecodedBytes: 100}}, /byte/], // 48 + 48 + 12 > 100.
    [{attributes: {POSITION: 3, NORMAL: 3}}, {limits: {attributeWidths: {POSITION: 3, NORMAL: 2}}}, /NORMAL width/],
    ...[0, -1, 1.5, NaN, Infinity, 17].map(width => [{attributes: {POSITION: 3, NORMAL: width}}, {}, /NORMAL width/]),
    [{attributes: {POSITION: 3, NORMAL: 3}}, {attributeIds: {POSITION: 0, NORMAL: 99}}, /missing attribute NORMAL/],
    [{attributes: {POSITION: 3, NORMAL: 3}}, {attributeIds: {POSITION: 0, NORMAL: 1}, componentTypes: {NORMAL: 1234}}, /component type/],
    [{kind: 2, points: 1_048_576, attributes: {POSITION: 16, A: 16, B: 16, C: 16, D: 16}}, {attributeIds: {POSITION: 0, A: 1, B: 2, C: 3, D: 4}, limits: {maxDecodedBytes: Number.MAX_SAFE_INTEGER}}, /byte/],
  ];
  for (const [options, request, pattern] of cases) {
    const {draco, log} = mockDraco(options);
    assert.throws(() => decodeDraco(draco, new Uint8Array(8), request), pattern);
    assert.deepEqual(log.malloc, [], 'all descriptors are checked before the first output malloc');
    assert.deepEqual(log.reads, [], 'invalid output metadata never reaches Draco extraction');
    assert.deepEqual(new Set(log.destroyed), new Set(log.created), 'preflight failure releases geometry and decoder handles');
  }
});

test('Draco output limits accept exact boundaries and account for final float32 named channels', () => {
  const {draco, log} = mockDraco({attributes: {POSITION: 3, NORMAL: 3}});
  const result = decodeDraco(draco, new Uint8Array(8), {limits: {maxVertices: 4, maxIndices: 6, maxDecodedBytes: 108, attributeWidths: {POSITION: 3, NORMAL: 3}}});
  assert.equal(result.positions.byteLength + result.normals.byteLength + result.indices.byteLength, 108);
  assert.equal(log.malloc.length, 3);
  assert.deepEqual([...log.free].sort(), [...log.malloc].sort());
  const integer = mockDraco();
  assert.throws(() => decodeDraco(integer.draco, new Uint8Array(8), {componentTypes: {POSITION: 5121}, limits: {maxDecodedBytes: 59}}), /byte/);
  assert.deepEqual(integer.log.malloc, [], 'integer named channels are budgeted at their final Float32Array byte length');
  assert.deepEqual(integer.log.reads, []);
  const cloud = mockDraco({kind: 2});
  assert.equal(decodeDraco(cloud.draco, new Uint8Array(8), {limits: {maxIndices: 0, maxDecodedBytes: 48}}).indices, undefined);
});

test('invalid Draco limits reject before handles, payload copies, input transfer or worker creation', async () => {
  const globals = ['window', 'Worker'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  let copies = 0, workers = 0;
  globalThis.window = {};
  globalThis.Worker = class {constructor() {workers++; throw new Error('unexpected worker');}};
  const source = new ArrayBuffer(1024), slice = source.slice.bind(source), decoder = new decoders.DracoDecoder();
  source.slice = (...args) => {copies++; return slice(...args);};
  const invalid = [null, [], 4, {maxVertices: 0}, {maxIndices: -1}, {maxDecodedBytes: 0}, {attributeWidths: null}, {attributeWidths: []}, {attributeWidths: {POSITION: 0}}, {attributeWidths: {POSITION: 17}}, {attributeWidths: {POSITION: 1.5}}];
  for (const name of ['maxVertices', 'maxIndices', 'maxDecodedBytes']) for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '4']) invalid.push({[name]: value});
  try {
    for (const limits of invalid) {
      const {draco, log} = mockDraco();
      assert.throws(() => decodeDraco(draco, new Uint8Array(8), {limits}), /Draco:/);
      assert.deepEqual(log.created, [], 'invalid requests never initialize Draco handles');
      for (const transfer of [false, true]) await assert.rejects(decoder.decode(source, {limits, transfer}), /Draco:/);
      assert.equal(source.byteLength, 1024);
    }
    assert.equal(copies, 0);
    assert.equal(workers, 0);
  } finally {
    decoder.dispose();
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('DracoDecoder carries validated output limits to the worker without changing transfer ownership', async () => {
  const globals = ['window', 'Worker'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  FakeWorker.created = [];
  globalThis.window = {};
  globalThis.Worker = class extends FakeWorker {constructor() {super((worker, message) => worker.reply({id: message.id, result: message.request}));}};
  const decoder = new decoders.DracoDecoder(), source = new ArrayBuffer(8), limits = {maxVertices: 4, maxIndices: 6, maxDecodedBytes: 108, attributeWidths: {POSITION: 3, NORMAL: 3}};
  try {
    const request = await decoder.decode(source, {attributeIds: {POSITION: 0, NORMAL: 1}, limits, transfer: true});
    assert.equal(source.byteLength, 0);
    assert.deepEqual(request.limits, limits);
    assert.deepEqual(request.attributeIds, {POSITION: 0, NORMAL: 1});
    const {draco, log} = mockDraco({points: 5, attributes: {POSITION: 3, NORMAL: 3}});
    assert.throws(() => decodeDraco(draco, new Uint8Array(8), request), /vertex/);
    assert.deepEqual(log.malloc, []);
    assert.deepEqual(log.reads, []);
  } finally {
    decoder.dispose();
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
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
    const normalsOnly = decodeDraco(draco, bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength), {attributeIds: {NORMAL: ext.attributes.NORMAL}});
    assert.equal(normalsOnly.vertexCount, position.count, `${name} explicit subset retains vertex count`);
    assert.ok(normalsOnly.positions instanceof Float32Array);
    assert.equal(normalsOnly.positions.length, 0, `${name} explicit subset does not require POSITION`);
    assert.deepEqual(normalsOnly.normals, result.normals, `${name} requested NORMAL channel is decoded`);
    assert.throws(() => decodeDraco(draco, bin, {attributeIds: {NORMAL: 999999}}), /missing attribute NORMAL/);
    assert.throws(() => decodeDraco(draco, bin, {attributeIds: {POSITION: 999999}}), /missing attribute POSITION/);
    if (name === 'Avocado') {assert.equal(result.uvs.length, position.count * 2); assert.equal(result.attributes.TANGENT.itemSize, 4); assert.ok(result.attributes.TANGENT.array instanceof Float32Array);}
  }
  const doc = JSON.parse(await fixture('Avocado.gltf')), bin = await fixture('Avocado.bin'), ext = doc.meshes[0].primitives[0].extensions.KHR_draco_mesh_compression;
  for (let i = 0; i < 20; i++) decodeDraco(draco, bin, {attributeIds: ext.attributes});
  const settled = draco.HEAPU8.length;
  for (let i = 0; i < 200; i++) decodeDraco(draco, bin, {attributeIds: ext.attributes});
  assert.equal(draco.HEAPU8.length, settled, 'Wasm heap stays flat, so handles and buffers are released');
});

test('real Draco normalized UVs and colors retain their accessor and default decoder semantics', async () => {
  const {module: draco} = await initDraco(base + 'draco/draco_wasm_wrapper.js', base + 'draco/draco_decoder.wasm');
  const doc = JSON.parse(await fixture('NormalizedTriangle.gltf')), bytes = await fixture('NormalizedTriangle.bin');
  const primitive = doc.meshes[0].primitives[0], attributeIds = primitive.extensions.KHR_draco_mesh_compression.attributes;
  const componentTypes = Object.fromEntries(Object.keys(attributeIds).map(semantic => [semantic, doc.accessors[primitive.attributes[semantic]].componentType]));
  const requested = decodeDraco(draco, bytes, {attributeIds, componentTypes});
  assert.deepEqual([...requested.uvs], [0, 0, 255, 0, 0, 255]);
  const colors = [255, 128, 0, 255, 0, 255, 128, 255, 128, 0, 255, 255].map(value => Math.fround(value / 255));
  assert.deepEqual([...requested.colors], colors, 'requested integer colors normalize once');
  const defaults = decodeDraco(draco, bytes, {attributeIds});
  assert.deepEqual([...defaults.uvs], [0, 0, 1, 0, 0, 1], 'native float extraction honors the normalized flag');
  assert.deepEqual([...defaults.colors], colors, 'native normalized colors do not divide by 255 twice');
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
