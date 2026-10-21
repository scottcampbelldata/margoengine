import assert from 'node:assert/strict';
import test from 'node:test';
import { checkTimeline, localFrame, packFrames, unpackFrames } from '../dist/animation.js';

test('packFrames stores equal models once and owns its copies', () => {
  const a = { frame: 0, size: [2, 1, 1], voxels: new Uint8Array([1, 2]), pivot: [0, 0, 0] },
    b = { ...a, frame: 3, voxels: a.voxels.slice() },
    c = { ...a, frame: 7, voxels: new Uint8Array([2, 1]) },
    packed = packFrames([a, b, c]);
  assert.equal(packed.version, 1);
  assert.equal(packed.banks.length, 2);
  assert.deepEqual(packed.keys, [
    { frame: 0, bank: 0 },
    { frame: 3, bank: 0 },
    { frame: 7, bank: 1 },
  ]);
  a.voxels[0] = 255;
  assert.equal(packed.banks[0].voxels[0], 1);
  const frames = unpackFrames(packed);
  frames[0].voxels[0] = 9;
  assert.equal(frames[1].voxels[0], 1);
  assert.equal(packed.banks[0].voxels[0], 1);
  assert.equal(packFrames([b, { ...b, frame: 4, pivot: [1, 0, 0] }]).banks.length, 2, 'pivots differ');
});

test('packFrames and unpackFrames refuse unsorted keys, bad grids and bad references', () => {
  const frame = { frame: 0, size: [1, 1, 1], voxels: new Uint8Array([7]) };
  for (const frames of [
    [frame, frame],
    [{ ...frame, frame: -1 }],
    [{ ...frame, size: [2, 1, 1] }],
    [{ ...frame, size: [NaN, 1, 1] }],
  ])
    assert.throws(() => packFrames(frames));
  assert.throws(() => packFrames([frame, { ...frame, frame: 1 }], { maxCells: 1 }), /maxCells/);
  assert.throws(() => unpackFrames({ version: 1, banks: [frame], keys: [{ frame: 0, bank: 2 }] }), /bank reference/);
  assert.throws(() => unpackFrames({ version: 2, banks: [], keys: [] }), TypeError);
});

test('localFrame maps offset, speed, held ends and loops', () => {
  const clock = { offset: 10, startFrame: 2, endFrame: 5, speed: 0.5, loop: false };
  assert.equal(localFrame(0, clock), 2);
  assert.equal(localFrame(11, clock), 2.5);
  assert.equal(localFrame(100, clock), 5);
  assert.equal(localFrame(18, { ...clock, loop: true }), 2);
  assert.equal(localFrame(20, { ...clock, loop: true }), 3);
  assert.equal(localFrame(2147483647), 2147483647);
  for (const patch of [
    { speed: 0 },
    { speed: NaN },
    { endFrame: 1 },
    { offset: Infinity },
    { startFrame: -1 },
    { loop: 1 },
  ])
    assert.throws(() => checkTimeline({ ...clock, ...patch }));
});

test('pivots may lie outside the grid within +-1,000,000', () => {
  const frames = [{ frame: 0, size: [1, 1, 1], voxels: new Uint8Array([7]), pivot: [-10, 1000000, 2] }];
  assert.deepEqual(unpackFrames(packFrames(frames)), frames);
  assert.throws(() => packFrames([{ ...frames[0], pivot: [1000001, 0, 0] }]), /pivot/);
  assert.throws(() => packFrames([{ ...frames[0], pivot: new Array(3) }]), /pivot/);
});
