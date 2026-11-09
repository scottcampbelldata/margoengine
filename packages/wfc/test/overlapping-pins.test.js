import test from 'node:test';
import assert from 'node:assert/strict';
import { OverlappingModel } from '../dist/overlapping.js';
// De Bruijn-like exhaustive binary 2x2 windows, generated independently from all 16 bit patterns.
const data = [];
for (let p = 0; p < 16; p++) data.push(p & 1, (p >> 1) & 1);
for (let p = 0; p < 16; p++) data.push((p >> 2) & 1, (p >> 3) & 1);
const model = new OverlappingModel({ data, width: 32, height: 2 }, { N: 2, symmetry: 1, periodicInput: false });
test('pins constrain all covering windows, including the far edge and periodic seam', () => {
  for (const periodic of [false, true])
    for (const seed of [1, 7, 33]) {
      const pins = [
        { position: [0, 0], value: 1 },
        { position: [10, 8], value: 1 },
        { position: [4, 3], value: 0 },
      ];
      const options = { seed, periodic, pins, ground: { value: 0, rows: 2 } };
      const out = model.solve(11, 11, options);
      for (const pin of pins) assert.equal(out[pin.position[0] + pin.position[1] * 11], pin.value);
      assert.deepEqual([...out.slice(99)], Array(22).fill(0));
      assert.deepEqual(model.solve(11, 11, options), out);
    }
});
test('incompatible pins/ground fail without returning a partial image; later solves reset restrictions', () => {
  for (const options of [
    {
      pins: [
        { position: [1, 1], value: 0 },
        { position: [1, 1], value: 1 },
      ],
    },
    { pins: [{ position: [3, 3], value: 1 }], ground: { value: 0 } },
    { pins: [{ position: [3, 3], value: 42 }] },
  ])
    assert.throws(
      () => model.solve(4, 4, { ...options, attempts: 1 }),
      (e) => e.code === 'failed' && /https:/.test(e.message),
    );
  assert.equal(model.solve(4, 4, { pins: [{ position: [3, 3], value: 1 }] }).at(-1), 1);
  for (const position of [
    [4, 0],
    [-1, 1],
    [0, 4],
    [1.5, 0],
  ])
    assert.throws(() => model.solve(4, 4, { pins: [{ position, value: 0 }] }), RangeError);
  for (const rows of [0, 5, 1.5, NaN])
    assert.throws(() => model.solve(4, 4, { ground: { value: 0, rows } }), RangeError);
  const c = new AbortController();
  c.abort();
  assert.throws(() => model.solve(4, 4, { signal: c.signal }), { name: 'AbortError' });
});
test('every output window remains a sampled pattern under pins, including backtracking and periodic tiny grids', () => {
  const sample = { data: [1, 0, 0, 1], width: 2, height: 2 };
  const m = new OverlappingModel(sample, { N: 2, symmetry: 1 });
  for (const periodic of [false, true]) {
    const out = m.solve(8, 8, { periodic, pins: [{ position: [7, 7], value: 1 }], ground: undefined });
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) assert.equal(out[x + 8 * y], (x + y) % 2 === 0 ? 1 : 0);
  }
  assert.throws(
    () => m.solve(1, 1, { periodic: true, pins: [{ position: [0, 0], value: 1 }], attempts: 1 }),
    /contradicted/,
  );
});

test('backtracking keeps pinned output pixels below every undo mark', () => {
  const rows = ['1111111', '1000001', '1011101', '1010001', '1010111', '1000001', '1111111'];
  const m = new OverlappingModel(
    { data: rows.join('').split('').map(Number), width: 7, height: 7 },
    { N: 3, symmetry: 1 },
  );
  const reference = m.solve(24, 24, { seed: 1, periodic: true, backtracks: 3000, attempts: 1 });
  const pins = [
    { position: [23, 23], value: reference.at(-1) },
    { position: [0, 12], value: reference[288] },
  ];
  const out = m.solve(24, 24, { seed: 1, periodic: true, backtracks: 3000, attempts: 1, pins });
  assert.ok(m.stats.backtracks > 0);
  for (const pin of pins) assert.equal(out[pin.position[0] + 24 * pin.position[1]], pin.value);
});
