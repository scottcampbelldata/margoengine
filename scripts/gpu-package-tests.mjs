import { deferSpeed, reportSpeedPhase, speedEnabled } from './support/speed-phase.mjs';
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
// Tests run directly on the GPU, each under its own hard time limit (Scott, 2026-11-16). Each test's result and time
// go to test-results/gpu-packages.json. A test that fails while the Windows event log shows a GPU driver reset runs once
// more (scripts/support/driver-resets.mjs, bug 25); the reset and the rerun are printed and kept in that file, never hidden:
// a run that passed only that way ends with a "PASSED WITH A DRIVER RESET" line per test and the file's top-level
// `passedAfterDriverReset` is true (the file is `{ profile, passedAfterDriverReset, results }`).
// Machine profiles (MARGO_MACHINE_PROFILE, scripts/support/machine-profiles.json, item 57.1a): a profile can leave
// packages out (each reported as EXCLUDED BY PROFILE with its stated reason, never a silent skip), run heavy suites as
// short steps, and watch the temperature: at the profile's stop temperature the running step's process tree is ended,
// the run waits (at most the profile's maximum) for the resume temperature and runs that same
// step again, then goes on. Each pause is reported as PAUSED FOR HEAT with the step, the peak, stop and resume
// temperatures and the time waited; a wait that runs out, or a step that keeps reaching the stop, is PAUSED FOR HEAT:
// NOT RESUMED with the reason. A run with no failure but a heat stop it did not resume from exits 75 (the heat guard's
// code), never 1. The workstation profile has no heat watch and runs every test as one step, as before. With
// MARGO_MACHINE_PROFILE unset the profile is matched by hardware (scripts/support/machine-profile.mjs); a machine no
// profile matches stops here before any GPU work, never falls back to one.
// Side by side (--parallel or MARGO_CHECK_PARALLEL=1; --serial or MARGO_CHECK_SERIAL=1 and every heat or split profile
// run one at a time): the same tests under scripts/support/parallel-run.mjs, longest first, none beside another with
// the same fixed port or output (scripts/support/suite-resources.mjs), each with its log in test-results/gpu-suites/.
// The first failure stops the run, names the suite and prints its log; a serial run goes on to the end and reports all
// failures.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { margoError } from '../packages/shared/errors.js';
import { showHelp } from './support/help.mjs';
import { DEFAULT_MINUTES } from './run-with-timeout.mjs';
import { keepGoingMode, parallelMode, runJobs, tailOf } from './support/parallel-run.mjs';
import { suiteResources } from './support/suite-resources.mjs';
import { describeResets, passedAfterResetLines, retryAfterDriverReset } from './support/driver-resets.mjs';
import { coolDown, thermalSource, watchHeat } from './support/heat.mjs';
import { describeProfile, excludedReason, machineProfile } from './support/machine-profile.mjs';
import { STEPS } from './modern-extension-suite.mjs';
import { packageMinutes, runLimited, testLimitMs } from './support/run-limited.mjs';

const root = resolve(import.meta.dirname, '..');
export const HEAT_EXIT = 75;
const json = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));

/** Root suites run here. */
export const ROOT = {
  'test:integration:browser': 'README everything scenes, both backends, device loss and disposal',
  'test:pages:browser': 'test pages driven like a user: every button, no errors, open bugs named',
  'test:composition:browser': 'C2 pairwise render-pass composition, native and WebGL2 compatibility, 1x and 4x MSAA',
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
  'modern:test:extensions':
    'glTF extension, material, parity, local shadow, picking, silent geometry, box and helper pixels',
  'modern:test:domains': 'combined rendering domains, device loss races and recovery',
  'modern:test:wrapper': 'the stage facade: quickstart bundle, orb pixels, controls, models, device and context loss',
  'modern:test:game': 'animation, shadows, clustered lights, terrain, VFX, foot IK and SSAO together',
  'modern:test:gltf-compression': 'Draco and meshopt in a production Vite consumer',
  'modern:test:sky': 'sky and fog: 1x and multisample shader parity, coverage, ownership of every shader module',
  'modern:test:finalization': 'picking races, depth precision at 500 m, 10,000-part hierarchy and device reboot',
  'test:gallery:browser':
    'the Harrow Head gallery: every page and section draws, no errors, phone layout, JavaScript off, budget, dedication',
  'test:physics2d-kernel-browsers':
    'the own 2D physics kernel in Wasm (simd128) gives the native pinned bits on a WebGPU page and a WebGL2 page',
  'test:orrery':
    'the Orrery example: production build, a picture, arms and wheels at the computed angles, fly-in, play, phone, missing model',
  'test:cabin-hearth':
    'the Cabin Hearth example by its pixels: firelit hearthstone falling off, flames over the logs, moonlit wall, lantern patch',
  'test:storm-light':
    'the Storm Light example: production build, a lit night first frame, the Storm slider, reduced motion, phone, missing model',
  'test:shot':
    'the shot tool: two renders of a small scene identical, the shot clock and seed, GPU readbacks settled, a leak caught',
};
/**
 * `test:release` suites that drive a browser yet stay out of check:merge, each with its reason. Anything else in
 * test:release that drives a browser must run in a check (unrunReleaseGates): modern:test:extensions ran nowhere but
 * there from about 2026-10-16, and by 2026-10-31 it hung and held a dozen stale checks and two real shader bugs.
 */
export const RELEASE_ONLY = {
  'modern:test:stress': '500 sessions of 120 frames, hours of GPU; the release checks it once',
  'test:basic-scene': 'the release record command measures the basic-scene network with it',
};
/**
 * Browser suites (`test:*`, `modern:test:*`) that no check runs, each with its reason (unrunBrowserSuites fails the
 * plan for any other). modern:test:sky, finalization and test:tokyo (since removed) had no check and were found passing on 2026-10-31
 * after their neighbours had rotted; they are in ROOT now.
 */
