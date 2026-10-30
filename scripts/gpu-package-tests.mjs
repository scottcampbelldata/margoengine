// Every real-GPU browser test, once (`npm run check:gpu-packages`, part of `npm run check:merge`): each package's
// `test:*browser*` and `test:*gpu*` scripts plus the root browser suites in ROOT, after one `npm run build:packages`
// (a package script's leading `npm run build && ` is dropped: build:packages already ran every package's build).
// Package scripts are found by name, so a new one runs with no edit here. A root script named like a browser or GPU
// test must be in ROOT, run by check:merge itself, or repeat a command run here; otherwise this check fails before it
// runs anything, naming the script.
// Options: --no-build (dist is current), --only=<substring> (run matching tests), --select=<id>,<id> (run exactly these:
// `<dir>/<script>` or `root/<script>`, see testId; check:merge passes the ones a change affects), --list (print the plan).
// Every test has a hard time limit (10 min; MARGO_GPU_TEST_TIMEOUT_MIN, or "margo": { "gpuTestTimeoutMinutes": n } in the
// package's package.json): a hung test has its whole process tree killed, is named in the output and fails the step.
// Holds one shared slot of the GPU lock (scripts/gpu-lock.mjs, up to 3 at once) for its shared tests; a timing test (one whose file
// asks for the GPU exclusively, see lockMode) runs after them as its own step under its own exclusive hold, released
// after it. Each test's result and time go to
// test-results/gpu-packages.json. A test that fails while the Windows event log shows a GPU driver reset runs once more
// (scripts/support/driver-resets.mjs, bug 25); the reset and the rerun are printed and kept in that file, never hidden:
// a run that passed only that way ends with a "PASSED WITH A DRIVER RESET" line per test and the file's top-level
// `passedAfterDriverReset` is true (the file is `{ profile, passedAfterDriverReset, results }`).
// Machine profiles (MARGO_MACHINE_PROFILE, scripts/support/machine-profiles.json, item 57.1a): a profile can leave
// packages out (each reported as EXCLUDED BY PROFILE with its stated reason, never a silent skip), run heavy suites as
// short steps, and watch the temperature: at the profile's stop temperature the running step's process tree is ended,
// the GPU lock is released, the run waits (at most the profile's maximum) for the resume temperature and runs that same
// step again, then goes on. Each pause is reported as PAUSED FOR HEAT with the step, the peak, stop and resume
// temperatures and the time waited; a wait that runs out, or a step that keeps reaching the stop, is PAUSED FOR HEAT:
// NOT RESUMED with the reason. A run with no failure but a heat stop it did not resume from exits 75 (the heat guard's
// code), never 1. The default profile has no heat watch and runs every test as one step, as before.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { margoError } from '../packages/shared/errors.js';
import { exitOnHelp } from './support/help.mjs';
import { acquire, lockDir } from './gpu-lock.mjs';
import { describeResets, passedAfterResetLines, retryAfterDriverReset } from './support/driver-resets.mjs';
import { coolDown, thermalSource, watchHeat } from './support/heat.mjs';
import { describeProfile, excludedReason, machineProfile } from './support/machine-profile.mjs';
import { packageMinutes, runLimited, testLimitMs } from './support/run-limited.mjs';

const root = resolve(import.meta.dirname, '..');
const json = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));

