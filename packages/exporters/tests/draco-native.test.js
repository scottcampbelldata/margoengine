import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compressDraco } from '@margoengine/exporters/draco';
import { exportGLB, splitGLB } from '@margoengine/exporters';
import { encodeNativeMesh, loadNativeEncoder } from '../dist/draco-native-encode.js';
import { decodeNativeDraco } from '../../decoders/dist/draco-native-codec.js';
import { decodeDraco } from '../../decoders/dist/codec.js';

const encoder = await loadNativeEncoder(new URL('../dist/draco-native-encoder.wasm', import.meta.url).href);
const {
  instance: { exports: decoder },
} = await WebAssembly.instantiate(readFileSync(new URL('../../decoders/dist/draco-native.wasm', import.meta.url)));
globalThis.require ??= createRequire(import.meta.url);
globalThis.__dirname ??= fileURLToPath(new URL('.', import.meta.url));
(0, eval)(readFileSync(new URL('../../decoders/dist/draco-full/draco_wasm_wrapper.js', import.meta.url), 'utf8'));
const { module: old } = await new Promise((resolve, reject) => {
  globalThis
    .DracoDecoderModule({
      wasmBinary: readFileSync(new URL('../../decoders/dist/draco-full/draco_decoder.wasm', import.meta.url)),
    })
    .then((module) => resolve({ module }), reject);
});
const attr = (semantic, kind, width, values, bits = 0, normalized = false) => ({
  semantic,
  kind,
  width,
  values,
  bits,
  normalized,
});
const component = (a) =>
  a instanceof Float32Array
    ? 5126
    : a instanceof Uint32Array
      ? 5125
      : a instanceof Uint16Array
        ? 5123
        : a instanceof Int16Array
          ? 5122
          : a instanceof Int8Array
            ? 5120
            : 5121;
const request = (attributes) => ({
  attributeIds: Object.fromEntries(attributes.map((a, i) => [a.semantic, i])),
  componentTypes: Object.fromEntries(attributes.map((a) => [a.semantic, component(a.values)])),
});

function checked(job) {
  const result = encodeNativeMesh(encoder, job),
    options = request(job.attributes);
  const ours = decodeNativeDraco(decoder, result.data, options);
  assert.deepEqual(ours, decodeDraco(old, result.data, options));
  assert.equal(ours.vertexCount, result.points);
  assert.equal(ours.indices.length, result.faces * 3);
  return { result, decoded: ours };
}

function triangles(indices, ids) {
  const out = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = Array.from(indices.slice(i, i + 3), (v) => ids[v]);
    out.push([a, [a[1], a[2], a[0]], [a[2], a[0], a[1]]].map((a) => a.join(',')).sort()[0]);
  }
  return out.sort();
}

test('both topology methods retain oriented nonmanifold, degenerate and disconnected triangles', {
  timeout: 30000,
}, () => {
  for (const indices of [
    [0, 1, 2, 2, 1, 3],
    [0, 1, 2, 1, 0, 3, 0, 1, 4],
    [0, 0, 1, 1, 1, 2],
    [0, 1, 2, 0, 3, 4],
  ]) {
    const points = Math.max(...indices) + 1;
    for (const encodeSpeed of [0, 5, 8, 10]) {
      const attributes = [
        attr(
          'POSITION',
          'POSITION',
          3,
          Float32Array.from({ length: points * 3 }, (_, i) => (i * 7) % 17),
        ),
        attr(
          '_ID',
          'GENERIC',
          1,
          Uint32Array.from({ length: points }, (_, i) => i),
        ),
      ];
      const { decoded } = checked({
        points,
        indices: new Uint32Array(indices),
        attributes,
        encodeSpeed,
        decodeSpeed: 5,
      });
      assert.deepEqual(
        triangles(decoded.indices, decoded.attributes._ID.array),
        triangles(
          indices,
          Uint32Array.from({ length: points }, (_, i) => i),
        ),
      );
    }
  }
});

