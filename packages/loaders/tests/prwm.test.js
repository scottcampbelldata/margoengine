// PRWM files assembled in the test from specifications/prwm.md (header, attribute blocks, padding, index block).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePRWM } from '../dist/prwm.js';
import { LoaderError } from '../dist/common.js';

const isError = (code) => (error) => error instanceof LoaderError && error.format === 'PRWM' && error.code === code;

const TYPES = {
  f32: [1, 4, 'setFloat32'],
  i8: [3, 1, 'setInt8'],
  i16: [4, 2, 'setInt16'],
  u8: [7, 1, 'setUint8'],
  u16: [8, 2, 'setUint16'],
  u32: [10, 4, 'setUint32'],
};

/** attributes: [{name, type, components, normalized, integer, values}] */
function build({ attributes, indices, index32 = false, little = true, values, version = 1 }) {
  const parts = [];
  let size = 8;
  const header = new Uint8Array(8);
  header[0] = version;
  header[1] = (indices ? 0x80 : 0) | (index32 ? 0x40 : 0) | (little ? 0 : 0x20) | attributes.length;
  const put24 = (at, n) => {
    const b = [n & 255, (n >> 8) & 255, (n >> 16) & 255];
    if (!little) b.reverse();
    header.set(b, at);
  };
  put24(2, values);
  put24(5, indices ? indices.length : 0);
  parts.push(header);
  for (const a of attributes) {
    const [code, bytes, setter] = TYPES[a.type];
    const name = [...a.name].map((c) => c.charCodeAt(0));
    const head = [...name, 0, (a.integer ? 0x80 : 0) | (a.normalized ? 0x40 : 0) | ((a.components - 1) << 4) | code];
    while ((size + head.length) % 4) head.push(0);
    parts.push(new Uint8Array(head));
    size += head.length;
    const data = new Uint8Array(a.values.length * bytes),
      view = new DataView(data.buffer);
    a.values.forEach((v, i) => view[setter](i * bytes, v, little));
    parts.push(data);
    size += data.length;
  }
  if (indices) {
    parts.push(new Uint8Array((4 - (size % 4)) % 4));
    const bytes = index32 ? 4 : 2,
      data = new Uint8Array(indices.length * bytes),
      view = new DataView(data.buffer);
    indices.forEach((v, i) => (index32 ? view.setUint32(i * 4, v, little) : view.setUint16(i * 2, v, little)));
    parts.push(data);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const quad = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
const tri = { name: 'position', type: 'f32', components: 3, values: [0, 0, 0, 1, 0, 0, 0, 1, 0] };
const zeros = { name: 'position', type: 'f32', components: 3, values: new Array(9).fill(0) };

for (const little of [true, false]) {
  test(`indexed model, ${little ? 'little' : 'big'} endian, with odd-size attribute blocks`, () => {
    const model = parsePRWM(
      build({
        little,
        values: 4,
        indices: [0, 1, 2, 0, 2, 3],
        attributes: [
          { name: 'position', type: 'f32', components: 3, values: quad },
          // 8 bytes of u8 uv: the next header must still read after data that is not 4-aligned.
          { name: 'uv', type: 'u8', components: 2, normalized: true, values: [0, 0, 255, 0, 255, 255, 0, 255] },
          {
            name: 'normal',
            type: 'i8',
            components: 3,
            normalized: true,
            values: [0, 0, 127, 0, 0, 127, 0, 0, 127, 0, 0, -128],
          },
          { name: 'weight', type: 'u16', components: 1, integer: true, values: [1, 2, 3, 65535] },
        ],
      }),
    );
    assert.equal(model.kind, 'mesh');
    assert.deepEqual([...model.positions], quad);
    assert.deepEqual([...model.indices], [0, 1, 2, 0, 2, 3]);
    assert.deepEqual([...model.uvs], [0, 0, 1, 0, 1, 1, 0, 1]);
    assert.equal(model.normals[2], 1);
    assert.equal(model.normals[11], -1);
    assert.deepEqual([...model.attributes.weight], [1, 2, 3, 65535]);
    assert.deepEqual(
      model.layout.map((l) => [l.name, l.components, l.normalized, l.integer]),
      [
        ['position', 3, false, false],
        ['uv', 2, true, false],
        ['normal', 3, true, false],
        ['weight', 1, false, true],
      ],
    );
    assert.equal(model.nonIndexed, false);
  });
}

test('non-indexed model gets the sequential triangle list; color keeps rgb of rgba', () => {
  const model = parsePRWM(
    build({
      values: 3,
      attributes: [
        tri,
        { name: 'color', type: 'u8', components: 4, normalized: true, values: [255, 0, 0, 9, 0, 255, 0, 9, 0, 0, 255, 9] },
      ],
    }),
  );
  assert.deepEqual([...model.indices], [0, 1, 2]);
  assert.equal(model.nonIndexed, true);
  assert.deepEqual([...model.colors], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

test('32-bit indices after unaligned attribute data', () => {
  const model = parsePRWM(
    build({
      index32: true,
      values: 3,
      indices: [2, 1, 0],
      attributes: [
        { name: 'position', type: 'i16', components: 3, values: [0, 0, 0, 1, 0, 0, 0, 1, 0] },
        { name: 'flag', type: 'u8', components: 1, values: [1, 2, 3] },
      ],
    }),
  );
  assert.deepEqual([...model.indices], [2, 1, 0]);
  assert.deepEqual([...model.attributes.flag], [1, 2, 3]);
});

test('errors carry their codes', () => {
  const ok = build({ values: 3, attributes: [tri] });
  assert.throws(() => parsePRWM(ok.subarray(0, 5)), isError('truncated'));
  assert.throws(() => parsePRWM(ok.subarray(0, ok.length - 4)), isError('truncated'));
  assert.throws(() => parsePRWM(build({ version: 0, values: 3, attributes: [zeros] })), isError('header'));
  assert.throws(() => parsePRWM(build({ version: 2, values: 3, attributes: [zeros] })), isError('unsupported'));
  assert.throws(
    () => parsePRWM(build({ values: 3, attributes: [{ ...zeros, name: 'normal' }] })),
    isError('header'),
  );
  assert.throws(() => parsePRWM(build({ values: 3, indices: [0, 1, 3], attributes: [zeros] })), isError('range'));
  assert.throws(
    () => parsePRWM(build({ values: 4, attributes: [{ ...zeros, values: new Array(12).fill(0) }] })),
    isError('header'),
  );
  assert.throws(() => parsePRWM(ok, { maxVertices: 2 }), isError('limit'));
  const reserved = ok.slice();
  reserved[8 + 9] = (reserved[8 + 9] & 0xf0) | 2; // "position\0" then the flag byte
  assert.throws(() => parsePRWM(reserved), isError('unsupported'));
  assert.throws(() => parsePRWM('nope'), isError('range'));
});
