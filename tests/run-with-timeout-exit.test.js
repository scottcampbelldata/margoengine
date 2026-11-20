// KB-OWN-EXIT1 and KB-OWN-EXIT2: scripts/run-with-timeout.mjs sets `process.exitCode` and ends by its event loop; it never
// ends through `process.exit`, which shuts V8's platform down while the isolate lives and can hold the exit for ever
// (nodejs/node#54918). tests/support/end-recorder.js records, from a preload, which way each node process ended.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { endRecorder } from './support/end-recorder.js';

const script = resolve(import.meta.dirname, '../scripts/run-with-timeout.mjs');

test('run-with-timeout ends by its event loop with its command code, and with 2 on a usage error', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'run-with-timeout-end-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const { env, lines } = endRecorder(folder);
  const ran = spawnSync(
    process.execPath,
    [script, 'run', '--max=1', '--', process.execPath, '-e', 'process.exitCode = 3'],
    {
      env,
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  assert.equal(ran.status, 3, ran.stderr);
  const noCommand = spawnSync(process.execPath, [script, '--max=1'], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(noCommand.status, 2, noCommand.stderr);
  const badMax = spawnSync(process.execPath, [script, '--max=0', '--', process.execPath, '-e', '0'], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(badMax.status, 2, badMax.stderr);
  const ends = lines();
  assert.ok(ends.includes('run loop 3'), `the wrapper did not end by its event loop: ${ends.join(' | ')}`);
  assert.ok(ends.includes('--max=1 loop 2'), `a missing command did not end by its event loop: ${ends.join(' | ')}`);
  assert.ok(ends.includes('--max=0 loop 2'), `a bad --max did not end by its event loop: ${ends.join(' | ')}`);
});
