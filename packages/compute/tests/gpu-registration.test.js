import assert from 'node:assert/strict';
import test from 'node:test';
import { plan } from '../../../scripts/gpu-package-tests.mjs';

test('the real ComputeFrame ownership regression runs in the package GPU plan', () => {
  const entry = plan().find((row) => row.dir === 'compute' && row.script === 'test:gpu:owners');
  assert.ok(entry, 'ComputeFrame ownership must run when compute changes');
  assert.match(entry.command, /node packages\/compute\/tests\/scene-owner-browser\.mjs/);
});
