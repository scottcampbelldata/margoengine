// check:merge side by side (list row 55.13): the scheduler, what it reads a suite's shared things from, the plan it runs
// (the serial plan's set, nothing dropped) and the comparison with a serial run. No GPU: tiny fake jobs and processes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  GPU_STEPS,
  PLAIN_STEPS,
  runStepsParallel,
  SCOPED_STEPS,
  stepJobs,
  TIMING_JOB,
} from '../scripts/check-merge.mjs';
import { compareRuns } from '../scripts/compare-check-runs.mjs';
import { holdMinutes, lockOrder, PREPARE, plan, planSteps, suiteJobs, testId } from '../scripts/gpu-package-tests.mjs';
import { longestFirst, parallelMode, runJobs, tailOf } from '../scripts/support/parallel-run.mjs';
import { runLimited } from '../scripts/support/run-limited.mjs';
import { fixedPorts, outputPaths, suiteResources, usesDefaultViteCache } from '../scripts/support/suite-resources.mjs';

const root = join(import.meta.dirname, '..');
const pass = async () => ({ ok: true });
/** A run that records who ran beside whom; each job ends on the next macrotask round. */
function tracer() {
  const open = new Set(),
    pairs = [],
    order = [];
  return {
    pairs,
    order,
    run: async (job) => {
      order.push(job.id);
      for (const other of open) pairs.push([other, job.id].sort().join('+'));
      open.add(job.id);
      await new Promise((done) => setTimeout(done, 5));
      open.delete(job.id);
      return { ok: true };
    },
  };
}

test('two suites on one fixed port never run at once, and others run beside them', async () => {
  const t = tracer();
  await runJobs(
    [
      { id: 'a', label: 'a', resources: ['port:5211'] },
      { id: 'b', label: 'b', resources: ['port:5211'] },
      { id: 'c', label: 'c', resources: ['port:5199'] },
    ],
    { limit: 3, run: t.run },
  );
  assert.ok(!t.pairs.includes('a+b'), t.pairs.join());
  assert.ok(t.pairs.includes('a+c'), 'a free slot is used by a suite with no conflict');
});

test('the longest suite starts first, and a long job with a busy port lets a shorter one past', async () => {
  assert.deepEqual(
    longestFirst([
      { id: 's', estimate: 1 },
      { id: 'x', estimate: 999, exclusive: true },
      { id: 'l', estimate: 400 },
    ]).map((j) => j.id),
    ['l', 's', 'x'],
  );
  const t = tracer();
  await runJobs(
    [
      { id: 'small', label: 's', estimate: 1 },
      { id: 'mid', label: 'm', estimate: 50, resources: ['port:1'] },
      { id: 'big', label: 'b', estimate: 400, resources: ['port:1'] },
    ],
    { limit: 2, run: t.run },
  );
  assert.deepEqual(t.order, ['big', 'small', 'mid']);
});

test('at most `limit` jobs run, each with its own hold, released once', async () => {
  let held = 0,
    peak = 0,
    released = 0;
  const jobs = [1, 2, 3, 4, 5].map((n) => ({ id: `${n}`, label: `${n}` }));
  const results = await runJobs(jobs, {
    limit: 2,
    take: async (mode) => {
      assert.equal(mode, 'shared');
      peak = Math.max(peak, ++held);
      return () => (held--, released++);
    },
    run: async () => (await new Promise((d) => setTimeout(d, 2)), { ok: true }),
  });
  assert.equal(peak, 2);
  assert.equal(released, 5);
  assert.deepEqual(
    results.map((r) => r.id),
    ['1', '2', '3', '4', '5'],
    'results keep the order given',
  );
  assert.ok(results.every((r) => r.outcome === 'pass' && r.hold === 'shared'));
});

test('an exclusive job waits for everything, holds exclusively, and nothing runs beside it', async () => {
  const t = tracer(),
    modes = {};
  const results = await runJobs(
    [
      { id: 'fly', label: 'fly', exclusive: true, estimate: 9999 },
      { id: 'a', label: 'a' },
      { id: 'b', label: 'b' },
      { id: 'objects', label: 'objects', exclusive: true },
    ],
    {
      limit: 4,
      take: async (mode, job) => ((modes[job.id] = mode), () => {}),
      run: t.run,
    },
  );
  assert.deepEqual(t.order.slice(2), ['fly', 'objects']);
  assert.deepEqual(t.pairs, ['a+b']);
  assert.equal(modes.fly, 'exclusive');
  assert.equal(modes.a, 'shared');
  assert.equal(results[0].hold, 'exclusive');
});

