import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

function fixture(t) {
  mkdirSync('test-results', { recursive: true });
  const folder = mkdtempSync(resolve('test-results/gpu-policy-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MARGO_GPU_')));
  env.MARGO_GPU_LOCK = join(folder, 'gpu.lock');
  env.npm_lifecycle_event = '';
  const run = (
    flags,
    command = [process.execPath, '-e', 'console.log(process.env.MARGO_GPU_LOCK_NESTED_MODE)'],
    extra = {},
  ) =>
    spawnSync(
      process.execPath,
      ['scripts/gpu-lock.mjs', 'run', '--owner=policy-test', '--wait-max=0.05', ...flags, '--', ...command],
      {
        env: { ...env, ...extra },
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      },
    );
  return { folder, env, run };
}

test('correctness CLI and environment exclusive requests are refused and recorded before waiting', {
  timeout: 60_000,
}, (t) => {
  const { folder, env, run } = fixture(t);
  for (const [flags, extra] of [
    [['--exclusive'], {}],
    [[], { MARGO_GPU_EXCLUSIVE: '1' }],
  ]) {
    const r = run(flags, undefined, extra);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /ERR_GPU_EXCLUSIVE_NOT_TIMING/);
    assert.equal(existsSync(env.MARGO_GPU_LOCK), false);
  }
  const records = readFileSync(join(folder, 'gpu-lock-refusals.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.code === 'ERR_GPU_EXCLUSIVE_NOT_TIMING' && r.owner === 'policy-test'));
});

test('a classified benchmark gets an exclusive slot without a timing override', { timeout: 30_000 }, (t) => {
  const { folder, run } = fixture(t);
  const bench = join(folder, 'bench-smoke.mjs');
  writeFileSync(bench, 'console.log(process.env.MARGO_GPU_LOCK_NESTED_MODE);');
  const r = run([], [process.execPath, bench]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'exclusive');
});

test('explicit timing reasons are retained and the 20-minute cap also applies inside a nested hold', {
  timeout: 60_000,
}, (t) => {
  const { folder, env, run } = fixture(t);
  const r = run(['--timing=CPU-only policy fixture', '--max=20']);
  assert.equal(r.status, 0, r.stderr);
  const record = JSON.parse(readFileSync(join(folder, 'gpu-lock-timing.log'), 'utf8'));
  assert.equal(record.timing, 'CPU-only policy fixture');
  assert.equal(record.maxMinutes, 20);
  const refused = run(['--timing=CPU-only policy fixture', '--max=20.01'], undefined, {
    MARGO_GPU_LOCK_NESTED: join(env.MARGO_GPU_LOCK, 'nested'),
    MARGO_GPU_LOCK_NESTED_MODE: 'exclusive',
  });
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /ERR_GPU_EXCLUSIVE_LIMIT/);
  assert.equal(JSON.parse(readFileSync(join(folder, 'gpu-lock-refusals.log'), 'utf8')).maxMinutes, 20.01);
});
