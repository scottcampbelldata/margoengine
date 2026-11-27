// LEADER and MULTILEADER in parseDXF, on drawings written here from the group codes (docs/clean-room.md,
// "DXF leaders"). Expected positions are worked by hand.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDXF, LoaderError } from '../dist/index.js';

const section = (name, body) => [[0, 'SECTION'], [2, name], ...body, [0, 'ENDSEC']];
const entity = (type, ...pairs) => [[0, type], ...pairs];
const at = (code, x, y, z = 0) => [
  [code, x],
  [code + 10, y],
  [code + 20, z],
];
const variable = (name, code, value) => [
  [9, name],
  [code, value],
];

function read({ header = [], tables = [], blocks = [], entities }, options) {
  const pairs = [
    ...section('HEADER', header),
    ...section('TABLES', tables),
    ...section('BLOCKS', blocks),
    ...section('ENTITIES', entities),
    [0, 'EOF'],
  ];
  return parseDXF(
    new TextEncoder().encode(`${pairs.map(([c, v]) => `${String(c).padStart(3)}\n${v}`).join('\n')}\n`),
    options,
  );
}

const round = (v) => Math.round(v * 1e4) / 1e4 + 0;
/** Line segments as [x0, y0, x1, y1]. */
const segments = ({ lines: { positions: p } }) => {
  const out = [];
  for (let i = 0; i < p.length; i += 6) out.push([p[i], p[i + 1], p[i + 3], p[i + 4]].map(round));
  return out;
};
/** Triangle corners as [x, y]. */
const corners = ({ mesh: { positions: p } }) => {
  const out = [];
  for (let i = 0; i < p.length; i += 3) out.push([round(p[i]), round(p[i + 1])]);
  return out;
};
/** The arrow's length, from its tip to the middle of its back edge. */
const arrowLength = (result) => {
  const [tip, a, b] = corners(result);
  return round(Math.hypot((a[0] + b[0]) / 2 - tip[0], (a[1] + b[1]) / 2 - tip[1]));
};

const leader = (pairs, vertices) =>
  entity('LEADER', [100, 'AcDbLeader'], ...pairs, [76, vertices.length], ...vertices.flatMap(([x, y]) => at(10, x, y)));

test('parseDXF draws a LEADER: its segments and a closed filled arrow of $DIMASZ x $DIMSCALE', () => {
  const result = read({
    header: [...variable('$DIMASZ', 40, 1), ...variable('$DIMSCALE', 40, 2)],
    entities: leader(
      [
        [71, 1],
        [72, 0],
        [73, 3],
      ],
      [
        [0, 0],
        [4, 3],
        [10, 3],
      ],
    ),
  });
  assert.deepEqual(result.skipped, {});
  assert.deepEqual(segments(result), [
    [0, 0, 4, 3],
    [4, 3, 10, 3],
  ]);
  // Size 2: the tip on the first vertex, the back 2 along the first segment, a third as wide.
  assert.deepEqual(corners(result), [
    [0, 0],
    [1.8, 0.9333],
    [1.4, 1.4667],
  ]);
});

test('parseDXF takes a LEADER arrow size from its overrides, then its DIMSTYLE, then the header', () => {
  const line = [
    [0, 0],
    [100, 0],
  ];
  const style = entity('DIMSTYLE', [105, '2F'], [2, 'Mine'], [40, 2], [41, 3]);
  const header = [...variable('$DIMASZ', 40, 7), ...variable('$DIMSCALE', 40, 1)];
  const named = leader([[3, 'MINE']], line);
  assert.equal(arrowLength(read({ header, tables: style, entities: named })), 6);
  assert.equal(arrowLength(read({ header, tables: style, entities: leader([[3, 'Other']], line) })), 7);
  const overridden = [
    ...named,
    [1001, 'ACAD'],
    [1000, 'DSTYLE'],
    [1002, '{'],
    [1070, 41],
    [1040, 5],
    [1070, 40],
    [1040, 4],
    [1002, '}'],
  ];
  assert.equal(arrowLength(read({ header, tables: style, entities: overridden })), 20);
  // Without a stated size: 0.18, or 2.5 in a metric drawing. A DIMSCALE of 0 counts as 1.
  assert.equal(arrowLength(read({ entities: leader([], line) })), 0.18);
  assert.equal(
    arrowLength(
      read({
        header: [...variable('$MEASUREMENT', 70, 1), ...variable('$DIMSCALE', 40, 0)],
        entities: leader([], line),
      }),
    ),
    2.5,
  );
});

