// Item 57.1a: on the thermally limited Linux server a heat stop read like a failure or a silent skip. The GPU package
// runner now reports a heat stop as PAUSED FOR HEAT (step, peak, stop and resume temperatures, time waited), waits a
// bounded time for the resume temperature, runs the paused step again (not the whole run) and, when the wait runs
// out, reports PAUSED FOR HEAT: NOT RESUMED with the reason; a machine profile that leaves a package out reports it as
// EXCLUDED BY PROFILE with its reason. A fake thermal source (a value the test sets, and a temperature file) drives
// every outcome with no real heat and no GPU: the steps are tiny node processes.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  HEAT_EXIT,
  exitCode,
  plan,
  planSteps,
  report,
  runPlan,
  splitSteps,
  summaryLines,
} from '../scripts/gpu-package-tests.mjs';
import { coolDown, fileTemperature, hottestZone, thermalSource, toCelsius } from '../scripts/support/heat.mjs';
import { machineProfile, PROFILES_FILE, readProfiles } from '../scripts/support/machine-profile.mjs';
import { runLimited } from '../scripts/support/run-limited.mjs';

const root = join(import.meta.dirname, '..');
const heatProfile = (heat = {}) => ({
  name: 'test-hot',
  description: 'a test profile',
  split: true,
  exclude: {},
  heat: { stopC: 80, resumeC: 70, maxWaitMin: 0.05, maxResumesPerStep: 2, pollS: 5, ...heat },
});
const step = (id) => ({ id, label: `pkg ${id}`, part: [1, 1] });
const sleepFor = (seconds) => `node -e "setTimeout(()=>{},${seconds * 1000})"`;
// Runs a step as a real child process that ends its tree when the heat watch aborts it.
const childStep = (command) => (_, signal) => runLimited(command, { cwd: root, limitMs: 30_000, signal });

