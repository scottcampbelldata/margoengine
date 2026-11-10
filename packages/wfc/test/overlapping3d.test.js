import test from 'node:test';
import assert from 'node:assert/strict';
import { Overlapping3DModel } from '../dist/overlapping3d.js';
const sample = {
  width: 3,
  height: 3,
  depth: 3,
  data: Array.from({ length: 27 }, (_, i) => (i * 7 + Math.floor(i / 3) * 5) % 4),
};
function windows(data, w, h, d, N, periodic = false) {
  const out = [];
  for (let z = 0; z < (periodic ? d : d - N + 1); z++)
    for (let y = 0; y < (periodic ? h : h - N + 1); y++)
      for (let x = 0; x < (periodic ? w : w - N + 1); x++) {
        const p = [];
        for (let dz = 0; dz < N; dz++)
          for (let dy = 0; dy < N; dy++)
            for (let dx = 0; dx < N; dx++) p.push(data[((x + dx) % w) + w * (((y + dy) % h) + h * ((z + dz) % d))]);
        out.push(p.join());
      }
  return out;
}
test('every cubic output window is learned on all axes, with deterministic labels and copied input', () => {
  const input = { ...sample, data: [...sample.data] },
    m = new Overlapping3DModel(input, { N: 2 });
  input.data.fill(99);
  const learned = new Set(windows(sample.data, 3, 3, 3, 2, true));
  for (const periodic of [false, true]) {
    const data = m.solve(6, 6, 6, { seed: 7, periodic });
    assert.deepEqual(data, m.solve(6, 6, 6, { seed: 7, periodic }));
    for (const p of windows(data, 6, 6, 6, 2, periodic)) assert.ok(learned.has(p));
  }
});
test('pins constrain every covering pattern at outer faces, edges and corners, including wrapped seams', () => {
  const s = {
      width: 2,
      height: 2,
      depth: 2,
      data: Array.from({ length: 8 }, (_, i) => ((i & 1) + ((i >> 1) & 1) + (i >> 2)) % 2),
    },
    m = new Overlapping3DModel(s);
  for (const periodic of [false, true]) {
    const out = m.solve(4, 4, 4, {
      periodic,
      pins: [
        { position: [3, 3, 3], value: 1 },
        { position: [0, 0, 0], value: 0 },
      ],
    });
    assert.equal(out[63], 1);
    assert.equal(out[0], 0);
    for (const p of windows(out, 4, 4, 4, 2, periodic)) assert.ok(new Set(windows(s.data, 2, 2, 2, 2, true)).has(p));
  }
  assert.throws(
    () => m.solve(3, 3, 3, { periodic: true, attempts: 1 }),
    (e) => e.code === 'failed',
  );
  assert.throws(
    () => m.solve(1, 1, 1, { periodic: true, attempts: 1 }),
    (e) => e.code === 'failed',
  );
  assert.throws(
    () => m.solve(4, 4, 4, { pins: [{ position: [0, 0, 0], value: 99 }], attempts: 1 }),
    (e) => e.code === 'failed',
  );
  assert.equal(m.solve(4, 4, 4).length, 64);
});
test('all cube rotations and reflections learn the full orientation orbit without touching source', () => {
  const s = { width: 2, height: 2, depth: 2, data: [0, 1, 2, 3, 4, 5, 6, 7] };
  for (const [symmetry, reflections, count] of [
    ['none', false, 1],
    ['none', true, 2],
    ['y', false, 4],
    ['y', true, 8],
    ['cube', false, 24],
    ['cube', true, 48],
  ]) {
    const m = new Overlapping3DModel(s, { periodicInput: false, symmetry, reflections });
    assert.equal(m.patterns, count);
    assert.deepEqual(
      [...m.solve(2, 2, 2)].sort((a, b) => a - b),
      s.data,
    );
  }
});
test('malformed voxel samples, sparse coordinates, overflow and cancellation fail before search', () => {
  for (const s of [
    { ...sample, data: Array(27) },
    { ...sample, depth: NaN },
    { ...sample, data: Array(27).fill(Infinity) },
  ])
    assert.throws(() => new Overlapping3DModel(s));
  const m = new Overlapping3DModel({ width: 2, height: 2, depth: 2, data: Array(8).fill(4) });
  for (const args of [
    [1, 2, 2, {}],
    [2, 2, 2, { pins: [{ position: [0, , 0], value: 4 }] }],
    [2, 2, 2, { pins: [{ position: [2, 0, 0], value: 4 }] }],
    [2, 2, 2, { attempts: 0 }],
  ])
    assert.throws(() => m.solve(...args));
  const c = new AbortController();
  c.abort('stop');
  assert.throws(
    () => m.solve(2, 2, 2, { signal: c.signal }),
    (e) => e === 'stop',
  );
});
test('all fully pinned binary cubes agree with the learned set and N=3 windows preserve original labels', () => {
  const m = new Overlapping3DModel({ width: 2, height: 2, depth: 2, data: [0, 1, 1, 0, 1, 0, 0, 1] });
  for (let bits = 0; bits < 256; bits++) {
    const pins = Array.from({ length: 8 }, (_, i) => ({
      position: [i % 2, Math.floor(i / 2) % 2, Math.floor(i / 4)],
      value: (bits >> i) & 1,
    }));
    const matches = bits === 105 || bits === 150;
    if (matches)
      assert.deepEqual(
        [...m.solve(2, 2, 2, { pins })],
        pins.map((p) => p.value),
      );
    else
      assert.throws(
        () => m.solve(2, 2, 2, { pins, attempts: 1 }),
        (e) => e.code === 'failed',
      );
  }
  const n3 = new Overlapping3DModel(sample, { N: 3 }),
    out = n3.solve(6, 6, 6, { periodic: true });
  const valid = new Set(windows(sample.data, 3, 3, 3, 3, true));
  for (const p of windows(out, 6, 6, 6, 3, true)) assert.ok(valid.has(p));
});
