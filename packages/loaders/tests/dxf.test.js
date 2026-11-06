import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDXF, LoaderError } from '../dist/index.js';

/** A DXF file from [code, value] pairs. */
const dxf = (pairs) => `${pairs.map(([c, v]) => `${String(c).padStart(3)}\n${v}`).join('\n')}\n  0\nEOF\n`;
const section = (name, body) => [[0, 'SECTION'], [2, name], ...body, [0, 'ENDSEC']];
/** ACIS text as a DXF 3DSOLID stores it: each character but space mapped to 159 - code, a caret written '^ '. */
const encrypt = (line) =>
  [...line]
    .map((c) => (c === ' ' ? ' ' : String.fromCharCode(159 - c.charCodeAt(0))))
    .join('')
    .replaceAll('^', '^ ');

const drawing = dxf([
  ...section('HEADER', [
    [9, '$ACADVER'],
    [1, 'AC1015'],
    [9, '$INSUNITS'],
    [70, 4],
  ]),
  ...section('TABLES', [
    [0, 'TABLE'],
    [2, 'LAYER'],
    [0, 'LAYER'],
    [2, 'Walls'],
    [70, 0],
    [62, 1],
    [0, 'LAYER'],
    [2, 'Hidden'],
    [70, 1],
    [62, 3],
    [0, 'ENDTAB'],
  ]),
  ...section('BLOCKS', [
    [0, 'BLOCK'],
    [2, 'Tick'],
    [10, 1],
    [20, 0],
    [30, 0],
    [0, 'LINE'],
    [8, '0'],
    [62, 0],
    [10, 1],
    [20, 0],
    [30, 0],
    [11, 2],
    [21, 0],
    [31, 0],
    [0, 'ENDBLK'],
  ]),
  ...section('ENTITIES', [
    // 1 segment, red by layer.
    [0, 'LINE'],
    [8, 'Walls'],
    [10, 0],
    [20, 0],
    [30, 0],
    [11, 1000],
    [21, 0],
    [31, 0],
    // On a frozen layer: left out.
    [0, 'LINE'],
    [8, 'Hidden'],
    [10, 0],
    [20, 0],
    [30, 0],
    [11, 1],
    [21, 1],
    [31, 1],
    // A full circle of radius 10 mm: 64 segments.
    [0, 'CIRCLE'],
    [8, 'Walls'],
    [62, 5],
    [10, 0],
    [20, 0],
    [30, 0],
    [40, 10],
    // A semicircle by bulge 1 from (0,0) to (20,0): passes through (10,-10).
    [0, 'LWPOLYLINE'],
    [8, 'Walls'],
    [90, 2],
    [70, 0],
    [10, 0],
    [20, 0],
    [42, 1],
    [10, 20],
    [20, 0],
    // A quadratic Bezier spline (one span) from (0,0) to (20,0) through control (10,20).
    [0, 'SPLINE'],
    [8, 'Walls'],
    [70, 8],
    [71, 2],
    [72, 6],
    [73, 3],
    [40, 0],
    [40, 0],
    [40, 0],
    [40, 1],
    [40, 1],
    [40, 1],
    [10, 0],
    [20, 0],
    [30, 0],
    [10, 10],
    [20, 20],
    [30, 0],
    [10, 20],
    [20, 0],
    [30, 0],
    // A square face: 2 triangles.
    [0, '3DFACE'],
    [8, 'Walls'],
    [10, 0],
    [20, 0],
    [30, 0],
    [11, 10],
    [21, 0],
    [31, 0],
    [12, 10],
    [22, 10],
    [32, 0],
    [13, 0],
    [23, 10],
    [33, 0],
    // The block placed in 2 columns, 30 mm apart, rotated 90 degrees and scaled 2, cyan (its line is BYBLOCK).
    [0, 'INSERT'],
    [8, 'Walls'],
    [62, 4],
    [2, 'Tick'],
    [10, 100],
    [20, 0],
    [30, 0],
    [41, 2],
    [42, 2],
    [43, 2],
    [50, 90],
    [70, 2],
    [44, 30],
    // Paper space: left out.
    [0, 'LINE'],
    [67, 1],
    [10, 0],
    [20, 0],
    [30, 0],
    [11, 1],
    [21, 0],
    [31, 0],
    [0, 'MTEXT'],
    [8, 'Walls'],
    [10, 5],
    [20, 5],
    [30, 0],
    [40, 2.5],
    [1, '{\\fArial|b1;Hello}\\PWorld'],
    [0, '3DSOLID'],
    [8, 'Walls'],
    [1, encrypt('400 0 1 0')],
    [1, encrypt('16 ACIS 32.0 NT 24 Wed ^ Jan')],
    [0, 'HATCH'],
    [8, 'Walls'],
  ]),
]);

