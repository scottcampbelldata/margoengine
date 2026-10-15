// Proof for @margoengine/splines: Spline.at resolves the curve kind, control-point offsets and basis weights once
// per call instead of once per axis. Every query type routes through it, so all of them are compared bit-for-bit.
// Run: node examples/package-benchmarks/proofs/splines.proof.js [ref] [pin]
// Pinned: f05414a against f47ff3f, the commit that recorded results/splines.json, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import { refs, versions, time, record } from './compare.js';

const { ref, pin } = refs('f05414a', 'f47ff3f'),
  { baseline, candidate } = await versions('splines', ref, undefined, pin);
const wave = (count, seed) =>
  Array.from({ length: count }, (_, i) => [
    Math.sin(i * 1.3 + seed) * 6 + i,
    Math.cos(i * 0.7 + seed) * 2,
    Math.sin(i * 2.1 + seed) * 5,
  ]);
// The three demo curves (examples/package-benchmarks/splines.js), plus open/closed variants, the two-point minimum,
// a long path and a multi-segment Bezier so every end-point branch is reached.
const fixtures = [
  [
    'catmull-rom closed',
    [
      [-5, 0.3, -2],
      [-2, 0.5, -2],
      [-2, 0.3, 2],
      [-5, 0.5, 2],
    ],
    { closed: true, divisions: 128 },
  ],
  [
    'bezier',
    [
      [-1.4, 0.3, -2],
      [1.4, 1.2, -0.8],
      [-1.4, 0.3, 0.8],
      [1.4, 0.5, 2],
    ],
    { kind: 'bezier', divisions: 128 },
  ],
  [
    'hermite closed',
    [
      [3, 0.3, -2],
      [5, 0.6, -1],
      [5, 0.3, 2],
      [3, 0.5, 1],
    ],
    {
      kind: 'hermite',
      closed: true,
      tangents: [
        [2, 0, -1],
        [1, 0, 2],
        [-2, 0, 1],
        [-1, 0, -2],
      ],
      divisions: 128,
    },
  ],
  [
    'catmull-rom open',
    [
      [-2, 0, -8],
      [2, 0.2, -3],
      [-2, 0.3, 3],
      [2, 0, 8],
    ],
    { divisions: 256 },
  ],
  [
    'catmull-rom two points',
    [
      [0, 0, 0],
      [10, 0, 0],
    ],
    {},
  ],
  [
    'catmull-rom closed two points',
    [
      [0, 0, 0],
      [10, 1, 0],
    ],
    { closed: true },
  ],
  ['catmull-rom open path', wave(40, 1), { divisions: 1024 }],
  ['catmull-rom closed path', wave(41, 2), { closed: true, divisions: 1024 }],
  ['bezier chain', wave(31, 3), { kind: 'bezier', divisions: 512 }],
  ['hermite open', wave(12, 4), { kind: 'hermite', tangents: wave(12, 5), divisions: 300 }],
];
const outcome = (run) => {
  try {
    return run();
  } catch (error) {
    return `${error.constructor.name}: ${error.message}`;
  }
};
const parameters = Array.from({ length: 4001 }, (_, i) => i / 4000).concat([1e-300, 1 - 1e-16, 0.5 + 1e-12, 1 / 3]);
for (const [name, points, options] of fixtures) {
  const a = new baseline.Spline(points, options),
    b = new candidate.Spline(points, options);
  assert.deepEqual(b.arcLengths, a.arcLengths, name);
  assert.equal(b.length, a.length);
  const a64 = new Float64Array(3),
    b64 = new Float64Array(3),
    a32 = new Float32Array(3),
    b32 = new Float32Array(3);
  for (const t of parameters) {
    assert.deepEqual(b.at(t, b64), a.at(t, a64), name);
    assert.deepEqual(b.at(t, b32), a.at(t, a32), name);
    assert.deepEqual(b.tangent(t, b64), a.tangent(t, a64), name);
    assert.deepEqual(b.atDistance(t * b.length, b64), a.atDistance(t * a.length, a64), name);
    assert.deepEqual([...b.at(t)], [...a.at(t)], name); // shared default output
  }
  // Rejections from packages/splines/test and the mutate-then-refresh path.
  for (const call of [
    (s) => s.at(-1),
    (s) => s.at(1.0000001),
    (s) => s.at(NaN),
    (s) => s.at(0.5, new Float64Array(4)),
    (s) => s.tangent(2),
    (s) => s.atDistance(s.length * 2),
    (s) => s.atDistance(-1),
  ])
    assert.equal(
      outcome(() => call(b)),
      outcome(() => call(a)),
      name,
    );
  a.points[3] = 2;
  b.points[3] = 2;
  a.updateArcLengths();
  b.updateArcLengths();
  assert.deepEqual(b.arcLengths, a.arcLengths, name);
}
for (const build of [
  (S) =>
    new S(
      [
        [0, 0, 0],
        [1, 0, 0],
      ],
      { kind: 'bezier' },
    ),
  (S) =>
    new S(
      [
        [0, 0, 0],
        [1, 0, 0],
      ],
      { kind: 'hermite' },
    ),
  (S) => new S([[0, 0, 0]]),
  (S) =>
    new S([
      [0, 0, 0],
      [1, NaN, 0],
    ]),
])
  assert.equal(
    outcome(() => build(candidate.Spline)),
    outcome(() => build(baseline.Spline)),
  );

const cases = [];
// 1,536 followers (the demo's largest preset) for 60 frames: half ask for position + tangent, half for arc-length positions.
for (const [name, points, options] of fixtures.slice(0, 4)) {
  const a = new baseline.Spline(points, options),
    b = new candidate.Spline(points, options),
    position = new Float64Array(3),
    direction = new Float64Array(3);
  const frame = (curve) => {
    for (let i = 0; i < 1536; i++) {
      const t = (i * 0.6180339887) % 1;
      if (i & 1) {
        curve.atDistance(t * curve.length, position);
        curve.atDistance(Math.min(1, t + 0.0001) * curve.length, direction);
      } else {
        curve.at(t, position);
        curve.tangent(t, direction);
      }
    }
  };
  cases.push({
    case: `${name}: 1536 followers x 60 frames`,
    queries: 1536 * 2 * 60,
    ...time(
      () => {
        for (let f = 0; f < 60; f++) frame(a);
      },
      () => {
        for (let f = 0; f < 60; f++) frame(b);
      },
    ),
  });
}
// Editing a path: 200 rebuilds of a 40-point curve's 1,024-entry arc-length table.
{
  const a = new baseline.Spline(wave(40, 1), { divisions: 1024 }),
    b = new candidate.Spline(wave(40, 1), { divisions: 1024 });
  cases.push({
    case: 'updateArcLengths, 1024 divisions x 200',
    ...time(
      () => {
        for (let i = 0; i < 200; i++) a.updateArcLengths();
      },
      () => {
        for (let i = 0; i < 200; i++) b.updateArcLengths();
      },
    ),
  });
}
await record(
  'splines',
  ref,
  cases,
  'at, tangent, atDistance and arcLengths are bit-identical for every curve kind, open and closed.',
  pin,
);
