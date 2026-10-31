import assert from 'node:assert/strict';
import test from 'node:test';
import { PHASES, timingLines } from '../src/timing.ts';

test('the timing panel prints each phase in order, seconds and the gap since the last, a dash for what did not happen', () => {
  const lines = timingLines({ html: 200, js: 1500, move: 2750 }, ['extra']);
  assert.equal(lines.length, PHASES.length + 4);
  const row = (label) => lines.find((line) => line.startsWith(label));
  assert.match(row('HTML downloaded'), /0\.20 \+0\.20$/);
  assert.match(row('JS downloaded'), /1\.50 \+1\.30$/);
  assert.match(row('CAN MOVE'), /2\.75 \+1\.25$/);
  assert.match(row('Welcome'), / - *$/);
  assert.equal(lines.at(-1), 'extra');
  assert.ok(
    lines.every((line) => line.length <= 52 && !/[–—]/.test(line)),
    'fits a phone, no long dashes',
  );
});
