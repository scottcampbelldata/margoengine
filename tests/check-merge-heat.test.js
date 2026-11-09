// check:merge heat watch on every GPU step (2026-10-30). Only check:gpu-packages watched the temperature; on the
// Intel Arc laptop (profile `laptop`, stop 88 C) visual:check ran to 88.9 C with no watch, and check:views,
// check:depth, check:no-webgpu, check:wgsl, modern:test:bundlers and check:quickstart had none either. check:merge
// now runs every GPU step under the same watch (runPlan in scripts/gpu-package-tests.mjs): stop at stopC, wait
// bounded for resumeC, run that step again, at most maxResumesPerStep times, each pause in the summary. A fake thermal
// file and fake steps (tiny node processes) drive every outcome with no GPU and no real heat.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { heatWatched, NO_GPU_STEPS, runSteps, SELF_WATCHED_STEPS, summary } from '../scripts/check-merge.mjs';
import { HEAT_EXIT } from '../scripts/gpu-package-tests.mjs';
import { thermalSource } from '../scripts/support/heat.mjs';
import { machineProfile } from '../scripts/support/machine-profile.mjs';
import { runLimited } from '../scripts/support/run-limited.mjs';

const root = join(import.meta.dirname, '..');
const laptopLike = (heat = {}) => ({
  name: 'test-laptop',
  description: 'a test profile',
  split: true,
  exclude: {},
  heat: { stopC: 88, resumeC: 75, maxWaitMin: 0.02, maxResumesPerStep: 2, pollS: 5, ...heat },
});
const steps = (...names) => names.map((name) => ({ command: `npm run ${name}` }));
const noRetry = (_, fn) => fn();
const quiet = () => {};

// A thermal file the test writes, read through the real source (MARGO_THERMAL_FILE).
function thermalFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'margo-cm-heat-')),
    file = join(dir, 'temp.log');
  const set = (c) => writeFileSync(file, `${c}\n`);
  set(t);
  return { set, read: thermalSource({ MARGO_THERMAL_FILE: file }).read, done: () => rmSync(dir, { recursive: true }) };
}

// A fake step: a real child process (it would run for 20 s) that heats the thermal file to `hot` once it starts, then
// cools it to `cool` once the watch has ended its tree. Steps not in `heats` exit 0 at once.
function fakeRun(thermal, { heats = [], hot = 90, cool = 60, failing = [], record = [] } = {}) {
  return async (command, name, signal) => {
    record.push({ name, watched: Boolean(signal) });
    if (failing.includes(name)) return { ok: false, status: 1 };
    if (!heats.includes(name)) return { ok: true, status: 0 };
    thermal.set(hot);
    signal?.addEventListener('abort', () => cool !== null && thermal.set(cool), { once: true });
    return runLimited(`node -e "setTimeout(()=>{},20000)"`, { cwd: root, limitMs: 30_000, signal });
  };
}

