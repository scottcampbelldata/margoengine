import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDXF, LoaderError } from '../dist/index.js';
import { readDXFHatch } from '../dist/dxf-hatch.js';

const ascii = (pairs) => `${pairs.map(([c, v]) => `${String(c).padStart(3)}\n${v}`).join('\n')}\n  0\nEOF\n`;
const drawing = (entities) =>
  encode(
    ascii([
      [0, 'SECTION'],
      [2, 'HEADER'],
      [9, '$ACADVER'],
      [1, 'AC1032'],
      [0, 'ENDSEC'],
      [0, 'SECTION'],
      [2, 'ENTITIES'],
      ...entities,
      [0, 'ENDSEC'],
    ]),
  );
const encode = (text) => new TextEncoder().encode(text);

/** A closed polyline boundary path. */
const poly = (points, flags = 3) => {
  const bulges = points.some((p) => p[2]);
  return [
    [92, flags],
    [72, bulges ? 1 : 0],
    [73, 1],
    [93, points.length],
    ...points.flatMap(([x, y, b = 0]) => [[10, x], [20, y], ...(bulges ? [[42, b]] : [])]),
    [97, 0],
  ];
};
const box = (x0, y0, x1, y1) =>
  poly([
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]);
/** An edge boundary path. */
const edges = (list, sources = []) => [
  [92, 1],
  [93, list.length],
  ...list.flat(),
  [97, sources.length],
  ...sources.map((s) => [330, s]),
];
const line = (x0, y0, x1, y1) => [
  [72, 1],
  [10, x0],
  [20, y0],
  [11, x1],
  [21, y1],
];
const arc = (x, y, r, a0, a1, ccw = 1) => [
  [72, 2],
  [10, x],
  [20, y],
  [40, r],
  [50, a0],
  [51, a1],
  [73, ccw],
];

const hatch = (paths, { pattern, style = 0, elevation = 0, extra = [], head = [] } = {}) => [
  [0, 'HATCH'],
  [8, '0'],
  [62, 1],
  ...head,
  [10, 0],
  [20, 0],
  [30, elevation],
  [2, pattern ? 'USER' : 'SOLID'],
  [70, pattern ? 0 : 1],
  [71, 0],
  [91, paths.length],
  ...paths.flat(),
  [75, style],
  [76, 1],
  ...(pattern
    ? [
        [52, 0],
        [41, 1],
        [77, 0],
        [78, pattern.length],
        ...pattern.flatMap(({ angle = 0, base = [0, 0], offset, dashes = [] }) => [
          [53, angle],
          [43, base[0]],
          [44, base[1]],
          [45, offset[0]],
          [46, offset[1]],
          [79, dashes.length],
          ...dashes.map((d) => [49, d]),
        ]),
      ]
    : []),
  ...extra,
  [98, 1],
  [10, 123],
  [20, 456],
];

const read = (entities, options = {}) =>
  parseDXF(drawing(entities), { units: 'file', hatch: readDXFHatch, ...options });
const area = ({ positions }) => {
  let sum = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const ux = positions[i + 3] - positions[i],
      uy = positions[i + 4] - positions[i + 1],
      uz = positions[i + 5] - positions[i + 2],
      vx = positions[i + 6] - positions[i],
      vy = positions[i + 7] - positions[i + 1],
      vz = positions[i + 8] - positions[i + 2];
    sum += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return sum;
};
/** Segments as [x0, y0, x1, y1], rounded. */
const segments = ({ lines }) => {
  const p = lines.positions,
    out = [];
  for (let i = 0; i < p.length; i += 6)
    out.push([p[i], p[i + 1], p[i + 3], p[i + 4]].map((v) => Math.round(v * 1e4) / 1e4 + 0));
  return out;
};
const length = (result) => segments(result).reduce((s, [a, b, c, d]) => s + Math.hypot(c - a, d - b), 0);
/** Three rings, one in the other, of areas 100, 36 and 4. */
const rings = [box(0, 0, 10, 10), box(2, 2, 8, 8), box(4, 4, 6, 6)];
const rows = { offset: [0, 1], base: [0, 0.5] };