export const NOT_IN_CHECKS = {
  'modern:test:hardware':
    'needs a physical NVIDIA or AMD GPU (GPU_VENDOR=nvidia|amd), a visible window and 60 s of recording; the machines that run check:merge may have neither',
  'modern:test:blender': 'drives Blender, which Scott has not cleared for the checks (needs his go)',
};
/**
 * `scripts/*-gpu-check.js` files that no check runs, each with its reason (unrunCheckFiles fails the plan for any other).
 * Twenty-one such files were once written for one job and run by hand: nothing ran them, and five had rotted.
 */
export const LOOSE_CHECKS = {};
/**
 * Root suites that check one package's own shaders or kernels, with the packages that own them. Each owner runs the
 * suite from its own GPU script (`"test:gpu:<name>": "cd ../.. && npm run <suite>"`, PREPARE commands first), so a
 * change to that package runs it in the fast gate, which runs only the changed packages' GPU scripts; plan() folds
 * those scripts into the one root test, so a full or affected run still runs the suite once. KB-POSTFX-DOFSTALE1: from
 * 2026-11-15 the depth-of-field and tonemap changes broke modern:test:postfx:browser's hand-built bindings, and no push
 * ran it. tests/gpu-root-owners.test.js holds this map to the owners' scripts, and fails on a root suite that imports a
 * package's sources (`/packages/<name>/src/`) without that package here.
 */