/** Root suites run here. */
export const ROOT = {
  'modern:test:browser': 'WebGL2 and WebGPU modern pages, starters and wrappers',
  'modern:test:browser:slow-compile': 'the same with every pipeline 300 ms slower (a slow driver compiler)',
  'modern:test:xr:browser': 'simulated XR stereo pixels',
  'modern:test:usdz:browser': 'USDZ textures and the file-picker demo',
  'modern:test:postfx:browser': 'DOF and tonemapping pixels',
  'test:docs:browser': 'README quickstart and the task guides, run as written',
  'test:modules:browser': 'Margo modules and FBX playback',
  'test:catalog:browser': 'catalog layout, clicks and clipboard',
  'test:lifecycle:browser': 'background tab, no WebGPU, fractional zoom and device loss on the stage and React',
  'test:python:browser': 'the margoengine Python package in JupyterLab and Notebook 7, camera events and to_png',
  'test:frame-alloc:browser': 'JavaScript heap bytes of a steady-state frame, per scene, against their floors',
};
/** Commands a root suite needs first (it reads their output), run once before it. */
export const PREPARE = {
  'modern:test:browser': [
    'npm run build --workspace @margoengine/starter-vite',
    'npm run build --workspace @margoengine/starter-next',
  ],
  'modern:test:browser:slow-compile': [
    'npm run build --workspace @margoengine/starter-vite',
    'npm run build --workspace @margoengine/starter-next',
  ],
  'modern:test:usdz:browser': ['npm run modern:test:usdz'],
};
/**
 * What `npm run check:merge` runs when this runner changes (scripts/support/file-classes.mjs RUNNER): the runner does
 * not change what a test draws, and its planning, limits, lock modes and heat guard are pinned by unit tests
 * (heat-containment, gpu-timing-lock, voxel-pathtracer-gpu-split), so one real test of each kind it treats
 * differently runs, plus every test the change affects through packages. Kinds (tests/check-merge-affected.test.js
 * checks each is here): a shared package test that splits into steps (shader test:gpu), the exclusive timing test,
 * which also has a per-script time limit (biomes test:gpu:flythrough, the only one), a split suite (voxel test:gpu), a
 * root suite (lifecycle) and a root suite with PREPARE commands (usdz).
 */
