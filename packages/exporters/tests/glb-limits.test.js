// exportGLB output limits: maxBinaryBytes (the aligned BIN payload) and maxBytes (the whole GLB), exact at the boundary,
// checked before data is normalized, copied or allocated. Allocation is observed by wrapping the typed-array
// constructors and TextEncoder.encode while an over-limit export runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportGLB } from '../dist/index.js';

const quad = () => ({
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 1, 1],
  indices: [0, 1, 2],
});
// PNG signature plus filler: enough for the writer, which embeds image bytes as they are.
const png = (length) => {
  const bytes = new Uint8Array(length).fill(7);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
  return bytes;
};
const sizes = (glb) => {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength),
    json = view.getUint32(12, true);
  return { total: view.getUint32(8, true), json, bin: 20 + json < glb.length ? view.getUint32(20 + json, true) : 0 };
};
const triangle = (vertices) => ({
  positions: new Float32Array(vertices * 3).fill(0).map((_, i) => (i === 3 || i === 7 ? 1 : 0)),
  normals: new Float32Array(vertices * 3).fill(1),
  indices: [0, 1, 2],
});

test('maxBinaryBytes and maxBytes accept the exact size and refuse one byte less', () => {
  const scene = {
      nodes: [{ geometry: quad(), material: { baseColorTexture: { image: png(1001), mimeType: 'image/png' } } }],
    },
    free = exportGLB(scene),
    { total, bin } = sizes(free);
  assert.equal(total, free.length);
  assert.deepEqual(exportGLB(scene, { maxBinaryBytes: bin, maxBytes: total }), free, 'same bytes with limits');
  assert.throws(() => exportGLB(scene, { maxBinaryBytes: bin - 1 }), /over maxBinaryBytes/);
  assert.throws(() => exportGLB(scene, { maxBytes: total - 1 }), /over maxBytes/);
  // BIN only: a BIN limit equal to the payload passes although the whole file is larger.
  assert.ok(total > bin);
  assert.equal(exportGLB(scene, { maxBinaryBytes: bin }).length, total);
});

test('padding and index width are counted: 78 data bytes are an 80-byte BIN', () => {
  const scene = { nodes: [{ geometry: { ...quad(), uvs: undefined } }] },
    { bin } = sizes(exportGLB(scene));
  assert.equal(bin, 36 + 36 + 8, 'POSITION 36, NORMAL 36, three 16-bit indices 6 padded to 8');
  assert.equal(exportGLB(scene, { maxBinaryBytes: 80 }).length > 0, true);
  assert.throws(() => exportGLB(scene, { maxBinaryBytes: 79 }), /needs at least 80 bytes/);
  // 65,535 vertices keep 16-bit indices; 65,536 switch to 32-bit ones (65,535 is the restart value).
  const short = sizes(exportGLB({ nodes: [{ geometry: triangle(65535) }] })).bin,
    long = sizes(exportGLB({ nodes: [{ geometry: triangle(65536) }] })).bin;
  assert.equal(short, 65535 * 24 + 8);
  assert.equal(long, 65536 * 24 + 12);
  assert.throws(() => exportGLB({ nodes: [{ geometry: triangle(65536) }] }, { maxBinaryBytes: long - 1 }), RangeError);
});

test('JSON-heavy scenes meet maxBytes, texture-heavy ones both limits', () => {
  const notes = { text: 'é'.repeat(50_000) }, // two UTF-8 bytes each
    json = { nodes: [{ geometry: quad(), extras: notes }] },
    small = sizes(exportGLB(json));
  assert.ok(small.json > 100_000 && small.bin < 200, 'large JSON, small BIN');
  assert.equal(exportGLB(json, { maxBinaryBytes: small.bin }).length, small.total);
  assert.throws(() => exportGLB(json, { maxBytes: small.total - 1 }), /JSON chunk/);
  assert.equal(exportGLB(json, { maxBytes: small.total }).length, small.total);
  const texture = { image: png(300_001), mimeType: 'image/png' },
    heavy = { nodes: [{ geometry: quad(), material: { baseColorTexture: texture } }] },
    size = sizes(exportGLB(heavy));
  assert.equal(size.bin, 36 + 36 + 24 + 8 + 300_004);
  assert.throws(() => exportGLB(heavy, { maxBinaryBytes: 300_000 }), /over maxBinaryBytes/);
  assert.throws(() => exportGLB(heavy, { maxBytes: 300_000 }), /over maxBytes/);
});

