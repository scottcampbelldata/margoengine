import test from 'node:test';
import assert from 'node:assert/strict';
import { LoaderError, parseSTL } from '../dist/index.js';

/** Two triangles sharing an edge: a unit square in the z = 0 plane, counter-clockwise seen from +z. */
const SQUARE = [
  [0, 0, 0, 1, 0, 0, 1, 1, 0],
  [0, 0, 0, 1, 1, 0, 0, 1, 0],
];

/** Binary STL; `normals[i]` is the stored normal (default zero), `attributes[i]` the 16-bit attribute. */
function binary(triangles, { normals = [], attributes = [], header = 'binary', extra = 0 } = {}) {
  const bytes = new Uint8Array(84 + 50 * triangles.length + extra);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(header));
  view.setUint32(80, triangles.length, true);
  triangles.forEach((t, i) => {
    const at = 84 + i * 50;
    (normals[i] ?? [0, 0, 0]).forEach((v, k) => view.setFloat32(at + k * 4, v, true));
    t.forEach((v, k) => view.setFloat32(at + 12 + k * 4, v, true));
    view.setUint16(at + 48, attributes[i] ?? 0, true);
  });
  return bytes;
}

function ascii(triangles, { normals = [], name = 'part', upper = false } = {}) {
  const lines = [`solid ${name}`];
  triangles.forEach((t, i) => {
    const n = normals[i] ?? [0, 0, 0];
    lines.push(`  facet normal ${n.join(' ')}`, '    outer loop');
    for (let c = 0; c < 3; c++) lines.push(`      vertex ${t[c * 3]} ${t[c * 3 + 1]} ${t[c * 3 + 2]}`);
    lines.push('    endloop', '  endfacet');
  });
  lines.push(`endsolid ${name}`);
  const text = lines.join('\n') + '\n';
  return new TextEncoder().encode(upper ? text.toUpperCase() : text);
}

const flat = (arrays) => Float32Array.from(arrays.flat());
const closeTo = (actual, expected, tolerance = 1e-6) => {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `index ${i}`);
};

test('binary STL: positions in file order, identity indices, no colors', () => {
  const mesh = parseSTL(binary(SQUARE));
  assert.equal(mesh.kind, 'mesh');
  assert.deepEqual(mesh.positions, flat(SQUARE));
  assert.deepEqual(mesh.indices, Uint32Array.from([0, 1, 2, 3, 4, 5]));
  assert.equal(mesh.colors, undefined);
  assert.ok(mesh.positions instanceof Float32Array && mesh.normals instanceof Float32Array);
});

test('binary STL: stored normals are kept as written, zero normals become flat normals', () => {
  const stored = parseSTL(
    binary(SQUARE, {
      normals: [
        [0, 0, 5],
        [0, 0, 1],
      ],
    }),
  );
  assert.deepEqual(stored.normals.slice(0, 3), Float32Array.from([0, 0, 5]), 'stored normal is not renormalized');
  closeTo(stored.normals.slice(9, 12), [0, 0, 1]);
  const computed = parseSTL(binary(SQUARE));
  closeTo(
    computed.normals,
    flat([
      [0, 0, 1, 0, 0, 1, 0, 0, 1],
      [0, 0, 1, 0, 0, 1, 0, 0, 1],
    ]),
  );
  const bad = parseSTL(
    binary(SQUARE, {
      normals: [
        [NaN, 0, 0],
        [Infinity, 0, 0],
      ],
    }),
  );
  closeTo(bad.normals, computed.normals);
});

test('binary STL: a degenerate triangle gets the +z fallback normal', () => {
  const mesh = parseSTL(binary([[1, 1, 1, 1, 1, 1, 1, 1, 1]]));
  closeTo(mesh.normals, [0, 0, 1, 0, 0, 1, 0, 0, 1]);
});

test('binary STL: VisCAM color extension (bit 15 set) gives colors, others get gray', () => {
  const red = 0x8000 | (31 << 10),
    blue = 0x8000 | 31;
  const colored = parseSTL(binary(SQUARE, { attributes: [red, 0] }));
  closeTo(colored.colors.slice(0, 9), [1, 0, 0, 1, 0, 0, 1, 0, 0]);
  closeTo(colored.colors.slice(9, 12), [0.8, 0.8, 0.8]);
  const second = parseSTL(binary(SQUARE, { attributes: [0, blue] }));
  closeTo(second.colors.slice(9, 12), [0, 0, 1]);
  assert.equal(parseSTL(binary(SQUARE, { attributes: [0x1234, 0x0001] })).colors, undefined);
});

test('binary STL: a header starting with solid is still binary when the length matches', () => {
  const mesh = parseSTL(binary(SQUARE, { header: 'solid exported by a CAD tool facet' }));
  assert.equal(mesh.positions.length, 18);
});

