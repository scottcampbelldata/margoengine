// KB-GL1: `gpu-lock run` refused browser checks whose file names carry no GPU word (ERR_GPU_COMMAND_NOT_GPU), so
// helpers ran them outside the lock and 8 GPU users were seen at once against the 5-slot cap. A node script that opens
// a browser, itself or through its own relative imports, is a GPU leaf; `run` admits it, and each one holds a slot.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { gpuCommand, opensBrowser } from '../scripts/support/gpu-command.mjs';

const lockScript = resolve('scripts/gpu-lock.mjs');

// Temp scripts live two folders below the checkout root, so '../../scripts/...' names the real launchers. Each launcher
// import sits behind a branch that never runs: the scripts open no browser when started.
function writeScripts(folder) {
  const scripts = {
    'direct.mjs': "if (process.env.MARGO_NEVER) await import('../../scripts/browser.js');",
    'through-helper.mjs': "import { start } from './helper.mjs';\nif (process.env.MARGO_NEVER) await start();",
    'helper.mjs': "export const start = () => import('../../scripts/lib/browser.mjs');",
    'host.mjs': "import '../../scripts/support/browser-host.mjs';",
    'playwright-bare.mjs': "import { webkit } from 'playwright';\nvoid webkit;",
    'plain.mjs': "import { readFileSync } from 'node:fs';\nvoid readFileSync;",
    'plain-helper.mjs': "import './plain.mjs';",
  };
  for (const [name, text] of Object.entries(scripts)) writeFileSync(join(folder, name), text);
}

