import assert from 'node:assert/strict';
import test from 'node:test';
import { plan } from '../../../scripts/gpu-package-tests.mjs';

test('the real ComputeFrame ownership regression runs in the package GPU plan', () => {
  const entry = plan().find((row) => row.dir === 'compute' && row.script === 'test:gpu:owners');
  assert.ok(entry, 'ComputeFrame ownership must run when compute changes');
  assert.match(entry.command, /node packages\/compute\/tests\/scene-owner-browser\.mjs/);
});

test('dense decomposition and previously orphaned feature suites run in the GPU plan', () => {
  const entries = plan();
  for (const [dir, script] of [
    ['compute', 'test:browser:decomp'],
    ['cameras', 'test:browser:panorama'],
    ['weather', 'test:browser:parity'],
  ])
    assert.ok(
      entries.some((row) => row.dir === dir && row.script === script),
      `${dir}/${script} must run`,
    );
  for (const [dir, script] of [
    ['compute', 'test:browser:shape'],
    ['compute', 'test:browser:decomp'],
    ['cameras', 'test:browser:panorama'],
    ['weather', 'test:browser:parity'],
  ])
    assert.match(
      entries.find((row) => row.dir === dir && row.script === script).command,
      /^cd \.\.\/\.\. && node packages\//,
    );
});
