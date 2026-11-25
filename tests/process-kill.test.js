// KB-TEST-FILEEXIT1: a `node --test` file of a long package run ended after 122 s and 257 s as 'test failed', with no
// failing subtest and nothing on stderr. That is what its runner reports for a file process ended from outside: a
// `taskkill /F` on its pid gives exactly that report. Windows hands a freed pid to a new process about a minute later on
// the workstation, and test files are the processes the lanes start most often, so a tree kill sent by pid after its
// target had exited (a timer that fired after the exit, a cleanup that killed a pid it had kept, a second kill of a
// tree already ended) or a tree walked through a reused ParentProcessId could end another run's test file.
// Every tree kill now goes through scripts/support/shutdown.mjs: a child only before its exit is seen, while Node holds
// its handle (killChildTreeSync), and a bare pid only while it is this process or below it, checked by creation time
// (killOwnTree), so a pid that has become another process's is left alone.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import test from 'node:test';
import { killTree } from '../scripts/run-with-timeout.mjs';
import { endTree, killChildTreeSync, killOwnTreeSync } from '../scripts/support/shutdown.mjs';

const root = new URL('..', import.meta.url);
const windows = process.platform === 'win32';
const LIMIT = { timeout: 120_000 };
const keep = 'setInterval(() => {}, 1000)';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

const named = (ended, ...pids) =>
  assert.deepEqual(
    pids.filter((pid) => !ended.includes(pid)),
    [],
    `the kill named ${ended.join(', ')}`,
  );

/** A process that is not below this one: started by a launcher that has since exited, as another run's process is. */
async function foreignProcess() {
  const launcher = spawn(
    process.execPath,
    [
      '-e',
      `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(keep)}], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid);`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
  );
  let out = '';
  launcher.stdout.on('data', (chunk) => (out += chunk));
  await new Promise((resolve) => launcher.once('close', resolve));
  const pid = Number(out.trim());
  assert.ok(alive(pid), 'the foreign process runs');
  return pid;
}

test(
  'a pid that is not this process or below it is never ended, however it is named (KB-TEST-FILEEXIT1)',
  LIMIT,
  async (t) => {
    if (!windows) return t.skip('Windows only: elsewhere the kills go by process group and handle');
    const pid = await foreignProcess();
    try {
      // Each is how a kill by a pid kept past its process's exit reached another run's test file before the fix.
      killTree(pid);
      assert.equal(alive(pid), true, 'run-with-timeout killTree ended a process that is not ours');
      assert.deepEqual(killOwnTreeSync(pid), []);
      assert.deepEqual(await endTree(pid, { waitMs: 5000 }), []);
      assert.equal(alive(pid), true, 'endTree ended a process that is not ours');
    } finally {
      process.kill(pid, 'SIGKILL');
    }
  },
);

test('a child of this process is ended with everything it started, by handle or by pid', {
  timeout: 400_000,
}, async (t) => {
  if (!windows) return t.skip('Windows only');
  const failures = [];
  const report = (line) => failures.push(line);
  for (const [how, end] of [
    ['killTree(child)', (child) => killTree(child)],
    ['killTree(pid)', (child) => killTree(child.pid)],
    ['endTree(child)', async (child) => assert.deepEqual(await endTree(child, { waitMs: 20_000 }), [])],
    ['endTree(pid)', async (child) => assert.deepEqual(await endTree(child.pid, { waitMs: 20_000 }), [])],
    // The lists name the child and its grandchild, and may name more (a console host Windows starts for the child).
    ['killChildTreeSync', (child, grandchild) => named(killChildTreeSync(child), child.pid, grandchild)],
    [
      'killOwnTreeSync',
      (child, grandchild) => {
        const ended = killOwnTreeSync(child.pid, undefined, report);
        assert.equal(ended[0], child.pid, 'parents first');
        named(ended, child.pid, grandchild);
      },
    ],
  ]) {
    // The grandchild is detached, so only the tree kill ends it (a node child's attached children end with it).
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(keep)}], { stdio: 'ignore', detached: true }); console.log(c.pid); ${keep}`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    const exited = new Promise((resolve) => parent.once('exit', resolve));
    const grandchild = await new Promise((resolve) => parent.stdout.once('data', (d) => resolve(Number(String(d)))));
    await end(parent, grandchild);
    await exited;
    assert.deepEqual(failures, [], `${how}: the kill ran`);
    for (const stop = Date.now() + 20_000; alive(grandchild) && Date.now() < stop; )
      await new Promise((resolve) => setTimeout(resolve, 20)); // fixed-wait: polling the process table
    if (alive(grandchild)) process.kill(grandchild, 'SIGKILL');
    else continue;
    assert.fail(`${how}: the grandchild outlived the tree kill`);
  }
});

test('a child whose exit has been seen is not ended by its pid, which may be another process by then', async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve) => child.once('exit', resolve));
  assert.deepEqual(killChildTreeSync(child), [], 'no taskkill runs for it');
  assert.deepEqual(await endTree(child, { settle: null, waitMs: 10 }), []);
});

// The class, caught in check:merge: a new raw taskkill, or a ParentProcessId walk outside the shared helper, fails here.
const ALLOWED = new Map([
  ['scripts/support/result-cache.mjs', 'names taskkill in its table of commands that read nothing; runs none'],
  [
    'packages/exporters/scripts/test-unity.mjs',
    'lists the orphans of an exited Editor by ParentProcessId and creation time',
  ],
  ['tests/process-kill.test.js', 'this check'],
  ['scripts/support/shutdown.mjs', 'the helper'],
]);

const SOURCES = ['scripts', 'tests', 'packages', 'examples', 'tools', 'python'];

/** Tracked JavaScript and TypeScript lines matching `args`, as `file:line:text` (git grep exits 1 on no match). */
function grep(args) {
  try {
    return execFileSync('git', ['grep', '-n', '-I', ...args, '--', ...SOURCES], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .filter((line) => /^[^:]+\.(c|m)?[jt]sx?:/.test(line));
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

test('the scan reads the tracked sources (a scan that read nothing would pass)', () => {
  assert.ok(grep(['-e', 'killOwnTreeSync']).some((line) => line.startsWith('scripts/run-with-timeout.mjs:')));
});

test('no script, test or tool ends a process tree by raw taskkill or walks ParentProcessId outside the helper', () => {
  const found = grep(['-i', '-E', '[\'"`]taskkill(\\.exe)?[\'"`]|\\bParentProcessId\\b']).filter(
    (line) => !ALLOWED.has(line.slice(0, line.indexOf(':'))),
  );
  assert.deepEqual(
    found,
    [],
    'end a tree by pid with killOwnTree or killOwnTreeSync (scripts/support/shutdown.mjs), or killTree/endTree, which use it',
  );
});
