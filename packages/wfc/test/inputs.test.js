import test from 'node:test';
import assert from 'node:assert/strict';
import { WFC } from '../dist/index.js';
import { HeapWFC, ChunkedWFC } from '../dist/chunks.js';
import { ConstrainedWFC } from '../dist/constraints.js';
import { OverlappingModel } from '../dist/overlapping.js';
import { buildSocketTiles } from '../dist/sockets.js';

const tiles = [{ neighbors: Array.from({ length: 6 }, () => [0]) }];
const hole = (values, axis) => {
  const copy = [...values];
  delete copy[axis];
  return copy;
};

test('all grid entries reject every missing dimension before allocating or loading', async () => {
  for (let axis = 0; axis < 3; axis++) {
    const dims = hole([1, 1, 1], axis);
    for (const Model of [WFC, HeapWFC, ConstrainedWFC, ChunkedWFC])
      assert.throws(() => new Model(dims, tiles), RangeError, `${Model.name} axis ${axis}`);
    await assert.rejects(HeapWFC.create(dims, tiles, { backend: 'wasm' }), RangeError);
  }
  for (const dims of [
    [Number.MAX_SAFE_INTEGER, 2, 1],
    [Infinity, 1, 1],
    [1e200, 1e200, 1],
  ])
    for (const Model of [WFC, HeapWFC, ConstrainedWFC, ChunkedWFC])
      assert.throws(() => new Model(dims, tiles), RangeError);
});

test('coordinate validation visits every pin and path component in every solver', async () => {
  const heap = new HeapWFC([1, 1, 1], tiles);
  const wasm = await HeapWFC.create([1, 1, 1], tiles, { backend: 'wasm' });
  const constrained = new ConstrainedWFC([1, 1, 1], tiles);
  const legacy = new WFC([1, 1, 1], tiles);
  for (let axis = 0; axis < 3; axis++) {
    const position = hole([0, 0, 0], axis),
      pins = [{ position, tile: 0 }];
    assert.throws(() => legacy.solve(1, pins), RangeError);
    for (const model of [heap, wasm, constrained]) assert.throws(() => model.solve({ pins }), RangeError);
    for (const end of ['from', 'to'])
      assert.throws(
        () =>
          new ConstrainedWFC([1, 1, 1], tiles, {
            paths: [{ from: [0, 0, 0], to: [0, 0, 0], tiles: [0], [end]: position }],
          }),
        RangeError,
      );
  }
  const overlapping = new OverlappingModel({ data: [0, 0, 0, 0], width: 2, height: 2 }, { N: 2 });
  for (let axis = 0; axis < 2; axis++)
    assert.throws(() => overlapping.solve(2, 2, { pins: [{ position: hole([0, 0], axis), value: 0 }] }), RangeError);
});

test('sparse rule directions, IDs and constraint lists never create partial rules', () => {
  const argumentError = (e) => e instanceof RangeError || e instanceof TypeError;
  for (const Model of [WFC, HeapWFC, ConstrainedWFC, ChunkedWFC]) {
    assert.throws(() => new Model([1, 1, 1], Array(1)), argumentError);
    for (let d = 0; d < 6; d++) {
      assert.throws(() => new Model([1, 1, 1], [{ neighbors: hole(tiles[0].neighbors, d) }]), argumentError);
      const neighbors = [...tiles[0].neighbors];
      neighbors[d] = Array(1);
      assert.throws(() => new Model([1, 1, 1], [{ neighbors }]), argumentError);
    }
  }
  for (const constraints of [
    { connected: Array(1) },
    { paths: Array(1) },
    { counts: Array(1) },
    { paths: [{ from: [0, 0, 0], to: [0, 0, 0], tiles: Array(1) }] },
    { counts: [{ tiles: Array(1) }] },
  ])
    assert.throws(() => new ConstrainedWFC([1, 1, 1], tiles, constraints), argumentError);
  for (const model of [new HeapWFC([1, 1, 1], tiles), new ConstrainedWFC([1, 1, 1], tiles)])
    assert.throws(() => model.solve({ pins: Array(1) }), argumentError);
});

test('socket source and face validation rejects holes instead of matching undefined labels', () => {
  assert.throws(() => buildSocketTiles(Array(1)), RangeError);
  for (let d = 0; d < 6; d++)
    assert.throws(() => buildSocketTiles([{ sockets: hole(Array(6).fill('a'), d), rotations: 'none' }]), RangeError);
  assert.throws(() => buildSocketTiles([{ sockets: Array(6), rotations: 'none' }]), RangeError);
});

test('chunk addresses reject holes without committing or populating the cache', async () => {
  using world = new ChunkedWFC([1, 1, 1], tiles);
  for (let axis = 0; axis < 3; axis++) await assert.rejects(world.solveChunk(hole([0, 0, 0], axis)), RangeError);
  assert.equal(world.size, 0);
});

test('legacy exhaustion follows the coded failure and help-link contract', () => {
  const impossible = [{ neighbors: Array.from({ length: 6 }, () => []) }];
  assert.throws(
    () => new WFC([2, 1, 1], impossible).solve(1, [], 1),
    (e) => e.code === 'failed' && /https:\/\/margoengine.com\/docs\/wfc/.test(e.message),
  );
});
