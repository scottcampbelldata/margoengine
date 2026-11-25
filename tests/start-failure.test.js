// KB-FILM-HEADLESS1: `npm test --workspace=packages/headless` once stopped with only "npm error code 3221225794": the
// cmd.exe or node process for `build-optional.js headless` could not start (0xC0000142, STATUS_DLL_INIT_FAILED) and
// printed nothing, so the gate's log gave no cause and no machine state. The runners that see the code now name it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { failedStep } from '../scripts/test-changed.mjs';
import { runWithTimeout } from '../scripts/run-with-timeout.mjs';
import { STATUS_DLL_INIT_FAILED, startFailureNote, startFailureState } from '../scripts/support/start-failure.mjs';

const root = resolve(import.meta.dirname, '..');

test('0xC0000142 is named with the machine state; other codes are not', () => {
  assert.equal(STATUS_DLL_INIT_FAILED, 3221225794);
  const note = startFailureNote(
    3221225794,
    () => 'running processes: 412; desktop heap SharedSection=1024,20480,768 KB',
  );
  assert.match(note, /0xC0000142, STATUS_DLL_INIT_FAILED/);
  assert.match(note, /desktop heap ran out/);
  assert.match(note, /running processes: 412; desktop heap SharedSection=1024,20480,768 KB/);
  assert.match(note, /KB-FILM-HEADLESS1/);
  for (const code of [0, 1, 124, 3221225477])
    assert.equal(
      startFailureNote(code, () => assert.fail('no probe')),
      '',
    );
});

test('test:changed lists a step that could not start with its cause', () => {
  const note = (code) => (code === STATUS_DLL_INIT_FAILED ? 'exit 0xC0000142' : '');
  assert.equal(failedStep('packages/headless', 3221225794, false, note), 'packages/headless (exit 0xC0000142)');
  assert.equal(failedStep('packages/headless', 1, false, note), 'packages/headless');
  assert.equal(failedStep('packages/headless', 124, true, note), 'packages/headless (timed out)');
});

test('the machine state reads the process count and SharedSection, and says when a probe could not start', () => {
  const run = (file) => {
    if (file === 'tasklist') return '"a.exe","1"\r\n"b.exe","2"\r\n"c.exe","3"\r\n';
    return '\r\nHKEY_LOCAL_MACHINE\\...\\SubSystems\r\n    Windows    REG_EXPAND_SZ    %SystemRoot%\\system32\\csrss.exe ObjectDirectory=\\Windows SharedSection=1024,20480,768 Windows=On\r\n';
  };
  assert.equal(startFailureState(run), 'running processes: 3; desktop heap SharedSection=1024,20480,768 KB');
  const failing = () => {
    throw Object.assign(new Error('spawnSync tasklist'), { status: 3221225794 });
  };
  assert.match(startFailureState(failing), /running processes: could not be read \(tasklist could not start either\)/);
});

test('an npm script whose child exits 0xC0000142 reaches the runner with that code', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'start-failure-'));
  try {
    writeFileSync(
      join(folder, 'package.json'),
      JSON.stringify({
        name: 'start-failure-probe',
        version: '1.0.0',
        scripts: { build: 'node -e "process.exitCode=3221225794"', test: 'npm run build' },
      }),
    );
    const { code } = await runWithTimeout('npm run test', { cwd: folder, timeoutMs: 120_000 });
    if (process.platform === 'win32') assert.equal(code, STATUS_DLL_INIT_FAILED);
    else assert.notEqual(code, 0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// Exit codes above 255 exist only on Windows; elsewhere the code wraps and nothing is named.
test('run-with-timeout prints the cause when its command exits 0xC0000142', () => {
  const run = spawnSync(
    process.execPath,
    ['scripts/run-with-timeout.mjs', '--max=1', '--', process.execPath, '-e', 'process.exitCode=3221225794'],
    { cwd: root, encoding: 'utf8', timeout: 90_000 },
  );
  if (process.platform !== 'win32') return assert.doesNotMatch(run.stderr, /0xC0000142/);
  assert.equal(run.status, STATUS_DLL_INIT_FAILED);
  assert.match(run.stderr, /0xC0000142, STATUS_DLL_INIT_FAILED/);
  assert.match(run.stderr, /running processes: \d+; desktop heap SharedSection=[\d,]+ KB/);
});