test('parseDXF leaves off a LEADER arrow that is turned off or whose first segment is under twice its size', () => {
  const header = variable('$DIMASZ', 40, 3);
  const short = read({
    header,
    entities: leader(
      [],
      [
        [0, 0],
        [4, 3],
      ],
    ),
  });
  assert.equal(corners(short).length, 0);
  assert.equal(segments(short).length, 1);
  const long = [
    [0, 0],
    [6, 0],
  ];
  assert.equal(corners(read({ header, entities: leader([], long) })).length, 3);
  assert.equal(corners(read({ header, entities: leader([[71, 0]], long) })).length, 0);
});

test('parseDXF runs a LEADER on under its text when DIMTAD places it above the line', () => {
  const draw = (pairs, tad = 1) =>
    segments(
      read({
        tables: entity('DIMSTYLE', [2, 'S'], [41, 1], [77, tad], [147, 0.5]),
        entities: leader(
          [[3, 'S'], [41, 4], ...pairs],
          [
            [0, 0],
            [5, 5],
          ],
        ),
      }),
    );
  assert.deepEqual(draw([[73, 0]]).at(-1), [5, 5, 9.5, 5]);
  assert.deepEqual(
    draw([
      [73, 0],
      [74, 1],
    ]).at(-1),
    [5, 5, 0.5, 5],
  );
  assert.deepEqual(draw([[73, 0], ...at(211, 0, 1)]).at(-1), [5, 5, 5, 9.5]);
  assert.equal(draw([[73, 3]]).length, 1, 'no annotation, no hook line');
  assert.equal(draw([[73, 0]], 0).length, 1, 'text beside the line, no hook line');
});

test('parseDXF draws a spline LEADER through its vertices, leaving and arriving along the end chords', () => {
  const spline = (vertices) =>
    read(
      {
        entities: leader(
          [
            [72, 1],
            [71, 0],
          ],
          vertices,
        ),
      },
      { splineSegments: 4 },
    );
  const bent = segments(
    spline([
      [0, 0],
      [1, 1],
      [2, 0],
    ]),
  );
  assert.equal(bent.length, 8);
  // The cubic with end tangents (1, 1) and (1, -1) over the chord has its half-span point at (0.5, 0.625).
  assert.deepEqual(bent[1].slice(2), [0.5, 0.625]);
  assert.deepEqual(bent[3].slice(2), [1, 1]);
  assert.deepEqual(bent[7].slice(2), [2, 0]);
  // On a straight line with uneven spacing the cubic is the line itself, at an even pace in each span.
  const straight = segments(
    spline([
      [0, 0],
      [4, 0],
      [8, 0],
      [20, 0],
      [24, 0],
    ]),
  );
  assert.deepEqual(
    straight.map((s) => s[2]),
    [1, 2, 3, 4, 5, 6, 7, 8, 11, 14, 17, 20, 21, 22, 23, 24],
  );
  assert.throws(
    () =>
      read(
        {
          entities: leader(
            [[72, 1]],
            [
              [0, 0],
              [1, 1],
              [2, 0],
            ],
          ),
        },
        { maxSegments: 10 },
      ),
    (error) => error instanceof LoaderError && error.code === 'limit',
  );
});

