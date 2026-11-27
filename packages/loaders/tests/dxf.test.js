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
  for (const [code, value] of [
    [10, 0],
    [20, 0],
    [30, 0],
    [11, 3],
    [21, 4],
    [31, 0],
  ])
    double(code, value);
  // 255 announces a two-byte code: 1000 is a string of extended data.
  bytes.push(255, 1000 & 255, 1000 >> 8, ...encoder.encode('note'), 0);
  string(0, 'ENDSEC');
  string(0, 'EOF');
  const drawing = parseDXF(new Uint8Array(bytes));
  assert.equal(drawing.version, 'AC1009');
  assert.equal(drawing.lines.positions.length, 6);
});

test('a SPLINE whose knots or weights cannot make a curve stays its control polygon', () => {
  const body = ['0', 'SECTION', '2', 'ENTITIES', '0', 'SPLINE', '71', '2', '72', '6', '73', '3'];
  for (const k of [0, 0, 0, 2, 1, 1]) body.push('40', String(k));
  for (const [x, y] of [
    [0, 0],
    [1, 2],
    [3, 0],
  ])
    body.push('10', String(x), '20', String(y), '30', '0');
  body.push('0', 'ENDSEC', '0', 'EOF');
  assert.equal(parseDXF(new TextEncoder().encode(body.join('\n'))).lines.positions.length, 4 * 3);
});

test('$INSUNITS 21 to 24 are the US survey foot, inch, yard and mile', () => {
  const unit = (code) =>
    parseDXF(
      new TextEncoder().encode(
        dxf([
          ...section('HEADER', [
            [9, '$INSUNITS'],
            [70, code],
          ]),
        ]),
      ),
    ).unit;
  assert.equal(unit(21), 1200 / 3937);
  assert.equal(unit(22), 100 / 3937);
  assert.equal(unit(23), 3600 / 3937);
  assert.equal(unit(24), 6336000 / 3937);
});

/** The pairs of an entity: its type, then [code, value] pairs. */
const entity = (type, ...pairs) => [[0, type], ...pairs];
const point = (x, y, code = 10) => [
  [code, x],
  [code + 10, y],
  [code + 20, 0],
];

const attributed = (...entities) =>
  new TextEncoder().encode(
    dxf([
      ...section('BLOCKS', [
        ...entity('BLOCK', [2, 'Tag'], ...point(0, 0)),
        // A prompted definition (the INSERT's ATTRIB stands for it) and a constant one.
        ...entity('ATTDEF', ...point(1, 1), [40, 1], [1, 'default'], [2, 'ROOM'], [70, 0]),
        ...entity('ATTDEF', ...point(2, 3), [40, 1], [1, 'fixed'], [2, 'KIND'], [70, 2]),
        ...entity('ATTDEF', ...point(2, 4), [40, 1], [1, 'secret'], [2, 'COST'], [70, 3]),
        [0, 'ENDBLK'],
      ]),
      ...section('ENTITIES', entities.flat()),
    ]),
  );

test('parseDXF draws the visible attributes of a block reference where the file puts them', () => {
  const result = parseDXF(
    attributed(
      entity('INSERT', [8, 'Doors'], [62, 5], [66, 1], [2, 'Tag'], ...point(10, 20), [50, 90]),
      // An ATTRIB's point is in the drawing's space: the INSERT neither moves nor turns it again.
      entity('ATTRIB', [8, '0'], [62, 0], ...point(11, 22), [40, 2], [1, 'Hall %%c25 %%d'], [2, 'ROOM'], [70, 0]),
      entity('ATTRIB', ...point(0, 0), [40, 2], [1, 'hidden'], [2, 'COST'], [70, 1]),
      // 74 (not 73, the field length) is the vertical justification that makes code 11 the position.
      entity('ATTRIB', ...point(0, 0), [40, 1], [1, 'low'], [2, 'LOW'], [70, 0], [73, 8], [74, 2], ...point(7, 8, 11)),
      entity('ATTRIB', ...point(3, 3), [40, 1], [1, 'field'], [2, 'LEN'], [70, 0], [73, 8], ...point(9, 9, 11)),
      entity('ATTRIB', ...point(4, 4), [40, 1], [1, ''], [2, 'EMPTY'], [70, 0]),
      entity('SEQEND'),
    ),
  );
  assert.deepEqual(result.skipped, {});
  const by = Object.fromEntries(result.texts.map((t) => [t.tag, t]));
  assert.deepEqual(Object.keys(by).sort(), ['KIND', 'LEN', 'LOW', 'ROOM']);
  assert.equal(by.ROOM.text, 'Hall ∅25 °');
  assert.deepEqual(by.ROOM.position, [11, 22, 0]);
  assert.equal(by.ROOM.height, 2);
  // Layer 0 and BYBLOCK take the INSERT's.
  assert.equal(by.ROOM.layer, 'Doors');
  assert.deepEqual(by.ROOM.color, [0, 0, 1]);
  assert.deepEqual(by.LOW.position, [7, 8, 0]);
  assert.deepEqual(by.LEN.position, [3, 3, 0]);
  // The constant definition is the block's own: moved to (10, 20) and turned a quarter.
  assert.equal(by.KIND.text, 'fixed');
  assert.deepEqual(by.KIND.position.map(Math.round), [7, 22, 0]);
});