test('without the reader a hatch is counted as skipped', () => {
  const result = parseDXF(drawing(hatch([box(0, 0, 1, 1)])));
  assert.deepEqual(result.skipped, { HATCH: 1 });
  assert.equal(result.mesh.positions.length, 0);
});

test('a solid hatch fills its boundary with the entity colour', () => {
  const result = read(hatch([box(0, 0, 4, 3)], { elevation: 2 }));
  assert.deepEqual(result.skipped, {});
  assert.ok(Math.abs(area(result.mesh) - 12) < 1e-5);
  assert.deepEqual(result.mesh.groups[0].color, [1, 0, 0, 1]);
  for (let i = 2; i < result.mesh.positions.length; i += 3) assert.equal(result.mesh.positions[i], 2);
  assert.equal(result.lines.positions.length, 0);
});

test('the hatch styles fill islands by parity, the outermost area only, or everything', () => {
  for (const [style, expected] of [
    [0, 100 - 36 + 4],
    [1, 100 - 36],
    [2, 100],
  ])
    assert.ok(Math.abs(area(read(hatch(rings, { style })).mesh) - expected) < 1e-4, `style ${style}`);
  // The rings in any order, wound either way.
  const mixed = [
    box(4, 4, 6, 6),
    poly([
      [0, 0],
      [0, 10],
      [10, 10],
      [10, 0],
    ]),
    box(2, 2, 8, 8),
  ];
  assert.ok(Math.abs(area(read(hatch(mixed)).mesh) - 68) < 1e-4);
});

test('pattern lines are clipped to the rings by the same styles', () => {
  // Rows at y = 0.5 .. 9.5: ten of 10, six of them cross the 6 wide island, two the 2 wide one.
  for (const [style, expected] of [
    [0, 100 - 36 + 4],
    [1, 100 - 36],
    [2, 100],
  ]) {
    const result = read(hatch(rings, { style, pattern: [rows] }));
    assert.ok(Math.abs(length(result) - expected) < 1e-3, `style ${style}: ${length(result)}`);
    assert.equal(result.mesh.positions.length, 0);
  }
});

test('a pattern line through a vertex is counted once', () => {
  // A diamond with its side vertices on the line y = 1.
  const result = read(
    hatch(
      [
        poly([
          [1, 0],
          [2, 1],
          [1, 2],
          [0, 1],
        ]),
      ],
      { pattern: [{ offset: [0, 1] }] },
    ),
  );
  assert.deepEqual(segments(result), [[0, 1, 2, 1]]);
});

test('angle, base point and negative spacing place the lines', () => {
  const up = read(hatch([box(0, 0, 4, 4)], { pattern: [{ angle: 90, base: [1, 0], offset: [-2, 0] }] }));
  assert.deepEqual(
    segments(up)
      .map(([x0, , x1]) => [x0, x1])
      .sort((a, b) => a[0] - b[0]),
    [
      [1, 1],
      [3, 3],
    ],
  );
  const down = read(hatch([box(0, 0, 4, 4)], { pattern: [{ base: [0, 1], offset: [0, -2] }] }));
  assert.deepEqual(
    segments(down)
      .map((s) => s[1])
      .sort(),
    [1, 3],
  );
});

