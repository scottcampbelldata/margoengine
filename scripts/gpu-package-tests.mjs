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
// Holds one shared slot of the GPU lock (scripts/gpu-lock.mjs, up to 3 at once) for the whole run; each test's result and time go to
// test-results/gpu-packages.json. A test that fails while the Windows event log shows a GPU driver reset runs once more
// (scripts/support/driver-resets.mjs, bug 25); the reset and the rerun are printed and kept in that file, never hidden.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquire, lockDir } from './gpu-lock.mjs';
import { describeResets, retryAfterDriverReset } from './support/driver-resets.mjs';
import { runLimited, testLimitMs } from './support/run-limited.mjs';

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
};
/** Commands a root suite needs first (it reads their output), run once before it. */
const PREPARE = {
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
/** Browser scripts under packages/ that are tools, not tests (the guard below skips them). */
const TOOLS = {
  'packages/voxel-pathtracer/tests/magicavoxel/mv-vox.mjs': 'renders .vox files for a side-by-side comparison',
  'packages/webgl2-compat/scripts/capabilities.mjs':
    'prints the WebGL2 report of every installed browser and ANGLE back end (test:browser checks the default one)',
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
        minutes: json(file).margo?.gpuTestTimeoutMinutes,
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
    tests.push({ label: `root ${name}`, cwd: '.', command: `npm run ${name}`, name });
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
  const select = process.argv.find((a) => a.startsWith('--select='))?.slice(9);
  const chosen = select === undefined ? undefined : new Set(select.split(',').filter(Boolean));
  const tests = plan().filter((t) => (!only || t.label.includes(only)) && (!chosen || chosen.has(testId(t))));
  const unknown = chosen ? [...chosen].filter((id) => !tests.some((t) => testId(t) === id)) : [];
  if (unknown.length) throw new Error(`--select names no GPU test: ${unknown.join(', ')}; list them with --list`);
  if (process.argv.includes('--list')) {
    for (const t of tests) console.log(`${t.label}: (${t.cwd}) ${t.command}`);
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
  // The build needs no GPU, so it runs before the lock is taken.
  if (!process.argv.includes('--no-build') && !run('npm run build:packages', '.').ok)
    throw new Error('npm run build:packages failed; fix the build first');
  // A short poll: other holders often release and take the lock again within seconds.
  // Held for the whole run (about 10 min alone, 15 with another run beside it), so the hold limit is 60 min.
  const release = await acquire({ owner: 'check:gpu-packages', mode: 'shared', max: 60, poll: 2000 });
  const started = performance.now();
  const results = [],
    prepared = new Set();
  try {
    for (const test of tests) {
      // Each preparing command once, however many suites need it.
      for (const command of PREPARE[test.name] ?? []) {
        if (prepared.has(command)) continue;
        if (!run(command, '.').ok) throw new Error(`${command} failed (needed by ${test.label}); fix it first`);
        prepared.add(command);
      }
      console.log(`\n=== ${test.label}`);
      // A test that fails while the GPU driver resets (bug 25) runs once more; the reset and the rerun are printed.
      const result = await retryAfterDriverReset(test.label, async () => {
        const run = await runLimited(test.command, {
          cwd: join(root, test.cwd),
          env,
          limitMs: testLimitMs(test.minutes),
          label: test.label,
        });
        if (run.message) console.error(`\nHUNG: ${run.message}`);
        return run;
      });
      results.push({ ...test, ...result });
    }
  } finally {
    release();
  }
  const failed = results.filter((r) => !r.ok);
  mkdirSync(join(root, 'test-results'), { recursive: true });
  writeFileSync(join(root, 'test-results/gpu-packages.json'), JSON.stringify(results, null, 2) + '\n');
  console.log('\nGPU package tests:');
  for (const r of results)
    console.log(
      `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}  ${r.seconds} s${r.driverReset ? `  (run again after a ${describeResets(r.driverReset.resets)})` : ''}`,
    );
  console.log(`  total ${Math.round((performance.now() - started) / 1000)} s`);
  if (failed.length) {
    console.error(`${failed.length} of ${results.length} failed: ${failed.map((r) => r.label).join(', ')}`);
    process.exitCode = 1;
  }
}