test('DXF: units, layers, curves, faces, blocks with rows and columns, text and ACIS solids', () => {
  const d = parseDXF(new TextEncoder().encode(drawing));
  assert.equal(d.version, 'AC1015');
  assert.equal(d.unit, 0.001);
  assert.deepEqual(
    d.layers.map((l) => [l.name, l.visible, l.color]),
    [
      ['Walls', true, [1, 0, 0]],
      ['Hidden', false, [0, 1, 0]],
    ],
  );
  const vertices = (g) =>
    Array.from({ length: g.count }, (_, k) => [
      ...d.lines.positions.subarray((g.start + k) * 3, (g.start + k) * 3 + 3),
    ]);
  const [red, blue, cyan] = d.lines.groups;
  assert.deepEqual(
    [red.color, blue.color, cyan.color],
    [
      [1, 0, 0, 1],
      [0, 0, 1, 1],
      [0, 1, 1, 1],
    ],
  );
  // The red group: the line, the bulge arc (32 segments for half a turn), the spline (16 segments).
  assert.equal(red.count / 2, 1 + 32 + 16);
  assert.deepEqual(vertices(red)[1], [1, 0, 0]);
  const red2 = vertices(red),
    has = (list, p) => list.some((q) => q.every((v, k) => Math.abs(v - p[k]) < 1e-7));
  assert.ok(has(red2, [0.01, -0.01, 0]), 'the bulge arc passes below the chord');
  assert.ok(has(red2, [0.01, 0.01, 0]), 'the spline peaks at half its control height');
  assert.equal(blue.count / 2, 64);
  // Block: its line from (1,0) to (2,0) relative to base (1,0), scaled 2 and turned 90 degrees, at x = 100 and 100 + 30.
  const ticks = vertices(cyan).map((p) => p.map((v) => +v.toFixed(6)));
  assert.deepEqual(ticks, [
    [0.1, 0, 0],
    [0.1, 0.002, 0],
    [0.1, 0.03, 0],
    [0.1, 0.032, 0],
  ]);
  assert.equal(d.mesh.indices.length, 6);
  assert.deepEqual(d.mesh.groups, [{ start: 0, count: 6, name: 'Walls', color: [1, 0, 0, 1] }]);
  assert.deepEqual(
    d.texts.map((t) => [t.text, +t.height.toFixed(6), t.position.map((v) => +v.toFixed(6))]),
    [['Hello\nWorld', 0.0025, [0.005, 0.005, 0]]],
  );
  assert.equal(d.solids.length, 1);
  assert.equal(d.solids[0].sat, '400 0 1 0\n16 ACIS 32.0 NT 24 Wed ^ Jan');
  assert.deepEqual(d.solids[0].transform.slice(0, 1), [0.001]);
  assert.deepEqual(d.skipped, { 'LINE (paper space)': 1, HATCH: 1 });
});

test('DXF: drawing units kept, binary files, and errors that name the problem', () => {
  const file = parseDXF(new TextEncoder().encode(drawing), { units: 'file' });
  assert.deepEqual([...file.lines.positions.subarray(3, 6)], [1000, 0, 0]);
  // Binary DXF (R13 and later): the same LINE as 16-bit group codes and typed values.
  const parts = [new TextEncoder().encode('AutoCAD Binary DXF\r\n\x1a\0')],
    code = (c) => parts.push(Uint8Array.of(c & 255, c >> 8)),
    text = (s) => parts.push(new TextEncoder().encode(`${s}\0`)),
    real = (v) => {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, v, true);
      parts.push(b);
    };
  code(0), text('SECTION'), code(2), text('ENTITIES'), code(0), text('LINE'), code(8), text('0');
  for (const [c, v] of [
    [10, 1],
    [20, 2],
    [30, 3],
    [11, 4],
    [21, 5],
    [31, 6],
  ])
    code(c), real(v);
  code(0), text('ENDSEC'), code(0), text('EOF');
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (bytes.set(p, at), at + p.length), 0);
  assert.deepEqual([...parseDXF(bytes).lines.positions], [1, 2, 3, 4, 5, 6]);
  assert.throws(() => parseDXF(bytes.subarray(0, bytes.length - 3)), {
    name: 'LoaderError',
    message: /truncated|ends inside/,
  });
  assert.throws(
    () => parseDXF(new TextEncoder().encode('  0\nSECTION\nabc\nENTITIES\n')),
    (e) => e instanceof LoaderError && e.code === 'syntax',
  );
  assert.throws(
    () => parseDXF(new TextEncoder().encode(drawing), { maxSegments: 10 }),
    (e) => e.code === 'limit',
  );
  assert.throws(
    () => parseDXF(new TextEncoder().encode(drawing), { arcSegments: 2 }),
    (e) => e.code === 'range',
  );
});

test('regression: binary DXF before R13 has one-byte group codes, and the version of a binary file is read', () => {
  const encoder = new TextEncoder(),
    bytes = [...encoder.encode('AutoCAD Binary DXF\r\n\x1a\0')],
    string = (code, value) => bytes.push(code, ...encoder.encode(value), 0),
    double = (code, value) => {
      bytes.push(code);
      bytes.push(...new Uint8Array(new Float64Array([value]).buffer));
    };
  string(0, 'SECTION');
  string(2, 'HEADER');
  string(9, '$ACADVER');
  string(1, 'AC1009');
  string(0, 'ENDSEC');
  string(0, 'SECTION');
  string(2, 'ENTITIES');
  string(0, 'LINE');
  string(8, '0');
  for (const [code, value] of [[10, 0], [20, 0], [30, 0], [11, 3], [21, 4], [31, 0]]) double(code, value);
  // 255 announces a two-byte code: 1000 is a string of extended data.
  bytes.push(255, 1000 & 255, 1000 >> 8, ...encoder.encode('note'), 0);
  string(0, 'ENDSEC');
  string(0, 'EOF');
  const drawing = parseDXF(new Uint8Array(bytes));
  assert.equal(drawing.version, 'AC1009');
  assert.equal(drawing.lines.positions.length, 6);
});