test('dashes start at each line’s own origin, and a zero dash is a dot', () => {
  const dashed = read(hatch([box(0, 0, 10, 2)], { pattern: [{ base: [0, 0.5], offset: [1, 1], dashes: [2, -1] }] }));
  const bottom = segments(dashed).filter((s) => s[1] === 0.5),
    top = segments(dashed).filter((s) => s[1] === 1.5);
  assert.deepEqual(
    bottom.map((s) => [s[0], s[2]]),
    [
      [0, 2],
      [3, 5],
      [6, 8],
      [9, 10],
    ],
  );
  assert.deepEqual(
    top.map((s) => [s[0], s[2]]),
    [
      [1, 3],
      [4, 6],
      [7, 9],
    ],
  );
  const dots = read(hatch([box(0, 0, 2, 1)], { pattern: [{ base: [0.25, 0.5], offset: [0, 1], dashes: [0, -0.5] }] }));
  assert.deepEqual(
    segments(dots),
    [0.25, 0.75, 1.25, 1.75].map((x) => [x, 0.5, x, 0.5]),
  );
});

test('polyline bulges and arc edges give the same half disc, clockwise angles mirrored', () => {
  const half = Math.PI / 2;
  const bulged = read(
    hatch([
      poly([
        [-1, 0],
        [1, 0, 1],
      ]),
    ]),
    { arcSegments: 1024 },
  );
  assert.ok(Math.abs(area(bulged.mesh) - half) < 1e-4, `${area(bulged.mesh)}`);
  const ccw = read(hatch([edges([line(-1, 0, 1, 0), arc(0, 0, 1, 0, 180)])]), { arcSegments: 1024 });
  assert.ok(Math.abs(area(ccw.mesh) - half) < 1e-4);
  // From (-1, 0) to (1, 0) along the bottom edge reversed: clockwise from 180 to 360 as stored runs -180 to -360.
  const cw = read(hatch([edges([line(1, 0, -1, 0), arc(0, 0, 1, 180, 360, 0)])]), { arcSegments: 1024 });
  assert.ok(Math.abs(area(cw.mesh) - half) < 1e-4);
  assert.ok(Math.max(...cw.mesh.positions.filter((_, i) => i % 3 === 1)) > 0.99, 'upper half');
  // A quarter wedge, clockwise: stored 270 to 360, so it runs from (0, 1) to (1, 0).
  const wedge = read(hatch([edges([line(0, 0, 0, 1), arc(0, 0, 1, 270, 360, 0), line(1, 0, 0, 0)])]), {
    arcSegments: 1024,
  });
  assert.ok(Math.abs(area(wedge.mesh) - Math.PI / 4) < 1e-4);
});

test('elliptic edges take geometric angles, and a full turn is a whole ellipse', () => {
  const ellipse = (a0, a1, ccw = 1) => [
    [72, 3],
    [10, 0],
    [20, 0],
    [11, 2],
    [21, 0],
    [40, 0.5],
    [50, a0],
    [51, a1],
    [73, ccw],
  ];
  const whole = read(hatch([edges([ellipse(0, 360)])]), { arcSegments: 1024 });
  assert.ok(Math.abs(area(whole.mesh) - 2 * Math.PI) < 1e-4);
  // The sector to 45 degrees: parameter atan(2), not 45 degrees, so its end is on y = x.
  const end = 2 / Math.sqrt(5);
  const sector = read(hatch([edges([ellipse(0, 45), line(end, end, 0, 0), line(0, 0, 2, 0)])]), { arcSegments: 1024 });
  assert.ok(Math.abs(area(sector.mesh) - Math.atan(2)) < 1e-4, `${area(sector.mesh)}`);
});

test('spline edges read their knots, weights and fit data, with source references after them', () => {
  // A quarter circle as a rational quadratic, closed by two lines.
  const quarter = (fit) => [
    [72, 4],
    [94, 2],
    [73, 1],
    [74, 0],
    [95, 6],
    [96, 3],
    ...[0, 0, 0, 1, 1, 1].map((k) => [40, k]),
    [10, 1],
    [20, 0],
    [42, 1],
    [10, 1],
    [20, 1],
    [42, Math.SQRT1_2],
    [10, 0],
    [20, 1],
    [42, 1],
    ...fit,
  ];
  const data = [
    [97, 2],
    [11, 1],
    [21, 0],
    [11, 0],
    [21, 1],
    [12, 0],
    [22, 1],
    [13, -1],
    [23, 0],
  ];
  // Fit data absent (before R2010), empty, and present; the spline last or first in its path.
  for (const fit of [[], [[97, 0]], data]) {
    const last = [line(0, 1, 0, 0), line(0, 0, 1, 0), quarter(fit)],
      first = [quarter(fit), line(0, 1, 0, 0), line(0, 0, 1, 0)];
    for (const list of [first, last])
      for (const sources of [[], ['1A', '1B']]) {
        const result = read(hatch([edges(list, sources)]), { splineSegments: 1024 });
        assert.deepEqual(result.skipped, {});
        assert.ok(Math.abs(area(result.mesh) - Math.PI / 4) < 1e-4, `${area(result.mesh)}`);
      }
  }
});