test('limits are validated; sizes past safe integers throw before allocating; inputs stay unchanged', () => {
  const scene = { nodes: [{ geometry: quad() }] };
  for (const bad of [-1, 1.5, Number.NaN, Infinity, 2 ** 32, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => exportGLB(scene, { maxBytes: bad }), RangeError, String(bad));
    assert.throws(() => exportGLB(scene, { maxBinaryBytes: bad }), RangeError, String(bad));
  }
  assert.throws(() => exportGLB(scene, { maxBytes: '100' }), TypeError);
  assert.ok(exportGLB(scene, { maxBytes: 2 ** 32 - 1 }).length > 0);
  assert.ok(exportGLB({ nodes: [{ name: 'Empty' }] }, { maxBinaryBytes: 0 }).length > 0, 'no BIN chunk at all');
  // An array-like claiming 2^52 vertices: its byte count passes 2^53 and is refused before anything is copied.
  const huge = { length: 3 * 2 ** 52 };
  assert.throws(() => exportGLB({ nodes: [{ geometry: { positions: huge, normals: huge } }] }), RangeError);
  const before = structuredClone(scene);
  assert.throws(() => exportGLB(scene, { maxBytes: 10 }), RangeError);
  assert.deepEqual(scene, before);
});

/** Runs `fn` with the typed-array constructors and TextEncoder.encode wrapped; returns the largest allocation. */
function largestAllocation(fn) {
  const saved = {},
    sizes = [],
    kinds = ['Uint8Array', 'Uint16Array', 'Uint32Array', 'Float32Array', 'Float64Array'];
  for (const kind of kinds) {
    const Original = (saved[kind] = globalThis[kind]);
    globalThis[kind] = new Proxy(Original, {
      construct(target, args) {
        const array = Reflect.construct(target, args);
        sizes.push(array.byteLength);
        return array;
      },
    });
  }
  const encode = TextEncoder.prototype.encode;
  TextEncoder.prototype.encode = function (text) {
    const out = encode.call(this, text);
    sizes.push(out.byteLength);
    return out;
  };
  let error;
  try {
    fn();
  } catch (caught) {
    error = caught;
  } finally {
    Object.assign(globalThis, saved);
    TextEncoder.prototype.encode = encode;
  }
  return { error, largest: Math.max(0, ...sizes) };
}

test('an over-limit export throws before any buffer near its size is allocated', () => {
  const budget = 64 * 1024;
  // Vertex-heavy: 24 MiB of attributes, refused when planned, before normalization copies them.
  const vertices = 1 << 19,
    heavy = {
      positions: new Float32Array(vertices * 3),
      normals: new Float32Array(vertices * 3).fill(1),
      indices: [0, 1, 2],
    },
    rejected = largestAllocation(() => exportGLB({ nodes: [{ geometry: heavy }] }, { maxBinaryBytes: budget }));
  assert.ok(rejected.error instanceof RangeError, String(rejected.error));
  assert.ok(rejected.largest < budget, `largest allocation ${rejected.largest}`);
  // Control: without a limit the same instrumentation sees the normalized copies and the GLB.
  const free = largestAllocation(() => exportGLB({ nodes: [{ geometry: heavy }] }));
  assert.equal(free.error, undefined);
  assert.ok(free.largest > vertices * 24, `largest allocation ${free.largest}`);
  // Index-heavy: 3 vertices drawn 1,048,576 times; the 12 MiB index list is refused before it is copied.
  const indexed = { ...quad(), uvs: undefined, indices: new Uint32Array(3 << 20).map((_, i) => i % 3) },
    listed = largestAllocation(() => exportGLB({ nodes: [{ geometry: indexed }] }, { maxBinaryBytes: budget }));
  assert.ok(listed.error instanceof RangeError, String(listed.error));
  assert.ok(listed.largest < budget, `largest allocation ${listed.largest}`);
  // Texture-heavy: an 8 MiB image is never copied.
  const image = png(8 << 20),
    textured = { nodes: [{ geometry: quad(), material: { baseColorTexture: { image, mimeType: 'image/png' } } }] },
    texture = largestAllocation(() => exportGLB(textured, { maxBytes: budget }));
  assert.ok(texture.error instanceof RangeError);
  assert.ok(texture.largest < budget, `largest allocation ${texture.largest}`);
  // JSON-heavy: 1 MiB of extras is serialized but never encoded or copied into a GLB.
  const notes = { nodes: [{ geometry: quad(), extras: { text: 'x'.repeat(1 << 20) } }] },
    json = largestAllocation(() => exportGLB(notes, { maxBytes: budget }));
  assert.match(String(json.error), /JSON chunk/);
  assert.ok(json.largest < budget, `largest allocation ${json.largest}`);
});
