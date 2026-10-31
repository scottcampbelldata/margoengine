// The nightly full check had no overall deadline and no alert: a hung step blocked the GPU lock and the machine until
// someone noticed (playbook part A). runNightly now kills the running step's whole process tree at the deadline,
// exits non-zero, and records the result in last-status.json, the dated log and ALERT.txt. A fake step that starts a
// grandchild and sleeps proves the tree dies; a tiny deadline keeps it to seconds.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deadlineMs, lastLines, publishStatus, runNightly } from '../scripts/nightly-full.mjs';

const env = { ...process.env, MARGO_NIGHTLY_NO_ALERT: '1' };
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const node = (source) => [process.execPath, ['-e', source]];
// A step that starts a grandchild (writing its pid to `pidFile`) and then sleeps for a minute.
const hang = (pidFile) =>
  node(
    `const {spawn}=require('node:child_process');` +
      `const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});` +
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setTimeout(()=>{},60000);`,
  );
const tmp = () => mkdtempSync(join(tmpdir(), 'nightly-deadline-'));

test('the deadline kills the whole process tree, exits non-zero and names the step that hung', async () => {
  const dir = tmp(),
    pidFile = join(dir, 'grandchild.pid');
  try {
    const code = await runNightly({
      steps: [
        { label: 'quick step', command: node('process.exit(0)') },
        { label: 'hanging step', command: hang(pidFile) },
        {
          label: 'never runs',
          command: node(`require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'ran'))},'1')`),
        },
      ],
      dir,
      env,
      deadline: 2500,
      quiet: true,
    });
    assert.equal(code, 124);
    const status = JSON.parse(readFileSync(join(dir, 'last-status.json'), 'utf8'));
    assert.equal(status.result, 'timeout');
    assert.equal(status.step, 'hanging step');
    assert.equal(status.exitCode, 124);
    assert.equal(existsSync(join(dir, 'ran')), false, 'steps after the timeout do not run');
    assert.match(readFileSync(join(dir, 'ALERT.txt'), 'utf8'), /nightly RESULT TIMEOUT at step "hanging step"/);
    const log = readdirSync(dir).find((name) => name.endsWith('.log'));
    assert.match(readFileSync(join(dir, log), 'utf8'), /TIMED OUT[\s\S]*nightly RESULT TIMEOUT at step "hanging step"/);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    for (const end = Date.now() + 30_000; alive(grandchild); await sleep(10))
      assert.ok(Date.now() < end, 'the grandchild process was killed with the tree');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing step gives a fail status and its exit code; a pass clears the alert', async () => {
  const dir = tmp();
  try {
    const code = await runNightly({
      steps: [{ label: 'broken', command: node('process.exit(3)') }],
      dir,
      env,
      quiet: true,
    });
    assert.equal(code, 3);
    const status = JSON.parse(readFileSync(join(dir, 'last-status.json'), 'utf8'));
    assert.deepEqual([status.result, status.step], ['fail', 'broken']);
    assert.ok(existsSync(join(dir, 'ALERT.txt')));
    assert.equal(await runNightly({ steps: [{ label: 'fine', command: node('0') }], dir, env, quiet: true }), 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'last-status.json'), 'utf8')).result, 'pass');
    assert.equal(existsSync(join(dir, 'ALERT.txt')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the deadline defaults to 4 hours and MARGO_NIGHTLY_DEADLINE_MIN overrides it', () => {
  assert.equal(deadlineMs({}), 4 * 60 * 60_000);
  assert.equal(deadlineMs({ MARGO_NIGHTLY_DEADLINE_MIN: '30' }), 30 * 60_000);
  assert.equal(deadlineMs({ MARGO_NIGHTLY_DEADLINE_MIN: 'nope' }), 4 * 60 * 60_000);
});

test('a one-string step runs through the shell (the light GPU checks are npm chains), and its exit code counts', async () => {
  const dir = tmp();
  try {
    assert.equal(await runNightly({ steps: [{ label: 'chain', command: ['exit 0'] }], dir, env, quiet: true }), 0);
    assert.equal(await runNightly({ steps: [{ label: 'chain', command: ['exit 3'] }], dir, env, quiet: true }), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nightly-status skips with one line when no status repository is configured', () => {
  for (const unset of [{}, { MARGO_STATUS_REPO: 'x' }, { MARGO_STATUS_DIR: 'y' }]) {
    const { result, line } = publishStatus({ dir: 'nowhere', profile: 'laptop', env: unset });
    assert.equal(result, 'skipped');
    assert.match(line, /^nightly-status: skipped, MARGO_STATUS_REPO and MARGO_STATUS_DIR/);
  }
});

test('nightly-status copies last-status.json and the last 40 log lines into the status repository and pushes', () => {
  const work = tmp(),
    git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Nightly',
    GIT_AUTHOR_EMAIL: 'nightly@example.invalid',
    GIT_COMMITTER_NAME: 'Nightly',
    GIT_COMMITTER_EMAIL: 'nightly@example.invalid',
  };
  try {
    const bare = join(work, 'status.git'),
      dir = join(work, 'nightly'),
      log = join(work, 'run.log');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    execFileSync('git', ['init', '-q', join(work, 'seed')]);
    writeFileSync(join(work, 'seed', 'README.txt'), 'status\n');
    git(join(work, 'seed'), 'add', '.');
    git(join(work, 'seed'), 'commit', '-q', '-m', 'start');
    git(join(work, 'seed'), 'push', '-q', bare, 'HEAD:refs/heads/main');
    git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    writeFileSync(log, Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'));
    execFileSync('git', ['init', '-q', dir]);
    const status = { result: 'fail', step: 'pinned proofs', finished: '2026-10-30T10:00:00Z', log };
    writeFileSync(join(dir, 'last-status.json'), JSON.stringify(status));
    const statusEnv = { ...gitEnv, MARGO_STATUS_REPO: bare, MARGO_STATUS_DIR: join(work, 'clone') };
    const first = publishStatus({ dir, profile: 'laptop', env: statusEnv });
    assert.equal(first.result, 'published', first.line);
    // A fresh clone of the status repository holds what was published.
    git(work, 'clone', '-q', bare, 'check');
    assert.deepEqual(JSON.parse(readFileSync(join(work, 'check', 'laptop', 'last-status.json'), 'utf8')), status);
    const lines = readFileSync(join(work, 'check', 'laptop', 'last-log.txt'), 'utf8')
      .trim()
      .split(/\r?\n/);
    assert.equal(lines.length, 40);
    assert.deepEqual([lines[0], lines.at(-1)], ['line 11', 'line 50']);
    assert.match(git(join(work, 'check'), 'log', '-1', '--format=%s'), /^nightly laptop: fail at pinned proofs/);
    // Again with nothing new: the clone is pulled, nothing is committed, and it still reports published.
    assert.equal(publishStatus({ dir, profile: 'laptop', env: statusEnv }).result, 'published');
    assert.equal(git(bare, 'rev-list', '--count', 'main').trim(), '2');
    // A repository that cannot be reached fails with the reason, never silently.
    const broken = publishStatus({
      dir,
      profile: 'laptop',
      env: { ...gitEnv, MARGO_STATUS_REPO: join(work, 'missing.git'), MARGO_STATUS_DIR: join(work, 'clone2') },
    });
    assert.equal(broken.result, 'failed');
    assert.match(broken.line, /^nightly-status: FAILED to publish \(git clone failed/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('lastLines keeps the last lines of a log and gives nothing for a missing file', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'a.log'), 'a\r\nb\r\nc\r\n');
    assert.equal(lastLines(join(dir, 'a.log'), 2), 'b\nc\n');
    assert.equal(lastLines(join(dir, 'missing.log')), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
