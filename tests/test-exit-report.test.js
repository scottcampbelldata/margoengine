// A test file whose process is ended from outside is reported with its exit code, signal and elapsed time, not as a
// bare 'test failed' (the flood bounds file, 2026-11-26, KB-TEST-FILEEXIT1).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exitLine, testExitEnv } from '../scripts/support/test-exit-reporter.mjs';

test('a test file killed from outside is reported with its exit code, signal and time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exit-report-')),
    pidFile = join(dir, 'pid');
  try {
    writeFileSync(
      join(dir, 'victim.test.js'),
      `import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
test('waits', () => { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); return new Promise(() => setInterval(() => {}, 1000)); });
`,
    );
    const runner = spawn(process.execPath, ['--test', 'victim.test.js'], {
      cwd: dir,
      env: { ...testExitEnv(), NODE_TEST_CONTEXT: undefined },
    });
    let out = '';
    runner.stdout.on('data', (d) => (out += d));
    runner.stderr.on('data', (d) => (out += d));
    const closed = new Promise((done) => runner.once('close', done));
    const deadline = Date.now() + 30_000;
    // fixed-wait: the poll interval of a loop that checks for the pid file, bound 30 s
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(pidFile), 'the test file started');
    process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
    await closed;
    assert.match(out, /test file ended without a result: .*victim\.test\.js, exit code \S+, signal \S+, after \d+ ms/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing subtest is not reported as a file that ended', () => {
  const data = {
    nesting: 0,
    file: 'a.test.js',
    details: {
      duration_ms: 5,
      error: { code: 'ERR_TEST_FAILURE', cause: 'x' },
    },
  };
  assert.equal(exitLine(data), '');
  data.details.error.cause = 'test failed';
  assert.match(exitLine(data), /a\.test\.js, exit code none, signal none, after 5 ms/);
});
