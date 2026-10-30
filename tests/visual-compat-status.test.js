import assert from 'node:assert/strict';
import test from 'node:test';
import { exact, gateProblems, record, verdict } from '../scripts/support/visual-compat-status.js';

const m = (over2, mean, max) => ({ over2, mean, max });

test('the parity rule is absolute: native noise never turns a layer difference into "same"', () => {
  assert.equal(verdict(m(0.001, 0.25, 9)), 'same');
  assert.equal(verdict(m(0.00101, 0.01, 9)), 'differs');
  assert.equal(verdict(m(0, 0.26, 9)), 'differs');
  // ui-game before its backdrop held still: layer 0.18% while the two native captures differed by 0.21%.
  const row = { status: verdict(m(0.0018, 0.0735, 203)), diff: m(0.0018, 0.0735, 203), noise: m(0.0021, 0.161, 101) };
  assert.equal(row.status, 'differs');
  assert.deepEqual(gateProblems(row, { status: 'same', exact: true }), [
    'expected same, got differs',
    'the two native captures differ (d > 2 on 0.21%, max d 101): the still frame is no longer exact, something moves under reduced motion',
  ]);
});

test('a demo recorded with an exact still frame fails the gate when its native captures differ at all', () => {
  const want = { status: 'same', exact: true };
  assert.deepEqual(gateProblems({ status: 'same', diff: m(0, 0, 0), noise: m(0, 0, 0) }, want), []);
  const problems = gateProblems({ status: 'same', diff: m(0, 0, 0), noise: m(0, 0.00001, 1) }, want);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no longer exact/);
  // A demo not recorded as exact keeps the old gate.
  assert.deepEqual(gateProblems({ status: 'same', diff: m(0, 0, 0), noise: m(0, 0.00001, 1) }, { status: 'same' }), []);
});

test('the same numbers always give the same status and problems (the gate cannot flip on its own)', () => {
  const row = { status: 'differs', diff: m(0.0707, 0.8, 204), noise: m(0, 0, 0) },
    want = { status: 'differs', over2: 0.0707, mean: 0.8, exact: true };
  for (let i = 0; i < 3; i++) assert.deepEqual(gateProblems(row, want), []);
  assert.deepEqual(gateProblems({ ...row, diff: m(0.2, 0.8, 204) }, want), ['over2 0.2 over the recorded 0.0707']);
});

test('--write records an exact still frame, and an unrecorded demo fails without --write', () => {
  assert.equal(exact(m(0, 0, 0)), true);
  assert.equal(exact(m(0, 0.0000586, 1)), false);
  assert.deepEqual(record({ status: 'same', diff: m(0, 0, 0), noise: m(0, 0, 0) }), { status: 'same', exact: true });
  assert.deepEqual(record({ status: 'differs', diff: m(0.0066, 0.66, 90), noise: m(0, 0.0001, 1) }), {
    status: 'differs',
    over2: 0.0066,
    mean: 0.66,
  });
  assert.deepEqual(record({ status: 'refused', refused: 'needs storage textures' }), {
    status: 'refused',
    refused: 'needs storage textures',
  });
  assert.deepEqual(gateProblems({ status: 'same', diff: m(0, 0, 0) }, undefined), [
    'not in visual-compat-expected.json (run with --write)',
  ]);
  assert.deepEqual(gateProblems({ status: 'same', diff: m(0, 0, 0) }, undefined, { write: true }), []);
});

test('the frame budget counts only when the layer is over it and at least twice native', () => {
  const frame = (native, compat) => ({ native: { work: native }, compat: { work: compat } });
  const want = { status: 'same' };
  assert.deepEqual(gateProblems({ status: 'same', frame: frame(10, 40) }, want, { budget: 33 }), [
    'median frame on the layer 40.0 ms, over the 33 ms budget',
  ]);
  assert.deepEqual(gateProblems({ status: 'same', frame: frame(30, 40) }, want, { budget: 33 }), []);
  assert.deepEqual(gateProblems({ status: 'same', frame: frame(10, 30) }, want, { budget: 33 }), []);
});
