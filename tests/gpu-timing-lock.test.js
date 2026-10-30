// Timing tests in shared GPU slots (2026-10-30): the biomes flythrough (streaming may add at most 0.3 ms to the p99
// frame and 1 ms to the worst one) ran in check:gpu-packages's shared slot beside other agents' GPU suites, and its
// worst frame grew by 2.6 ms; alone it adds 0.1 to 0.3 ms. A timing test now asks scripts/gpu-lock.mjs for the GPU
// exclusively; the runner gives it a step of its own after the shared ones, under an exclusive hold taken just before
// it and released after, and a timing test that would share a step with other checks fails the plan. And a failed
// biomes check on the Intel laptop sat until the runner killed it at 600 s: a failed check now exits at once with its
// own error, its teardown bounded and reported beside it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lockMode, lockOrder, plan, runPlan, TIMING_TEST } from '../scripts/gpu-package-tests.mjs';
import { runLimited } from '../scripts/support/run-limited.mjs';
import { runSuite } from '../scripts/support/shutdown.mjs';

const root = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(root, file), 'utf8');

test('a timing test runs as its own step under the exclusive GPU lock; every other test stays shared', () => {
  const tests = plan(),
    fly = tests.find((t) => t.label === 'biomes test:gpu:flythrough');
  assert.ok(fly, 'the biomes flythrough has a script of its own');
  assert.equal(fly.exclusive, true);
  assert.equal(fly.command, 'cd ../.. && node packages/biomes/tests/flythrough-check.mjs');
  for (const label of ['biomes test:gpu', 'biomes test:gpu:objects'])
    assert.equal(tests.find((t) => t.label === label)?.exclusive, undefined, `${label} runs in a shared slot`);
  assert.match(read('packages/biomes/tests/flythrough-check.mjs'), TIMING_TEST);
  const ordered = lockOrder(tests);
  assert.deepEqual(
    ordered.slice(-tests.filter((t) => t.exclusive).length).map((t) => t.label),
    tests.filter((t) => t.exclusive).map((t) => t.label),
    'the timing steps run last',
  );
});

test('a timing test in one step with other checks fails the plan, naming both', () => {
  const files = {
    'a/view.mjs': 'await page.evaluate(() => 1);',
    'a/fly.mjs': "await acquire({ owner: 'f', mode: 'exclusive' });",
  };
  assert.throws(
    () => lockMode('a test:gpu', ['a/view.mjs', 'a/fly.mjs'], (f) => files[f]),
    (error) => {
      assert.equal(error.code, 'GPU_TIMING_TEST_SHARED');
      assert.match(error.message, /a test:gpu runs the timing test a\/fly\.mjs in one step with a\/view\.mjs/);
      return true;
    },
  );
  assert.equal(
    lockMode('a x', ['a/fly.mjs'], (f) => files[f]),
    'exclusive',
  );
  assert.equal(
    lockMode('a y', ['a/view.mjs'], (f) => files[f]),
    'shared',
  );
  assert.equal(
    lockMode('a z', ['a/s.mjs'], () => "await acquire({ owner: 's' });"),
    'shared',
  );
});

test('the run holds the GPU exclusively only around a timing step and shared around every other', async () => {
  const events = [];
  let open = 0;
  const steps = lockOrder([
    { id: 'a', label: 'p a', part: [1, 1] },
    { id: 'fly', label: 'p fly', part: [1, 1], exclusive: true },
    { id: 'b', label: 'p b', part: [1, 1] },
  ]);
  const results = await runPlan(steps, {
    profile: { name: 'test', heat: null },
    take: async (mode, step) => {
      assert.equal(open, 0, 'a hold is taken only after the last one was released');
      open++;
      events.push(`take ${mode} for ${step.id}`);
      return () => (open--, events.push(`release ${mode}`));
    },
    runStep: async (step) => (events.push(`run ${step.id}`), { ok: true, seconds: 0 }),
  });
  assert.deepEqual(events, [
    'take shared for a',
    'run a',
    'run b',
    'release shared',
    'take exclusive for fly',
    'run fly',
    'release exclusive',
  ]);
  assert.equal(open, 0);
  assert.ok(results.every((r) => r.outcome === 'pass'));
});

test('every timing test fails at once when it is run inside a shared GPU slot', () => {
  const lock = mkdtempSync(join(tmpdir(), 'margo-timing-lock-'));
  try {
    for (const timing of plan().filter((t) => t.exclusive)) {
      const begun = Date.now(),
        file = /node (\S+\.m?js)/.exec(timing.command)[1],
        run = spawnSync(process.execPath, [file], {
          cwd: root,
          encoding: 'utf8',
          timeout: 60_000,
          env: {
            ...process.env,
            MARGO_GPU_LOCK: lock,
            MARGO_GPU_LOCK_NESTED: join(lock, 'nested'),
            MARGO_GPU_LOCK_NESTED_MODE: 'shared',
          },
        });
      assert.notEqual(run.status, 0, `${timing.label} ran in a shared slot`);
      assert.match(run.stderr, /needs the GPU exclusively/, timing.label);
      assert.ok(Date.now() - begun < 30_000, `${timing.label} took ${Date.now() - begun} ms to fail`);
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
});

test('runSuite: a failed check stays the error even when the teardown fails too; a clean run returns', async () => {
  const lines = [];
  await assert.rejects(
    runSuite(
      async () => assert.fail('planted'),
      async () => {
        throw new Error('close ran out');
      },
      { report: (line) => lines.push(line) },
    ),
    /planted/,
  );
  assert.match(lines.join('\n'), /teardown failed too: close ran out/);
  let closed = 0;
  assert.equal(
    await runSuite(
      async () => 7,
      async () => closed++,
    ),
    7,
  );
  assert.equal(closed, 1);
  await assert.rejects(
    runSuite(
      async () => 7,
      async () => assert.fail('close'),
    ),
    /close/,
  );
});

// A suite shaped like the biomes checks: a server and a timer left open, a page that never answers its WGSL question,
// and an assertion that fails after the setup. Under the GPU runner's own runLimited it must exit non-zero within the
// bounded teardown with the planted assertion as its error.
test('a planted assertion failure under the GPU runner exits within the bounded teardown, naming the assertion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-planted-')),
    url = (file) => JSON.stringify(new URL(`../scripts/support/${file}`, import.meta.url).href);
  try {
    writeFileSync(
      join(dir, 'suite.mjs'),
      `import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { runSuite, watchExit, closeAll } from ${url('shutdown.mjs')};
import { settleWgslReports } from ${url('wgsl-guard.js')};
const server = createServer().listen(0, '127.0.0.1');
setInterval(() => {}, 1000);
const page = { evaluate: () => new Promise(() => {}) };
await runSuite(async () => {
  console.log('packing: 30 frames copied');
  assert.equal(1, 0, 'planted: 1 frames stopped copying with budget left');
}, async () => {
  try { await settleWgslReports(page, { budgetMs: 500 }); } finally { await closeAll({ servers: [server], budgetMs: 2000 }); }
});
watchExit();
`,
    );
    const out = join(dir, 'out.txt'),
      result = await runLimited(`node suite.mjs > out.txt 2>&1`, { cwd: dir, limitMs: 30_000, label: 'planted' });
    const text = readFileSync(out, 'utf8');
    assert.equal(result.timedOut, false, text);
    assert.equal(result.ok, false, text);
    assert.ok(result.seconds < 10, `took ${result.seconds} s:\n${text}`);
    assert.match(text, /planted: 1 frames stopped copying/);
    assert.match(text, /teardown failed too: the page did not answer within 500 ms/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
