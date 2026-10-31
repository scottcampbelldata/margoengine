// Keep going: one failure used to leave 99 suites not run, which on a main failing in several places meant one full
// check per bug. With --keep-going or MARGO_CHECK_KEEP_GOING=1 a failure stops nothing beside it. Injected runners, no GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSteps, runStepsParallel, stepJobs, summary } from '../scripts/check-merge.mjs';
import { exitCode } from '../scripts/gpu-package-tests.mjs';
import { keepGoingMode, runJobs } from '../scripts/support/parallel-run.mjs';

const job = (id, extra = {}) => ({ id, label: id, ...extra });
const planned = (...names) => names.map((name) => ({ command: `npm run ${name}` }));
const noHeat = { name: 'workstation', heat: null };
const retry = (_, again) => again();

test('keepGoingMode: the flag or the variable, off otherwise', () => {
  assert.equal(keepGoingMode({ argv: ['--keep-going'] }), true);
  assert.equal(keepGoingMode({ env: { MARGO_CHECK_KEEP_GOING: '1' } }), true);
  assert.equal(keepGoingMode({ argv: ['--serial'], env: { MARGO_CHECK_KEEP_GOING: '0' } }), false);
});

test('runJobs keepGoing: every other suite runs, nothing beside the failure is aborted, exit stays 1', async () => {
  const ran = [],
    aborted = [];
  const results = await runJobs([job('a'), job('b'), job('c'), job('timing', { exclusive: true })], {
    limit: 2,
    keepGoing: true,
    run: async (j, signal) => {
      ran.push(j.id);
      signal.addEventListener('abort', () => aborted.push(j.id));
      await new Promise((done) => setTimeout(done, 1));
      return { ok: j.id !== 'a' };
    },
  });
  assert.deepEqual(ran.sort(), ['a', 'b', 'c', 'timing']);
  assert.deepEqual(aborted, []);
  assert.deepEqual(
    results.map((r) => r.outcome),
    ['fail', 'pass', 'pass', 'pass'],
  );
  assert.equal(exitCode(results), 1);
});

test('runJobs keepGoing: all failures are reported, and only what needs a failed job does not run, however deep', async () => {
  const results = await runJobs(
    [job('site'), job('visual', { after: ['site'] }), job('deep', { after: ['visual'] }), job('other'), job('bad')],
    { limit: 1, keepGoing: true, run: async (j) => ({ ok: j.id === 'other' }) },
  );
  const by = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(by.site.outcome, 'fail');
  assert.equal(by.bad.outcome, 'fail');
  assert.equal(by.other.outcome, 'pass');
  assert.equal(by.visual.outcome, 'not-run');
  assert.match(by.visual.reason, /needs site/);
  assert.match(by.deep.reason, /needs visual/);
});

test('runJobs without keepGoing still stops at the first failure', async () => {
  const results = await runJobs([job('a'), job('b')], { limit: 1, run: async () => ({ ok: false }) });
  assert.deepEqual(
    results.map((r) => r.outcome),
    ['fail', 'not-run'],
  );
});

test('runSteps keepGoing: the steps after a failure run, a step that needs it does not, all are listed', async () => {
  const ran = [];
  const out = await runSteps(planned('build:site', 'check:views', 'check:quickstart', 'check:wgsl'), {
    profile: noHeat,
    keepGoing: true,
    retry,
    log: () => {},
    run: async (_, name) => {
      ran.push(name);
      return { ok: name === 'check:wgsl' ? false : name !== 'build:site' };
    },
  });
  // check:views and check:wgsl read the built site.
  assert.deepEqual(ran, ['build:site', 'check:quickstart']);
  assert.equal(out.failed, 'npm run build:site');
  assert.match(out.results[1].notRun, /needs build:site/);
  assert.deepEqual(
    out.failures.map((f) => f.step),
    ['npm run build:site'],
  );
});

test('runSteps keepGoing: two failures are both listed and the summary says so', async () => {
  const out = await runSteps(planned('check:quickstart', 'check:fresh-clone', 'check:depth'), {
    profile: noHeat,
    keepGoing: true,
    retry,
    log: () => {},
    run: async (_, name) => ({ ok: name === 'check:fresh-clone' }),
  });
  assert.equal(out.failures.length, 2);
  const { lines } = summary({ ...out, seconds: 1 });
  assert.ok(lines.includes('  FAILED  npm run check:quickstart'));
  assert.ok(lines.includes('  FAILED  npm run check:depth'));
  assert.equal(lines.at(-1), 'FAILED at npm run check:quickstart in 1 s');
});

