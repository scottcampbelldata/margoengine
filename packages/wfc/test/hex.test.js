import test from 'node:test';
import assert from 'node:assert/strict';
import { HexWFC, hexCellCenter, buildHexSocketTiles } from '../dist/hex.js';
const tiles = (faces = 6) =>
  [0, 1, 2].map((t) => ({
    neighbors: Array.from({ length: faces }, (_, d) => (d < 6 ? [0, 1, 2].filter((v) => v !== t) : [t])),
  }));
const layouts = ['axial', 'odd-r', 'even-r', 'odd-q', 'even-q'];
function valid(model, grid) {
  const [W, H, D] = model.dimensions;
  for (let z = 0; z < D; z++)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        for (let d = 0; d < (D > 1 ? 8 : 6); d++) {
          const p = [x, y, z],
            n = model.neighbor(p, d);
          if (!n) continue;
          assert.deepEqual(model.neighbor(n, d ^ 1), p);
          const a = grid[x + W * (y + H * z)],
            b = grid[n[0] + W * (n[1] + H * n[2])];
          if (d < 6) assert.notEqual(a, b);
          else assert.equal(a, b);
        }
}
test('all five layouts have six reciprocal sides, eight prism faces and seeded consistent output', () => {
  for (const layout of layouts) {
    const m = new HexWFC([4, 4, 2], tiles(8), { layout }),
      out = m.solve({ seed: 7, pins: [{ position: [0, 0, 0], tile: 2 }] });
    assert.equal(out[0], 2);
    assert.deepEqual(out, m.solve({ seed: 7, pins: [{ position: [0, 0, 0], tile: 2 }] }));
    valid(m, out);
    const center = hexCellCenter([1, 1, 0], { layout });
    for (let d = 0; d < 6; d++) {
      const n = m.neighbor([1, 1, 0], d),
        p = hexCellCenter(n, { layout });
      assert.ok(Math.abs(Math.hypot(...p.map((v, i) => v - center[i])) - Math.sqrt(3)) < 1e-12);
    }
  }
});
test('periodic axial and staggered prisms have reciprocal seams and no row-parity discontinuity', () => {
  for (const layout of layouts) {
    const m = new HexWFC([6, 6, 2], tiles(8), { layout, periodic: true }),
      out = m.solve({ seed: 4 });
    valid(m, out);
    assert.ok(m.neighbor([0, 0, 0], 1));
  }
});
test('masked hexagonal boards preserve holes, pins and copied input rules', () => {
  const mask = Array.from(
      { length: 25 },
      (_, i) =>
        +(
          Math.max(Math.abs((i % 5) - 2), Math.abs(Math.floor(i / 5) - 2), Math.abs((i % 5) + Math.floor(i / 5) - 4)) <=
          2
        ),
    ),
    rules = tiles(),
    dims = [5, 5, 1],
    m = new HexWFC(dims, rules, { mask });
  mask.fill(0);
  dims[0] = 1;
  rules[0].neighbors[0].length = 0;
  const out = m.solve({ pins: [{ position: [2, 2, 0], tile: 1 }] });
  assert.equal([...out].filter((t) => t !== 65535).length, 19);
  assert.equal(out[12], 1);
  valid(m, out);
  assert.throws(() => m.solve({ pins: [{ position: [0, 0, 0], tile: 0 }] }));
});
test('triangular local cycles reject two colors and bounded searches preserve abort reasons', () => {
  const rules = [0, 1].map((t) => ({ neighbors: Array.from({ length: 6 }, () => [t ^ 1]) }));
  const m = new HexWFC([2, 2, 1], rules);
  assert.throws(
    () => m.solve({ attempts: 1 }),
    (e) => e.code === 'failed' && /https:/.test(e.message),
  );
  const c = new AbortController();
  c.abort('stop');
  assert.throws(
    () => m.solve({ signal: c.signal }),
    (e) => e === 'stop',
  );
});
test('60-degree and reflected socket transforms agree with geometric face directions and preserve total weight', () => {
  const source = { sockets: ['E', 'W', 'SE', 'NW', 'NE', 'SW', 'top', 'bottom'], reflections: true, weight: 12 };
  const variants = buildHexSocketTiles([source]);
  assert.equal(variants.length, 12);
  assert.equal(
    variants.reduce((n, v) => n + v.weight, 0),
    12,
  );
  const directions = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [1, -1, 0],
      [-1, 1, 0],
    ],
    vectors = directions.map((p) => hexCellCenter(p));
  for (const v of variants)
    for (let d = 0; d < 6; d++) {
      const p = vectors[d],
        r = v.rotation,
        t = [0, 1, 2].map((a) => r[a] * p[0] + r[3 + a] * p[1] + r[6 + a] * p[2]);
      const target = vectors.findIndex((p) => p.every((n, a) => Math.abs(n - t[a]) < 1e-10));
      assert.ok(target >= 0);
      assert.equal(v.sockets[target], source.sockets[d]);
      assert.equal(v.sockets[6], 'top');
      assert.equal(v.sockets[7], 'bottom');
    }
  const all = buildHexSocketTiles([{ sockets: Array(6).fill('open') }]);
  assert.equal(new HexWFC([3, 3, 1], all).solve().length, 9);
});
test('invalid dimensions, layouts, parity, sparse labels and nonreciprocal adjacency reject', () => {
  for (const [dim, rule, options] of [
    [[2, , 1], tiles(), {}],
    [[2, 2, 2], tiles(), {}],
    [[2, 3, 1], tiles(), { layout: 'odd-r', periodic: true }],
    [[3, 2, 1], tiles(), { layout: 'even-q', periodic: true }],
    [[2, 2, 1], tiles(), { layout: 'bad' }],
    [[2, 2, 1], tiles(), { mask: Array(4) }],
  ])
    assert.throws(() => new HexWFC(dim, rule, options));
  assert.throws(() => buildHexSocketTiles([{ sockets: Array(6) }]));
  assert.throws(() => buildHexSocketTiles([{ sockets: Array(6).fill('x'), weight: Number.MIN_VALUE }]));
  assert.throws(() => hexCellCenter([0, 0, 0], { radius: Infinity }));
});
test('exhaustive tiny triangular graphs agree with a brute-force assignment oracle', () => {
  const W = 2,
    H = 2;
  for (let bits = 0; bits < 8; bits++) {
    const allowed = [0, 1].map((a) => [0, 1].filter((b) => bits & (1 << (a === b ? (a === 0 ? 0 : 2) : 1))));
    const rules = [0, 1].map((a) => ({ neighbors: Array.from({ length: 6 }, () => allowed[a]) }));
    const m = new HexWFC([W, H, 1], rules);
    const solutions = [];
    for (let assignment = 0; assignment < 16; assignment++) {
      let ok = true;
      for (let i = 0; i < 4; i++)
        for (let d = 0; d < 6; d++) {
          const n = m.neighbor([i % W, Math.floor(i / W), 0], d);
          if (n && !allowed[(assignment >> i) & 1].includes((assignment >> (n[0] + W * n[1])) & 1)) ok = false;
        }
      if (ok) solutions.push(assignment);
    }
    if (!solutions.length)
      assert.throws(
        () => m.solve({ attempts: 1 }),
        (e) => e.code === 'failed',
      );
    else {
      const out = m.solve({ attempts: 1, seed: 7 }),
        bits = out.reduce((n, t, i) => n | (t << i), 0);
      assert.ok(solutions.includes(bits));
    }
  }
  assert.throws(
    () => new HexWFC([1, 1, 1], [{ neighbors: [[1], [], [], [], [], []] }, { neighbors: [[], [], [], [], [], []] }]),
    /opposite rule/,
  );
});