export const RUNNER_SMOKE = [
  'shader/test:gpu',
  'biomes/test:gpu:flythrough',
  'voxel/test:gpu',
  'root/test:lifecycle:browser',
  'root/modern:test:usdz:browser',
];
/** Browser scripts under packages/ that are tools, not tests (the guard below skips them). */
const TOOLS = {
  'packages/voxel-pathtracer/tests/magicavoxel/mv-vox.mjs': 'renders .vox files for a side-by-side comparison',
  'packages/webgl2-compat/scripts/capabilities.mjs':
    'prints the WebGL2 report of every installed browser and ANGLE back end (test:browser checks the default one)',
  'packages/webgl2-compat/test/perf-browser.mjs':
    'times the M7 performance matrix with the GPU held exclusively (test:gpu checks the same scenes for pixels)',
};
/** A file that drives a real browser (Playwright, or scripts/browser.js's openBrowser). */
const DRIVES_BROWSER =
  /\bopenBrowser\(|\bchromium\.launch\(|\blaunchBrowser\(|\bchromiumLaunchOptions\(|from '@playwright\/test'|from 'playwright'/;

/** A package script this check runs: `test:browser`, `test:browser:walk`, `test:probes:browser`, `test:gpu`, ... */
export const isGpuScript = (name) => /^test:/.test(name) && /(^|:)(browser|gpu)(:|$)/.test(name);

/** A test's stable id: `dof/test:browser` for a package script, `root/modern:test:xr:browser` for a root suite. */
export const testId = (test) => (test.name ? `root/${test.name}` : test.label.replace(' ', '/'));

/** [{ label, cwd, command }] in run order: packages by directory, then ROOT. Throws on an unrun root script. */
export function plan() {
  const tests = [];
  for (const dir of readdirSync(join(root, 'packages')).sort()) {
    const file = `packages/${dir}/package.json`;
    if (!existsSync(join(root, file))) continue;
    for (const [name, script] of Object.entries(json(file).scripts ?? {})) {
      if (!isGpuScript(name)) continue;
      const command = script.replace(/^npm run build && /, '');
      if (/\bnpm run build\b/.test(command))
        throw new Error(`${file} "${name}" builds after its start (${script}); begin it with "npm run build && "`);
      tests.push({
        label: `${dir} ${name}`,
        cwd: `packages/${dir}`,
        command,
        minutes: packageMinutes(json(file).margo?.gpuTestTimeoutMinutes, name),
        dir,
        script: name,
        ...(json(file).margo?.gpuTestSteps?.[name] && { steps: json(file).margo.gpuTestSteps[name] }),
      });
    }
  }
  const scripts = json('package.json').scripts;
  const merge = scripts['check:merge:steps'] ?? '';
  const commands = new Set([...tests.map((t) => t.command), ...Object.keys(ROOT).map((n) => scripts[n])]);
  const unrun = Object.keys(scripts).filter(
    (name) =>
      /(^|:)(browser|gpu)(:|$)/.test(name) &&
      !(name in ROOT) &&
      !merge.split(' && ').includes(`npm run ${name}`) &&
      !commands.has(scripts[name]),
  );
  if (unrun.length)
    throw new Error(
      `root script(s) ${unrun.join(', ')} look like GPU tests but no check runs them; add each to ROOT in scripts/gpu-package-tests.mjs or to check:merge:steps`,
    );
  for (const name of Object.keys(ROOT)) {
    if (!scripts[name]) throw new Error(`ROOT lists ${name}, which package.json no longer has; remove it from ROOT`);
    tests.push({ label: `root ${name}`, cwd: '.', command: `npm run ${name}`, name, dir: 'root', script: name });
  }
  // A timing test takes the GPU exclusively itself; it runs as its own step under the exclusive hold, never in a
  // shared slot beside other suites (or its measurements carry their load).
  for (const test of tests) {
    const files = (test.name ? scriptFiles('.', scripts[test.name]) : scriptFiles(test.cwd, test.command)).filter(
      (file) => existsSync(join(root, file)),
    );
    if (lockMode(test.label, files, (file) => readFileSync(join(root, file), 'utf8')) === 'exclusive')
      test.exclusive = true;
  }

  // Every file under packages/*/{test,tests,scripts} that drives a browser must be run by one of these commands (or by
  // a check:merge script): a GPU test with no script is the gap this check closes.
  const run = new Set();
  const merged = merge
    .split(' && ')
    .map((part) => /^npm run (\S+)/.exec(part)?.[1])
    .filter((name) => scripts[name])
    .map((name) => ({ cwd: '.', command: scripts[name] }));
  for (const { cwd, command } of [...tests.filter((t) => !t.name), ...merged])
    for (const file of scriptFiles(cwd, command)) run.add(file);
  // A check:merge step runs outside this check's hold and takes its own lock: a timing test there asks for the GPU
  // exclusively itself, and must not share its step with other checks either (this throws when one does).
  mergeTimingSteps();
  const files = browserFiles();
  // A test that takes test-results/gpu.lock by hand waits forever inside this check's own hold.
  const ownLock = files.filter((file) => {
    const text = readFileSync(join(root, file), 'utf8');
    return text.includes('gpu.lock') && !text.includes('gpu-lock.mjs');
  });
  if (ownLock.length)
    throw new Error(
      `${ownLock.join(', ')} take(s) the GPU lock by hand; use acquire() from scripts/gpu-lock.mjs, which runs inside a holder`,
    );
  const unrunFiles = files.filter((file) => !run.has(file) && !(file in TOOLS));
  if (unrunFiles.length)
    throw new Error(
      `${unrunFiles.join(', ')} drive(s) a browser but no script this check runs starts it; add a "test:browser" or "test:gpu" script to the owning package (or list a tool in TOOLS)`,
    );
  return tests;
}

/** Repo-relative .js/.mjs files a script command runs with node, following `cd` (paths with '/'). */
function scriptFiles(cwd, command) {
  const files = [];
  let dir = cwd;
  const tokens = command.split(/\s+/);
  tokens.forEach((token, i) => {
    if (token === 'cd' && tokens[i + 1]) dir = join(dir, tokens[i + 1]);
    else if (/\.m?js$/.test(token) && tokens[i - 1] !== 'cd')
      files.push(relative(root, resolve(root, dir, token)).replaceAll('\\', '/'));
  });
  return files;
}

/** A timing test: its file awaits an exclusive hold of the GPU from scripts/gpu-lock.mjs's acquire, mode exclusive. */
export const TIMING_TEST = /\bawait acquire\(\{[^}]*\bmode:\s*['"]exclusive['"]/;

/**
 * The GPU lock mode a planned test runs under: 'exclusive' when the files it runs are timing tests (TIMING_TEST),
 * else 'shared'. A test whose files mix a timing test with other checks throws GPU_TIMING_TEST_SHARED: in one step the
 * other checks would hold the exclusive GPU for nothing, or the timing test would run in a shared slot. `read(file)`
 * gives a repo-relative file's text.
 */
export function lockMode(label, files, read) {
  const texts = files.map((file) => [file, read(file)]);
  const timing = texts.filter(([, text]) => TIMING_TEST.test(text)).map(([file]) => file);
  if (!timing.length) return 'shared';
  const others = texts.map(([file]) => file).filter((file) => !timing.includes(file));
  if (others.length)
    throw margoError(
      'GPU_TIMING_TEST_SHARED',
      `${label} runs the timing test ${timing.join(', ')} in one step with ${others.join(', ')}; give the timing test a script of its own (for example "test:gpu:<name>") so it runs alone under the exclusive GPU lock`,
    );
  return 'exclusive';
}

/**
 * The timing tests among the check:merge steps (each `npm run <name>` of check:merge:steps whose files ask for the GPU
 * exclusively): `[{ label, files }]`. Throws GPU_TIMING_TEST_SHARED for a step that runs a timing test together with
 * other checks.
 */
export function mergeTimingSteps() {
  const scripts = json('package.json').scripts,
    readText = (file) => readFileSync(join(root, file), 'utf8');
  return (scripts['check:merge:steps'] ?? '')
    .split(' && ')
    .map((part) => /^npm run (\S+)/.exec(part)?.[1])
    .filter((name) => scripts[name])
    .flatMap((name) => {
      const label = `check:merge ${name}`,
        files = scriptFiles('.', scripts[name]).filter((file) => existsSync(join(root, file)));
      return lockMode(label, files, readText) === 'exclusive' ? [{ label, files }] : [];
    });
}

/** Files under packages/<dir>/{test,tests,scripts}/ (not node tests) that open a browser. */
function browserFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'fixtures') walk(path);
      } else if (/\.m?js$/.test(entry.name) && !entry.name.endsWith('.test.js')) {
        if (DRIVES_BROWSER.test(readFileSync(join(root, path), 'utf8'))) found.push(path);
      }
    }
  };
  for (const pkg of readdirSync(join(root, 'packages')))
    for (const sub of ['test', 'tests', 'scripts'])
      if (existsSync(join(root, 'packages', pkg, sub))) walk(`packages/${pkg}/${sub}`);
  return found.sort();
}

/**
 * What a run writes to test-results/gpu-packages.json and the warning lines it ends with. A run in which every test
 * that ran passed, but some only on their rerun after a logged GPU driver reset, has `passedAfterDriverReset: true` and
 * one "PASSED WITH A DRIVER RESET" line per such test; a clean pass or a failed run has false and no lines. Tests a
 * profile excluded, or a heat stop left unrun, do not count as runs here (their outcome says what happened).
 */
export function report(results, profile) {
  const ran = results.filter((r) => r.outcome !== 'excluded' && r.outcome !== 'not-run');
  const warnings = ran.every((r) => r.ok) ? passedAfterResetLines(ran) : [];
  return {
    json: { ...(profile && { profile: profile.name }), passedAfterDriverReset: warnings.length > 0, results },
    warnings,
  };
}

// A chain part that can run as its own step: a `cd` or one `node <file>` with plain arguments.
const SIMPLE_PART = /^(cd \S+|node \S+\.m?js(?: [^\s&|;<>]+)*)$/;

/**
 * The short steps one planned test runs as on a profile with `split` (item 57.1a). A package script that is a chain of
 * plain `node <file>` commands joined by ` && ` runs one step per command (each keeps the chain's `cd`); a script with
 * `"margo": { "gpuTestSteps": { "<script>": ["<args>", ...] } }` in its package.json runs once per entry with those
 * arguments appended, which together cover what the script runs with none. Every other test is one step. Each step
 * is `{ ...test, label, command, id, part: [i, n] }`; the assertions are the script's own, unchanged.
 */
export function splitSteps(test) {
  const one = { ...test, id: testId(test), part: [1, 1] };
  const many = (commands, names) =>
    commands.map((command, i) => ({
      ...test,
      command,
      label: `${test.label} [${i + 1}/${commands.length}] ${names[i]}`,
      id: `${testId(test)}#${i + 1}`,
      part: [i + 1, commands.length],
    }));
  if (test.steps) {
    if (!Array.isArray(test.steps) || !test.steps.length || test.steps.some((a) => typeof a !== 'string' || !a.trim()))
      throw margoError(
        'GPU_TEST_STEPS_INVALID',
        `${test.label}: "margo.gpuTestSteps" must be a list of argument strings that together cover the whole script; fix packages/${test.dir}/package.json`,
      );
    return many(
      test.steps.map((args) => `${test.command} ${args}`),
      test.steps,
    );
  }
  const parts = test.command.split(' && ').map((part) => part.trim());
  if (!parts.every((part) => SIMPLE_PART.test(part))) return [one];
  const commands = [],
    names = [],
    cds = [];
  for (const part of parts) {
    if (part.startsWith('cd ')) cds.push(part);
    else {
      commands.push([...cds, part].join(' && '));
      names.push(basename(part.split(' ')[1]));
    }
  }
  return commands.length > 1 ? many(commands, names) : [one];
}

/**
 * The steps in run order: every shared step first, then the timing steps (`exclusive`), each in plan order, so the run
 * gives up its shared slot once and the timing steps wait for the GPU alone at the end, not in the middle of the run.
 */
export const lockOrder = (steps) => [...steps.filter((s) => !s.exclusive), ...steps.filter((s) => s.exclusive)];

/** The steps a profile runs, in plan order: excluded tests stay in the list with their stated reason. */
export function planSteps(tests, profile) {
  return tests.flatMap((test) => {
    const reason = excludedReason(profile, test.dir ?? test.label.split(' ')[0], test.script ?? test.name);
    if (reason) return [{ ...test, id: testId(test), part: [1, 1], excluded: reason }];
    return profile.split ? splitSteps(test) : [{ ...test, id: testId(test), part: [1, 1] }];
  });
}

const times = (n) => (n === 1 ? 'once' : `${n} times`);
/** One heat pause in words: peak, stop, reason and how the wait ended (also used by scripts/check-merge.mjs). */
export const pauseText = (p) =>
  `peak ${p.peakC ?? '?'} C, stopped at ${p.stoppedAtC ?? '?'} C (${p.reason}), ${
    p.resumed
      ? `resumed at ${p.resumedAtC} C after ${p.waitedS} s`
      : p.waitedS === undefined
        ? 'no wait'
        : `not resumed after ${p.waitedS} s`
  }`;

/**
 * Runs the steps in order and resolves one result per step, each with `outcome`: 'pass', 'fail', 'excluded' (with
 * `reason`), 'heat-not-resumed' (with `reason`) or 'not-run' (with `reason`), and `pauses` (each heat pause: peak,
 * stop and resume temperatures, seconds waited). `runStep(step, signal)` runs one step and resolves `{ ok, seconds,
 * aborted? }`; it must end the step when `signal` aborts. `read()` gives degrees C or null (scripts/support/heat.mjs);
 * `take(mode, step)` takes the GPU lock in `mode` ('shared', or 'exclusive' for a step with `exclusive`, a timing
 * test) and resolves its release, which is called before every cooldown and taken again after, so the lock is never
 * held while waiting for heat; the run switches holds between a shared step and an exclusive one. A heat profile with no reading at the start throws
 * THERMAL_SOURCE_MISSING: a run that cannot watch its temperature does not start. `pollMs` overrides the profile's
 * sample interval (tests).
 */
export async function runPlan(
  steps,
  { profile, runStep, read = () => null, take = async () => () => {}, log = console.log, pollMs } = {},
) {
  const heat = profile.heat,
    poll = pollMs ?? (heat ? heat.pollS * 1000 : 0),
    results = [];
  if (heat && read() === null)
    throw margoError(
      'THERMAL_SOURCE_MISSING',
      `machine profile ${profile.name} watches the temperature but no reading could be had; set MARGO_THERMAL_FILE to a file holding the current temperature, or run on a machine with /sys/class/thermal zones`,
    );
  // A timing step (`exclusive`) runs under its own exclusive hold of the GPU, taken just before it and released just
  // after; every other step runs under the shared hold. take(mode, step) resolves the release of a hold in that mode.
  const modeOf = (step) => (step?.exclusive ? 'exclusive' : 'shared');
  let held = modeOf(steps.find((s) => !s.excluded)),
    release = await take(
      held,
      steps.find((s) => !s.excluded),
    ),
    stopped = null;
  const hold = async (step) => {
    if (modeOf(step) === held) return;
    release();
    release = () => {};
    held = modeOf(step);
    release = await take(held, step);
  };
  // Releases the GPU lock, waits (bounded) for the resume temperature, and takes the lock again if it came.
  const coolFor = async (step, pause) => {
    release();
    release = () => {};
    log(
      `\nPAUSED FOR HEAT: ${step.label}: ${pause.reason}; peak ${pause.peakC ?? '?'} C. GPU lock released; waiting at most ${heat.maxWaitMin} min for below ${heat.resumeC} C`,
    );
    const cool = await coolDown({ read, resumeC: heat.resumeC, maxWaitMs: heat.maxWaitMin * 60_000, pollMs: poll });
    Object.assign(pause, {
      resumeC: heat.resumeC,
      waitedS: cool.waitedS,
      resumed: cool.resumed,
      resumedAtC: cool.lastC,
    });
    if (cool.resumed) {
      log(`RESUMED: ${step.label} at ${cool.lastC} C after ${cool.waitedS} s; running this step again from its start`);
      release = await take(held, step);
    } else
      pause.notResumed = `still ${cool.lastC ?? 'unreadable'} C after the maximum wait of ${heat.maxWaitMin} min (lowest ${cool.lowestC ?? 'unreadable'} C; resume needs below ${heat.resumeC} C)`;
    return cool.resumed;
  };
  try {
    for (const step of steps) {
      if (step.excluded) {
        results.push({ ...step, outcome: 'excluded', reason: step.excluded });
        continue;
      }
      if (stopped) {
        results.push({ ...step, outcome: 'not-run', reason: stopped });
        continue;
      }
      await hold(step);
      const pauses = [];
      let peakC = null,
        result = null;
      while (!result) {
        // Starting hot only trips the stop at once: cool first (the same bounded wait, reported as a pause).
        const before = heat ? read() : null;
        if (heat && (before === null || before >= heat.stopC)) {
          const pause = {
            before: true,
            peakC: before,
            stoppedAtC: before,
            reason:
              before === null
                ? 'no temperature reading before the start'
                : `${before} C before the start (stop ${heat.stopC} C)`,
          };
          pauses.push(pause);
          if (!(await coolFor(step, pause))) result = { outcome: 'heat-not-resumed', reason: pause.notResumed };
          continue;
        }
        const controller = new AbortController(),
          watch = heat ? watchHeat({ read, stopC: heat.stopC, pollMs: poll, onStop: () => controller.abort() }) : null,
          run = await runStep(step, controller.signal),
          seen = watch?.stop();
        if (seen && seen.peakC !== null) peakC = Math.max(peakC ?? seen.peakC, seen.peakC);
        if (!(run.aborted && seen?.reason)) {
          result = { ...run, outcome: run.ok ? 'pass' : 'fail' };
          break;
        }
        const pause = { peakC: seen.peakC, stoppedAtC: seen.stoppedAtC, reason: seen.reason, seconds: run.seconds },
          stops = pauses.filter((p) => !p.before).length + 1;
        pauses.push(pause);
        if (stops > heat.maxResumesPerStep) {
          pause.notResumed = `this step reached the stop ${times(stops)} (at most ${heat.maxResumesPerStep} resumes per step), so it does not fit profile ${profile.name}'s thermal budget; run it on a profile that can take the load, or split it further`;
          result = { ...run, outcome: 'heat-not-resumed', reason: pause.notResumed };
        } else if (!(await coolFor(step, pause)))
          result = { ...run, outcome: 'heat-not-resumed', reason: pause.notResumed };
      }
      results.push({ ...step, ...result, ok: result.outcome === 'pass', pauses, peakC });
      // A machine that did not cool down in time runs nothing more; a step that is only too heavy stops itself.
      if (result.outcome === 'heat-not-resumed' && pauses.at(-1).resumed === false)
        stopped = `the run stopped for heat at ${step.label}: ${result.reason}`;
    }
  } finally {
    release();
  }
  return results;
}

/** 1 when any step failed, else 75 (the heat guard's code) when a heat stop was not resumed, else 0. */
export const exitCode = (results) =>
  results.some((r) => r.outcome === 'fail')
    ? 1
    : results.some((r) => r.outcome === 'heat-not-resumed' || r.outcome === 'not-run')
      ? 75
      : 0;

/** The summary lines of a run: one per step, then a count of each outcome other than a plain pass. */
export function summaryLines(results) {
  const lines = [];
  for (const r of results) {
    const heatNote = r.pauses?.length
      ? `  (paused for heat ${times(r.pauses.length)}: ${r.pauses.map(pauseText).join('; ')})`
      : r.peakC !== null && r.peakC !== undefined
        ? `  (peak ${r.peakC} C)`
        : '';
    const reset = r.driverReset ? `  (run again after a ${describeResets(r.driverReset.resets)})` : '';
    if (r.outcome === 'excluded') lines.push(`  EXCLUDED BY PROFILE  ${r.label}  (${r.reason})`);
    else if (r.outcome === 'not-run') lines.push(`  NOT RUN  ${r.label}  (${r.reason})`);
    else if (r.outcome === 'heat-not-resumed')
      lines.push(`  PAUSED FOR HEAT: NOT RESUMED  ${r.label}  (${r.reason})${heatNote}`);
    else lines.push(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}  ${r.seconds} s${reset}${heatNote}`);
  }
  const count = (outcome) => results.filter((r) => r.outcome === outcome).length,
    resumed = results.filter((r) => r.pauses?.length && (r.outcome === 'pass' || r.outcome === 'fail')).length;
  if (resumed) lines.push(`  paused for heat and resumed: ${resumed} step(s)`);
  for (const [outcome, text] of [
    ['heat-not-resumed', 'paused for heat, not resumed'],
    ['not-run', 'not run after a heat stop'],
    ['excluded', 'excluded by profile'],
  ])
    if (count(outcome)) lines.push(`  ${text}: ${count(outcome)} step(s)`);
  return lines;
}

export const USAGE = `usage: node scripts/gpu-package-tests.mjs [options]

Runs every real-GPU browser test once, after building the packages, holding shared slots of the GPU lock.

Options:
  --no-build                 dist is current; skip the package build
  --only=<substring>         run the tests whose label contains the substring
  --select=<id>,<id>         run exactly these tests; an id is <dir>/<script> or root/<script>
  --list                     print the plan and the machine profile, run nothing
  -h, --help                 print this help and exit

Example:
  node scripts/gpu-package-tests.mjs --no-build --select=sky/test:gpu,root/test:basic-scene`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  exitOnHelp(USAGE);
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
  const select = process.argv.find((a) => a.startsWith('--select='))?.slice(9);
  const chosen = select === undefined ? undefined : new Set(select.split(',').filter(Boolean));
  const tests = plan().filter((t) => (!only || t.label.includes(only)) && (!chosen || chosen.has(testId(t))));
  const unknown = chosen ? [...chosen].filter((id) => !tests.some((t) => testId(t) === id)) : [];
  if (unknown.length) throw new Error(`--select names no GPU test: ${unknown.join(', ')}; list them with --list`);
  const profile = machineProfile(),
    steps = lockOrder(planSteps(tests, profile));
  if (process.argv.includes('--list')) {
    console.log(describeProfile(profile));
    for (const s of steps)
      console.log(
        s.excluded
          ? `${s.label}: EXCLUDED BY PROFILE (${s.excluded})`
          : `${s.label}: (${s.cwd}) ${s.command}${s.exclusive ? '  [timing: exclusive GPU, own step]' : ''}`,
      );
    process.exit(0);
  }
  // Children taking this same lock run inside it; any other lock they take is still taken. In this gate a Jupyter check
  // that cannot run (no Python, no network to make its venv) fails instead of printing SKIP (python/tests/venv.mjs).
  const env = {
    ...process.env,
    MARGO_GPU_LOCK_NESTED: join(lockDir, 'nested'),
    MARGO_GPU_LOCK_NESTED_MODE: 'shared',
    MARGO_REQUIRE_JUPYTER: process.env.MARGO_REQUIRE_JUPYTER ?? '1',
  };
  const run = (command, cwd) => {
    const t0 = performance.now();
    const { status } = spawnSync(command, { cwd: join(root, cwd), shell: true, stdio: 'inherit', env });
    return { ok: status === 0, seconds: Math.round((performance.now() - t0) / 100) / 10 };
  };
  console.log(describeProfile(profile));
  // The build needs no GPU, so it runs before the lock is taken.
  if (!process.argv.includes('--no-build') && !run('npm run build:packages', '.').ok)
    throw new Error('npm run build:packages failed; fix the build first');
  const started = performance.now(),
    prepared = new Set(),
    thermal = profile.heat ? thermalSource() : null;
  if (thermal) console.log(`temperature from the ${thermal.name}`);
  const results = await runPlan(steps, {
    profile,
    read: thermal?.read,
    // A short poll: other holders often release and take the lock again within seconds. Held for the whole run (about
    // 10 min alone, 15 with another run beside it), so the hold limit is 60 min; a heat pause releases it while it waits.
    // A timing step holds the GPU exclusively for itself alone: the hold limit is its own time limit plus 5 min, the
    // heartbeat keeps it, and it is released as soon as the step ends.
    take: (mode, step) =>
      acquire({
        owner: mode === 'exclusive' ? `check:gpu-packages ${step.label}` : 'check:gpu-packages',
        mode,
        max: mode === 'exclusive' ? Math.ceil(testLimitMs(step.minutes) / 60_000) + 5 : 60,
        poll: 2000,
      }),
    runStep: async (step, signal) => {
      // Each preparing command once, however many suites need it.
      for (const command of PREPARE[step.name] ?? []) {
        if (prepared.has(command)) continue;
        if (!run(command, '.').ok) throw new Error(`${command} failed (needed by ${step.label}); fix it first`);
        prepared.add(command);
      }
      console.log(`\n=== ${step.label}`);
      const once = async () => {
        const result = await runLimited(step.command, {
          cwd: join(root, step.cwd),
          env: { ...env, MARGO_GPU_LOCK_NESTED_MODE: step.exclusive ? 'exclusive' : 'shared' },
          limitMs: testLimitMs(step.minutes),
          label: step.label,
          signal,
        });
        if (result.message) console.error(`\nHUNG: ${result.message}`);
        return result;
      };
      // A test that fails while the GPU driver resets (bug 25) runs once more; the reset and the rerun are printed. A
      // step ended by the heat watch goes back to runPlan as it is: the heat pause, not a reset, explains it.
      const first = await once();
      if (first.ok || first.aborted) return first;
      let used = false;
      return retryAfterDriverReset(step.label, async () => (used ? once() : ((used = true), first)));
    },
  });
  mkdirSync(join(root, 'test-results'), { recursive: true });
  const { json, warnings } = report(results, profile);
  writeFileSync(join(root, 'test-results/gpu-packages.json'), JSON.stringify(json, null, 2) + '\n');
  console.log(`\nGPU package tests, ${describeProfile(profile)}:`);
  for (const line of summaryLines(results)) console.log(line);
  console.log(`  total ${Math.round((performance.now() - started) / 1000)} s`);
  for (const line of warnings) console.log(`\n${line}`);
  const failed = results.filter((r) => r.outcome === 'fail'),
    code = exitCode(results);
  if (failed.length)
    console.error(`${failed.length} of ${results.length} failed: ${failed.map((r) => r.label).join(', ')}`);
  else if (code === 75)
    console.error(
      'No test failed, but a heat stop was not resumed: the run is incomplete (exit 75). Rerun the steps named above when the machine is cool, or on a profile that can take the load.',
    );
  process.exitCode = code;
}
