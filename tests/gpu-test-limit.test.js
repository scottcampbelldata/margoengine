// check:gpu-packages gives every test a hard time limit (scripts/support/run-limited.mjs). Before this, one hung
// package test held the GPU lock and blocked a whole check:merge until the overall limit.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_TEST_MINUTES, runLimited, testLimitMs } from '../scripts/support/run-limited.mjs';
import { endTree, taskkillPids } from '../scripts/support/shutdown.mjs';

const node = JSON.stringify(process.execPath);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A hard limit on each test that waits on a process: a kill path that broke would otherwise hang the file.
const LIMIT = { timeout: 5 * 60_000 };

test('a hanging test is killed with its child process, within the limit, and named', LIMIT, async () => {
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
    // The limit fires once the child has recorded its pid, however long a busy machine took to start the two processes
    // (a real 1.5 s limit fired first: "the fake test never started its child").
    let fire, limitAsked;
    const running = runLimited(`${node} ${JSON.stringify(parentFile)}`, {
      cwd: dir,
      limitMs: 1500,
      label: 'fake-package test:browser',
      startLimit: (run, ms) => {
        fire = run;
        limitAsked = ms;
      },
    });
    assert.equal(limitAsked, 1500);
    let pid = Number.NaN;
    while (!(pid > 0)) {
      // fixed-wait: polling for the file the fake test writes, which has no event to wait on.
      await new Promise((resolve) => setTimeout(resolve, 10));
      pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : Number.NaN;
    }
    assert.equal(alive(pid), true, 'the hung test is running before the limit');
    fire();
    const result = await running;
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.match(result.message, /fake-package test:browser hung: no result after 2 s/);
    assert.match(result.message, /MARGO_GPU_TEST_TIMEOUT_MIN/);
    assert.equal(alive(pid), false, 'the hung test left its child process running');
    assert.equal(result.survivors, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the limit really fires on the clock, with no help from a test', async () => {
  const result = await runLimited(`${node} -e "setInterval(() => {}, 1000)"`, {
    cwd: tmpdir(),
    limitMs: 50,
    label: 'on the clock',
  });
  assert.equal(result.timedOut, true);
  assert.match(result.message, /on the clock hung/);
});

test('runLimited resolves after a killed tree is gone, not when the shell has exited', LIMIT, async () => {
  // taskkill returns while the processes are dying and still hold the folder they ran in: removing it right after
  // failed with EPERM under load. The end of the kill is held back here, so the order is the same every run.
  let finishKill;
  const killStarted = Promise.withResolvers();
  let resolved = false;
  const running = runLimited(`${node} -e "setInterval(() => {}, 1000)"`, {
    cwd: tmpdir(),
    limitMs: 1,
    end: async (pid) => {
      await endTree(pid);
      killStarted.resolve();
      await new Promise((resolve) => (finishKill = resolve));
      return [];
    },
  }).then((result) => {
    resolved = true;
    return result;
  });
  await killStarted.promise;
  // fixed-wait: long enough for the shell's exit to reach Node; the assertion can only pass wrongly, never fail wrongly.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(resolved, false, 'resolved while the tree was still being ended');
  finishKill();
  assert.equal((await running).timedOut, true);
});

test('endTree waits for every process taskkill named, and returns the ones past the limit', async () => {
  const seen = [];
  let polls = 0;
  const gone = await endTree(1, {
    kill: async () => [11, 12],
    alive: (pid) => {
      seen.push(pid);
      return pid === 12 && ++polls < 3;
    },
  });
  assert.deepEqual(gone, []);
  assert.equal(polls, 3, 'it kept asking until the last process was gone');
  const left = await endTree(1, { kill: async () => [13], alive: () => true, waitMs: 20 });
  assert.deepEqual(left, [13]);
});

test('the pids come from taskkill lines, never the parent it names', () => {
  assert.deepEqual(
    taskkillPids(
      'SUCCESS: The process with PID 95380 (child process of PID 55468) has been terminated.\r\nSUCCESS: The process with PID 55468 (child process of PID 102216) has been terminated.\r\n',
    ),
    [95380, 55468],
  );
  assert.deepEqual(taskkillPids(''), []);
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