test('summary names the suites inside a failed GPU step, even when it is the only failed step', () => {
  const { lines } = summary({
    results: [],
    failed: 'npm run check:gpu-packages',
    seconds: 1,
    failures: [{ step: 'npm run check:gpu-packages', suites: ['sky test:gpu', 'root test:x'] }],
  });
  assert.ok(lines.includes('  FAILED  npm run check:gpu-packages: sky test:gpu, root test:x'));
});

test('runSteps keepGoing: a failed verify is followed by one build; the rest run if it builds, and nothing if not', async () => {
  for (const builds of [true, false]) {
    const ran = [];
    let rebuilt = 0;
    const out = await runSteps(planned('verify', 'check:quickstart'), {
      profile: noHeat,
      keepGoing: true,
      retry,
      log: () => {},
      rebuild: async () => (rebuilt++, builds),
      run: async (_, name) => (ran.push(name), { ok: name !== 'verify' }),
    });
    assert.equal(rebuilt, 1);
    assert.deepEqual(ran, builds ? ['verify', 'check:quickstart'] : ['verify']);
    assert.equal(out.failed, 'npm run verify');
  }
});

test('runSteps without keepGoing stops at the first failure and asks for no build', async () => {
  const ran = [];
  const out = await runSteps(planned('verify', 'check:quickstart'), {
    profile: noHeat,
    retry,
    log: () => {},
    rebuild: () => assert.fail('no build'),
    run: async (_, name) => (ran.push(name), { ok: false }),
  });
  assert.deepEqual(ran, ['verify']);
  assert.equal(out.failed, 'npm run verify');
});

test('runSteps keepGoing: an unresumed heat stop still ends the run', async () => {
  const ran = [];
  const out = await runSteps(planned('check:gpu-packages', 'check:quickstart'), {
    profile: noHeat,
    keepGoing: true,
    retry,
    log: () => {},
    run: async (_, name) => (ran.push(name), { ok: false, status: 75 }),
  });
  assert.deepEqual(ran, ['check:gpu-packages']);
  assert.equal(out.heatStopped, 'npm run check:gpu-packages');
});

test('runSteps keepGoing: a step that fails during a driver reset still gets its one rerun', async () => {
  let tries = 0;
  const out = await runSteps(planned('check:quickstart'), {
    profile: noHeat,
    keepGoing: true,
    log: () => {},
    retry: async (_, again) => (await again(), again()),
    run: async () => ({ ok: ++tries === 2 }),
  });
  assert.equal(tries, 2);
  assert.deepEqual(out.failures, []);
});

test('stepJobs: with keepGoing the timing part does not wait for the shared part to pass, but still runs last', () => {
  const steps = planned('verify', 'build:site', 'check:gpu-packages');
  const timing = (options) => stepJobs(steps, () => true, options).find((j) => j.exclusive);
  assert.deepEqual(timing().after, ['check:gpu-packages']);
  assert.deepEqual(timing({ keepGoing: true }).after, ['build:site']);
});

test('runStepsParallel keepGoing: a failed shared suite step leaves the rest and the timing part running', async () => {
  const ran = [];
  const out = await runStepsParallel(
    planned('verify', 'build:site', 'check:gpu-packages', 'check:wgsl', 'check:quickstart'),
    {
      keepGoing: true,
      retry,
      log: () => {},
      logFor: (id) => `${id}.log`,
      run: async (command, name) => {
        ran.push(command);
        return { ok: !/phase=shared|check:quickstart/.test(command), name };
      },
    },
  );
  assert.ok(ran.some((c) => c.includes('--phase=timing')));
  assert.ok(ran.includes('npm run check:wgsl'));
  assert.deepEqual(out.failures.map((f) => f.step).sort(), ['npm run check:gpu-packages', 'npm run check:quickstart']);
  assert.ok(out.failed);
});

test('runStepsParallel keepGoing: a failed verify builds once, then the rest run; verify stays failed', async () => {
  let rebuilt = 0;
  const out = await runStepsParallel(planned('verify', 'check:quickstart'), {
    keepGoing: true,
    retry,
    log: () => {},
    logFor: (id) => `${id}.log`,
    rebuild: async () => (rebuilt++, true),
    run: async (command) => ({ ok: command !== 'npm run verify' }),
  });
  assert.equal(rebuilt, 1);
  assert.equal(out.failed, 'npm run verify');
  assert.equal(out.results.find((r) => r.command === 'npm run check:quickstart').ok, true);
});
