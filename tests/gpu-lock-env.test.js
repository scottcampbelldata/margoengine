import './support/gpu-lock-env.js';
// Root tests of the GPU lock run with the lane's own lock settings in the environment (MARGO_GPU_SLOTS=4 while the
// queue drains, MARGO_GPU_LOCK_NESTED inside `gpu-lock run`) and beside other lanes that hold the real lock. Found in the
// KB-FL1 hunt (2026-11-11): "shared holders share ... (3 by default)" failed on every root run with MARGO_GPU_SLOTS=4.
// tests/support/gpu-lock-env.js clears those settings and gives each test process a lock of its own; these checks keep
// every such test on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const LINE = "import './support/gpu-lock-env.js';";

test('every root test that names the GPU lock or a MARGO_GPU_ variable imports gpu-lock-env first', () => {
  const missing = [];
  for (const name of readdirSync(join(root, 'tests')).filter((n) => n.endsWith('.test.js'))) {
    const text = readFileSync(join(root, 'tests', name), 'utf8');
    if (!/scripts\/gpu-lock\.mjs|MARGO_GPU_/.test(text)) continue;
    // The first import is the one that runs first: ES modules evaluate their imports in order.
    const first = text.split(/\r?\n/).find((line) => /^import[\s{'"*]/.test(line));
    if (first?.trim() !== LINE) missing.push(`tests/${name} (first import: ${first ?? 'none'})`);
  }
  assert.deepEqual(missing, [], `put ${LINE} above every other import`);
});

test("gpu-lock-env clears the lane's lock settings and gives the process a lock outside the main checkout", () => {
  const helper = pathToFileURL(join(root, 'tests/support/gpu-lock-env.js')).href,
    gpuLock = pathToFileURL(join(root, 'scripts/gpu-lock.mjs')).href,
    real = join(root, 'test-results', 'gpu.lock');
  const probe = `const env = await import(${JSON.stringify(helper)}); const gpu = await import(${JSON.stringify(gpuLock)});
console.log(JSON.stringify({ own: env.ownLock, lockDir: gpu.lockDir, slots: gpu.slots(), names: Object.keys(process.env).filter((k) => /^MARGO_GPU_/i.test(k)) }));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: root,
    encoding: 'utf8',
    // A hang bound only: the probe loads two modules and prints.
    timeout: 60_000,
    env: {
      ...process.env,
      MARGO_GPU_SLOTS: '4',
      MARGO_GPU_LOCK: real,
      MARGO_GPU_LOCK_NESTED: join(real, 'nested'),
      MARGO_GPU_EXCLUSIVE: '1',
      MARGO_GPU_WAIT_MAX_MIN: '0.001',
    },
  });
  assert.equal(run.status, 0, `${run.error ?? ''}\n${run.stderr}`);
  const seen = JSON.parse(run.stdout);
  assert.deepEqual(seen.names, ['MARGO_GPU_LOCK'], 'only the own lock is left');
  assert.equal(seen.lockDir, seen.own);
  assert.ok(seen.own.startsWith(tmpdir()), seen.own);
  assert.notEqual(resolve(seen.own), resolve(real));
  assert.equal(seen.slots, 3, 'the default slot count, not the lane setting');
});