test('a node script that opens a browser, directly or through a helper, is a GPU leaf', { timeout: 10_000 }, () => {
  const folder = mkdtempSync(resolve('test-results/gpu-command-'));
  try {
    writeScripts(folder);
    for (const name of ['direct.mjs', 'through-helper.mjs', 'host.mjs', 'playwright-bare.mjs']) {
      assert.equal(opensBrowser(join(folder, name)), true, name);
      assert.equal(gpuCommand(['node', join(folder, name)]), 'gpu', name);
    }
    for (const name of ['plain.mjs', 'plain-helper.mjs']) {
      assert.equal(opensBrowser(join(folder, name)), false, name);
      assert.equal(gpuCommand(['node', join(folder, name)]), 'unknown', name);
    }
    // A launcher one import deeper than the search depth is not followed.
    assert.equal(opensBrowser(join(folder, 'through-helper.mjs'), { depth: 0 }), false);
    // A relative leaf resolves against the command's folder.
    assert.equal(gpuCommand(['node', 'through-helper.mjs'], { cwd: folder }), 'gpu');
    // Real repository checks: browser checks without a GPU word are GPU leaves; CPU tools stay CPU.
    assert.equal(gpuCommand(['node', 'scripts/csp-check.mjs']), 'gpu');
    assert.equal(gpuCommand(['node', 'scripts/hygiene.js']), 'cpu');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('gpu-lock run admits browser scripts without a reason and each one holds a slot', { timeout: 120_000 }, async () => {
  const folder = mkdtempSync(resolve('test-results/gpu-command-run-'));
  const lock = join(folder, 'gpu.lock');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MARGO_GPU_')));
  Object.assign(env, { MARGO_GPU_LOCK: lock, MARGO_GPU_SLOTS: '2', MARGO_GPU_FRESH_MS: '0' });
  // Each script reports the slot mode its run holds, then waits for the test to let it finish.
  const helper = [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'export async function hold(folder, label) {',
    "  if (process.env.MARGO_NEVER) await import('../../scripts/browser.js');",
    "  writeFileSync(join(folder, `${label}-started`), process.env.MARGO_GPU_LOCK_NESTED_MODE ?? 'none');",
    '  for (const deadline = Date.now() + 60_000; !existsSync(join(folder, `${label}-finish`)); ) {',
    "    if (Date.now() > deadline) throw new Error('fixture exceeded its hard limit');",
    '    await new Promise((done) => setTimeout(done, 10));',
    '  }',
    '}',
  ].join('\n');
  writeFileSync(join(folder, 'hold.mjs'), helper);
  writeFileSync(
    join(folder, 'check.mjs'),
    "import { hold } from './hold.mjs';\nawait hold(process.argv[2], process.argv[3]);",
  );
  const children = [];
  const start = (label) => {
    const tree = join(folder, label);
    mkdirSync(join(tree, '.git'), { recursive: true });
    const child = spawn(
      process.execPath,
      [lockScript, 'run', `--owner=lane-${label}`, '--max=2', '--wait-max=1', '--', process.execPath, join(folder, 'check.mjs'), folder, label],
      { cwd: tree, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    child.stderrText = '';
    child.stderr.on('data', (chunk) => (child.stderrText += chunk));
    child.done = new Promise((done) => child.on('exit', (code) => done(code)));
    children.push(child);
    return child;
  };
  const until = async (ok, what) => {
    for (const deadline = Date.now() + 60_000; !ok(); ) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((done) => setTimeout(done, 20));
    }
  };
  const started = (label) => existsSync(join(folder, `${label}-started`));
  try {
    const a = start('a'),
      b = start('b');
    await Promise.race([
      until(() => started('a') && started('b'), 'both browser scripts to start'),
      a.done.then((code) => assert.fail(`run a exited ${code} before starting: ${a.stderrText}`)),
      b.done.then((code) => assert.fail(`run b exited ${code} before starting: ${b.stderrText}`)),
    ]);
    for (const label of ['a', 'b']) assert.equal(readFileSync(join(folder, `${label}-started`), 'utf8'), 'shared');
    // Both slots are held: a third browser script waits for one of them.
    const c = start('c');
    // gpu-lock reads MARGO_GPU_LOCK once, when it is first imported.
    const saved = process.env.MARGO_GPU_LOCK;
    process.env.MARGO_GPU_LOCK = lock;
    let gpu;
    try {
      gpu = await import(`../scripts/gpu-lock.mjs?gpu-command=${Date.now()}`);
    } finally {
      if (saved === undefined) delete process.env.MARGO_GPU_LOCK;
      else process.env.MARGO_GPU_LOCK = saved;
    }
    await until(() => gpu.status()?.waiting?.length === 1, 'the third run to queue');
    assert.deepEqual(gpu.status().holders.map((entry) => entry.owner).sort(), ['lane-a', 'lane-b']);
    assert.equal(started('c'), false, 'a third browser script ran past the slot cap');
    writeFileSync(join(folder, 'a-finish'), '');
    assert.equal(await a.done, 0, a.stderrText);
    await until(() => started('c'), 'the third run to take the freed slot');
    writeFileSync(join(folder, 'b-finish'), '');
    writeFileSync(join(folder, 'c-finish'), '');
    assert.equal(await b.done, 0, b.stderrText);
    assert.equal(await c.done, 0, c.stderrText);
  } finally {
    for (const label of ['a', 'b', 'c']) writeFileSync(join(folder, `${label}-finish`), '');
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.done));
    rmSync(folder, { recursive: true, force: true });
  }
});

// Regression (sweep L6b, 2026-11-11): `npm run test:mtoon:browser` was classed as a CPU command (its name starts with
// `test:` but not `test:browser`), so `gpu-lock run` refused it outright and its MToon GPU suites could not take a slot.
test('npm scripts with a GPU word in a later part of their name are GPU leaves', () => {
  for (const leaf of ['test:mtoon:browser', 'test:constraints:browser', 'test:limits:gpu', 'test:gpu', 'test:browser', 'test:xr'])
    assert.equal(gpuCommand(['npm', 'run', leaf, '--workspace', 'packages/rigging']), 'gpu', leaf);
  for (const leaf of ['test', 'test:unit', 'test:browserless', 'lint', 'build'])
    assert.equal(gpuCommand(['npm', 'run', leaf]), 'cpu', leaf);
});