test('a heat stop pauses, releases the lock, resumes at the paused step and reports peak, stop and resume', async () => {
  let temp = 50,
    held = 0,
    cooledUnlocked = false;
  const calls = [],
    lines = [];
  const results = await runPlan([step('a'), step('b'), step('c')], {
    profile: heatProfile(),
    pollMs: 20,
    read: () => {
      if (calls.length === 2 && held === 0) cooledUnlocked = true;
      return temp;
    },
    take: async () => {
      held++;
      return () => held--;
    },
    log: (line) => lines.push(line),
    runStep: (s, signal) => {
      calls.push(s.id);
      // Step b heats the machine on its first run; the fake source cools it 150 ms after the stop.
      if (s.id === 'b' && calls.filter((c) => c === 'b').length === 1) {
        setTimeout(() => (temp = 85), 100);
        signal.addEventListener('abort', () => setTimeout(() => (temp = 60), 150), { once: true });
        return childStep(sleepFor(20))(s, signal);
      }
      return childStep('node -e "process.exit(0)"')(s, signal);
    },
  });
  assert.deepEqual(calls, ['a', 'b', 'b', 'c'], 'the paused step runs again, the run does not start over');
  assert.equal(cooledUnlocked, true, 'the GPU lock is released while the machine cools');
  assert.equal(held, 0, 'every lock taken is released');
  assert.deepEqual(
    results.map((r) => r.outcome),
    ['pass', 'pass', 'pass'],
  );
  const [pause] = results[1].pauses;
  assert.equal(results[1].pauses.length, 1);
  assert.equal(pause.stoppedAtC, 85);
  assert.equal(pause.peakC, 85);
  assert.equal(pause.resumeC, 70);
  assert.equal(pause.resumed, true);
  assert.equal(pause.resumedAtC, 60);
  assert.ok(pause.waitedS >= 0);
  assert.match(pause.reason, /85 C reached the stop temperature 80 C/);
  assert.ok(
    lines.some((l) => /PAUSED FOR HEAT: pkg b: .*GPU lock released; waiting at most 0\.05 min for below 70 C/.test(l)),
  );
  assert.ok(lines.some((l) => /RESUMED: pkg b at 60 C after \d+ s; running this step again/.test(l)));
  assert.equal(exitCode(results), 0, 'a resumed pause that then passed is a pass');
  const summary = summaryLines(results).join('\n');
  assert.match(
    summary,
    /PASS {2}pkg b .*paused for heat once: peak 85 C, stopped at 85 C .*resumed at 60 C after \d+ s/,
  );
  assert.match(summary, /paused for heat and resumed: 1 step\(s\)/);
});
test('a cooldown that passes its maximum wait is PAUSED FOR HEAT: NOT RESUMED, the rest NOT RUN, exit 75, never a failure', async () => {
  let temp = 50;
  const calls = [];
  const started = performance.now();
  const results = await runPlan([step('a'), step('b'), step('c')], {
    profile: heatProfile({ maxWaitMin: 0.005 }),
    pollMs: 20,
    read: () => temp,
    log: () => {},
    runStep: (s, signal) => {
      calls.push(s.id);
      if (s.id === 'b') setTimeout(() => (temp = 90), 100);
      return childStep(s.id === 'b' ? sleepFor(20) : 'node -e "process.exit(0)"')(s, signal);
    },
  });
  // wall-clock: a 0.3 s maximum wait; step b sleeps 20 s, and an unbounded cooldown never returns.
  assert.ok(performance.now() - started < 15_000, 'the wait is bounded, never forever');
  assert.deepEqual(calls, ['a', 'b'], 'nothing runs on a machine that did not cool down');
  assert.deepEqual(
    results.map((r) => r.outcome),
    ['pass', 'heat-not-resumed', 'not-run'],
  );
  assert.match(
    results[1].reason,
    /still 90 C after the maximum wait of 0\.005 min \(lowest 90 C; resume needs below 70 C\)/,
  );
  assert.match(results[2].reason, /the run stopped for heat at pkg b/);
  assert.equal(exitCode(results), HEAT_EXIT);
  const summary = summaryLines(results).join('\n');
  assert.match(summary, /PAUSED FOR HEAT: NOT RESUMED {2}pkg b {2}\(still 90 C/);
  assert.match(summary, /NOT RUN {2}pkg c/);
  assert.doesNotMatch(summary, /FAIL/);
  assert.equal(report(results).json.passedAfterDriverReset, false);
});
test('a step that keeps reaching the stop ends after its resume limit with the reason, and the run goes on', async () => {
  let temp = 50;
  const calls = [];
  const results = await runPlan([step('heavy'), step('light')], {
    profile: heatProfile({ maxResumesPerStep: 1 }),
    pollMs: 20,
    read: () => temp,
    log: () => {},
    runStep: (s, signal) => {
      calls.push(s.id);
      if (s.id === 'heavy') {
        setTimeout(() => (temp = 82), 60);
        signal.addEventListener('abort', () => setTimeout(() => (temp = 55), 60), { once: true });
        return childStep(sleepFor(20))(s, signal);
      }
      return childStep('node -e "process.exit(0)"')(s, signal);
    },
  });
  assert.deepEqual(calls, ['heavy', 'heavy', 'light']);
  assert.deepEqual(
    results.map((r) => r.outcome),
    ['heat-not-resumed', 'pass'],
  );
  assert.match(
    results[0].reason,
    /reached the stop 2 times \(at most 1 resumes per step\), so it does not fit profile test-hot/,
  );
  assert.equal(exitCode(results), HEAT_EXIT);
});

test('a machine that starts hot cools before the step; a failure stays a failure', async () => {
  let temp = 81;
  setTimeout(() => (temp = 60), 80);
  const results = await runPlan([step('a')], {
    profile: heatProfile(),
    pollMs: 20,
    read: () => temp,
    log: () => {},
    runStep: childStep('node -e "process.exit(3)"'),
  });
  assert.equal(results[0].outcome, 'fail', 'a real failure is never turned into a heat pause');
  assert.equal(results[0].pauses[0].before, true);
  assert.equal(exitCode(results), 1);
});

test('a heat profile with no temperature reading does not start', async () => {
  await assert.rejects(
    runPlan([step('a')], { profile: heatProfile(), read: () => null, runStep: () => assert.fail('ran') }),
    (error) =>
      error.name === 'MargoError' &&
      error.code === 'THERMAL_SOURCE_MISSING' &&
      /MARGO_THERMAL_FILE/.test(error.message),
  );
});

test('a temperature file drives the watch: millidegrees or degrees, a stale file reads as none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heat-')),
    file = join(dir, 'temp');
  try {
    writeFileSync(file, '71500\n');
    assert.equal(fileTemperature(file), 71.5);
    writeFileSync(file, '99\n64, 36.0\n');
    assert.equal(fileTemperature(file), 64, 'the last line is the current value');
    assert.equal(toCelsius('not a number'), null);
    const old = new Date(Date.now() - 120_000);
    utimesSync(file, old, old);
    assert.equal(fileTemperature(file), null, 'a logger that stopped is no reading');
    // The same file through the runner: pause at 85, cool to 60, resume.
    writeFileSync(file, '50\n');
    const source = thermalSource({ MARGO_THERMAL_FILE: file });
    let runs = 0;
    const results = await runPlan([step('a')], {
      profile: heatProfile(),
      pollMs: 20,
      read: source.read,
      log: () => {},
      runStep: (s, signal) => {
        runs++;
        if (runs === 1) {
          setTimeout(() => writeFileSync(file, '85000\n'), 80);
          signal.addEventListener('abort', () => setTimeout(() => writeFileSync(file, '60\n'), 80), { once: true });
          return childStep(sleepFor(20))(s, signal);
        }
        return childStep('node -e "process.exit(0)"')(s, signal);
      },
    });
    assert.equal(results[0].outcome, 'pass');
    assert.equal(results[0].pauses[0].stoppedAtC, 85);
    assert.equal(results[0].pauses[0].resumedAtC, 60);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('the hottest readable thermal zone counts; a zone that cannot be read is left out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zones-'));
  try {
    for (const [name, value] of [
      ['thermal_zone0', '27800'],
      ['thermal_zone2', '50000'],
    ]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'temp'), `${value}\n`);
    }
    mkdirSync(join(dir, 'thermal_zone1'));
    assert.equal(hottestZone(dir), 50);
    assert.equal(hottestZone(join(dir, 'missing')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coolDown never waits past its maximum', async () => {
  const t0 = performance.now(),
    cool = await coolDown({ read: () => 95, resumeC: 70, maxWaitMs: 100, pollMs: 10 });
  assert.equal(cool.resumed, false);
  assert.equal(cool.lastC, 95);
  // wall-clock: maxWaitMs 100 ended the wait; the reading never cools, so without it this waits for ever.
  assert.ok(performance.now() - t0 < 15_000);
});

