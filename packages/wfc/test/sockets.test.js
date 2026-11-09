import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSocketTiles } from '../dist/sockets.js';
import { ConstrainedWFC } from '../dist/constraints.js';

test('proper cube transforms rotate every labelled face, without reflections', () => {
  const labels = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  const variants = buildSocketTiles([{ sockets: labels, rotations: 'cube', weight: 12 }]);
  assert.equal(variants.length, 24);
  assert.equal(new Set(variants.map((v) => v.rotation.join())).size, 24);
  for (const v of variants) {
    const m = v.rotation;
    assert.equal(
      m[0] * (m[4] * m[8] - m[5] * m[7]) - m[3] * (m[1] * m[8] - m[2] * m[7]) + m[6] * (m[1] * m[5] - m[2] * m[4]),
      1,
    );
    assert.equal(v.weight, 0.5);
    for (let axis = 0; axis < 3; axis++) {
      const column = m.slice(axis * 3, axis * 3 + 3),
        target = column.findIndex((n) => n !== 0);
      assert.equal(v.sockets[target * 2 + (column[target] < 0 ? 1 : 0)], labels[axis * 2]);
    }
  }
  assert.equal(buildSocketTiles([{ sockets: labels }]).length, 4);
  assert.deepEqual(buildSocketTiles([{ sockets: labels, rotations: 'none' }])[0].sockets, labels);
});

test('48 variants solve beyond bit 31 with reciprocal rotated socket adjacency', () => {
  const variants = buildSocketTiles([0, 1].map(() => ({ sockets: ['a', 'b', 'a', 'b', 'a', 'b'], rotations: 'cube' })));
  assert.equal(variants.length, 48);
  for (const v of variants)
    for (let d = 0; d < 6; d++)
      assert.deepEqual(
        v.neighbors[d],
        variants.flatMap((u, i) => (v.sockets[d] === u.sockets[d ^ 1] ? [i] : [])),
      );
  const m = new ConstrainedWFC([4, 3, 2], variants),
    out = m.solve({ seed: 7, pins: [{ position: [0, 0, 0], tile: 47 }] });
  assert.equal(out[0], 47);
  assert.deepEqual(out, m.solve({ seed: 7, pins: [{ position: [0, 0, 0], tile: 47 }] }));
  for (let z = 0; z < 2; z++)
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 4; x++) {
        const i = x + 4 * (y + 3 * z);
        for (const [d, j, valid] of [
          [0, i + 1, x < 3],
          [2, i + 4, y < 2],
          [4, i + 12, z < 1],
        ])
          if (valid) assert.ok(variants[out[i]].neighbors[d].includes(out[j]));
      }
});

test('socket inputs are copied and invalid or excessive variants fail before solving', () => {
  const sockets = Array(6).fill('');
  const v = buildSocketTiles([{ sockets }]);
  sockets[0] = 'changed';
  assert.equal(v[0].sockets[0], '');
  for (const sources of [
    [],
    [{ sockets: [] }],
    [{ sockets, weight: 0 }],
    [{ sockets, rotations: 'bad' }],
    Array(171).fill({ sockets, rotations: 'cube' }),
  ])
    assert.throws(() => buildSocketTiles(sources), RangeError);
});
