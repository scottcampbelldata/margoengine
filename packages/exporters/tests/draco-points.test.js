// encodeDraco: bare .drc streams for triangle meshes and point clouds. Every stream is read back by Draco's own full
// decoder (the independent reference) and by Margo's native decoder.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { encodeDraco } from '@margoengine/exporters/draco';
import { decodeDraco, decodeDracoPoints } from '../../decoders/dist/codec.js';
import { decodeNativeDraco, decodeNativePoints } from '../../decoders/dist/draco-native-codec.js';

globalThis.require ??= createRequire(import.meta.url);
globalThis.__dirname ??= fileURLToPath(new URL('.', import.meta.url));
const dist = new URL('../../decoders/dist/', import.meta.url);
(0, eval)(readFileSync(new URL('draco-full/draco_wasm_wrapper.js', dist), 'utf8'));
const { module: google } = await new Promise((resolve, reject) => {
  globalThis
    .DracoDecoderModule({ wasmBinary: readFileSync(new URL('draco-full/draco_decoder.wasm', dist)) })
    .then((module) => resolve({ module }), reject);
});
const {
  instance: { exports: native },
} = await WebAssembly.instantiate(readFileSync(new URL('draco-native.wasm', dist)));

/** Both decoders on one cloud; they must agree on every value. */
function cloud(data) {
  const reference = decodeDracoPoints(google, data),
    ours = decodeNativePoints(native, data),
    plain = ({ uniqueId, itemSize, array }) => ({ uniqueId, itemSize, array });
  assert.equal(ours.pointCount, reference.pointCount);
  assert.deepEqual(ours.attributes.map(plain), reference.attributes.map(plain));
  return reference;
}

// A repeatable random stream.
const random = (seed) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;

function survey(points, seed = 7) {
  const next = random(seed),
    positions = Float32Array.from({ length: points * 3 }, () => next() * 20 - 10),
    normals = new Float32Array(points * 3);
  for (let i = 0; i < points; i++) {
    const v = [next() - 0.5, next() - 0.5, next() - 0.5],
      length = Math.hypot(...v) || 1;
    normals.set(
      v.map((c) => c / length),
      i * 3,
    );
  }
  return {
    positions,
    normals,
    uvs: Float32Array.from({ length: points * 2 }, next),
    colors: Uint8Array.from({ length: points * 4 }, () => next() * 256),
    attributes: {
      id: { values: Uint32Array.from({ length: points }, (_, i) => i), width: 1 },
      offset: { values: Int16Array.from({ length: points * 2 }, () => next() * 600 - 300), width: 2 },
      flag: { values: Int8Array.from({ length: points }, () => next() * 256 - 128), width: 1 },
    },
  };
}

/** Checks every decoded point against the input point its `id` names, within each float attribute's grid step. */
function matches(decoded, input, ids, steps) {
  const by = new Map(decoded.attributes.map((a) => [a.uniqueId, a])),
    id = by.get(ids.id).array,
    // The input point each id names.
    at = new Map(Array.from(input.attributes.id.values, (value, i) => [value, i])),
    sources = {
      POSITION: input.positions,
      NORMAL: input.normals,
      TEXCOORD_0: input.uvs,
      COLOR_0: input.colors,
      ...Object.fromEntries(Object.entries(input.attributes).map(([name, a]) => [name, a.values])),
    };
  assert.equal(new Set(id).size, input.positions.length / 3, 'every point once');
  for (const [name, source] of Object.entries(sources)) {
    if (!source) continue;
    const { array, itemSize } = by.get(ids[name]),
      step = steps[name] ?? 0;
    assert.equal(array.constructor, source.constructor, name);
    for (let i = 0; i < id.length; i++)
      for (let c = 0; c < itemSize; c++) {
        const got = array[i * itemSize + c],
          want = source[at.get(id[i]) * itemSize + c];
        assert.ok(Math.abs(got - want) <= step, `${name} point ${id[i]}: ${got} for ${want}`);
      }
  }
}

const steps = { POSITION: 20 / 16383, NORMAL: 2 / 511, TEXCOORD_0: 1 / 4095 };

test('a point cloud at speed 10 is a sequential stream that keeps every point in order', {
  timeout: 60000,
}, async () => {
  const input = survey(700),
    copy = input.positions.slice(),
    { data, ids, points, faces } = await encodeDraco(input, { mode: 'points', encodeSpeed: 10 });
  assert.deepEqual([...data.subarray(0, 9)], [...Buffer.from('DRACO'), 2, 3, 0, 0]);
  assert.deepEqual([points, faces], [700, 0]);
  assert.deepEqual(input.positions, copy);
  const decoded = cloud(data);
  assert.deepEqual([...decoded.attributes.find((a) => a.uniqueId === ids.id).array], [...input.attributes.id.values]);
  matches(decoded, input, ids, steps);
});

