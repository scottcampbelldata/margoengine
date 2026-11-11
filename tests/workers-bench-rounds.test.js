// workers/run.mjs discards round 0; --rounds=1 once ran the whole browser session and then failed on an empty median.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const script = new URL('../examples/package-benchmarks/workers/run.mjs', import.meta.url);

for (const rounds of ['1', '0', '2.5'])
  test(`workers bench refuses --rounds=${rounds} before any work`, () => {
    const run = spawnSync(process.execPath, [script.pathname.replace(/^\/([A-Za-z]:)/, '$1'), `--rounds=${rounds}`], {
      env: { ...process.env, MARGO_SPEED_PHASE: 'active' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /--rounds must be an integer of at least 2/);
  });
