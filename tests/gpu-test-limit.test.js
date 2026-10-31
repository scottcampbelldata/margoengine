// check:gpu-packages gives every test a hard time limit (scripts/support/run-limited.mjs). Before this, one hung
// package test held the GPU lock and blocked a whole check:merge until the overall limit.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_TEST_MINUTES, runLimited, testLimitMs } from '../scripts/support/run-limited.mjs';

const node = JSON.stringify(process.execPath);

test('a hanging test is killed with its child process, within the limit, and named', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-limit-'));
  try {
    const pidFile = join(dir, 'grandchild.pid');
    // The test starts a child that records its pid, then both hang forever.
    const childFile = join(dir, 'child.cjs');
    const parentFile = join(dir, 'parent.cjs');
    writeFileSync(
      childFile,
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    writeFileSync(
      parentFile,
      `require('child_process').spawn(process.execPath, [${JSON.stringify(childFile)}], { stdio: 'inherit' }); setInterval(() => {}, 1000);`,
    );
    const t0 = Date.now();
    const result = await runLimited(`${node} ${JSON.stringify(parentFile)}`, {
      cwd: dir,
      limitMs: 1500,
      label: 'fake-package test:browser',
    });
    assert.ok(Date.now() - t0 < 20_000, 'returned long after the limit');
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.match(result.message, /fake-package test:browser hung: no result after 2 s/);
    assert.match(result.message, /MARGO_GPU_TEST_TIMEOUT_MIN/);
    assert.ok(existsSync(pidFile), 'the fake test never started its child');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const gone = () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    for (const end = Date.now() + 30_000; !gone(); await new Promise((r) => setTimeout(r, 10)))
      assert.ok(Date.now() < end, 'the hung test left its child process running');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a passing test and a failing test finish normally, with no timeout message', async () => {
  const pass = await runLimited(`${node} -e "process.exit(0)"`, { cwd: tmpdir(), limitMs: 30_000 });
  assert.deepEqual([pass.ok, pass.timedOut, pass.message], [true, false, undefined]);
  const fail = await runLimited(`${node} -e "process.exit(3)"`, { cwd: tmpdir(), limitMs: 30_000 });
  assert.deepEqual([fail.ok, fail.timedOut, fail.message], [false, false, undefined]);
});

test('the limit: environment beats the package setting, which beats the 10 minute default', () => {
  assert.equal(testLimitMs(undefined, {}), DEFAULT_TEST_MINUTES * 60_000);
  assert.equal(testLimitMs(20, {}), 20 * 60_000);
  assert.equal(testLimitMs(20, { MARGO_GPU_TEST_TIMEOUT_MIN: '2' }), 2 * 60_000);
  assert.throws(() => testLimitMs(undefined, { MARGO_GPU_TEST_TIMEOUT_MIN: 'soon' }), /positive number of minutes/);
  assert.throws(() => testLimitMs(0, {}), RangeError);
});