test('a failure stops the run: running jobs are aborted, the rest not run, and every log stays reported', async () => {
  let aborted = 0;
  const results = await runJobs(
    [
      { id: 'bad', label: 'bad', estimate: 9 },
      { id: 'beside', label: 'beside', estimate: 8 },
      { id: 'later', label: 'later', estimate: 1 },
      { id: 'fly', label: 'fly', exclusive: true },
    ],
    {
      limit: 2,
      run: (job, signal) =>
        job.id === 'bad'
          ? new Promise((d) => setTimeout(() => d({ ok: false, log: 'bad.log' }), 5))
          : new Promise((d) =>
              signal.addEventListener('abort', () => (aborted++, d({ ok: false, aborted: true, log: 'beside.log' }))),
            ),
    },
  );
  const by = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(aborted, 1);
  assert.equal(by.bad.outcome, 'fail');
  assert.equal(by.bad.log, 'bad.log');
  assert.equal(by.beside.outcome, 'not-run');
  assert.equal(by.beside.log, 'beside.log');
  assert.match(by.beside.reason, /stopped at bad/);
  assert.equal(by.later.outcome, 'not-run');
  assert.equal(by.fly.outcome, 'not-run');
});

test('a stop does not wait for a slot, and a hold that arrives late is given back', async () => {
  let releaseLate,
    gaveBack = 0;
  const late = new Promise((d) => (releaseLate = d));
  const results = await runJobs(
    [
      { id: 'bad', label: 'bad', estimate: 2 },
      { id: 'queued', label: 'queued', estimate: 1 },
    ],
    {
      limit: 2,
      take: (_, job) => (job.id === 'queued' ? late : async () => {}),
      run: async () => ({ ok: false }),
    },
  );
  assert.equal(results[1].outcome, 'not-run');
  releaseLate(() => gaveBack++);
  await new Promise((d) => setTimeout(d, 1));
  assert.equal(gaveBack, 1);
});