test('binary STL: trailing bytes are ignored and a typed-array view with an offset works', () => {
  const bytes = binary(SQUARE, { extra: 7 });
  assert.equal(parseSTL(bytes).positions.length, 18);
  const padded = new Uint8Array(bytes.length + 5);
  padded.set(bytes, 3);
  assert.deepEqual(parseSTL(padded.subarray(3, 3 + bytes.length)).positions, flat(SQUARE));
  assert.deepEqual(parseSTL(bytes.buffer.slice(0)).positions, flat(SQUARE));
});

test('binary STL: zero triangles is an empty mesh', () => {
  const mesh = parseSTL(binary([]));
  assert.equal(mesh.positions.length, 0);
  assert.equal(mesh.indices.length, 0);
});

test('ASCII STL gives the same geometry as binary', () => {
  const normals = [
    [0, 0, 1],
    [0, 0, 1],
  ];
  const a = parseSTL(ascii(SQUARE, { normals })),
    b = parseSTL(binary(SQUARE, { normals }));
  assert.deepEqual(a.positions, b.positions);
  assert.deepEqual(a.normals, b.normals);
  assert.deepEqual(a.indices, b.indices);
  assert.equal(a.colors, undefined);
});

test('binary and ASCII compute the same flat normals, bit for bit', () => {
  // The binary loop computes a zero-normal facet from corners it holds in locals; ASCII goes through flatNormal. Exact
  // float32 values in the text keep the corners equal, so any drift between the two sums shows here.
  const round = (v) => Math.fround(v);
  const triangles = Array.from({ length: 64 }, (_, i) =>
    Array.from({ length: 9 }, (_, k) => round(Math.sin(i * 12.9898 + k * 78.233) * 1000)),
  );
  triangles.push([1, 2, 3, 1, 2, 3, 4, 5, 6]); // degenerate: two equal corners
  triangles.push([3e38, 0, 0, -3e38, 0, 0, 0, 3e38, 3e38]); // the cross product overflows to the +z fallback
  const fromBinary = parseSTL(binary(triangles)),
    fromText = parseSTL(ascii(triangles));
  assert.deepEqual(fromBinary.positions, fromText.positions);
  assert.deepEqual(fromBinary.normals, fromText.normals);
});

test('ASCII STL: zero normals are computed, upper case keywords, exponents, CRLF and several solids', () => {
  const text = new TextDecoder().decode(ascii(SQUARE, { upper: true })).replaceAll('\n', '\r\n');
  const mesh = parseSTL(new TextEncoder().encode(text.replace(/0 0 0/g, '0 0 0')));
  closeTo(mesh.normals.slice(0, 3), [0, 0, 1]);
  const exp = parseSTL(
    new TextEncoder().encode(
      'solid a\nfacet normal 0 0 1\nouter loop\nvertex 1e0 0E0 -0.0\nvertex 2.5e-1 1 0\nvertex +0 0 0\nendloop\nendfacet\nendsolid a\n' +
        'solid b name with facet words\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid b\n',
    ),
  );
  assert.equal(exp.positions.length, 18);
  closeTo(exp.positions.slice(0, 6), [1, 0, -0, 0.25, 1, 0]);
});

test('ASCII STL: large files grow the buffers', () => {
  const triangles = Array.from({ length: 5000 }, (_, i) => [i, 0, 0, i + 1, 0, 0, i, 1, 0]);
  const mesh = parseSTL(ascii(triangles));
  assert.equal(mesh.positions.length, 5000 * 9);
  assert.equal(mesh.positions[4999 * 9 + 3], 5000);
});

test('weld: true merges equal positions, smooth normals, and keeps colors apart', () => {
  const welded = parseSTL(binary(SQUARE), { weld: true });
  assert.equal(welded.positions.length, 12, 'four distinct corners');
  assert.equal(welded.indices.length, 6);
  const original = flat(SQUARE);
  welded.indices.forEach((vertex, corner) =>
    assert.deepEqual(welded.positions.slice(vertex * 3, vertex * 3 + 3), original.slice(corner * 3, corner * 3 + 3)),
  );
  closeTo(welded.normals, flat(Array(4).fill([0, 0, 1])));
  const colored = parseSTL(binary(SQUARE, { attributes: [0x8000 | (31 << 10), 0x8000 | 31] }), { weld: true });
  assert.equal(colored.positions.length / 3, 6, 'different colors keep the shared corners apart');
  const same = parseSTL(binary(SQUARE, { attributes: [0x8000 | 31, 0x8000 | 31] }), { weld: true });
  assert.equal(same.positions.length / 3, 4);
  const zeros = parseSTL(
    binary([
      [0, 0, 0, 1, 0, 0, 0, 1, 0],
      [-0, 0, 0, 1, 0, 0, 0, 0, 1],
    ]),
    { weld: true },
  );
  assert.equal(zeros.positions.length / 3, 4, '-0 and +0 are the same position');
});