test('a hatch in a block is placed with its insert', () => {
  const pairs = [
    [0, 'SECTION'],
    [2, 'BLOCKS'],
    [0, 'BLOCK'],
    [2, 'Tile'],
    [10, 0],
    [20, 0],
    [30, 0],
    ...hatch([box(0, 0, 1, 1)]),
    [0, 'ENDBLK'],
    [0, 'ENDSEC'],
    [0, 'SECTION'],
    [2, 'ENTITIES'],
    [0, 'INSERT'],
    [2, 'Tile'],
    [10, 5],
    [20, 7],
    [41, 2],
    [42, 3],
    [50, 90],
    [0, 'ENDSEC'],
  ];
  const { mesh } = parseDXF(encode(ascii(pairs)), { units: 'file', hatch: readDXFHatch });
  const range = (axis) => {
    const list = mesh.positions.filter((_, i) => i % 3 === axis);
    return [Math.min(...list), Math.max(...list)];
  };
  assert.deepEqual(
    [range(0), range(1)],
    [
      [2, 5],
      [7, 9],
    ],
  );
});

test('a hatch is mirrored through its extrusion', () => {
  const mirrored = read(
    hatch([box(1, 0, 2, 1)], {
      head: [
        [210, 0],
        [220, 0],
        [230, -1],
      ],
    }),
  );
  const xs = mirrored.mesh.positions.filter((_, i) => i % 3 === 0);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [-2, -1]);
});

test('a gradient takes its first colour', () => {
  const result = read(
    hatch([box(0, 0, 1, 1)], {
      extra: [
        [450, 1],
        [451, 0],
        [452, 0],
        [453, 2],
        [463, 0],
        [421, 255],
        [463, 1],
        [421, 65280],
        [470, 'LINEAR'],
      ],
    }),
  );
  assert.deepEqual(result.mesh.groups[0].color, [0, 0, 1, 1]);
});

test('broken boundaries are skipped and limits are errors', () => {
  const short = [
    [0, 'HATCH'],
    [70, 1],
    [91, 1],
    [92, 1],
    [93, 3],
    [72, 1],
    [10, 0],
  ];
  assert.deepEqual(read(short).skipped, { HATCH: 1 });
  assert.deepEqual(read(hatch([edges([[[72, 9]]])])).skipped, { HATCH: 1 });
  assert.deepEqual(read(hatch([box(0, 0, 1, 1)], { pattern: [] })).skipped, { HATCH: 1 });
  const limit = (error) => error instanceof LoaderError && error.code === 'limit';
  // A pattern far finer than its area fails before it allocates.
  assert.throws(() => read(hatch([box(0, 0, 1e6, 1e6)], { pattern: [{ offset: [0, 1e-6] }] })), limit);
  assert.throws(
    () => read(hatch([box(0, 0, 1e9, 1)], { pattern: [{ base: [0, 0.5], offset: [0, 1], dashes: [1e-6, -1e-6] }] })),
    limit,
  );
  assert.throws(() => read(hatch([box(0, 0, 10, 10)], { pattern: [rows] }), { maxSegments: 3 }), limit);
  assert.throws(() => read(hatch([box(0, 0, 10, 10)]), { maxTriangles: 1 }), limit);
});