/** 0 to points - 1 in a random order, so no method gets the ids for nothing. */
function shuffled(points) {
  const next = random(13),
    ids = Uint32Array.from({ length: points }, (_, i) => i);
  for (let i = points - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

/** A scan whose attributes follow its positions, as measured clouds do: 16 dimensions. */
function scan(points) {
  const next = random(11),
    positions = Float32Array.from({ length: points * 3 }, () => next() * 20 - 10),
    from = (Type, width, value) =>
      Type.from({ length: points * width }, (_, i) => value(positions[((i / width) | 0) * 3]));
  return {
    positions,
    normals: from(Float32Array, 3, (x) => (x < 0 ? -1 : 1) / Math.sqrt(3)),
    uvs: from(Float32Array, 2, (x) => (x + 10) / 20),
    colors: from(Uint8Array, 4, (x) => (x + 10) * 12),
    attributes: {
      id: { values: shuffled(points), width: 1 },
      offset: { values: from(Int16Array, 2, (x) => Math.round(x) - 5), width: 2 },
      flag: { values: from(Int8Array, 1, (x) => (x < 0 ? -128 : 127)), width: 1 },
    },
  };
}

/** 24 dimensions of one width: random bands beside the positions. */
function wide(points) {
  const next = random(17),
    band = () => ({ values: Uint16Array.from({ length: points * 4 }, () => next() * 16384), width: 4 });
  return {
    positions: scan(points).positions,
    attributes: { id: { values: shuffled(points), width: 1 }, a: band(), b: band(), c: band(), d: band(), e: band() },
  };
}

test('a point cloud below speed 10 takes the KD-tree stream where it is smaller', { timeout: 60000 }, async () => {
  // Up to 16 dimensions take level 6 (chosen axes), more take level 4 (axes in turn).
  for (const [input, level] of [
    [scan(5000), 6],
    [wide(5000), 4],
  ]) {
    const kd = await encodeDraco(input, { mode: 'points' }),
      ordered = await encodeDraco(input, { mode: 'points', decodeSpeed: 10 });
    assert.deepEqual([...kd.data.subarray(5, 9)], [2, 3, 0, 1], `level ${level}`);
    // The level byte follows the header, point count, decoder count and the attribute list (5 bytes an attribute).
    assert.equal(kd.data[11 + 4 + 1 + 1 + Object.keys(kd.ids).length * 5], level);
    assert.ok(kd.data.length < ordered.data.length, `${kd.data.length} against ${ordered.data.length}`);
    assert.equal(kd.points, 5000);
    // The KD-tree method has no octahedron transform: normals sit on a 10-bit grid over their range.
    matches(cloud(kd.data), input, kd.ids, steps);
  }
  // Positions alone: the tree codes how many points fall in each cell, not where each one is.
  const next = random(5),
    positions = Float32Array.from({ length: 60000 }, () => next()),
    kd = await encodeDraco({ positions }, { mode: 'points' }),
    ordered = await encodeDraco({ positions }, { mode: 'points', encodeSpeed: 10 });
  // A set of n different points carries log2(n!) bits fewer than the same points in a list, which bounds any coder of
  // uniform random positions: here 20,000 points of 3 x 14 bits.
  let order = 0;
  for (let i = 2; i <= 20000; i++) order += Math.log2(i);
  const bound = (20000 * 42 - order) / 8;
  assert.ok(kd.data.length < bound * 1.05, `${kd.data.length} bytes, bound ${Math.round(bound)}`);
  assert.ok(ordered.data.length > 20000 * 5, `${ordered.data.length} bytes in order`);
});

test('KD-tree corner cases: tiny, equal and duplicate points, full-width integers', { timeout: 60000 }, async () => {
  const next = random(3);
  for (const count of [1, 2, 3, 4, 5, 33, 257]) {
    // Few distinct values, so cells empty one side and run out of bits.
    const positions = Float32Array.from({ length: count * 3 }, () => Math.floor(next() * 3)),
      word = Uint32Array.from({ length: count }, () => next() * 2 ** 32),
      signed = Int16Array.from({ length: count }, (_, i) => (i % 2 ? 32767 : -32768)),
      input = {
        positions,
        attributes: { word: { values: word, width: 1 }, signed: { values: signed, width: 1 } },
      },
      { data, ids } = await encodeDraco(input, { mode: 'points', positionBits: 2 });
    const decoded = cloud(data),
      by = new Map(decoded.attributes.map((a) => [a.uniqueId, a.array])),
      rows = (p, w, s) => Array.from(w, (_, i) => [...p.slice(i * 3, i * 3 + 3), w[i], s[i]].join()).sort();
    assert.equal(decoded.pointCount, count);
    assert.deepEqual(
      rows(by.get(ids.POSITION).map(Math.round), by.get(ids.word), by.get(ids.signed)),
      rows(positions, word, signed),
      `${count} points`,
    );
  }
  // Every value equal: the tree has no bits at all.
  const same = await encodeDraco(
    { positions: new Float32Array(3), attributes: { n: { values: new Uint16Array(1), width: 1 } } },
    { mode: 'points' },
  );
  assert.equal(cloud(same.data).pointCount, 1);
  const zeros = new Uint16Array(300),
    flat = await encodeDraco({ positions: zeros }, { mode: 'points' });
  assert.deepEqual([...cloud(flat.data).attributes[0].array], new Array(300).fill(0));
});

test('canvas bytes and Node Buffers encode as plain bytes and stay as they were', async () => {
  const colors = new Uint8ClampedArray([255, 0, 7, 9, 200, 30]),
    tag = Buffer.from([4, 5]),
    { data, ids } = await encodeDraco(
      { positions: new Float32Array([0, 0, 0, 1, 1, 1]), colors, attributes: { tag: { values: tag, width: 1 } } },
      { mode: 'points', encodeSpeed: 10 },
    ),
    by = new Map(cloud(data).attributes.map((a) => [a.uniqueId, a.array]));
  assert.deepEqual([...by.get(ids.COLOR_0)], [255, 0, 7, 9, 200, 30]);
  assert.deepEqual([...by.get(ids.tag)], [4, 5]);
  assert.deepEqual([...tag], [4, 5]);
});

test('exact floats stay sequential and keep their bits', { timeout: 60000 }, async () => {
  const input = survey(100),
    { data, ids } = await encodeDraco(input, { mode: 'points', positionBits: 0 });
  assert.equal(data[8], 0);
  assert.deepEqual(cloud(data).attributes.find((a) => a.uniqueId === ids.POSITION).array, input.positions);
});

test('triangles give a bare mesh stream, indexed or listed three points at a time', { timeout: 60000 }, async () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    indexed = await encodeDraco({ positions, indices: [0, 1, 2, 0, 2, 3] }),
    soup = new Float32Array([0, 1, 2, 0, 2, 3].flatMap((i) => [...positions.subarray(i * 3, i * 3 + 3)])),
    listed = await encodeDraco({ positions: soup });
  for (const { data, points, faces } of [indexed, listed]) {
    assert.equal(data[7], 1);
    assert.deepEqual([points, faces], [4, 2]);
    const request = { attributeIds: { POSITION: 0 }, componentTypes: { POSITION: 5126 } },
      reference = decodeDraco(google, data, request);
    assert.deepEqual(decodeNativeDraco(native, data, request), reference);
    const corners = Array.from(reference.indices, (v) =>
      Array.from(reference.positions.subarray(v * 3, v * 3 + 3), Math.round).join(),
    );
    assert.deepEqual(corners.sort(), ['0,0,0', '0,0,0', '0,1,0', '1,0,0', '1,1,0', '1,1,0']);
  }
});

test('bad input is refused by name; an aborted signal rejects with its reason', async () => {
  const positions = new Float32Array(9),
    reason = new Error('stop');
  for (const [geometry, options, error] of [
    [{ positions: [0, 0, 0] }, {}, TypeError],
    [{ positions: new Float32Array(4) }, {}, TypeError],
    [{ positions }, { mode: 'lines' }, TypeError],
    [{ positions, indices: [0, 1, 2] }, { mode: 'points' }, TypeError],
    [{ positions, indices: [0, 1, 3] }, {}, RangeError],
    [{ positions, indices: [0, 1] }, {}, RangeError],
    [{ positions, normals: new Float32Array(3) }, {}, RangeError],
    [{ positions, attributes: { POSITION: { values: new Uint8Array(3), width: 1 } } }, {}, TypeError],
    [{ positions, attributes: { a: { values: new Float64Array(3), width: 1 } } }, {}, TypeError],
    [{ positions, attributes: { a: { values: new BigInt64Array(3), width: 1 } } }, {}, TypeError],
    [{ positions }, { positionBits: 31 }, RangeError],
    [{ positions: new Float32Array([NaN, 0, 0]) }, { mode: 'points' }, RangeError],
  ])
    await assert.rejects(encodeDraco(geometry, options), error, JSON.stringify(options));
  await assert.rejects(encodeDraco({ positions }, { signal: AbortSignal.abort(reason) }), (e) => e === reason);
});
