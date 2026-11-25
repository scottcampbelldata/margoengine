import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from './rustc.js';

test('a missing compiler fails with "not installed", not a NaN assert message', () => {
  assert.throws(
    () => compile([], { command: 'margo-no-such-rustc' }),
    (error) => error.code === 'ERR_ASSERTION' && /margo-no-such-rustc not installed/.test(error.message),
  );
});

test('a compiler that exits non-zero reports its status and output', () => {
  assert.throws(
    () => compile(['-e', 'process.stderr.write("boom");process.exit(3)'], { command: process.execPath }),
    /exited 3\nboom/,
  );
});
