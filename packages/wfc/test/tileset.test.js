import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTileset, parseTilesetXML } from '../dist/tileset.js';
import { ConstrainedWFC } from '../dist/constraints.js';
test('all six symmetry classes have stable Gumin cardinalities and D4 reciprocal adjacency', () => {
  const letters = ['X', 'I', '\\', 'L', 'T', 'F'];
  const tiles = letters.map((name) => ({ name, symmetry: name }));
  const neighbors = tiles.flatMap((a) => tiles.map((b) => ({ left: a.name, right: b.name })));
  const variants = buildTileset({ tiles, neighbors });
  assert.equal(variants.length, 21);
  assert.deepEqual(
    letters.map((name) => variants.filter((v) => v.name === name).length),
    [1, 2, 2, 4, 4, 8],
  );
  for (const [id, v] of variants.entries())
    for (let d = 0; d < 6; d++)
      for (const other of v.neighbors[d]) assert.ok(variants[other].neighbors[d ^ 1].includes(id));
  const grid = new ConstrainedWFC([5, 1, 5], variants).solve({ seed: 4 });
  assert.equal(grid.length, 25);
  assert.equal(
    variants.filter((v) => v.source === 5 && v.rotation[0] * v.rotation[8] - v.rotation[2] * v.rotation[6] < 0).length,
    4,
  );
});
test('oriented neighbor rules expand under every rotation and reflection without introducing unconstrained pairs', () => {
  const variants = buildTileset({
    tiles: [
      { name: 'a', symmetry: 'F' },
      { name: 'b', symmetry: 'F' },
    ],
    neighbors: [{ left: 'a', right: 'b 1' }],
  });
  assert.deepEqual(variants[0].neighbors[0], [9]);
  assert.deepEqual(variants[1].neighbors[5], [10]);
  assert.equal(
    variants.reduce(
      (n, v) => n + v.neighbors[0].length + v.neighbors[1].length + v.neighbors[4].length + v.neighbors[5].length,
      0,
    ),
    16,
  );
});
test('XML tiles, encoded names, weights, orientation references and subsets work in Node without a DOM', () => {
  const text = `<?xml version="1.0"?><set unique="false"><tiles><!-- data --><tile name="road &amp; path" symmetry="I" weight="2.5"/><tile name="empty"/></tiles><neighbors><neighbor left="road &amp; path 1" right="empty"/><neighbor left="empty" right="empty"/></neighbors><subsets><subset name="blank"><tile name="empty"/></subset></subsets></set>`;
  const d = parseTilesetXML(text);
  assert.equal(d.tiles[0].name, 'road & path');
  assert.equal(buildTileset(d).length, 3);
  assert.equal(buildTileset(d)[0].weight, 2.5);
  assert.equal(buildTileset(d, 'blank').length, 1);
});
test('bad XML, sparse inputs, invalid classes, missing references and unavailable subsets reject', () => {
  for (const text of [
    '<set/>',
    '<set><tiles></set>',
    '<!DOCTYPE set SYSTEM "https://bad"><set/>',
    '<set><tiles><tile name="a" name="b"/></tiles><neighbors/></set>',
    '<set><tiles><tile name="&oops;"/></tiles><neighbors/></set>',
  ])
    assert.throws(() => parseTilesetXML(text));
  for (const tiles of [
    [{ name: 'a', symmetry: '?' }],
    [{ name: 'a' }, { name: 'a' }],
    Array(1),
    [{ name: 'a', weight: Infinity }],
  ])
    assert.throws(() => buildTileset({ tiles, neighbors: [] }));
  assert.throws(() => buildTileset({ tiles: [{ name: 'a' }], neighbors: [{ left: 'b', right: 'a' }] }));
  assert.throws(() => buildTileset({ tiles: [{ name: 'a' }], neighbors: [] }, 'missing'));
});
test('F symmetry preserves contradictions and fully authored F adjacencies solve in 2D', () => {
  const tiles = [{ name: 'f', symmetry: 'F' }];
  assert.throws(
    () =>
      new ConstrainedWFC([2, 1, 2], buildTileset({ tiles, neighbors: [{ left: 'f', right: 'f' }] })).solve({
        attempts: 1,
      }),
    (e) => e.code === 'failed',
  );
  const neighbors = Array.from({ length: 8 }, (_, a) =>
    Array.from({ length: 8 }, (_, b) => ({ left: `f ${a}`, right: `f ${b}` })),
  ).flat();
  const grid = new ConstrainedWFC([2, 1, 2], buildTileset({ tiles, neighbors })).solve({ seed: 1 });
  assert.equal(grid.length, 4);
});