/** A MULTILEADER from its common codes, context codes and leaders. */
function multi({ common = [], context = [], leaders = [] }) {
  return entity(
    'MULTILEADER',
    [5, '90'],
    [330, '1F'],
    [100, 'AcDbMLeader'],
    [270, 2],
    [300, 'CONTEXT_DATA{'],
    [40, 1],
    ...at(10, 99, 99),
    [140, 1],
    ...context,
    ...leaders.flatMap(({ own = [], lines = [] }) => [
      [302, 'LEADER{'],
      ...own,
      ...lines.flatMap((line) => [[304, 'LEADER_LINE{'], ...line, [91, 0], [305, '}']]),
      [303, '}'],
    ]),
    [301, '}'],
    [340, '2A'],
    [170, 1],
    [290, 1],
    [291, 1],
    [41, 3],
    ...common,
  );
}
/** Replaces common codes written by `multi`: the first value of a code counts, so these go in front. */
const typed = (drawing, ...common) => {
  const k = drawing.findIndex(([c, v]) => c === 301 && v === '}') + 1;
  return [...drawing.slice(0, k), ...common, ...drawing.slice(k)];
};
const landing = (x, y, length = 3) => [[290, 1], [291, 1], ...at(10, x, y), ...at(11, 1, 0), [90, 0], [40, length]];
const text = [
  [41, 2.5],
  [290, 1],
  [304, '\\A1;{\\fArial|b0;NOTE}\\Pline %%p1'],
  ...at(11, 0, 0, 1),
  ...at(12, 14, 6),
  ...at(13, 1, 0),
];
const noted = multi({
  context: text,
  leaders: [{ own: landing(10, 5), lines: [at(10, 0, 0), at(10, 0, 10)] }],
  common: [[172, 2]],
});

test('parseDXF draws a MULTILEADER: each leader line to the landing, the dogleg, the arrows and the text', () => {
  const result = read({ entities: noted });
  assert.deepEqual(result.skipped, {});
  assert.deepEqual(segments(result), [
    [0, 0, 10, 5],
    [0, 10, 10, 5],
    [10, 5, 13, 5],
  ]);
  assert.equal(corners(result).length, 6, 'one arrow for each leader line');
  assert.deepEqual(corners(result)[0], [0, 0]);
  assert.deepEqual(corners(result)[3], [0, 10]);
  assert.equal(arrowLength(result), 1);
  assert.equal(result.texts.length, 1);
  const [note] = result.texts;
  assert.equal(note.text, 'NOTE\nline ±1');
  assert.deepEqual(note.position, [14, 6, 0]);
  assert.equal(note.height, 2.5);
  assert.deepEqual(note.direction, [1, 0, 0]);
});

test('parseDXF ends MULTILEADER lines where an undrawn dogleg would, and hides an invisible leader', () => {
  const off = read({ entities: typed(noted, [291, 0]) });
  assert.deepEqual(segments(off), [
    [0, 0, 13, 5],
    [0, 10, 13, 5],
  ]);
  const spline = read({ entities: typed(noted, [170, 2]) }, { splineSegments: 4 });
  assert.deepEqual(
    segments(spline),
    [
      [0, 0, 13, 5],
      [0, 10, 13, 5],
    ],
    'two points make a straight spline, and a spline leader has no dogleg',
  );
  const invisible = read({ entities: typed(noted, [170, 0]) });
  assert.deepEqual(segments(invisible), []);
  assert.equal(corners(invisible).length, 0);
  assert.equal(invisible.texts.length, 1);
});

test('parseDXF cuts the breaks out of MULTILEADER lines and doglegs', () => {
  const result = read({
    entities: multi({
      leaders: [
        {
          // The dogleg runs from (20, 0) to (24, 0), broken from 21 to 22.
          own: [...landing(20, 0, 4), ...at(12, 21, 0), ...at(13, 22, 0)],
          lines: [
            [
              ...at(10, 0, 0),
              ...at(10, 5, 0),
              // Two breaks on the segment from (5, 0) to (15, 0), the farther one first, one end pair reversed.
              ...at(11, 10, 0),
              ...at(12, 11, 0),
              ...at(11, 8, 0),
              ...at(12, 7, 0),
              ...at(10, 15, 0),
              // One on the segment to the landing.
              ...at(11, 16, 0),
              ...at(12, 17, 0),
            ],
          ],
        },
      ],
    }),
  });
  assert.deepEqual(segments(result), [
    [0, 0, 5, 0],
    [5, 0, 7, 0],
    [8, 0, 10, 0],
    [11, 0, 15, 0],
    [15, 0, 16, 0],
    [17, 0, 20, 0],
    [20, 0, 21, 0],
    [22, 0, 24, 0],
  ]);
});