test('runLimited ends the step tree when its signal aborts and says it was aborted', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const t0 = performance.now(),
    run = await runLimited(sleepFor(30), { cwd: root, limitMs: 30_000, signal: controller.signal });
  assert.equal(run.aborted, true);
  assert.equal(run.ok, false);
  assert.equal(run.timedOut, false);
  // wall-clock: the abort ended a 30 s sleep.
  assert.ok(performance.now() - t0 < 10_000);
});

test('a profile that excludes a package reports it as EXCLUDED BY PROFILE with its reason, never a silent skip', async () => {
  const profile = machineProfile({ MARGO_MACHINE_PROFILE: 'thermal-limited' }),
    tests = plan().filter((t) => t.dir === 'voxel-pathtracer' || t.label === 'animation test:gpu'),
    steps = planSteps(tests, profile),
    ran = [];
  assert.ok(tests.length >= 2);
  const results = await runPlan(steps, {
    profile: { ...profile, heat: null },
    log: () => {},
    runStep: async (s) => (ran.push(s.id), { ok: true, seconds: 0 }),
  });
  assert.deepEqual(ran, ['animation/test:gpu']);
  const excluded = results.filter((r) => r.outcome === 'excluded');
  assert.equal(excluded.length, tests.length - 1);
  for (const r of excluded) assert.match(r.reason, /^excluded by profile thermal-limited: path tracing/);
  const summary = summaryLines(results).join('\n');
  assert.match(summary, /EXCLUDED BY PROFILE {2}voxel-pathtracer test:gpu {2}\(excluded by profile thermal-limited: /);
  assert.match(summary, /excluded by profile: \d+ step\(s\)/);
  assert.equal(exitCode(results), 0, 'an exclusion is stated, not a failure');
  assert.equal(report(results, profile).json.profile, 'thermal-limited');
});

test('the laptop profile loads, has a heat watch and excludes nothing', () => {
  const profile = machineProfile({ MARGO_MACHINE_PROFILE: 'laptop' });
  assert.equal(profile.name, 'laptop');
  assert.ok(profile.heat && profile.heat.stopC === 88 && profile.heat.resumeC === 75);
  assert.equal(profile.split, true);
  assert.deepEqual(profile.exclude, {});
});

test('the default profile runs every planned test as one step, exactly as before', () => {
  const profile = machineProfile({}),
    tests = plan(),
    steps = planSteps(tests, profile);
  assert.equal(profile.name, 'workstation');
  assert.equal(profile.heat, null);
  assert.deepEqual(
    steps.map((s) => [s.label, s.command]),
    tests.map((t) => [t.label, t.command]),
  );
});

// The voxel path tracer's cases are split into package scripts (tests/voxel-pathtracer-gpu-split.test.js checks they
// cover every case once), so it has no `margo.gpuTestSteps` of its own.
test('split steps cover the whole suite: both bevel sample counts, each chain part', () => {
  const tests = plan(),
    byId = (id) => tests.find((t) => `${t.dir}/${t.script}` === id);
  const bevel = readFileSync(join(root, 'packages/voxel/tests/bevel-browser-check.mjs'), 'utf8'),
    counts = JSON.parse(/SAMPLE_COUNTS = (\[[^\]]*\])/.exec(bevel)[1]);
  for (const script of ['test:gpu:slow-compile', 'test:gpu:slow-mesh']) {
    const steps = splitSteps(byId(`voxel/${script}`));
    assert.deepEqual(
      steps.map((s) => Number(/--samples=(\d+)$/.exec(s.command)[1])),
      counts,
    );
    assert.ok(steps.every((s) => s.command.startsWith(byId(`voxel/${script}`).command)));
  }
  const chain = splitSteps(byId('voxel/test:gpu'));
  assert.deepEqual(
    chain.map((s) => s.command),
    [
      'cd ../.. && node packages/voxel/tests/render-browser-check.mjs',
      'cd ../.. && node packages/voxel/tests/bevel-browser-check.mjs',
      'cd ../.. && node packages/voxel/tests/render-lighting-browser-check.mjs',
      'cd ../.. && node packages/voxel/tests/lod-browser-check.mjs',
      'cd ../.. && node packages/voxel/tests/light-rgb-browser-check.mjs',
      'cd ../.. && node packages/voxel/tests/gpu-mesher-browser-check.mjs',
      'cd ../.. && node packages/voxel/tests/smooth-browser-check.mjs',
      'cd ../.. && node packages/voxel/tests/gi-browser-check.mjs',
    ],
  );
  assert.deepEqual(
    chain.map((s) => s.id),
    [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `voxel/test:gpu#${n}`),
  );
  assert.equal(splitSteps({ label: 'x y', command: 'npm run a || node b.mjs', dir: 'x' }).length, 1);
  // Post's browser checks: one step each, so a hot machine cools between them.
  assert.deepEqual(
    splitSteps(byId('post/test:gpu')).map((s) => s.command.replace('cd ../.. && node packages/post/test/', '')),
    [
      'image-browser.mjs',
      'outline-browser.mjs',
      'contact-shadows-browser.mjs',
      'sss-browser.mjs',
      'material-decals-browser.mjs',
      'decals-cull-browser.mjs',
      'ssr-rough-browser.mjs',
      'ssgi-bounce-browser.mjs',
      'anamorphic-browser.mjs',
      'blur-browser.mjs',
    ],
  );
});

