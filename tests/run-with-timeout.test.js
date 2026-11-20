// scripts/run-with-timeout.mjs runs GPU work directly with a hard timeout; no GPU lock is used, ever (Scott,
// 2026-11-16). Regression for the removed GPU lock: every command starts at once, however many run, and
// a hung one is still ended at its timeout with its whole process tree.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { quoteWindows, windowsCommandLine } from '../scripts/run-with-timeout.mjs';
import { eachAtOnce } from '../scripts/support/each-at-once.mjs';

const script = resolve('scripts/run-with-timeout.mjs');

/** Starts the helper with `flags` and node running `program`; resolves {code, out, err}. */
function run(flags, program) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...flags, '--', process.execPath, ...program], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '',
      err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => done({ code, out, err }));
  });
}

for (const count of [2, 8])
  test(`${count} commands started together all run at once`, { timeout: 60_000 }, async () => {
    // Each command waits until all of them have started, so any waiting would deadlock until the timeout.
    const dir = resolve('test-results', `run-with-timeout-${count}-${process.pid}`);
    const results = await Promise.all(
      Array.from({ length: count }, () =>
        run(['--max=1'], [resolve('tests/fixtures/rendezvous.mjs'), dir, String(count)]),
      ),
    );
    rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(
      results.map((r) => r.out.trim()),
      Array(count).fill('ok'),
    );
    assert.ok(results.every((r) => r.code === 0));
  });

test('a hung command is ended at its timeout, with exit 124', { timeout: 30_000 }, async () => {
  const started = Date.now();
  const result = await run(['--max=0.03'], ['-e', 'setInterval(()=>{},1000)']);
  assert.equal(result.code, 124);
  assert.match(result.err, /TIMEOUT after 0\.03 min/);
  // wall-clock: a hang guard; the command is ended after 1.8 s.
  assert.ok(Date.now() - started < 20_000);
});

test("the command's own exit code is passed through", { timeout: 30_000 }, async () => {
  assert.equal((await run([], ['-e', 'process.exitCode = 3'])).code, 3);
});

test('the run verb and an old flag from a tool outside the repository are accepted', { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, [script, 'run', '--owner=x', '--max=1', '--', process.execPath, '-e', '0'], {
    stdio: 'ignore',
  });
  assert.equal(await new Promise((done) => child.on('close', done)), 0);
});

test('Windows command lines keep every argument and cmd operator literal', () => {
  assert.equal(quoteWindows('plain/path.mjs'), 'plain/path.mjs');
  assert.equal(quoteWindows('a b'), '"a b"');
  assert.equal(windowsCommandLine(['node', 'a"|b']), 'node "a\\"^|b"');
  assert.equal(windowsCommandLine(['echo', 'x&y']), 'echo "x&y"');
});

test('eachAtOnce runs every item, at most `jobs` at a time', async () => {
  let running = 0,
    peak = 0;
  const seen = [];
  await eachAtOnce([1, 2, 3, 4, 5], 2, async (item) => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, 5));
    seen.push(item);
    running--;
  });
  assert.deepEqual(
    seen.sort((a, b) => a - b),
    [1, 2, 3, 4, 5],
  );
  assert.equal(peak, 2);
});