test('portable transforms retain integer boundaries, normalized flags and exact floats', { timeout: 30000 }, () => {
  const attributes = [
    attr('POSITION', 'POSITION', 3, new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])),
    attr('_UINT', 'GENERIC', 1, new Uint32Array([0, 4294967295, 2147483648, 16777217])),
    attr('_SINT', 'GENERIC', 2, new Int16Array([-32768, 32767, 0, -1, 30000, -30000, 1, 1024])),
    attr('_ID', 'GENERIC', 1, new Uint16Array([0, 1, 2, 3])),
  ];
  for (const encodeSpeed of [0, 5, 10]) {
    const { decoded } = checked({
      points: 4,
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      attributes,
      encodeSpeed,
      decodeSpeed: 5,
    });
    for (let i = 0; i < decoded.vertexCount; i++) {
      const id = decoded.attributes._ID.array[i];
      assert.equal(decoded.attributes._UINT.array[i], attributes[1].values[id]);
      assert.deepEqual(
        Array.from(decoded.attributes._SINT.array.slice(i * 2, i * 2 + 2)),
        Array.from(attributes[2].values.slice(id * 2, id * 2 + 2)),
      );
    }
  }
});

test('position seams share a grid while every UV corner and exact weight survives', { timeout: 30000 }, () => {
  const attributes = [
    attr(
      'WEIGHTS_0',
      'GENERIC',
      4,
      new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    ),
    attr('POSITION', 'POSITION', 3, new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]), 14),
    attr('TEXCOORD_0', 'TEX_COORD', 2, new Float32Array([0, 0, 1, 0, 1, 1, 0.25, 0, 0.75, 1, 0, 1]), 12),
  ];
  const { decoded } = checked({
    points: 6,
    indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    attributes,
    encodeSpeed: 5,
    decodeSpeed: 5,
  });
  assert.equal(decoded.vertexCount, 6);
  assert.equal(decoded.indices.length, 6);
  for (let i = 0; i < decoded.vertexCount; i++)
    assert.deepEqual(Array.from(decoded.attributes.WEIGHTS_0.array.slice(i * 4, i * 4 + 4)), [1, 0, 0, 0]);
});

