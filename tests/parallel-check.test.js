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
  KERNEL_STEPS,
  stepJobs,
} from '../scripts/check-merge.mjs';
import { compareRuns } from '../scripts/compare-check-runs.mjs';
import {
  PREPARE,
  plan,
  planSteps,
  runLimitMs,
  runPlan,
  stepMinutes,
  suiteJobs,
  testId,
} from '../scripts/gpu-package-tests.mjs';
import { DEFAULT_MINUTES } from '../scripts/run-with-timeout.mjs';
import { longestFirst, parallelMode, runJobs, tailOf } from '../scripts/support/parallel-run.mjs';
import { runLimited, testLimitMs } from '../scripts/support/run-limited.mjs';
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
  assert.ok(t.pairs.includes('a+c'), 'a suite with no conflict runs beside it');
});

test('the longest suite starts first, and a long job with a busy port lets a shorter one past', async () => {
  assert.deepEqual(
    longestFirst([
      { id: 's', estimate: 1 },
      { id: 'x', estimate: 999 },
      { id: 'l', estimate: 400 },
    ]).map((j) => j.id),
    ['x', 'l', 's'],
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

test('at most `limit` jobs run at once, and every job runs once', async () => {
  let open = 0,
    peak = 0,
    ran = 0;
  const jobs = [1, 2, 3, 4, 5].map((n) => ({ id: `${n}`, label: `${n}` }));
  const results = await runJobs(jobs, {
    limit: 2,
    run: async () => {
      peak = Math.max(peak, ++open);
      ran++;
      await new Promise((d) => setTimeout(d, 2));
      open--;
      return { ok: true };
    },
  });
  assert.equal(peak, 2);
  assert.equal(ran, 5);
  assert.deepEqual(
    results.map((r) => r.id),
    ['1', '2', '3', '4', '5'],
    'results keep the order given',
  );
  assert.ok(results.every((r) => r.outcome === 'pass'));
});

test('a failure stops the run: running jobs are aborted, the rest not run, and every log stays reported', async () => {
  let aborted = 0;
  const results = await runJobs(
    [
      { id: 'bad', label: 'bad', estimate: 9 },
      { id: 'beside', label: 'beside', estimate: 8 },
      { id: 'later', label: 'later', estimate: 1 },
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
});

test('a job whose build ends after the run stopped is not run', async () => {
  let finishBuild;
  const built = new Promise((d) => (finishBuild = d)),
    ran = [];
  const running = runJobs(
    [
      { id: 'bad', label: 'bad', estimate: 2 },
      { id: 'queued', label: 'queued', estimate: 1 },
    ],
    {
      limit: 2,
      prepare: async (job) => (job.id === 'queued' ? built : null),
      run: async (job) => (ran.push(job.id), { ok: false }),
    },
  );
  await new Promise((d) => setTimeout(d, 1));
  finishBuild(null);
  const results = await running;
  assert.deepEqual(ran, ['bad']);
  assert.equal(results[1].outcome, 'not-run');
  assert.match(results[1].reason, /stopped at bad/);
});

// The serial and side-by-side
// paths still rerun a suite that failed during a GPU driver reset, and a failed build still ends its suite unrun.
test('a rerun after a driver reset runs the suite again on both paths, and a failed build ends a suite unrun', async () => {
  const suite = { id: 'p/a', label: 'p a', name: 'test:gpu:a', minutes: 30, part: [1, 1], command: 'a' };
  let runs = 0;
  const [serial] = await runPlan([suite], {
    profile: { name: 'test', heat: null },
    retry: async (label, attempt) => {
      const first = await attempt();
      assert.equal(first.ok, false, 'the retry is handed the first result without a new run');
      return attempt();
    },
    runStep: async () => ({ ok: ++runs > 1, seconds: 1 }),
  });
  assert.equal(serial.outcome, 'pass');
  assert.equal(runs, 2);
  let jobRuns = 0;
  const [side] = await runJobs([{ ...suite, estimate: 1 }], {
    limit: 1,
    retry: async (label, attempt) => (await attempt(), attempt()),
    run: async () => ({ ok: ++jobRuns > 1 }),
  });
  assert.equal(side.outcome, 'pass');
  assert.equal(jobRuns, 2);
  const [serialBuild] = await runPlan([suite], {
    profile: { name: 'test', heat: null },
    prepare: async () => ({ ok: false, seconds: 0 }),
    runStep: async () => assert.fail('ran'),
  });
  assert.equal(serialBuild.outcome, 'fail');
  const [sideBuild] = await runJobs([{ ...suite, estimate: 1 }], {
    limit: 1,
    prepare: async () => ({ ok: false, message: 'npm run build:x failed' }),
    run: async () => assert.fail('ran'),
  });
  assert.equal(sideBuild.outcome, 'fail');
  assert.match(sideBuild.message, /build:x failed/);
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
    usesDefaultViteCache(`import { createServer } from 'vite';
import { noFileWatcher } from '../scripts/support/no-file-watcher.js'; createServer({ plugins: [noFileWatcher()], server: { port: 0 } })`),
    true,
  );
  assert.equal(
    usesDefaultViteCache(`import { createServer } from 'vite'; createServer({ plugins: [noFileWatcher()], cacheDir })`),
    false,
  );
  assert.equal(usesDefaultViteCache(`import { createServer } from 'node:http';`), false);
});

const tests = plan(),
  steps = planSteps(tests, { heat: null, split: false, exclude: {} }),
  manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
  resources = suiteResources(root, steps, { scripts: manifest.scripts, prepare: PREPARE });

test('the parallel plan is the serial plan: every suite once, each run within 10 min and its share of the run', () => {
  const jobs = suiteJobs(steps, resources);
  assert.deepEqual(jobs.map((j) => j.label).sort(), tests.map((t) => t.label).sort());
  // A run and its rerun after a driver reset each end at their own limit, at most 10 min.
  for (const job of jobs) {
    assert.equal(runLimitMs(job), Math.min(testLimitMs(job.minutes), DEFAULT_MINUTES * 60_000), job.label);
    assert.ok(stepMinutes(job) * 60_000 >= 2 * runLimitMs(job), job.label);
  }
  // Real suites reach the 10 minute cap (the 9 minute cap that kept a run under a 10 minute hold is gone).
  assert.ok(
    jobs.some((job) => runLimitMs(job) === DEFAULT_MINUTES * 60_000),
    'some suites run up to 10 minutes',
  );
});

test('suite limits: a run limited to its own limit or 10 min, and a step counts two runs', () => {
  for (const minutes of [0.5, 6, 10, 15, 60]) {
    const job = { name: 'a-suite-without-prepare', minutes };
    assert.equal(stepMinutes(job), 20);
    assert.equal(runLimitMs(job), Math.min(testLimitMs(minutes), 10 * 60_000));
    assert.ok(stepMinutes(job) * 60_000 >= 2 * runLimitMs(job));
  }
});

test('real suites that share a port or an output are told apart', () => {
  const id = (label) => testId(tests.find((t) => t.label === label));
  const shared = (a, b) => resources[id(a)].filter((r) => resources[id(b)].includes(r));
  assert.ok(shared('compute test:browser', 'compute test:browser:spec-math').length, 'compute suites');
  assert.ok(shared('voxel-pathtracer test:gpu', 'voxel-pathtracer test:gpu:viewport').length, 'the capture folder');
  assert.ok(shared('sky test:gpu', 'studio test:gpu').includes('port:5211'), 'port 5211');
  assert.ok(shared('exporters test:png:browser', 'exporters test:capture:browser').includes('vite-default-cache'));
  assert.ok(resources[id('root modern:test:extensions')].includes('port:5211'), 'steps named by new URL');
  assert.ok(resources[id('webgl2-compat test:gpu')].includes('port:5267'), "it reaches another package's check");
});

test('the GPU runner side by side, with real processes and no GPU: a failure names its suite and keeps its log', () => {
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
      suite('bad', "console.log('bad said why');process.exitCode = 3"),
    ];
    writeFileSync(
      script,
      `import { runSideBySide } from ${JSON.stringify(new URL('../scripts/gpu-package-tests.mjs', import.meta.url).href)};
const results = await runSideBySide(${JSON.stringify(fake)}, { env: process.env, logs: ${JSON.stringify(join(dir, 'logs'))} });
console.log('RESULTS' + JSON.stringify(results.map((r) => [r.label, r.outcome, r.log])));`,
    );
    const run = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 90_000,
      env: process.env,
    });
    assert.equal(run.status, 0, run.stderr);
    const by = Object.fromEntries(JSON.parse(/RESULTS(.*)/.exec(run.stdout)[1]).map((r) => [r[0], r]));
    assert.equal(by.bad[1], 'fail');
    assert.match(readFileSync(by.bad[2], 'utf8'), /=== bad[\s\S]*bad said why/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check:merge steps: each placed once, nothing lost, verify alone, the GPU suites one job, none on a suite port', () => {
  const planned = manifest.scripts['check:merge:steps'].split(' && ').map((command) => ({ command })),
    jobs = stepJobs(planned);
  assert.deepEqual(
    jobs.map((j) => j.id).sort(),
    [...GPU_STEPS, ...PLAIN_STEPS, ...SCOPED_STEPS, ...KERNEL_STEPS].filter((s) => s !== 'verify').sort(),
  );
  const gpu = jobs.find((j) => j.id === 'check:gpu-packages');
  assert.equal(gpu.command, gpu.step, 'the GPU suites run as one job, as written');
  assert.doesNotMatch(gpu.command, /--phase/);
  for (const name of ['visual:check', 'check:no-webgpu', 'check:gpu-packages'])
    assert.deepEqual(jobs.find((j) => j.id === name).after, ['build:site'], name);
  assert.deepEqual(jobs.find((j) => j.id === 'modern:test:bundlers').after, ['modern:test:packages']);
  assert.throws(
    () => stepJobs([{ command: 'npm run check:new' }]),
    (error) => error.code === 'CHECK_MERGE_STEP_UNPLACED',
  );
  // A step on a suite's fixed port would make that suite wait for the port.
  const all = new Set(Object.values(resources).flat());
  const basicScene = Number(readFileSync('scripts/basic-scene-network.mjs', 'utf8').match(/\bport = (\d+)/)[1]);
  for (const port of [5297, 5317, basicScene]) assert.ok(!all.has(`port:${port}`), `port ${port}`);
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
  assert.deepEqual(seen, ['npm run verify', 'npm run build:site', 'npm run check:gpu-packages -- --no-build']);
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
  serialGpu: { results: [suite('a'), suite('fly')] },
  parallelMerge: mergeFile({ parallel: true }),
  parallelGpu: {
    parallel: true,
    results: [suite('a', { startedAt: 1, endedAt: 5 }), suite('fly', { startedAt: 6, endedAt: 9 })],
  },
  ...over,
});

test('compare: the same work passes; new suites are listed apart', () => {
  assert.deepEqual(compareRuns(runs()).problems, []);
  const more = runs();
  more.parallelGpu.results.push(suite('new', { startedAt: 1, endedAt: 2 }));
  more.parallelGpu.results.push(suite('new fly', { startedAt: 20, endedAt: 21 }));
  const result = compareRuns(more);
  assert.equal(result.ok, true);
  assert.deepEqual(result.newSuites, ['new', 'new fly']);
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
