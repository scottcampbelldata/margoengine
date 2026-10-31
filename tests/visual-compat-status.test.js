import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTable, parseTable } from '../scripts/support/visual-compat-doc.js';
import {
  exact,
  frameProblems,
  gateProblems,
  noFrameProblems,
  record,
  verdict,
} from '../scripts/support/visual-compat-status.js';

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

test('the frame budget counts only when the layer is over it and at least twice native, and only in its own step', () => {
  const frame = (native, compat) => ({
    native: { work: native, interval: 16.7 },
    compat: { work: compat, interval: 16.7 },
  });
  assert.deepEqual(frameProblems(frame(10, 40), 33), ['median frame on the layer 40.0 ms, over the 33 ms budget']);
  assert.deepEqual(frameProblems(frame(30, 40), 33), []);
  assert.deepEqual(frameProblems(frame(10, 30), 33), []);
  assert.deepEqual(frameProblems(frame(1, 86)), ['median frame on the layer 86.0 ms, over the 50 ms budget']);
  // The pixel gate runs in a shared GPU slot and holds no frame to a budget, whatever the row carries.
  assert.deepEqual(gateProblems({ status: 'same', frame: frame(1, 86) }, { status: 'same' }), []);
});

test('a demo that draws no frames measured nothing, and that fails the budget instead of passing it', () => {
  const none = { frames: 0, work: NaN, interval: NaN },
    drawn = { frames: 60, work: 2, interval: 16.7 };
  assert.match(frameProblems({ native: none, compat: none })[0], /no frame measured on native and layer/);
  assert.match(frameProblems({ native: drawn, compat: none })[0], /no frame measured on layer/);
  assert.match(frameProblems({ native: none, compat: drawn })[0], /no frame measured on native/);
  // One frame has work but no interval: still no median to judge.
  assert.match(frameProblems({ native: drawn, compat: { frames: 1, work: 3, interval: NaN } })[0], /on layer/);
  assert.deepEqual(frameProblems({ native: drawn, compat: drawn }), []);
});

test('a demo with no frame reports the uncaught page error behind its timeout', () => {
  const capture = 'layer: capture: page.waitForFunction: Timeout 240000ms exceeded.',
    thrown = "layer: pageerror: Cannot read properties of undefined (reading 'start')";
  assert.deepEqual(noFrameProblems([thrown, capture]), [capture, thrown]);
  assert.deepEqual(noFrameProblems([capture]), [capture]);
  assert.deepEqual(noFrameProblems([]), ['no frame measured']);
});

test('the demos table round-trips, and each step rewrites only its own columns', () => {
  const doc = [
    'intro',
    '<!-- visual-compat table: generated by npm run visual:compat -- --write -->',
    'Last recorded 2026-10-30 at abc on gpu (edge); a row not rerun then keeps the numbers of its last run on the same machine.',
    '',
    '| Demo | View | On the WebGL2 layer | Native run-to-run (d > 2, mean) | Frame work native / layer; interval native / layer |',
    '| --- | --- | --- | --- | --- |',
    '| `a` | high | runs, same pixels | exact | 0.4 ms / 0.7 ms; 16.7 ms / 16.7 ms |',
    '| `b` | model | refused: needs storage / atomics | exact | - |',
    '<!-- end of the visual-compat table -->',
    'outro',
  ].join('\n');
  const { rows, recorded } = parseTable(doc);
  assert.equal(formatTable(doc, rows, recorded), doc);
  rows.get('a')[4] = '1.0 ms / 2.0 ms; 16.7 ms / 16.7 ms';
  const framed = formatTable(doc, rows, recorded);
  assert.match(framed, /\| `a` \| high \| runs, same pixels \| exact \| 1\.0 ms \/ 2\.0 ms; 16\.7 ms \/ 16\.7 ms \|/);
  assert.match(framed, /^Last recorded 2026-10-30 at abc/m);
});
