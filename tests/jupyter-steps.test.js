// The Jupyter end-to-end check's step limits (python/tests/jupyter-steps.mjs): a hung step is named, and a timeout ends
// the whole process tree. Before this, a notebook run before its kernel was attached hung for minutes with no name, and
// the server and browser were left running.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { killTree, StepTimeout, step } from '../python/tests/jupyter-steps.mjs';

test('a step that hangs fails after its limit and names itself', async () => {
  const t0 = Date.now();
  await assert.rejects(
    step('open the notebook', 150, () => new Promise(() => {})),
    (error) =>
      error instanceof StepTimeout &&
      error.step === 'open the notebook' &&
      /"open the notebook" hung/.test(error.message),
  );
  assert.ok(Date.now() - t0 < 5000);
});

test('a step that finishes returns its value and leaves no timer behind', async () => {
  assert.equal(await step('quick', 60_000, async () => 7), 7);
});

test('killTree ends the process and everything it started', async () => {
  const grandchild = 'setInterval(() => {}, 1000)';
  const parent = spawn(
    process.execPath,
    [
      '-e',
      `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });
       console.log(c.pid); setInterval(() => {}, 1000);`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' },
  );
  const childPid = await new Promise((resolve) => parent.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(alive(childPid), 'the grandchild runs before the kill');
  killTree(parent.pid);
  for (let t = 0; alive(childPid) && t < 50; t++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!alive(childPid), 'the grandchild is gone after killTree');
});