test('a GPU step that reaches the stop is ended, waits for the resume temperature, runs again and is reported', async () => {
  const thermal = thermalFile(60),
    record = [];
  let heated = 0;
  const base = fakeRun(thermal, { heats: ['visual:check'], record });
  // The second run of visual:check stays cool and passes.
  const run = async (command, name, signal) => {
    if (name === 'visual:check' && heated++ > 0) {
      record.push({ name, watched: Boolean(signal) });
      return { ok: true, status: 0 };
    }
    return base(command, name, signal);
  };
  try {
    const t0 = performance.now();
    const { results, failed, heatStopped } = await runSteps(steps('verify', 'visual:check', 'check:views'), {
      profile: laptopLike(),
      read: thermal.read,
      run,
      log: quiet,
      pollMs: 20,
      retry: noRetry,
    });
    // wall-clock: the child runs 20 s unless the watch ends it.
    assert.ok(performance.now() - t0 < 10_000, 'the child was ended by the watch, not left to run 20 s');
    assert.equal(failed, undefined);
    assert.equal(heatStopped, undefined);
    assert.deepEqual(
      record.map((r) => r.name),
      ['verify', 'visual:check', 'visual:check', 'check:views'],
    );
    const visual = results[1];
    assert.equal(visual.ok, true);
    assert.equal(visual.pauses.length, 1);
    assert.equal(visual.pauses[0].stoppedAtC, 90);
    assert.equal(visual.pauses[0].resumed, true);
    assert.equal(visual.pauses[0].resumedAtC, 60);
    const { lines, pausedForHeat } = summary({ results, seconds: 3 });
    assert.equal(pausedForHeat, true);
    assert.match(lines.join('\n'), /PAUSED FOR HEAT during npm run visual:check once: peak 90 C, stopped at 90 C/);
    assert.match(lines.join('\n'), /ran again from its start: a stopped step is rerun, a failed one never is/);
    assert.match(lines.at(-1), /^PASSED AFTER A HEAT PAUSE in 3 s: 1 step stopped by the heat watch/);
  } finally {
    thermal.done();
  }
});
test('a step that keeps reaching the stop ends the run as PAUSED FOR HEAT: NOT RESUMED after maxResumesPerStep', async () => {
  const thermal = thermalFile(60),
    record = [];
  try {
    const { results, failed, heatStopped } = await runSteps(steps('check:views', 'check:depth'), {
      profile: laptopLike({ maxResumesPerStep: 2 }),
      read: thermal.read,
      run: fakeRun(thermal, { heats: ['check:views'], record }),
      log: quiet,
      pollMs: 20,
      retry: noRetry,
    });
    // Two resumes, then the third stop is final: three runs, and check:depth never starts.
    assert.deepEqual(
      record.map((r) => r.name),
      ['check:views', 'check:views', 'check:views'],
    );
    assert.equal(failed, undefined);
    assert.equal(heatStopped, 'npm run check:views');
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].pauses.length, 3);
    assert.match(results[0].heatNotResumed, /reached the stop 3 times \(at most 2 resumes per step\)/);
    const { lines } = summary({ results, heatStopped, seconds: 4 });
    assert.ok(lines.some((l) => l.startsWith('PAUSED FOR HEAT: NOT RESUMED npm run check:views (this step reached')));
    assert.match(lines.at(-1), /^PAUSED FOR HEAT: NOT RESUMED at npm run check:views in 4 s: no step failed.*exit 75/);
    assert.ok(!lines.some((l) => l.startsWith('PASSED') || l.startsWith('FAILED')));
  } finally {
    thermal.done();
  }
});

test('a cooldown that runs out is reported as not resumed, never a pass, a failure or a skip', async () => {
  const thermal = thermalFile(60),
    record = [];
  try {
    const { results, heatStopped } = await runSteps(steps('check:wgsl', 'check:quickstart'), {
      profile: laptopLike({ maxWaitMin: 0.002 }),
      read: thermal.read,
      run: fakeRun(thermal, { heats: ['check:wgsl'], cool: null, record }),
      log: quiet,
      pollMs: 20,
      retry: noRetry,
    });
    assert.equal(heatStopped, 'npm run check:wgsl');
    assert.equal(record.length, 1);
    assert.equal(results[0].pauses[0].resumed, false);
    assert.match(results[0].heatNotResumed, /still 90 C after the maximum wait/);
  } finally {
    thermal.done();
  }
});

test('a step that fails on its own is a failure and is not rerun for heat (no retry until green)', async () => {
  const thermal = thermalFile(60),
    record = [];
  try {
    const { results, failed, heatStopped } = await runSteps(steps('modern:test:bundlers', 'check:quickstart'), {
      profile: laptopLike(),
      read: thermal.read,
      run: fakeRun(thermal, { failing: ['modern:test:bundlers'], record }),
      log: quiet,
      pollMs: 20,
      retry: noRetry,
    });
    assert.deepEqual(record, [{ name: 'modern:test:bundlers', watched: true }]);
    assert.equal(failed, 'npm run modern:test:bundlers');
    assert.equal(heatStopped, undefined);
    assert.equal(results[0].pauses, undefined);
    assert.equal(
      summary({ results, failed, seconds: 1 }).lines.at(-1),
      'FAILED at npm run modern:test:bundlers in 1 s',
    );
  } finally {
    thermal.done();
  }
});

