import assert from 'node:assert/strict';
import test from 'node:test';
import { settle } from '../scripts/verify.mjs';

test('verify names cache settlement before synchronous build bookkeeping starts', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const command = 'npm run build:packages',
    shadow = {
      finish(step, dir, options) {
        assert.equal(lines.length, 1);
        assert.match(lines[0], /cache: settling npm run build:packages:.*packing outputs.*archive cap/);
        assert.equal(step, command);
        assert.equal(dir, 'recorded-build');
        assert.deepEqual(options, { kind: 'builds', code: 0, seconds: 1 });
        return [{ cache: { wouldHit: false } }];
      },
    };
  settle(shadow, { command, code: 0, seconds: 1, recordDir: 'recorded-build' });
  assert.match(lines[1], /0 of 1 would hit/);
});

test('verify prints no settlement for an unrecorded command', (t) => {
  const log = t.mock.method(console, 'log');
  settle(undefined, { command: 'unrecorded' });
  assert.equal(log.mock.callCount(), 0);
});
