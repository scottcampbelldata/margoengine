// A hung unit test must be named. One verify run sat in the unit test step until its outer limit with no name, because
// the step prints only when it ends and `--test-timeout` cannot reach a blocked process.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { HangWatch, SILENCE_SECONDS } from '../scripts/support/test-watch.mjs';
import { PARALLEL, TEST_TIMEOUT_MS } from '../scripts/verify.mjs';

const file = resolve('a.test.js'),
  event = (type, name) => ({ type, data: { name, file } }),
  watch = (limit = 10) => {
    const hangs = new HangWatch(limit);
    hangs.see(event('test:dequeue', 'a.test.js'), 0);
    return hangs;
  };

test('a long file of short tests is never called hung', () => {
  const hangs = watch();
  for (let second = 1; second < 100; second++) {
    hangs.see(event('test:dequeue', `test ${second}`), second * 1000);
    hangs.see(event('test:complete', `test ${second}`), second * 1000 + 500);
    assert.deepEqual(hangs.hung(second * 1000 + 600), []);
  }
});

test('a silent file names the running test, with its parents', () => {
  const hangs = watch();
  hangs.see(event('test:dequeue', 'outer'), 1000);
  hangs.see(event('test:dequeue', 'inner'), 2000);
  assert.deepEqual(hangs.hung(11000), []);
  assert.deepEqual(hangs.hung(13000), ['HUNG TEST: a.test.js in test "outer > inner": no event for 11 s']);
});

test('a test that blocks its process before its start gets out is named from the queue', () => {
  const hangs = watch();
  hangs.see(event('test:enqueue', 'first'), 0);
  hangs.see(event('test:enqueue', 'second'), 0);
  hangs.see(event('test:dequeue', 'first'), 1);
  hangs.see(event('test:complete', 'first'), 2);
  assert.match(hangs.hung(20000)[0], /in or before test "second"/);
});

test('a process alive after its last test, and one that never reached a test, each say so', () => {
  const done = watch();
  done.see(event('test:dequeue', 'only'), 1);
  done.see(event('test:complete', 'only'), 2);
  assert.match(done.hung(20000)[0], /after its last test "only"/);
  assert.match(watch().hung(20000)[0], /with no test reported yet/);
});

test('a finished file is forgotten', () => {
  const hangs = watch();
  hangs.see(event('test:complete', 'a.test.js'), 5);
  assert.deepEqual(hangs.hung(100000), []);
});

test('a real hang is named and ends the run, children included', () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-test-watch-')),
    // Without this the inner runner takes itself for a test process of this one and runs nothing.
    env = { ...process.env, MARGO_TEST_SILENCE_SECONDS: '2', NODE_TEST_CONTEXT: undefined };
  try {
    writeFileSync(
      join(dir, 'blocked.test.js'),
      "import test from 'node:test';\ntest('fine', () => {});\ntest('spins for ever', () => { for (;;); });\n",
    );
    writeFileSync(
      join(dir, 'open.test.js'),
      "import test from 'node:test';\ntest('leaves a timer', () => { setInterval(() => {}, 1000); });\n",
    );
    // The shape of the voxel-net hang (af185850f): a failed hook skips the one that closes the server.
    writeFileSync(
      join(dir, 'hook.test.js'),
      "import { createServer } from 'node:net';\nimport test from 'node:test';\n" +
        "test('holds a server', (t) => {\n  const server = createServer().listen(0);\n" +
        "  t.after(() => { throw new Error('ENOTEMPTY'); });\n  t.after(() => server.close());\n});\n",
    );
    for (const [name, expected] of [
      ['blocked.test.js', /HUNG TEST: blocked\.test\.js with no test reported yet/],
      ['open.test.js', /HUNG TEST: open\.test\.js after its last test "leaves a timer"/],
      ['hook.test.js', /HUNG TEST: hook\.test\.js after its last test "holds a server"/],
    ]) {
      const reporter = new URL('../scripts/support/test-watch.mjs', import.meta.url).href,
        { status, stderr, error } = spawnSync(
          process.execPath,
          ['--test', `--test-reporter=${reporter}`, '--test-reporter-destination=stderr', name],
          { cwd: dir, encoding: 'utf8', timeout: 60000, env },
        );
      assert.equal(error, undefined, `${name} ended by itself, long before the spawn limit`);
      assert.notEqual(status, 0, 'a hung run fails');
      assert.match(stderr, expected);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The run once ended before its killer did, and the killer's working folder was the run's: rmSync failed with EPERM, about
// 1 run in 200 under load. The line below is printed only after every child is confirmed gone, so its absence is the bug.
test('a hung run ends last: its children and grandchildren are gone when it reports its end', () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-test-watch-')),
    env = { ...process.env, MARGO_TEST_SILENCE_SECONDS: '2', NODE_TEST_CONTEXT: undefined },
    alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
  try {
    writeFileSync(
      join(dir, 'tree.test.js'),
      "import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nimport test from 'node:test';\n" +
        "test('holds a child', () => {\n" +
        "  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\n" +
        "  writeFileSync('pids.json', JSON.stringify([process.pid, child.pid]));\n  for (;;);\n});\n",
    );
    const reporter = new URL('../scripts/support/test-watch.mjs', import.meta.url).href,
      { status, stderr, error } = spawnSync(
        process.execPath,
        ['--test', `--test-reporter=${reporter}`, '--test-reporter-destination=stderr', 'tree.test.js'],
        { cwd: dir, encoding: 'utf8', timeout: 60000, env },
      ),
      pids = JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8'));
    assert.equal(error, undefined);
    assert.notEqual(status, 0, 'a hung run fails');
    assert.deepEqual(pids.filter(alive), [], 'nothing the run started outlives it');
    // The test process and the one it started, on every system: the line is printed only once both are confirmed gone.
    const ended = /HUNG RUN ENDED: (\d+) child processes stopped and gone/.exec(stderr);
    assert.ok(ended && Number(ended[1]) >= 2, stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the unit test step of verify carries both limits, and the test limit fires first', () => {
  const step = PARALLEL.flat().find((command) => command.includes(' --test '));
  assert.ok(step.includes(`--test-timeout=${TEST_TIMEOUT_MS}`));
  assert.ok(step.includes('--test-reporter=./scripts/support/test-watch.mjs'));
  assert.ok(step.includes('--test-reporter=spec'), 'the normal report stays');
  assert.ok(SILENCE_SECONDS * 1000 > TEST_TIMEOUT_MS, 'a settled-never test gets its own error, with its stack');
});
