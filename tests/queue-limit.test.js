// Never more than 6 in the queue: the git hook, the count and the refusal, on a real temporary repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setupMergeDrivers } from '../scripts/setup-merge-drivers.mjs';
import { MAX_QUEUE, queueNames, queueStatus, refusal } from '../scripts/queue-limit.mjs';

const SCRIPT = resolve('scripts/queue-limit.mjs');

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'margo-queue-')),
    run = (...args) =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
        cwd: dir,
        encoding: 'utf8',
      });
  assert.equal(run('init', '-q', '-b', 'main').status, 0);
  assert.equal(run('commit', '-q', '--allow-empty', '-m', 'one').status, 0);
  return { dir, run, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the hook lets 6 branches exist and refuses a seventh, however it is created, with the rule in the message', () => {
  const { dir, run, done } = repo();
  try {
    setupMergeDrivers(dir);
    for (let i = 1; i <= MAX_QUEUE; i++) assert.equal(run('branch', `b${i}`).status, 0, `branch b${i}`);
    for (const args of [
      ['branch', 'seven'],
      ['checkout', '-q', '-b', 'seven'],
      ['worktree', 'add', '-q', '-b', 'seven', join(dir, 'wt')],
      ['update-ref', 'refs/heads/seven', 'HEAD'],
    ]) {
      const out = run(...args);
      assert.notEqual(out.status, 0, args.join(' '));
      assert.match(out.stderr, /NEVER MORE THAN 6 IN THE QUEUE/);
    }
    assert.equal(run('show-ref', '--verify', '--quiet', 'refs/heads/seven').status, 1);
  } finally {
    done();
  }
});

test('at the limit the hook passes work on main, updates, detached checkouts and deletes; a delete frees a place', () => {
  const { dir, run, done } = repo();
  try {
    setupMergeDrivers(dir);
    for (let i = 1; i <= MAX_QUEUE; i++) assert.equal(run('branch', `b${i}`).status, 0);
    assert.equal(run('commit', '-q', '--allow-empty', '-m', 'two').status, 0, 'a commit on main');
    assert.equal(run('branch', '-f', 'b1', 'main').status, 0, 'an update');
    assert.equal(run('checkout', '-q', '--detach', 'main').status, 0, 'a detached checkout');
    assert.equal(run('update-ref', 'refs/remotes/origin/x', 'HEAD').status, 0, 'a remote ref');
    assert.equal(run('branch', '-D', 'b2').status, 0, 'a delete');
    assert.equal(run('branch', 'seven').status, 0, 'the freed place');
  } finally {
    done();
  }
});

test('installing the hook twice leaves one working copy with LF line ends', () => {
  const { dir, run, done } = repo();
  try {
    setupMergeDrivers(dir);
    setupMergeDrivers(dir);
    const hook = run('rev-parse', '--git-path', 'hooks/reference-transaction').stdout.trim(),
      body = readFileSync(join(dir, hook), 'utf8');
    assert.match(body, /NEVER MORE THAN 6/);
    assert.ok(!body.includes('\r'));
  } finally {
    done();
  }
});

test('queueNames counts branches and READY files once each, never main', () => {
  const { dir, run, done } = repo();
  try {
    run('branch', 'one');
    mkdirSync(join(dir, 'private', 'queue'), { recursive: true });
    writeFileSync(join(dir, 'private', 'queue', 'one.ready'), 'READY abc\n');
    writeFileSync(join(dir, 'private', 'queue', 'two.ready'), 'READY abc\n');
    assert.deepEqual(queueNames(dir), ['one', 'two']);
    assert.equal(queueStatus(queueNames(dir)), 'queue: 2 of 6 unlanded');
  } finally {
    done();
  }
});

test('the script refuses with exit 2 and the banner at 6, and passes under it', () => {
  const { dir, run, done } = repo();
  try {
    for (let i = 1; i < MAX_QUEUE; i++) run('branch', `b${i}`);
    const under = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
    assert.equal(under.status, 0);
    assert.match(under.stdout, /queue: 5 of 6/);
    run('branch', 'b6');
    const at = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
    assert.equal(at.status, 2);
    assert.match(at.stderr, /NEVER MORE THAN 6 IN THE QUEUE: 6 unlanded/);
    assert.match(at.stderr, /b1, b2, b3, b4, b5, b6/);
    assert.match(queueStatus(queueNames(dir)), /NEVER MORE THAN 6/);
  } finally {
    done();
  }
});