test('a run that throws is a failure, and an after-list that cannot finish is named', async () => {
  const [thrown] = await runJobs([{ id: 'a', label: 'a' }], {
    limit: 1,
    run: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(thrown.outcome, 'fail');
  assert.equal(thrown.message, 'boom');
  await assert.rejects(runJobs([{ id: 'a', label: 'a', after: ['a'] }], { limit: 1, run: pass }), (error) => {
    assert.equal(error.code, 'PARALLEL_PLAN_STUCK');
    return true;
  });
  assert.throws(() => runJobs([], { limit: 0, run: pass }), RangeError);
});

test('runLimited keeps a suite log, and a timed-out job has its tree killed and is named', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-parallel-'));
  try {
    const logFile = join(dir, 'a.log');
    const said = await runLimited(`node -e "console.log('hello log');console.error('and err')"`, {
      cwd: dir,
      limitMs: 30_000,
      logFile,
    });
    assert.equal(said.ok, true);
    assert.match(readFileSync(logFile, 'utf8'), /hello log[\s\S]*and err/);
    assert.match(tailOf(logFile), /and err/);
    const hung = await runLimited(`node -e "setInterval(()=>{},1000)"`, {
      cwd: dir,
      limitMs: 300,
      label: 'suite x',
      logFile,
    });
    assert.equal(hung.timedOut, true);
    assert.match(hung.message, /suite x hung/);
    assert.match(tailOf(join(dir, 'missing.log')), /cannot read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the switch: serial always wins, small machines stay serial, and parallel is turned on by flag or env', () => {
  const big = { heat: null, split: false };
  assert.equal(parallelMode({ argv: ['--parallel'], profile: big }), true);
  assert.equal(parallelMode({ env: { MARGO_CHECK_PARALLEL: '1' }, profile: big }), true);
  assert.equal(parallelMode({ argv: ['--parallel', '--serial'], profile: big }), false);
  assert.equal(parallelMode({ argv: ['--parallel'], env: { MARGO_CHECK_SERIAL: '1' }, profile: big }), false);
  assert.equal(parallelMode({ argv: ['--parallel'], profile: { heat: { stopC: 80 } } }), false);
  assert.equal(parallelMode({ argv: ['--parallel'], profile: { split: true } }), false);
});

test('ports, outputs and the Vite cache are read from a file, comments left out', () => {
  assert.deepEqual(fixedPorts(`openBrowser({ startPath: '/a', port: 5211 });`), [5211]);
  assert.deepEqual(fixedPorts(`const PORT = 5199; fetch('http://127.0.0.1:5198/x');`), [5198, 5199]);
  assert.deepEqual(fixedPorts(`await openBrowser({ startPath: '/a' });`), [5193], 'the default port');
  assert.deepEqual(fixedPorts(`await openBrowser({ port: 'free' });`), []);
  assert.deepEqual(fixedPorts(`// port: 5211\nserver.listen(0);`), []);
  assert.deepEqual(outputPaths(`write('test-results/voxel/a.png'); join(root, 'test-results', 'b.json');`), [
    'test-results/b.json',
    'test-results/voxel',
  ]);
  assert.equal(
    usesDefaultViteCache(`import { createServer } from 'vite'; createServer({ server: { port: 0 } })`),
    true,
  );
  assert.equal(usesDefaultViteCache(`import { createServer } from 'vite'; createServer({ cacheDir })`), false);
  assert.equal(usesDefaultViteCache(`import { createServer } from 'node:http';`), false);
});

const tests = plan(),
  steps = lockOrder(planSteps(tests, { heat: null, split: false, exclude: {} })),
  manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
  resources = suiteResources(root, steps, { scripts: manifest.scripts, prepare: PREPARE });

test('the parallel plan is the serial plan: every suite once, the same timing tests, each with a hold longer than its limit', () => {
  const jobs = suiteJobs(steps, resources);
  assert.deepEqual(jobs.map((j) => j.label).sort(), tests.map((t) => t.label).sort());
  assert.deepEqual(
    jobs
      .filter((j) => j.exclusive)
      .map((j) => j.label)
      .sort(),
    tests
      .filter((t) => t.exclusive)
      .map((t) => t.label)
      .sort(),
  );
  assert.ok(
    jobs.some((j) => j.exclusive),
    'there are timing tests',
  );
  for (const job of jobs) assert.ok(holdMinutes(job) * 60_000 > 2 * 10 * 60_000, job.label);
});

test('real suites that share a port or an output are told apart', () => {
  const id = (label) => testId(tests.find((t) => t.label === label));
  const shared = (a, b) => resources[id(a)].filter((r) => resources[id(b)].includes(r));
  assert.ok(shared('compute test:browser', 'compute test:browser:spec-math').length, 'compute suites');
  assert.ok(shared('voxel-pathtracer test:gpu', 'voxel-pathtracer test:gpu:viewport').length, 'the capture folder');
  assert.ok(shared('sky test:gpu', 'staging test:gpu').includes('port:5211'), 'port 5211');
  assert.ok(shared('exporters test:png:browser', 'exporters test:capture:browser').includes('vite-default-cache'));
  assert.ok(resources[id('root modern:test:extensions')].includes('port:5211'), 'steps named by new URL');
  assert.ok(resources[id('webgl2-compat test:gpu')].includes('port:5267'), "it reaches another package's check");
});

test('the GPU runner side by side, with real locks and processes and no GPU: a failure names its suite and keeps its log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-side-'));
  try {
    const script = join(dir, 'run.mjs'),
      suite = (label, code, extra = {}) => ({
        id: label,
        label,
        cwd: '.',
        command: `node -e "${code}"`,
        part: [1, 1],
        ...extra,
      });
    const fake = [
      suite('good', "console.log('good ran')"),
      suite('bad', "console.log('bad said why');process.exit(3)"),
      suite('fly', "console.log('fly ran')", { exclusive: true }),
    ];
    writeFileSync(
      script,
      `import { runSideBySide } from ${JSON.stringify(new URL('../scripts/gpu-package-tests.mjs', import.meta.url).href)};
const results = await runSideBySide(${JSON.stringify(fake)}, { env: process.env, logs: ${JSON.stringify(join(dir, 'logs'))} });
console.log('RESULTS' + JSON.stringify(results.map((r) => [r.label, r.outcome, r.hold, r.log])));
process.exit(0);`,
    );
    const run = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 90_000,
      env: { ...process.env, MARGO_GPU_LOCK: join(dir, 'gpu.lock'), MARGO_GPU_SLOTS: '2' },
    });
    assert.equal(run.status, 0, run.stderr);
    const by = Object.fromEntries(JSON.parse(/RESULTS(.*)/.exec(run.stdout)[1]).map((r) => [r[0], r]));
    assert.equal(by.bad[1], 'fail');
    assert.match(readFileSync(by.bad[3], 'utf8'), /=== bad[\s\S]*bad said why/);
    assert.equal(by.fly[1], 'not-run', 'a timing test never starts after a failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check:merge steps: each placed, nothing lost, verify alone, timing last and alone, none on a suite port', () => {
  const planned = manifest.scripts['check:merge:steps'].split(' && ').map((command) => ({ command })),
    jobs = stepJobs(planned);
  assert.deepEqual(
    jobs
      .filter((j) => j.id !== TIMING_JOB)
      .map((j) => j.id)
      .sort(),
    [...GPU_STEPS, ...PLAIN_STEPS, ...SCOPED_STEPS].filter((s) => s !== 'verify').sort(),
  );
  const timing = jobs.find((j) => j.id === TIMING_JOB);
  assert.equal(timing.exclusive, true);
  assert.match(timing.command, /--no-build --phase=timing$/);
  assert.match(jobs.find((j) => j.id === 'check:gpu-packages').command, /--no-build --phase=shared$/);
  for (const name of ['visual:check', 'check:no-webgpu', 'check:gpu-packages'])
    assert.deepEqual(jobs.find((j) => j.id === name).after, ['build:site'], name);
  assert.deepEqual(jobs.find((j) => j.id === 'modern:test:bundlers').after, ['modern:test:packages']);
  assert.throws(
    () => stepJobs([{ command: 'npm run check:new' }]),
    (error) => error.code === 'CHECK_MERGE_STEP_UNPLACED',
  );
  // A step on a suite's fixed port would make that suite wait in its GPU slot.
  const all = new Set(Object.values(resources).flat());
  for (const port of [5293, 5297, 5317, 5259]) assert.ok(!all.has(`port:${port}`), `port ${port}`);
});

test('runStepsParallel: verify first and alone, then the rest; a skip stays a skip; one result per planned step', async () => {
  const seen = [];
  const planned = [
    { command: 'npm run verify' },
    { command: 'npm run build:site' },
    { command: 'npm run check:views', skip: 'no affected package uses it' },
    { command: 'npm run check:gpu-packages -- --no-build' },
  ];
  let snapped = 0;
  const { results, failed } = await runStepsParallel(planned, {
    log: () => {},
    logFor: (id) => `${id}.log`,
    before: () => {
      assert.deepEqual(seen, ['npm run verify'], 'the snapshot comes right after verify');
      snapped++;
    },
    run: async (command) => (seen.push(command), { ok: true }),
  });
  assert.equal(snapped, 1);
  assert.equal(failed, undefined);
  assert.deepEqual(seen, [
    'npm run verify',
    'npm run build:site',
    'npm run check:gpu-packages -- --no-build --phase=shared',
    'npm run check:gpu-packages -- --no-build --phase=timing',
  ]);
  assert.deepEqual(
    results.map((r) => r.command),
    planned.map((p) => p.command),
  );
  assert.equal(results[2].skipped, 'no affected package uses it');
  assert.ok(results[3].ok);
});

test('runStepsParallel: a failed step stops the others, is named with its log, and a failed verify starts nothing', async () => {
  const planned = [
    { command: 'npm run verify' },
    { command: 'npm run build:site' },
    { command: 'npm run check:views' },
    { command: 'npm run check:depth' },
  ];
  const noRetry = (_, run) => run();
  const stopped = await runStepsParallel(planned, {
    log: () => {},
    retry: noRetry,
    logFor: (id) => `${id}.log`,
    hasTiming: () => false,
    run: (command, _, signal) => {
      if (command === 'npm run check:views') return Promise.resolve({ ok: false });
      if (command === 'npm run check:depth')
        return new Promise((d) => signal.addEventListener('abort', () => d({ ok: false, aborted: true })));
      return Promise.resolve({ ok: true });
    },
  });
  assert.equal(stopped.failed, 'npm run check:views');
  assert.equal(stopped.failedLog, 'check:views.log');
  assert.match(stopped.results[3].notRun, /stopped at check:views/);
  let ran = 0;
  const noVerify = await runStepsParallel(planned, {
    log: () => {},
    retry: noRetry,
    logFor: (id) => id,
    run: async () => (ran++, { ok: false }),
  });
  assert.equal(noVerify.failed, 'npm run verify');
  assert.equal(ran, 1);
});

const mergeFile = (extra = {}) => ({
  mode: 'full',
  results: [
    { command: 'npm run verify', ok: true },
    { command: 'npm run check:views', ok: true },
  ],
  ...extra,
});
const suite = (label, extra = {}) => ({ label, outcome: 'pass', ok: true, ...extra });
const runs = (over = {}) => ({
  serialMerge: mergeFile(),
  serialGpu: { results: [suite('a'), suite('fly', { exclusive: true })] },
  parallelMerge: mergeFile({ parallel: true }),
  parallelGpu: {
    parallel: true,
    results: [
      suite('a', { hold: 'shared', startedAt: 1, endedAt: 5 }),
      suite('fly', { exclusive: true, hold: 'exclusive', startedAt: 6, endedAt: 9 }),
    ],
  },
  ...over,
});

test('compare: the same work passes; new suites are listed apart', () => {
  assert.deepEqual(compareRuns(runs()).problems, []);
  const more = runs();
  more.parallelGpu.results.push(suite('new', { hold: 'shared', startedAt: 1, endedAt: 2 }));
  more.parallelGpu.results.push(suite('new fly', { exclusive: true, hold: 'exclusive', startedAt: 20, endedAt: 21 }));
  const result = compareRuns(more);
  assert.equal(result.ok, true);
  assert.deepEqual(result.newSuites, ['new']);
  assert.deepEqual(result.newTiming, ['new fly']);
});

test('compare: a missing, failed, not-run or excluded suite, or a lost step, is a difference', () => {
  const change = (fn) => {
    const r = runs();
    fn(r);
    return compareRuns(r);
  };
  assert.match(change((r) => r.parallelGpu.results.shift()).problems.join(), /suite a is missing/);
  assert.match(change((r) => (r.parallelGpu.results[0].outcome = 'fail')).problems.join(), /suite a: fail/);
  assert.match(change((r) => (r.parallelGpu.results[0].outcome = 'not-run')).problems.join(), /suite a: not-run/);
  assert.match(change((r) => (r.parallelGpu.results[0].outcome = 'excluded')).problems.join(), /excluded/);
  assert.match(change((r) => r.parallelMerge.results.pop()).problems.join(), /step check:views is missing/);
  assert.match(
    change((r) => (r.parallelMerge.results[1] = { command: 'npm run check:views', skipped: 'x' })).problems.join(),
    /skipped/,
  );
  assert.match(change((r) => (r.parallelMerge.results[1].ok = false)).problems.join(), /check:views did not pass/);
  assert.match(change((r) => (r.parallelMerge.mode = 'affected')).problems.join(), /modes differ/);
  assert.match(change((r) => delete r.parallelMerge.parallel).problems.join(), /not from a side-by-side run/);
});

test('compare: a timing suite in a shared hold, or with a suite beside it, is a difference', () => {
  const shared = runs();
  shared.parallelGpu.results[1].hold = 'shared';
  assert.match(compareRuns(shared).problems.join(), /timing suite fly held shared/);
  const beside = runs();
  beside.parallelGpu.results[1].startedAt = 2;
  assert.match(compareRuns(beside).problems.join(), /timing suite fly ran beside a/);
});
