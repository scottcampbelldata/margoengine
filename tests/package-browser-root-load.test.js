// Regression KB-FL2 (2026-11-11): tests/package-browser-root.test.js failed once in a parallel root run and passed
// alone. Its cwd probes each had a 5 s step limit, so a probe that was only slow on a loaded machine failed it. Here the
// first probe is made slower than that limit on purpose: a preload (NODE_OPTIONS reaches the probe's Node, as the
// environment does) holds the first `node -p` back 6 s, standing in for the load. The test must still pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
// NODE_TEST_CONTEXT would make the inner runner report to this one instead of printing its results.
const outsideRunner = () =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));

test('package-browser-root passes when a probe is slower than any step limit would allow', { timeout: 180_000 }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'browser-root-slow-')),
    slow = join(folder, 'slow-probe.mjs'),
    once = join(folder, 'held-back');
  try {
    writeFileSync(
      slow,
      `import { existsSync, writeFileSync } from 'node:fs';
if (process.execArgv.includes('-p') && !existsSync(${JSON.stringify(once)})) {
  writeFileSync(${JSON.stringify(once)}, String(process.pid));
  const end = Date.now() + 6000; while (Date.now() < end);
}`,
    );
    const run = spawnSync(process.execPath, ['--test', 'tests/package-browser-root.test.js'], {
      cwd: root,
      encoding: 'utf8',
      // A hang bound only: the run takes about 7 s, 6 of them the held-back probe.
      timeout: 170_000,
      env: { ...outsideRunner(), NODE_OPTIONS: `--import=${pathToFileURL(slow).href}` },
    });
    assert.equal(run.status, 0, `${run.error ?? ''}\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /\bpass 1\b/);
    assert.match(run.stdout, /\bfail 0\b/);
    assert.ok(existsSync(once), 'a probe was held back');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