test('parseDXF repeats attributes over the rows and columns of an INSERT, within maxInserts', () => {
  const file = attributed(
    entity('INSERT', [66, 1], [2, 'Tag'], ...point(0, 0), [50, 90], [70, 2], [44, 10], [71, 1]),
    entity('ATTRIB', ...point(1, 2), [40, 1], [1, 'a'], [2, 'ROOM'], [70, 0]),
    entity('SEQEND'),
  );
  const rooms = parseDXF(file).texts.filter((t) => t.tag === 'ROOM');
  assert.deepEqual(
    rooms.map((t) => t.position.map(Math.round)),
    [
      [1, 2, 0],
      [1, 12, 0],
    ],
  );
  assert.throws(
    () => parseDXF(file, { maxInserts: 2 }),
    (error) => error instanceof LoaderError && error.code === 'limit',
  );
});

test('parseDXF reads attribute definitions, multiline attributes and %% control codes', () => {
  const result = parseDXF(
    attributed(
      entity('ATTDEF', ...point(0, 0), [40, 1], [1, 'unused'], [2, 'TITLE'], [70, 0]),
      entity('INSERT', [66, 1], [2, 'Tag'], ...point(0, 0)),
      // AutoCAD 2018's multiline attribute: the MTEXT after code 101 holds the whole string and repeats codes.
      entity(
        'ATTRIB',
        ...point(5, 5),
        [40, 1],
        [1, 'first'],
        [2, 'NOTE'],
        [70, 0],
        [101, 'Embedded Object'],
        ...point(50, 50),
        [72, 1],
        ...point(1, 0, 11),
        [3, 'first\\P'],
        [1, '{\\fArial;second} %%p1'],
      ),
      entity('SEQEND'),
      entity('TEXT', ...point(0, 0), [40, 1], [1, '%%UUnder%%u 100%%% %%065 %%P2 %%C3 90%%D']),
      entity('MTEXT', ...point(0, 0), [40, 1], [1, '45%%d']),
    ),
  );
  const note = result.texts.find((t) => t.tag === 'NOTE');
  assert.equal(note.text, 'first\nsecond ±1');
  assert.deepEqual(note.position, [5, 5, 0]);
  assert.equal(result.texts.find((t) => t.tag === 'TITLE').text, 'TITLE');
  assert.deepEqual(
    result.texts.filter((t) => t.tag === undefined).map((t) => t.text),
    ['Under 100% A ±2 ∅3 90°', '45°'],
  );
});

test('parseDXF draws an MLINE: each element along the miters, with its breaks, open and closed', () => {
  /** A vertex: point, segment direction, miter direction, then each element's 41 values. */
  const vertex = ([x, y], [dx, dy], [mx, my], ...elements) => [
    ...point(x, y, 11),
    ...point(dx, dy, 12),
    ...point(mx, my, 13),
    ...elements.flatMap((values) => [[74, values.length], ...values.map((v) => [41, v]), [75, 0]]),
  ];
  const mline = (flags, ...vertices) =>
    parseDXF(
      new TextEncoder().encode(
        dxf(
          section(
            'ENTITIES',
            entity(
              'MLINE',
              [40, 1],
              [70, 1],
              [71, flags],
              [72, vertices.length],
              [73, 2],
              ...point(0, 0),
              ...vertices.flat(),
            ),
          ),
        ),
      ),
    );
  const segments = (result) => {
    const p = result.lines.positions,
      out = [];
    for (let i = 0; i < p.length; i += 6) out.push([p[i], p[i + 1], p[i + 3], p[i + 4]]);
    return out;
  };
  // A corner: two elements 1 either side of the vertex line, joined on the miters. The first is cut from 3 to 5.
  const open = mline(
    1,
    vertex([0, 0], [1, 0], [0, 1], [1, 0, 3, 5], [-1, 0]),
    vertex([10, 0], [0, 1], [-1, 1], [1, 0], [-1, 0]),
    vertex([10, 8], [0, 1], [-1, 0], [1, 0], [-1, 0]),
  );
  assert.deepEqual(open.skipped, {});
  assert.deepEqual(segments(open), [
    [0, 1, 3, 1],
    [5, 1, 9, 1],
    [0, -1, 11, -1],
    [9, 1, 9, 8],
    [11, -1, 11, 8],
  ]);
  // Closed (flag 2): the last vertex's segment returns to the first. A start distance leaves the corner open.
  const closed = mline(
    3,
    vertex([0, 0], [1, 0], [0, 1], [0, 2]),
    vertex([4, 0], [0, 1], [0, 1], [0, 0]),
    vertex([4, 4], [-1, 0], [0, 1], [0, 0]),
  );
  assert.deepEqual(segments(closed), [
    [2, 0, 4, 0],
    [4, 0, 4, 4],
    [4, 4, 0, 0],
  ]);
});