test('Claude Code runs the refusal before every edit, shell command, helper and session', () => {
  const settings = JSON.parse(readFileSync('.claude/settings.json', 'utf8')),
    entry = settings.hooks.PreToolUse.find((e) => e.matcher.split('|').includes('Agent')),
    tools = entry.matcher.split('|');
  for (const tool of ['mcp__ccd_session__start_session', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell'])
    assert.ok(tools.includes(tool), tool);
  assert.match(entry.hooks[0].command, /scripts\/queue-limit\.mjs" --hook/);
});

const FILE = 'C:/Development/Projects/margoengine/packages/sky/a.ts';
const six = ['a', 'b', 'c', 'd', 'e', 'f'];

test('with 6 waiting nothing gets built: edits, commits and helpers are refused in any checkout', () => {
  const full = { ready: six, names: six };
  for (const call of [
    { tool_name: 'Edit', tool_input: { file_path: FILE } },
    { tool_name: 'Write', tool_input: { file_path: 'C:\\Development\\Projects\\margoengine-wt-x\\scripts\\a.mjs' } },
    { tool_name: 'Write', tool_input: { file_path: 'C:/Development/Projects/margoengine/private/queue/g.ready' } },
    { tool_name: 'NotebookEdit', tool_input: { notebook_path: FILE } },
    { tool_name: 'Bash', tool_input: { command: 'cd x; git add -A && git -c user.name=t commit -m one' } },
    { tool_name: 'PowerShell', tool_input: { command: 'git commit -m one' } },
    { tool_name: 'Agent', tool_input: {} },
    { tool_name: 'mcp__ccd_session__start_session', tool_input: {} },
  ])
    assert.match(refusal(call, full) ?? '', /NEVER MORE THAN 6/, JSON.stringify(call));
});

test('with 6 waiting landing, reading, notes and stop orders still run; under 6 builders finish', () => {
  const full = { ready: six, names: six };
  for (const call of [
    { tool_name: 'Bash', tool_input: { command: 'git push origin HEAD:main' } },
    { tool_name: 'Bash', tool_input: { command: 'node scripts/integrate.mjs' } },
    { tool_name: 'Read', tool_input: { file_path: FILE } },
    { tool_name: 'Write', tool_input: { file_path: 'C:/Development/Projects/margoengine/private/control.json' } },
    { tool_name: 'Write', tool_input: { file_path: 'C:/Development/Projects/margoengine/private/handoffs/a.md' } },
    {
      tool_name: 'Write',
      tool_input: { file_path: 'C:/Users/x/.claude/projects/C--Projects-margoengine/memory/a.md' },
    },
  ])
    assert.equal(refusal(call, full), null, JSON.stringify(call));
  const building = { ready: ['a'], names: six };
  assert.equal(refusal({ tool_name: 'Edit', tool_input: { file_path: FILE } }, building), null);
  assert.equal(refusal({ tool_name: 'Bash', tool_input: { command: 'git commit -m one' } }, building), null);
  assert.match(refusal({ tool_name: 'Agent' }, building) ?? '', /NEVER MORE THAN 6/);
});

test('--hook reads the call from stdin and exits 2 on a refusal', () => {
  const { dir, done } = repo();
  try {
    mkdirSync(join(dir, 'private', 'queue'), { recursive: true });
    for (const name of six) writeFileSync(join(dir, 'private', 'queue', `${name}.ready`), 'READY abc\n');
    const hook = (call) =>
        spawnSync(process.execPath, [SCRIPT, '--hook'], { cwd: dir, encoding: 'utf8', input: JSON.stringify(call) }),
      refused = hook({ tool_name: 'Edit', tool_input: { file_path: FILE } });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /Nothing gets built with 6 waiting/);
    assert.equal(hook({ tool_name: 'Read', tool_input: { file_path: FILE } }).status, 0);
  } finally {
    done();
  }
});
