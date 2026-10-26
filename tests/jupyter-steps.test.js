// The Jupyter end-to-end check's step limits (python/tests/jupyter-steps.mjs): a hung step is named, and a timeout ends
// the whole process tree. Before this, a notebook run before its kernel was attached hung for minutes with no name, and
// the server and browser were left running.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { killTree, notebookHasKernel, StepTimeout, serverPort, step } from '../python/tests/jupyter-steps.mjs';

// A JupyterLab or Notebook 7 app as window.jupyterapp shows it, with one notebook in the main area.
const app = (path, context) => ({
  shell: {
    widgets: (area) =>
      area === 'main' ? [{ context: { path }, sessionContext: context }][Symbol.iterator]() : [][Symbol.iterator](),
  },
});
const withApp = (value, run) => {
  globalThis.jupyterapp = value;
  try {
    return run();
  } finally {
    delete globalThis.jupyterapp;
  }
};
const connected = {
  isReady: true,
  hasNoKernel: false,
  session: { kernel: { id: 'k1', connectionStatus: 'connected' } },
};

test('a notebook has its kernel only once it holds its own connection to it, whatever the server counts', () => {
  const ask = { path: 'check.ipynb', kernelId: 'k1' };
  assert.equal(
    withApp(undefined, () => notebookHasKernel(ask)),
    false,
    'no app yet',
  );
  // The state the check once ran the cells in: the server counted the help menu's connection to k1, while the
  // notebook had not found its session (Run All then asks "Select Kernel" or runs nothing).
  assert.equal(
    withApp(app('check.ipynb', { isReady: false, hasNoKernel: true, session: null }), () => notebookHasKernel(ask)),
    false,
  );
  const connecting = { ...connected, session: { kernel: { id: 'k1', connectionStatus: 'connecting' } } };
  assert.equal(
    withApp(app('check.ipynb', connecting), () => notebookHasKernel(ask)),
    false,
    'still connecting',
  );
  const other = { ...connected, session: { kernel: { id: 'k2', connectionStatus: 'connected' } } };
  assert.equal(
    withApp(app('check.ipynb', other), () => notebookHasKernel(ask)),
    false,
    'another kernel',
  );
  assert.equal(
    withApp(app('plain.ipynb', connected), () => notebookHasKernel(ask)),
    false,
    'another notebook',
  );
  assert.equal(
    withApp(app('check.ipynb', connected), () => notebookHasKernel(ask)),
    true,
  );
});

test('the server port is the one the server took, read from its log', () => {
  assert.equal(serverPort('[I ServerApp] jupyterlab | extension was successfully loaded.'), undefined);
  // The port offered was in use: the server moved on, and only the port it serves on counts.
  const log =
    '[I ServerApp] The port 8913 is already in use, trying another port.\n[I ServerApp] http://127.0.0.1:8914/lab\n';
  assert.equal(serverPort(log), 8914);
});

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