test('profiles are chosen by name, are checked, and hold no machine names or home paths', () => {
  const data = readProfiles(),
    text = readFileSync(PROFILES_FILE, 'utf8');
  assert.ok(['workstation', 'mini-pc', 'laptop', 'thermal-limited'].every((n) => data.profiles[n]));
  assert.doesNotMatch(text, /\/home\/|[A-Z]:\\\\|~\/|Users/);
  for (const profile of Object.values(data.profiles))
    if (profile.heat) assert.ok(profile.heat.maxWaitMin > 0 && profile.heat.resumeC < profile.heat.stopC);
  assert.throws(
    () => machineProfile({ MARGO_MACHINE_PROFILE: 'nope' }),
    (error) => error.code === 'MACHINE_PROFILE_UNKNOWN' && /one of workstation/.test(error.message),
  );
  const dir = mkdtempSync(join(tmpdir(), 'profiles-')),
    file = join(dir, 'p.json');
  try {
    writeFileSync(
      file,
      JSON.stringify({
        default: 'a',
        profiles: {
          a: { heat: { stopC: 70, resumeC: 75, maxWaitMin: 5, maxResumesPerStep: 1, pollS: 5 } },
        },
      }),
    );
    assert.throws(
      () => readProfiles(file),
      (error) => error.code === 'MACHINE_PROFILES_INVALID' && /resumeC/.test(error.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
