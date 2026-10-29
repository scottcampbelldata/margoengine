// The nightly full check had no overall deadline and no alert: a hung step blocked the GPU lock and the machine until
// someone noticed (playbook part A). runNightly now kills the running step's whole process tree at the deadline,
// exits non-zero, and records the result in last-status.json, the dated log and ALERT.txt. A fake step that starts a
// grandchild and sleeps proves the tree dies; a tiny deadline keeps it to seconds.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deadlineMs, runNightly } from '../scripts/nightly-full.mjs';

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
    await sleep(500);
    assert.equal(alive(grandchild), false, 'the grandchild process was killed with the tree');
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