test('the default optional entry uses only the clean-room encoder asset', { timeout: 30000 }, async () => {
  const glb = exportGLB({
    nodes: [
      {
        geometry: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] },
      },
    ],
  });
  const result = await compressDraco(glb);
  assert.equal(result.compressed, 1);
  const parts = splitGLB(result.glb);
  assert.ok(parts.json.meshes[0].primitives[0].extensions.KHR_draco_mesh_compression);
  const source = readFileSync(new URL('../dist/draco.js', import.meta.url), 'utf8');
  assert.match(source, /draco-native-encoder\.wasm/);
  assert.doesNotMatch(source, /new URL\(['"]\.\/draco-encoder\//);
});

test('malformed packets reject and repeated encode/free cycles keep linear memory bounded', { timeout: 30000 }, () => {
  const pointer = encoder.encoder_alloc(16);
  try {
    new Uint8Array(encoder.memory.buffer, pointer, 16).fill(0);
    assert.equal(encoder.encoder_encode(pointer, 16), 1);
    assert.equal(encoder.encoder_output_length(), 0);
  } finally {
    encoder.encoder_free(pointer, 16);
    encoder.encoder_clear();
  }
  const job = {
    points: 3,
    indices: new Uint32Array([0, 1, 2]),
    attributes: [attr('POSITION', 'POSITION', 3, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 14)],
    encodeSpeed: 5,
    decodeSpeed: 5,
  };
  for (let i = 0; i < 20; i++) encodeNativeMesh(encoder, job);
  const memory = encoder.memory.buffer.byteLength;
  for (let i = 0; i < 256; i++) encodeNativeMesh(encoder, job);
  assert.equal(encoder.memory.buffer.byteLength, memory);
});

test('octahedral reconstruction beats the old encoder maximum error on 3000 fixed normal directions', {
  timeout: 30000,
}, () => {
  let random = 0x136aaf;
  const next = () => {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    return (random >>> 0) / 4294967296;
  };
  const points = 3000,
    positions = Float32Array.from({ length: points * 3 }, () => next() * 40 - 20),
    normals = new Float32Array(points * 3);
  for (let i = 0; i < points; i++) {
    const v = [next() * 2 - 1, next() * 2 - 1, next() * 2 - 1],
      length = Math.hypot(...v);
    normals.set(
      v.map((v) => v / length),
      i * 3,
    );
  }
  // Opaque old encoder 1.5.7, same vectors/settings, decoded through its full decoder.
  const legacy = [
    [2, 1.3918618750389131],
    [3, 0.5856641880624243],
    [8, 0.015625440887025267],
    [10, 0.003738358796769952],
    [16, 0.000060128126045140624],
    [24, 3.8628224721001747e-7],
  ];
  for (const [bits, maximum] of legacy) {
    const attributes = [
      attr('POSITION', 'POSITION', 3, positions),
      attr('NORMAL', 'NORMAL', 3, normals, bits),
      attr(
        '_ID',
        'GENERIC',
        1,
        Uint32Array.from({ length: points }, (_, i) => i),
      ),
    ];
    const { decoded } = checked({
      points,
      indices: Uint32Array.from({ length: points }, (_, i) => i),
      attributes,
      encodeSpeed: 5,
      decodeSpeed: 5,
    });
    let error = 0;
    for (let i = 0; i < decoded.vertexCount; i++) {
      const id = decoded.attributes._ID.array[i];
      error = Math.max(error, Math.hypot(...[0, 1, 2].map((k) => decoded.normals[i * 3 + k] - normals[id * 3 + k])));
    }
    assert.ok(error <= maximum, `${bits} bits: ${error} exceeds opaque encoder ${maximum}`);
  }
});

test('bulk Wasm output uses eight boundary calls independently of encoded byte count', { timeout: 30000 }, () => {
  for (const points of [3, 3000]) {
    let calls = 0;
    const counted = new Proxy({ ...encoder }, {
      get(target, key) {
        const value = target[key];
        return typeof value === 'function'
          ? (...args) => {
              calls++;
              return value(...args);
            }
          : value;
      },
    });
    const result = encodeNativeMesh(counted, {
      points,
      indices: Uint32Array.from({ length: points }, (_, i) => i),
      attributes: [
        attr(
          'POSITION',
          'POSITION',
          3,
          Float32Array.from({ length: points * 3 }, (_, i) => (i * 17) % 193),
          14,
        ),
      ],
      encodeSpeed: 10,
      decodeSpeed: 10,
    });
    assert.equal(calls, 8);
    assert.ok(result.data.length > calls);
  }
});

test('thirty-bit normal quantization remains representable without an upstream encoder abort', { timeout: 30000 }, () => {
  const normals = new Float32Array([-1,0,0, 0,-1,0, 0,0,-1]);
  const job = { points: 3, indices: new Uint32Array([0,1,2]), attributes: [attr('POSITION', 'POSITION', 3, new Float32Array([0,0,0, 1,0,0, 0,1,0]), 30), attr('NORMAL', 'NORMAL', 3, normals, 30), attr('_ID', 'GENERIC', 1, new Uint16Array([0,1,2]))], encodeSpeed: 5, decodeSpeed: 5 };
  const { decoded } = checked(job);
  for (let i = 0; i < decoded.vertexCount; i++) {
    const id = decoded.attributes._ID.array[i];
    assert.deepEqual(Array.from(decoded.normals.slice(i * 3, i * 3 + 3)), Array.from(normals.slice(id * 3, id * 3 + 3)));
  }
  assert.throws(() => encodeNativeMesh(encoder, { ...job, attributes: job.attributes.map(a => a.kind === 'NORMAL' ? { ...a, bits: 1 } : a) }), RangeError);
});