const tagBlock = [
  ...entity('BLOCK', [2, 'Tag'], ...at(10, 0, 0)),
  ...entity('LINE', ...at(10, 0, 0), ...at(11, 1, 0)),
  ...entity('ATTDEF', [5, 'B2'], ...at(10, 0, 0), [40, 1], [1, 'default'], [2, 'NUM'], [70, 0]),
  ...entity('ENDBLK'),
];
const records = [...entity('BLOCK_RECORD', [5, 'A1'], [2, 'Tag']), ...entity('BLOCK_RECORD', [5, 'C3'], [2, '_Mark'])];

test('parseDXF places a MULTILEADER block with its attribute values', () => {
  const result = read({
    tables: records,
    blocks: tagBlock,
    entities: multi({
      context: [[296, 1], [341, 'a1'], ...at(14, 0, 0, 1), ...at(15, 20, 0), ...at(16, 2, 2, 2), [46, Math.PI / 2]],
      common: [
        [172, 1],
        [330, 'B2'],
        [177, 0],
        [44, 0],
        [302, '42'],
      ],
    }),
  });
  assert.deepEqual(result.skipped, {});
  // Scaled by 2, turned a quarter and moved to (20, 0).
  assert.deepEqual(segments(result), [[20, 0, 20, 2]]);
  assert.deepEqual(
    result.texts.map((t) => [t.text, t.tag, t.height, t.position.map(round)]),
    [['42', 'NUM', 2, [20, 0, 0]]],
  );
});

test('parseDXF draws a leader arrow from its arrow block, turned and scaled to the leader', () => {
  const blocks = [
    ...entity('BLOCK', [2, '_Mark'], ...at(10, 0, 0)),
    ...entity('LINE', ...at(10, -1, 0.5), ...at(11, 0, 0)),
    ...entity('ENDBLK'),
  ];
  // The block's +X points out through the tip at (0, 0): here that is -X, so (-1, 0.5) lands at (2, -1) for size 2.
  const expected = [2, -1, 0, 0];
  const fromMulti = read({
    tables: records,
    blocks,
    entities: multi({
      context: [],
      leaders: [{ own: landing(10, 0), lines: [at(10, 0, 0)] }],
      common: [[342, 'C3']],
    }).map(([c, v]) => (c === 140 ? [c, 2] : [c, v])),
  });
  // After the leader line and its dogleg.
  assert.deepEqual(segments(fromMulti)[2], expected);
  assert.equal(corners(fromMulti).length, 0);
  const line = [
    [0, 0],
    [10, 0],
  ];
  const header = variable('$DIMASZ', 40, 2);
  const byName = read({
    header: [...header, ...variable('$DIMLDRBLK', 1, '_Mark')],
    blocks,
    entities: leader([], line),
  });
  assert.deepEqual(segments(byName)[1], expected);
  const byStyle = read({
    tables: [...records, ...entity('DIMSTYLE', [2, 'S'], [41, 2], [341, 'C3'])],
    blocks,
    entities: leader([[3, 'S']], line),
  });
  assert.deepEqual(segments(byStyle)[1], expected);
  assert.equal(corners(byStyle).length, 0);
  // An arrow block the file does not hold leaves the closed filled arrow.
  const missing = read({ header: [...header, ...variable('$DIMLDRBLK', 1, '_Gone')], entities: leader([], line) });
  assert.equal(corners(missing).length, 3);
});

test('parseDXF places MULTILEADERs through blocks and counts what it cannot draw', () => {
  const blocks = [...entity('BLOCK', [2, 'Holder'], ...at(10, 0, 0)), ...noted, ...entity('ENDBLK')];
  const placed = read({ blocks, entities: entity('INSERT', [2, 'Holder'], ...at(10, 100, 0), [41, 2], [42, 2]) });
  assert.deepEqual(segments(placed)[2], [120, 10, 126, 10]);
  assert.equal(placed.texts[0].height, 5);
  assert.deepEqual(placed.texts[0].position, [128, 12, 0]);
  const left = read({
    entities: [
      ...entity('MULTILEADER', [100, 'AcDbMLeader']),
      ...multi({ common: [[172, 3]] }),
      ...multi({
        context: [
          [296, 1],
          [341, 'FF'],
        ],
        common: [[172, 1]],
      }),
    ],
  });
  assert.deepEqual(left.skipped, {
    'MULTILEADER (no context data)': 1,
    'MULTILEADER (tolerance content)': 1,
    'MULTILEADER (missing block)': 1,
  });
});