export const ROOT_OWNERS = {
  'modern:test:postfx:browser': ['dof', 'tonemap'],
  'modern:test:sky': ['sky'],
  'modern:test:usdz:browser': ['usdz'],
  'modern:test:gltf-compression': ['decoders', 'gltf'],
  'test:physics2d-kernel-browsers': ['physics2d'],
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
 * not change what a test draws, and its planning, limits and heat guard are pinned by unit tests (heat-containment,
 * voxel-pathtracer-gpu-split), so one real test of each kind it treats differently runs, plus every test the change
 * affects through packages. Kinds (tests/check-merge-affected.test.js checks each is here): a package test that splits
 * into steps (shader test:gpu), a test with a per-script time limit (biomes test:gpu:flythrough, the only one), a split
 * suite (voxel test:gpu), a root suite (lifecycle) and a root suite with PREPARE commands (usdz).
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
  'packages/scenes/test/fauld-still.mjs':
    'stills of the Fauld film shots; it reads the OS Terrain 50 grid and the crater and tree models from the asset library outside git (MARGO_ASSETS), so it runs by hand per shot (--shots=fr008,...), not as a gate',
  'packages/webgl2-compat/scripts/browser-matrix.mjs':
    'the browser matrix of docs/limits.md (Safari, the iOS Simulator, Firefox, Android Chrome), not a gate: run with --browser (npm run matrix)',
  'scripts/reference-rendering/mip-blend-control.mjs':
    'raw WebGL2 and WebGPU trilinear blend control quoted by docs/known-bugs.md, not a gate; run directly',
  'packages/culling/test/gpu/compat-cost.mjs':
    'per-frame cost measurement of the WebGL2-layer culling paths for the speed phase, not a gate; run directly',
  'packages/culling/test/gpu/indirect-repro.mjs':
    'WebKit indirect-draw repro quoted by docs/known-bugs.md, not a gate: it prints differing pixels; run directly',
  'packages/gltf/scripts/draw-order-probe.mjs':
    'plain WebGPU draw-order repro quoted by docs/known-bugs.md, not a gate: it prints differing pixels; run directly',
  'packages/text/scripts/make-readme-atlas.mjs':
    'writes the documented OFL font atlas; text test:browser fetches and renders the committed atlas, generation is not a test',
  'packages/studio/scripts/rival-bench.mjs': 'contact-shadow ray reference comparison, run directly',
  'packages/sky/scripts/rival-bench.mjs': 'external sunsky radiance comparison, run directly',
  'packages/biomes/tests/gpu-region-fields-check.mjs':
    'exact-head region-fields hardware proof pinned to the RTX A6000, run directly',
  'packages/biomes/tests/gpu-fixed-lerp-check.mjs':
    'exact-head fixed-lerp hardware proof pinned to the RTX A6000, run directly',
  'packages/biomes/tests/gpu-field-integration-check.mjs':
    'exact-head field-integration hardware proof pinned to the RTX A6000, run directly',
  'packages/biomes/tests/gpu-classify-warp-check.mjs':
    'exact-head classify-warp hardware proof pinned to the RTX A6000, run directly',
  'packages/biomes/tests/gpu-classify-inputs-check.mjs':
    'exact-head classify-inputs hardware proof pinned to the RTX A6000, run directly',
  'packages/biomes/tests/gpu-placement-flow-check.mjs':
    'exact-head placement-flow hardware proof pinned to the RTX A6000, run directly',
  'packages/compute/scripts/rival-bench.mjs':
    'paired timing against TensorFlow.js WebGPU, installed outside the repository; run directly',
  'packages/sciviz/scripts/rival-bench.mjs':
    'paired volume timing against VTK.js, installed outside the repository; run directly',
  'packages/splats/scripts/truck-photo.mjs':
    'external Truck photograph comparison (data outside the repository), run directly',
  'packages/splats/scripts/rival-bench.mjs':
    'paired timing against GaussianSplats3D, installed outside the repository; run directly',
  'packages/loaders/scripts/real-files-render.mjs':
    'opt-in drawing of downloaded public files, and the Lottie frames of test:real-files, run directly by that script',
  'packages/netcode/tests/webtransport-proof/proof.mjs':
    'by-hand proof against an HTTP/3 server on the outside tool aioquic, which needs Python; run directly',
  'packages/webgl2-compat/test/metal-dropped-draw-repro.mjs':
    'raw WebGL2 repro of the ANGLE Metal dropped draw, not a gate: it prints what the browser does (test:gpu checks the fix in compute-browser.mjs scatterAfterWrite); run directly',
  'packages/sciviz/tests/webgl-long-invocation-repro.mjs':
    'raw WebGL2 repro of the ANGLE Metal draw dropped for a long single invocation, not a gate: it prints what the browser does (test:browser:aggregate checks the sliced aggregation); run directly',
  'packages/sky/test/compat-night-probe.mjs':
    'raw repro of the compat meadow difference on ANGLE Metal, not a gate: it prints the differing pixels per GLSL variant (test:gpu checks meadow in browser-check.mjs, test/compat-night-glsl.test.js pins the GLSL); run directly',
  'packages/vfx/test/bench-soft.mjs': 'benchmark of soft particles (test:gpu checks the pixels)',
  'packages/voxel-pathtracer/tests/magicavoxel/mv-vox.mjs': 'renders .vox files for a side-by-side comparison',
  'packages/webgl2-compat/scripts/capabilities.mjs':
    'prints the WebGL2 report of every installed browser and ANGLE back end (test:browser checks the default one)',
  'packages/webgl2-compat/test/perf-browser.mjs':
    'times the M7 performance matrix (test:gpu checks the same scenes for pixels)',
  'packages/culling/test/gpu/compat-cost.mjs':
    'prints draws, triangles, stalls and frame times per crowd size for docs/limits.md, asserts nothing (test:gpu checks the culled counts); run directly',
};
/** A file that drives a real browser (Playwright, or scripts/browser.js's openBrowser). */
const DRIVES_BROWSER =
  /\bopenBrowser\(|\bchromium\.launch\(|\blaunchBrowser\(|\bchromiumLaunchOptions\(|from '@playwright\/test'|from 'playwright'/;

/** Calls drive a browser; a reusable function declaration alone does not launch one. */
export const drivesBrowser = (text) =>
  DRIVES_BROWSER.test(
    text.replace(/\bfunction\s+(?:openBrowser|launchBrowser|chromiumLaunchOptions)\s*\(/g, 'function helper('),
  );

/** A package script this check runs: `test:browser`, `test:browser:walk`, `test:probes:browser`, `test:gpu`, ... */
export const isGpuScript = (name) => /^test:/.test(name) && /(^|:)(browser|gpu)(:|$)/.test(name);

/**
 * `npm run` suites of `test:release` that drive a browser (their `node <file>` matches DRIVES_BROWSER) and no check
 * runs: not in ROOT, not a check:merge step, not in RELEASE_ONLY. `read(file)` gives a file's text, or undefined.
 */
export function unrunReleaseGates(scripts, read, inChecks = ROOT, releaseOnly = RELEASE_ONLY) {
  const merge = (scripts['check:merge:steps'] ?? '').split(' && ');
  return (scripts['test:release'] ?? '')
    .split(' && ')
    .map((part) => /^npm run (\S+)/.exec(part)?.[1])
    .filter(
      (name) =>
        name &&
        !(name in inChecks) &&
        !(name in releaseOnly) &&
        !merge.includes(`npm run ${name}`) &&
        drivesBrowser(read(/^node (?:--\S+ )*(\S+\.m?js)/.exec(scripts[name] ?? '')?.[1]) ?? ''),
    );
}

/**
 * Root `test:*` / `modern:test:*` scripts that drive a browser and no check runs: not in ROOT, not a check:merge step,
 * not a copy of a ROOT command (`test:browser` is `modern:test:browser`), not a step of modern:test:extensions
 * (`covered`: its script paths), not in NOT_IN_CHECKS. test:release is not the only place a suite can rot unseen.
 */
export function unrunBrowserSuites(scripts, read, inChecks = ROOT, exempt = NOT_IN_CHECKS, covered = []) {
  const merge = (scripts['check:merge:steps'] ?? '').split(' && '),
    commands = new Set(Object.keys(inChecks).map((n) => scripts[n]));
  return Object.keys(scripts).filter((name) => {
    const file = /^node (?:--\S+ )*(\S+\.m?js)/.exec(scripts[name] ?? '')?.[1];
    return (
      /^(modern:)?test:/.test(name) &&
      file &&
      !(name in inChecks) &&
      !(name in exempt) &&
      !(name in RELEASE_ONLY) &&
      !commands.has(scripts[name]) &&
      !covered.includes(file) &&
      !merge.includes(`npm run ${name}`) &&
      drivesBrowser(read(file) ?? '')
    );
  });
}

/**
 * The `scripts/*-gpu-check.js` files no planned command names: not in `commands`, not a step of modern:test:extensions
 * (`covered`), not in LOOSE_CHECKS. unrunBrowserSuites sees npm scripts only, so a plain file is seen here.
 */
export function unrunCheckFiles(files, commands, covered = [], exempt = LOOSE_CHECKS) {
  return files.filter(
    (file) => !(file in exempt) && !covered.includes(file) && !commands.some((text) => text.includes(file)),
  );
}

/** A test's stable id: `dof/test:browser` for a package script, `root/modern:test:xr:browser` for a root suite. */
export const testId = (test) => (test.name ? `root/${test.name}` : test.label.replace(' ', '/'));

/**
 * The ROOT suite a package script only runs (`cd ../.. && npm run <suite>`, with that suite's PREPARE commands first),
 * or undefined. Such a script is the owner's way into the suite (ROOT_OWNERS), not a second test.
 */
export function rootSuiteOf(command, root = ROOT, prepare = PREPARE) {
  const rest = command.replace(/^cd \.\.\/\.\. && /, '');
  return Object.keys(root).find((name) => rest === [...(prepare[name] ?? []), `npm run ${name}`].join(' && '));
}

/**
 * Root suites a package's own GPU scripts do not reach, as `<suite>: <package> ...` lines: an owner in `owners`
 * (ROOT_OWNERS) with no script that runs the suite (rootSuiteOf), or a package whose sources (`/packages/<name>/src/`)
 * a suite's files import that is not one of its owners. `packageScripts(dir)` gives a package's scripts, `read(file)`
 * a file's text or undefined.
 */
export function unownedRootSuites({
  scripts,
  packageScripts,
  read,
  root = ROOT,
  owners = ROOT_OWNERS,
  prepare = PREPARE,
}) {
  const problems = [];
  for (const [suite, dirs] of Object.entries(owners)) {
    if (!(suite in root)) problems.push(`${suite}: in ROOT_OWNERS but not a ROOT suite`);
    for (const dir of dirs)
      if (
        !Object.entries(packageScripts(dir) ?? {}).some(
          ([name, command]) => isGpuScript(name) && rootSuiteOf(command, root, prepare) === suite,
        )
      )
        problems.push(
          `${suite}: ${dir} owns it but no GPU script of ${dir} runs it; add "test:gpu:<name>": "cd ../.. && ${[...(prepare[suite] ?? []), `npm run ${suite}`].join(' && ')}"`,
        );
  }
  for (const suite of Object.keys(root)) {
    const files = [...(scripts[suite] ?? '').matchAll(/\bnode (?:--\S+ )*(\S+\.m?js)/g)].map((m) => m[1]);
    const imported = new Set(
      files.flatMap((file) => [...(read(file) ?? '').matchAll(/\/packages\/([\w-]+)\/src\//g)].map((m) => m[1])),
    );
    for (const dir of [...imported].sort())
      if (!(owners[suite] ?? []).includes(dir))
        problems.push(`${suite}: checks ${dir}'s sources but ${dir} is not among its ROOT_OWNERS`);
  }
  return problems;
}

/** Whether `test` is picked by --only (a label, or the label of an owner's script folded into it) and --select. */
export const picked = (test, only, chosen) =>
  (!only || [test.label, ...(test.owners ?? [])].some((label) => label.includes(only))) &&
  (!chosen ||
    [testId(test), ...(test.owners ?? []).map((label) => label.replace(' ', '/'))].some((id) => chosen.has(id)));

/** [{ label, cwd, command }] in run order: packages by directory, then ROOT. Throws on an unrun root script. */
export function plan({
  compositionPackages = process.argv.find((a) => a.startsWith('--composition-packages='))?.slice(23),
} = {}) {
  const tests = [],
    owners = {};
  for (const dir of readdirSync(join(root, 'packages')).sort()) {
    const file = `packages/${dir}/package.json`;
    if (!existsSync(join(root, file))) continue;
    for (const [name, script] of Object.entries(json(file).scripts ?? {})) {
      if (!isGpuScript(name)) continue;
      const command = script.replace(/^npm run build && /, ''),
        suite = rootSuiteOf(command);
      if (suite) {
        (owners[suite] ??= []).push(`${dir} ${name}`);
        continue;
      }
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
  const orphans = unrunReleaseGates(scripts, (file) =>
    file && existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : undefined,
  );
  if (orphans.length)
    throw new Error(
      `test:release suite(s) ${orphans.join(', ')} drive a browser but no check runs them, so they rot unseen; add each to ROOT in scripts/gpu-package-tests.mjs or, with its reason, to RELEASE_ONLY`,
    );
  const loose = unrunBrowserSuites(
    scripts,
    (file) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : undefined),
    ROOT,
    NOT_IN_CHECKS,
    STEPS,
  );
  if (loose.length)
    throw new Error(
      `browser suite(s) ${loose.join(', ')} are in no check, so they rot unseen; add each to ROOT in scripts/gpu-package-tests.mjs or, with its reason, to NOT_IN_CHECKS`,
    );
  for (const name of Object.keys(ROOT)) {
    if (!scripts[name]) throw new Error(`ROOT lists ${name}, which package.json no longer has; remove it from ROOT`);
    const scope =
      name === 'test:composition:browser' && compositionPackages ? ` -- --packages=${compositionPackages}` : '';
    tests.push({
      label: `root ${name}`,
      cwd: '.',
      command: `npm run ${name}${scope}`,
      name,
      dir: 'root',
      script: name,
      ...(owners[name] && { owners: owners[name] }),
    });
  }
  const checkFiles = readdirSync(join(root, 'scripts'))
      .filter((file) => file.endsWith('-gpu-check.js'))
      .map((file) => `scripts/${file}`),
    unnamed = unrunCheckFiles(
      checkFiles,
      tests.map((test) => (test.name ? scripts[test.name] : test.command)),
      STEPS,
    );
  if (unnamed.length)
    throw new Error(
      `GPU check(s) ${unnamed.join(', ')} are in no check, so they rot unseen; name each in a package's test:gpu script or, with its reason, in LOOSE_CHECKS`,
    );
  // A timing test says so in its header (`// timing test: deferred in the build phase`): its numbers need a quiet machine,
  // so the correctness gate leaves it out until scripts/speed-phase.json says `active` (Scott, 2026-11-10).
  for (const test of tests) {
    const files = (test.name ? scriptFiles('.', scripts[test.name]) : scriptFiles(test.cwd, test.command)).filter(
      (file) => existsSync(join(root, file)),
    );
    if (files.some((file) => TIMING_TEST.test(readFileSync(join(root, file), 'utf8')))) test.timing = true;
  }

  // The check:merge scripts run browser files too; every browser test file must be reached from them or the tests.
  const merged = merge
    .split(' && ')
    .map((part) => /^npm run (\S+)/.exec(part)?.[1])
    .filter((name) => scripts[name])
    .map((name) => ({ cwd: '.', command: scripts[name] }));
  // Every browser test file (isBrowserFile: named for the browser or driving one) must be reached from what this check
  // runs: a check dropped from its package's chain is named here, with no hand-kept list (Scott, 2026-11-16).
  const starts = [
      ...tests.map((t) => (t.name ? { cwd: '.', command: scripts[t.name] } : { cwd: t.cwd, command: t.command })),
      ...merged,
    ],
    unrunFiles = unrunBrowserFiles(starts, testUniverse(), (file) => readFileSync(join(root, file), 'utf8'));
  if (unrunFiles.length)
    throw new Error(
      `${unrunFiles.join(', ')}: browser test file(s) that nothing check:gpu-packages runs reaches; add each to its package's "test:gpu" or "test:browser" chain (or, run by hand with its reason, to TOOLS)`,
    );
  return tests;
}

/** A timing test: its file says so in a header line. */
export const TIMING_TEST = /^\/\/ timing test: deferred in the build phase\s*$/m;

/**
 * Splits the steps into the shared ones and the timing ones (`timing`, from the file's header). While the speed phase is
 * deferred the timing steps are left out and each is named once as deferred (`defer(label)`); once it is active they run
 * after every shared step, one at a time, so nothing else runs beside a measurement.
 */
export function splitTiming(steps, { active = speedEnabled(), defer = deferSpeed } = {}) {
  const shared = steps.filter((s) => !s.timing),
    timing = steps.filter((s) => s.timing);
  if (!active) {
    for (const step of timing) defer(step.label);
    return { shared, timing: [] };
  }
  return { shared, timing };
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

/** A browser test file: under packages/<dir>/{test,tests,scripts}, `browser` in its name (`*-browser.mjs`, `*.browser.mjs`,
 * `browser-check.js`, a page module `*-browser.js`) or a body that drives a browser (DRIVES_BROWSER). */
export const isBrowserFile = (path, text) =>
  /^packages\/[^/]+\/(?:tests?|scripts)\/(?:.*\/)?[^/]+\.m?js$/.test(path) &&
  !/\.test\.m?js$/.test(path) &&
  !/\/fixtures\//.test(path) &&
  (/browser/i.test(path.slice(path.lastIndexOf('/') + 1)) || drivesBrowser(text));

const packageOf = (path) => /^packages\/[^/]+/.exec(path)?.[0] ?? '';
const stemOf = (path) =>
  path
    .slice(path.lastIndexOf('/') + 1)
    .replace(/\.(?:m?js|html)$/, '')
    .replace(/[-.]browser$/, '');
const uncomment = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;])\/\/.*$/gm, '$1');

/**
 * The browser test files (isBrowserFile) that nothing a check runs reaches, so they rot unseen. `commands` are
 * `{ cwd, command }` the checks run (package GPU scripts, ROOT suites, check:merge steps); `universe` every .js, .mjs and
 * .html file a run may load (package test folders, scripts/, tests/); `read(path)` its text. Reached: a file a command
 * starts with node, then, from any reached file (comments left out), a path it names (`./x.mjs`, `/packages/a/tests/b.html`,
 * a bare `b-browser.js` beside it) and, inside one package, a file whose stem (name less extension and `-browser`) is a
 * quoted word or a command argument (`--page=gi` loads `tests/gi.html` and `gi-browser.js`). Files in `exempt` (TOOLS:
 * tools run by hand, each with its reason) are not counted. No hand-kept list of tests: removing a file from its
 * package's chain makes it unreached, and this names it.
 */
export function unrunBrowserFiles(commands, universe, read, exempt = TOOLS) {
  const known = new Set(universe),
    reached = new Set(),
    queue = [],
    byStem = new Map(),
    byName = new Map();
  for (const file of universe) {
    const stem = `${packageOf(file)}:${stemOf(file)}`,
      name = file.slice(file.lastIndexOf('/') + 1);
    byStem.set(stem, [...(byStem.get(stem) ?? []), file]);
    byName.set(name, [...(byName.get(name) ?? []), file]);
  }
  const reach = (file) => {
    if (known.has(file) && !reached.has(file)) {
      reached.add(file);
      queue.push(file);
    }
  };
  const stems = (pkg, word) => {
    if (pkg) for (const file of byStem.get(`${pkg}:${word}`) ?? []) reach(file);
  };
  for (const { cwd, command } of commands) {
    for (const file of scriptFiles(cwd, command)) reach(file);
    const pkg = packageOf(cwd.replaceAll('\\', '/'));
    for (const token of command.split(/\s+/)) {
      const flag = /^--([\w-]+)(?:=([\w-]+))?$/.exec(token);
      if (flag) stems(pkg, flag[2] ?? flag[1]);
      else stems(pkg, token);
    }
  }
  while (queue.length) {
    const file = queue.pop(),
      text = uncomment(read(file) ?? ''),
      dir = file.slice(0, file.lastIndexOf('/')),
      pkg = packageOf(file);
    for (const [, name] of text.matchAll(/(?:^|[^\w./@-])((?:\.{1,2}\/|\/)?[\w@./-]*?[\w-]+\.(?:m?js|html))\b/g)) {
      if (name.startsWith('./') || name.startsWith('../'))
        reach(relative(root, resolve(root, dir, name)).replaceAll('\\', '/'));
      else if (name.startsWith('/')) reach(name.slice(1));
      else if (name.includes('/')) {
        for (const other of byName.get(name.slice(name.lastIndexOf('/') + 1)) ?? [])
          if (other === name || other.endsWith(`/${name}`)) reach(other);
      } else reach(`${dir}/${name}`);
    }
    for (const [, word] of text.matchAll(/['"`]([\w-]{2,})['"`]/g)) stems(pkg, word);
  }
  return universe.filter((file) => isBrowserFile(file, read(file) ?? '') && !reached.has(file) && !(file in exempt));
}

/**
 * Every .js, .mjs and .html file a GPU run may load: package test, tests and scripts folders, scripts/ and tests/.
 * A dot-named folder is a running test's scratch space (tests/.dev-server-watch-<pid> is made and removed while other
 * root tests plan), never a test source, so the walk does not enter it: a file removed between the walk and its read
 * failed the plan with ENOENT (KB-ROOT-RED18 part 5).
 */
export function testUniverse(base = root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(base, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist' && !entry.name.startsWith('.')) walk(path);
      } else if (/\.(?:m?js|html)$/.test(entry.name)) found.push(path);
    }
  };
  for (const pkg of readdirSync(join(base, 'packages')).sort())
    for (const sub of ['test', 'tests', 'scripts'])
      if (existsSync(join(base, 'packages', pkg, sub))) walk(`packages/${pkg}/${sub}`);
  walk('scripts');
  walk('tests');
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
 * The repo-relative files a planned step runs with node: a root suite's package.json script, else the step's own
 * command (following its `cd`); none for a step with no command.
 */
export function stepFiles(step) {
  const script = step.name && json('package.json').scripts[step.name];
  return script ? scriptFiles('.', script) : scriptFiles(step.cwd ?? '.', step.command ?? '');
}

/**
 * Why `profile` leaves a step out: its package is excluded, or it runs a file of an excluded package from another
 * package's script (webgl2-compat's test:gpu runs the path tracer's browser check with --compat), which the package's
 * own exclusion must cover too. Null when the step runs.
 */
function stepExcluded(profile, step) {
  for (const file of stepFiles(step)) {
    const dir = /^packages\/([^/]+)\//.exec(file)?.[1],
      reason = dir && dir !== step.dir && excludedReason(profile, dir, '');
    if (reason) return `${reason} (runs ${file})`;
  }
  return null;
}

/**
 * The steps a profile runs, in plan order: excluded tests stay in the list with their stated reason. A step that
 * runs a file of an excluded package is excluded as well (on a split profile only that step, else the whole test).
 */
export function planSteps(tests, profile) {
  return tests.flatMap((test) => {
    const reason = excludedReason(profile, test.dir ?? test.label.split(' ')[0], test.script ?? test.name);
    if (reason) return [{ ...test, id: testId(test), part: [1, 1], excluded: reason }];
    const steps = profile.split ? splitSteps(test) : [{ ...test, id: testId(test), part: [1, 1] }];
    return steps.map((step) => {
      const banned = stepExcluded(profile, step);
      return banned ? { ...step, excluded: banned } : step;
    });
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
 * aborted? }`; it must end the step when `signal` aborts. `read()` gives degrees C or null (scripts/support/heat.mjs).
 * `prepare(step)` runs the step's builds first and resolves null, or a result that ends the step without running it.
 * `retry(label, attempt)` may run a failed step once more (after a GPU driver reset). A heat profile with no reading
 * at the start throws THERMAL_SOURCE_MISSING: a run that cannot watch its temperature does not start. `pollMs`
 * overrides the profile's sample interval (tests).
 */
export async function runPlan(
  steps,
  {
    profile,
    runStep,
    prepare = async () => null,
    read = () => null,
    retry = (label, attempt) => attempt(),
    log = console.log,
    pollMs,
  } = {},
) {
  const heat = profile.heat,
    poll = pollMs ?? (heat ? heat.pollS * 1000 : 0),
    results = [];
  if (heat && read() === null)
    throw margoError(
      'THERMAL_SOURCE_MISSING',
      `machine profile ${profile.name} watches the temperature but no reading could be had; set MARGO_THERMAL_FILE to a file holding the current temperature, or run on a machine with /sys/class/thermal zones`,
    );
  let stopped = null;
  // Waits (bounded) for the resume temperature.
  const coolFor = async (step, pause) => {
    log(
      `\nPAUSED FOR HEAT: ${step.label}: ${pause.reason}; peak ${pause.peakC ?? '?'} C. Step ended; waiting at most ${heat.maxWaitMin} min for below ${heat.resumeC} C`,
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
    } else
      pause.notResumed = `still ${cool.lastC ?? 'unreadable'} C after the maximum wait of ${heat.maxWaitMin} min (lowest ${cool.lowestC ?? 'unreadable'} C; resume needs below ${heat.resumeC} C)`;
    return cool.resumed;
  };
  for (const step of steps) {
    {
      if (step.excluded) {
        results.push({ ...step, outcome: 'excluded', reason: step.excluded });
        continue;
      }
      if (stopped) {
        results.push({ ...step, outcome: 'not-run', reason: stopped });
        continue;
      }
      const pauses = [];
      let peakC = null,
        result = await prepare(step);
      if (result) result = { ...result, outcome: result.ok ? 'pass' : 'fail' };
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
          watch = heat ? watchHeat({ read, stopC: heat.stopC, pollMs: poll, onStop: () => controller.abort() }) : null;
        // `retry` (a rerun after a driver reset) calls the attempt again. A run ended by the heat watch is not retried:
        // the heat pause, not a reset, explains it.
        const attempt = () => runStep(step, controller.signal);
        let run;
        try {
          const first = await attempt();
          let used = false;
          run =
            first.ok || first.aborted
              ? first
              : await retry(step.label, () => (used ? attempt() : ((used = true), first)));
        } catch (error) {
          watch?.stop();
          throw error;
        }
        const seen = watch?.stop();
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
  }
  return results;
}

/** 1 when any step failed, else 75 (the heat guard's code) when a heat stop was not resumed, else 0. */
export const exitCode = (results) =>
  results.some((r) => r.outcome === 'fail')
    ? 1
    : results.some((r) => r.outcome === 'heat-not-resumed' || r.outcome === 'not-run')
      ? HEAT_EXIT
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

/**
 * Measured seconds of the suites that bound a run (a full run, 2026-10-29; the WebGL2 layer's corpus draw parts
 * 2026-11-18, KB-COMPAT-CORPUSTIME1); the last run's own times win. Others: 5 s.
 */
export const MEASURED_SECONDS = {
  'biomes test:gpu': 431,
  'voxel-pathtracer test:gpu': 271,
  'voxel test:gpu:slow-compile': 247,
  'webgl2-compat test:browser': 247,
  'voxel test:gpu': 160,
  'webgl2-compat test:gpu': 158,
  'webgl2-compat test:browser:compute-robot-planning-3': 149,
  'webgl2-compat test:browser:compute-robot-planning-2': 133,
  'webgl2-compat test:browser:compute-robot-planning-1': 123,
  'webgl2-compat test:browser:compute': 86,
  'root test:frame-alloc:browser': 83,
  'lod test:gpu': 62,
  'root test:docs:browser': 47,
  'voxel-pathtracer test:gpu:slow-compile': 45,
  'root test:python:browser': 40,
};

/**
 * The scheduler's jobs for the planned steps, not the excluded ones: each with its `resources` (`resourcesOf`: step id
 * to names) and its `estimate` (`last`: label to the seconds of the last run, then MEASURED_SECONDS, then 5).
 */
export function suiteJobs(steps, resourcesOf, last = {}) {
  return steps
    .filter((s) => !s.excluded)
    .map((s) => ({
      ...s,
      resources: resourcesOf[s.id] ?? [],
      estimate: last[s.label] ?? MEASURED_SECONDS[s.label] ?? 5,
    }));
}

/**
 * One run's time limit: the suite's own (testLimitMs), but at most DEFAULT_MINUTES (10 min, Scott 2026-11-16), so a
 * suite that runs long is ended by this runner and reported. A suite that needs longer is split into suites that each
 * fit.
 */
export const runLimitMs = (step) => Math.min(testLimitMs(step.minutes), DEFAULT_MINUTES * 60_000);

/** A step's share of a whole run's limit in minutes: its run and a rerun after a driver reset, plus its PREPARE builds. */
export const stepMinutes = (step) => 2 * DEFAULT_MINUTES + (PREPARE[step.name] ? 20 : 0);

/**
 * The longest a run of this script with `args` (its --only and --select) can take without anything hung, in minutes:
 * the sum of its steps' limits (stepMinutes), since every step is ended at its own. A caller that wraps a whole run in
 * one limit (scripts/record-wgsl-corpus.mjs) takes this, not a fixed cap that a slow GPU outgrows with nothing hung.
 */
export function runMinutes(args, tests = plan(), profile = machineProfile()) {
  const only = /--only=(\S+)/.exec(args)?.[1],
    select = /--select=(\S+)/.exec(args)?.[1],
    chosen = select && new Set(select.split(',').filter(Boolean)),
    chosenTests = tests.filter((t) => picked(t, only, chosen));
  return planSteps(chosenTests, profile)
    .filter((step) => !step.excluded)
    .reduce((sum, step) => sum + stepMinutes(step), 0);
}

/**
 * The suites side by side, each with its own log. The first failure stops the run, unless `keepGoing`: then every
 * suite runs and every failure is reported.
 */
export async function runSideBySide(steps, { env, keepGoing = false, logs = join(root, 'test-results/gpu-suites') }) {
  const record = join(root, 'test-results/gpu-packages.json'),
    scripts = json('package.json').scripts,
    last = existsSync(record)
      ? Object.fromEntries(JSON.parse(readFileSync(record, 'utf8')).results.map((r) => [r.label, r.seconds]))
      : {},
    resources = suiteResources(root, steps, { scripts, prepare: PREPARE });
  rmSync(logs, { recursive: true, force: true });
  mkdirSync(logs, { recursive: true });
  const prepared = new Map();
  const prepare = (command, logFile, signal) => {
    if (!prepared.has(command))
      prepared.set(
        command,
        runLimited(command, { cwd: root, env, limitMs: testLimitMs(), label: command, signal, logFile }),
      );
    return prepared.get(command);
  };
  const jobs = suiteJobs(steps, resources, last),
    logOf = (step) => join(logs, `${step.id.replace(/[^\w.-]+/g, '_')}.log`);
  const done = await runJobs(jobs, {
    // No limit on suites at once beyond what their resources allow.
    limit: jobs.length || 1,
    keepGoing,
    log: (line) => console.error(line),
    // A rerun after a driver reset.
    retry: async (label, attempt) => {
      const result = await retryAfterDriverReset(label, attempt);
      console.log(`${result.ok ? 'pass' : 'FAIL'}   ${label}  ${result.seconds} s`);
      return result;
    },
    // The suite's builds run before its GPU run.
    prepare: async (step, signal) => {
      const logFile = logOf(step);
      writeFileSync(logFile, `=== ${step.label}\n`);
      for (const command of PREPARE[step.name] ?? [])
        if (!(await prepare(command, logFile, signal)).ok)
          return { ok: false, log: logFile, message: `${command} failed (needed by ${step.label}); see ${logFile}` };
      return null;
    },
    run: async (step, signal) => {
      const logFile = logOf(step);
      console.log(`start  ${step.label}`);
      const result = await runLimited(step.command, {
        cwd: join(root, step.cwd),
        env,
        limitMs: runLimitMs(step),
        label: step.label,
        signal,
        logFile,
      });
      if (result.message) console.error(`\nHUNG: ${result.message}`);
      return { ...result, log: logFile };
    },
  });
  const byId = new Map(done.map((r) => [r.id, r]));
  return steps.map((s) =>
    s.excluded ? { ...s, outcome: 'excluded', reason: s.excluded } : { ...byId.get(s.id), pauses: [], peakC: null },
  );
}

export const USAGE = `usage: node scripts/gpu-package-tests.mjs [options]

Runs every real-GPU browser test once, after building the packages, each directly with a hard time limit.

Options:
  --no-build                 dist is current; skip the package build
  --only=<substring>         run the tests whose label contains the substring
  --select=<id>,<id>         run exactly these tests; an id is <dir>/<script> or root/<script>
  --list                     print the plan and the machine profile, run nothing
  --parallel                 run suites side by side (or MARGO_CHECK_PARALLEL=1)
  --serial                   one suite at a time, whatever else is set (or MARGO_CHECK_SERIAL=1)
  --keep-going               a failed suite stops nothing; the run ends with every failure and exit 1 (or MARGO_CHECK_KEEP_GOING=1)
  -h, --help                 print this help and exit

Example:
  node scripts/gpu-package-tests.mjs --no-build --select=sky/test:gpu,root/test:basic-scene`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && !showHelp(USAGE)) await main();

/** The command line run: the plan, or every picked suite once. */
async function main() {
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
  const select = process.argv.find((a) => a.startsWith('--select='))?.slice(9);
  const chosen = select === undefined ? undefined : new Set(select.split(',').filter(Boolean));
  const tests = plan().filter((t) => picked(t, only, chosen));
  const unknown = chosen ? [...chosen].filter((id) => !tests.some((t) => picked(t, undefined, new Set([id])))) : [];
  if (unknown.length) throw new Error(`--select names no GPU test: ${unknown.join(', ')}; list them with --list`);
  const profile = machineProfile(),
    planned = planSteps(tests, profile),
    sideBySide = parallelMode({ argv: process.argv, env: process.env, profile }),
    keepGoing = keepGoingMode({ argv: process.argv, env: process.env });
  reportSpeedPhase('check:gpu-packages');
  // Timing tests wait for the speed phase (scripts/speed-phase.json): deferred, they are named and left out of this run.
  const { shared: steps, timing: timingSteps } = splitTiming(planned);
  if (process.argv.includes('--list')) {
    console.log(describeProfile(profile));
    for (const s of [...steps, ...timingSteps])
      console.log(
        s.excluded ? `${s.label}: EXCLUDED BY PROFILE (${s.excluded})` : `${s.label}: (${s.cwd}) ${s.command}`,
      );
    return;
  }
  // In this gate a Jupyter check that cannot run (no Python, no network to make its venv) fails instead of printing
  // SKIP (python/tests/venv.mjs).
  const env = {
    ...process.env,
    MARGO_REQUIRE_JUPYTER: process.env.MARGO_REQUIRE_JUPYTER ?? '1',
  };
  const run = (command, cwd) => {
    const t0 = performance.now();
    const { status } = spawnSync(command, { cwd: join(root, cwd), shell: true, stdio: 'inherit', env });
    return { ok: status === 0, seconds: Math.round((performance.now() - t0) / 100) / 10 };
  };
  console.log(describeProfile(profile));
  // The build needs no GPU; it runs before every test.
  if (!process.argv.includes('--no-build') && !run('npm run build:packages', '.').ok)
    throw new Error('npm run build:packages failed; fix the build first');
  const started = performance.now(),
    prepared = new Set(),
    prepareFailed = new Set(),
    thermal = profile.heat ? thermalSource() : null;
  if (thermal) console.log(`temperature from the ${thermal.name}`);
  const runSteps = (list, beside) =>
    beside
      ? runSideBySide(list, { env, keepGoing })
      : runPlan(list, {
          profile,
          read: thermal?.read,
          // A test that fails while the GPU driver resets (bug 25) runs once more; the reset and the rerun are printed.
          retry: retryAfterDriverReset,
          // Each preparing command once, however many suites need it, before the suite runs.
          prepare: async (step) => {
            for (const command of PREPARE[step.name] ?? []) {
              if (prepared.has(command)) continue;
              if (prepareFailed.has(command) || !run(command, '.').ok) {
                if (!keepGoing) throw new Error(`${command} failed (needed by ${step.label}); fix it first`);
                // Once only: every other suite that needs it fails the same way, and the rest go on.
                prepareFailed.add(command);
                console.error(`${command} failed (needed by ${step.label}); that suite counts as failed`);
                return { ok: false, seconds: 0 };
              }
              prepared.add(command);
            }
            return null;
          },
          runStep: async (step, signal) => {
            console.log(`\n=== ${step.label}`);
            const result = await runLimited(step.command, {
              cwd: join(root, step.cwd),
              env,
              limitMs: runLimitMs(step),
              label: step.label,
              signal,
            });
            if (result.message) console.error(`\nHUNG: ${result.message}`);
            return result;
          },
        });
  const results = [
    ...(await runSteps(steps, sideBySide)),
    ...(timingSteps.length ? await runSteps(timingSteps, false) : []),
  ];
  mkdirSync(join(root, 'test-results'), { recursive: true });
  const recordFile = join(root, 'test-results/gpu-packages.json'),
    { json, warnings } = report(results, profile);
  writeFileSync(recordFile, JSON.stringify({ ...json, parallel: sideBySide }, null, 2) + '\n');
  console.log(`\nGPU package tests, ${describeProfile(profile)}${sideBySide ? ', side by side' : ''}:`);
  for (const line of summaryLines(results)) console.log(line);
  if (sideBySide) {
    const failedHere = results.filter((r) => r.outcome === 'fail');
    for (const r of failedHere) console.error(`\nFAILED: ${r.label}\nlog: ${r.log}\n${tailOf(r.log)}`);
    console.log(
      `\nSuite logs:\n${results
        .filter((r) => r.log)
        .map((r) => `  ${r.label}: ${r.log}`)
        .join('\n')}`,
    );
  }
  console.log(`  total ${Math.round((performance.now() - started) / 1000)} s`);
  for (const line of warnings) console.log(`\n${line}`);
  const failed = results.filter((r) => r.outcome === 'fail'),
    code = exitCode(results);
  if (failed.length)
    console.error(`${failed.length} of ${results.length} failed: ${failed.map((r) => r.label).join(', ')}`);
  else if (code === HEAT_EXIT)
    console.error(
      'No test failed, but a heat stop was not resumed: the run is incomplete (exit 75). Rerun the steps named above when the machine is cool, or on a profile that can take the load.',
    );
  // Every suite has ended by now, a stopped run's too (runJobs aborts the suites beside a failure and waits for them), so
  // the run ends by its event loop with this code (KB-OWN-EXIT2).
  process.exitCode = code;
}
