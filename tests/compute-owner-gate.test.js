import test from 'node:test';
import assert from 'node:assert/strict';
import { plan } from '../scripts/gpu-package-tests.mjs';

test('ComputeFrame owner regression is planned as package GPU correctness work', () => {
  const owner = plan().find((step) => step.dir === 'compute' && step.command.includes('scene-owner-browser.mjs'));
  assert.ok(owner, 'the real package GPU plan must execute the owner regression');
  assert.equal(owner.script, 'test:gpu:owners');
  assert.equal(owner.command, 'cd ../.. && node packages/compute/tests/scene-owner-browser.mjs');
  assert.ok(!owner.exclusive, 'owner correctness uses a shared slot');
});