test('check:gpu-packages is not watched twice; its exit 75 is an unresumed heat stop, and no-GPU steps are not watched', async () => {
  const thermal = thermalFile(60),
    record = [];
  try {
    const run = async (command, name, signal) => {
      record.push({ name, watched: Boolean(signal) });
      return name === 'check:gpu-packages' ? { ok: false, status: HEAT_EXIT } : { ok: true, status: 0 };
    };
    const { results, failed, heatStopped } = await runSteps(
      steps('verify', 'check:fresh-clone', 'build:site', 'check:gpu-packages', 'check:depth'),
      { profile: laptopLike(), read: thermal.read, run, log: quiet, pollMs: 20, retry: noRetry },
    );
    assert.deepEqual(record, [
      { name: 'verify', watched: false },
      { name: 'check:fresh-clone', watched: false },
      { name: 'build:site', watched: true },
      { name: 'check:gpu-packages', watched: false },
    ]);
    assert.equal(failed, undefined);
    assert.equal(heatStopped, 'npm run check:gpu-packages');
    assert.match(results.at(-1).heatNotResumed, /exit 75/);
  } finally {
    thermal.done();
  }
});

test('the workstation profile (heat null) runs every step as before: no watch, no reading, no heat lines', async () => {
  const workstation = machineProfile({ MARGO_MACHINE_PROFILE: 'workstation' });
  assert.equal(workstation.name, 'workstation');
  assert.equal(workstation.heat, null);
  const record = [];
  let reads = 0;
  const { results, failed, heatStopped } = await runSteps(steps('verify', 'visual:check', 'check:gpu-packages'), {
    profile: workstation,
    read: () => (reads++, 99),
    run: async (command, name, signal) => (record.push({ name, watched: Boolean(signal) }), { ok: true, status: 0 }),
    log: quiet,
    retry: noRetry,
  });
  assert.equal(reads, 0);
  assert.ok(record.every((r) => !r.watched));
  assert.equal(failed ?? heatStopped, undefined);
  assert.ok(results.every((r) => r.ok && !r.pauses));
  assert.deepEqual(summary({ results, seconds: 2 }), {
    passedAfterDriverReset: false,
    pausedForHeat: false,
    lines: ['PASSED in 2 s'],
  });
});

test('every check:merge step that drives the GPU is heat-watched by check:merge or by itself', () => {
  const names = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    .scripts['check:merge:steps'].split(' && ')
    .map((c) => /^npm run (\S+)/.exec(c)[1]);
  for (const name of [...NO_GPU_STEPS, ...SELF_WATCHED_STEPS])
    assert.ok(names.includes(name), `${name} is not a check:merge step any more; update the list in check-merge.mjs`);
  for (const name of [
    'build:site',
    'visual:check',
    'check:views',
    'check:depth',
    'check:wgsl',
    'check:no-webgpu',
    'modern:test:packages',
    'modern:test:bundlers',
    'check:quickstart',
  ])
    assert.ok(heatWatched(name), `${name} drives the GPU and must be heat-watched`);
  assert.equal(heatWatched('check:gpu-packages'), false);
});

test('check:merge always runs the complete CPU font and mesh regression suite', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(root, 'packages/text/package.json'), 'utf8'));
  assert.ok(manifest.scripts['check:merge:steps'].split(' && ').includes('npm run check:text-extrude'));
  assert.ok(manifest.scripts['check:text-extrude'].includes('packages/text/tests/extrude*.test.js'));
  assert.ok(pkg.scripts.test.includes('tests/extrude*.test.js'));
  assert.equal(heatWatched('check:text-extrude'), false);
});

test('check:merge always covers the test-page contract and road fold regression classes', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.ok(manifest.scripts['check:merge:steps'].split(' && ').includes('npm run check:testpage-contracts'));
  for (const path of [
    'procedural/test/testpage',
    'water/test/testpage',
    'wfc/test/testpage',
    'animation/tests/testpage',
    'voxel-edit/tests/testpage-contracts',
  ])
    assert.ok(manifest.scripts['check:testpage-contracts'].includes(path));
  assert.ok(manifest.scripts['check:road-invariants'].includes('packages/road/test/testpage.test.js'));
  assert.equal(heatWatched('check:testpage-contracts'), false);
});