test('weld: true on a sphere-like grid welds six corners into one', () => {
  const n = 20,
    triangles = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      triangles.push([x, y, 0, x + 1, y, 0, x, y + 1, 0], [x + 1, y, 0, x + 1, y + 1, 0, x, y + 1, 0]);
    }
  const welded = parseSTL(binary(triangles), { weld: true });
  assert.equal(welded.positions.length / 3, (n + 1) * (n + 1));
  assert.equal(welded.indices.length, triangles.length * 3);
});

test('errors: too short, neither flavor, truncated binary, truncated and malformed ASCII', () => {
  const code = (fn) => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof LoaderError, String(error));
      assert.match(error.message, /^STL: /);
      return error.code;
    }
    assert.fail('did not throw');
  };
  assert.equal(
    code(() => parseSTL(new Uint8Array(10))),
    'header',
  );
  assert.equal(
    code(() => parseSTL(new Uint8Array(60).fill(7))),
    'header',
  );
  assert.equal(
    code(() => parseSTL(new Uint8Array(200).fill(7))),
    'truncated',
    'header declares billions of triangles',
  );
  assert.equal(
    code(() => parseSTL(binary(SQUARE).subarray(0, 84 + 50 + 20))),
    'truncated',
  );
  const text = (s) => new TextEncoder().encode(s);
  const facet = 'solid a\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\n';
  assert.equal(
    code(() => parseSTL(text(facet))),
    'truncated',
  );
  assert.equal(
    code(() => parseSTL(text(facet + 'endloop\nendfacet\nendsolid\n'))),
    'syntax',
    'two vertices',
  );
  assert.equal(
    code(() => parseSTL(text(facet + 'vertex 0 1 x\nendloop\nendfacet\nendsolid\n'))),
    'syntax',
    'bad number',
  );
  assert.equal(
    code(() => parseSTL(text(facet + 'vertex 0 1\n'))),
    'truncated',
    'number missing at end of data',
  );
  assert.equal(
    code(() => parseSTL(text(facet + 'vertex 0 1 0\nvertex 3 3 3\nendfacet\n'))),
    'syntax',
    'four vertices',
  );
  assert.equal(
    code(() => parseSTL(text('solid a\nfacet normal 0 0 1\nfacet normal 0 0 1\nendsolid\n'))),
    'syntax',
  );
  assert.equal(
    code(() => parseSTL(text('solid a\nfacet 0 0 1\nendsolid\n'))),
    'syntax',
  );
  assert.equal(
    code(() => parseSTL(text('solid empty and long enough\nendsolid empty\n'))),
    'syntax',
    'no facets',
  );
  assert.equal(
    code(() => parseSTL(text('solid a\nvertex 0 0 0\nendsolid facet\n'))),
    'syntax',
    'vertex outside a facet',
  );
});

test('limits and arguments', () => {
  const two = binary(SQUARE);
  assert.throws(
    () => parseSTL(two, { maxTriangles: 1 }),
    (e) => e.code === 'limit' && /maxTriangles/.test(e.message),
  );
  assert.throws(
    () => parseSTL(two, { maxVertices: 5 }),
    (e) => e.code === 'limit' && /maxVertices/.test(e.message),
  );
  assert.throws(
    () => parseSTL(ascii(SQUARE), { maxTriangles: 1 }),
    (e) => e.code === 'limit',
  );
  assert.throws(
    () => parseSTL(ascii(SQUARE), { maxVertices: 3 }),
    (e) => e.code === 'limit',
  );
  assert.equal(parseSTL(two, { maxTriangles: 2, maxVertices: 6 }).positions.length, 18);
  assert.throws(
    () => parseSTL(two, { maxTriangles: -1 }),
    (e) => e.code === 'range',
  );
  assert.throws(
    () => parseSTL('not bytes'),
    (e) => e.code === 'range',
  );
  // A header that claims a huge triangle count is rejected on the length before anything is allocated.
  const lie = new Uint8Array(100);
  new DataView(lie.buffer).setUint32(80, 0xffffffff, true);
  assert.throws(
    () => parseSTL(lie),
    (e) => e.code === 'truncated',
  );
});

test('signal: aborted before and during the parse, both flavors and the weld', () => {
  const controller = new AbortController();
  controller.abort();
  for (const input of [binary(SQUARE), ascii(SQUARE)])
    assert.throws(
      () => parseSTL(input, { signal: controller.signal }),
      (e) => e.code === 'aborted',
    );
  const big = Array.from({ length: 40000 }, (_, i) => [i, 0, 0, i + 1, 0, 0, i, 1, 0]);
  for (const [input, weld] of [
    [binary(big), false],
    [binary(big), true],
    [ascii(big), false],
  ]) {
    const during = new AbortController();
    let reads = 0;
    const signal = {
      get aborted() {
        return ++reads > 2 && (during.abort(), true);
      },
    };
    assert.throws(
      () => parseSTL(input, { signal, weld }),
      (e) => e.code === 'aborted',
      `weld ${weld}`,
    );
  }
  assert.equal(parseSTL(binary(SQUARE), { signal: new AbortController().signal }).positions.length, 18);
});
