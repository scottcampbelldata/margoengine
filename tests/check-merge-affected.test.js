// The affected-GPU logic behind `npm run check:merge` (scripts/support/affected-gpu.mjs, scripts/check-merge.mjs):
// dependents, the triggers that fall back to the full run, unknown files, and that a documents-only change skips every
// GPU step of the real step list.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { GPU_STEPS, PLAIN_STEPS, SCOPED_STEPS, describe, planSteps } from '../scripts/check-merge.mjs';
import { MATRIX_DIRS, matrixClosure, packageScopes } from '../scripts/support/affected-packages.mjs';
import { PARALLEL, SERIAL, TEST_CONCURRENCY } from '../scripts/verify.mjs';
import { nightlyCommand, stamp } from '../scripts/nightly-full.mjs';
import { plan, testId } from '../scripts/gpu-package-tests.mjs';
import {
  analyse,
  buildFootprints,
  demoSources,
  scan,
  dependents,
  loadWorkspaces,
  visualIds,
  wgslPackages,
} from '../scripts/support/affected-gpu.mjs';
import { demos } from '../scripts/support/visual-demos.js';

const root = resolve(import.meta.dirname, '..');
const ws = (name, deps = []) => ({ name, dir: `packages/${name}`, deps });
// a <- b <- c, d alone; x depends on a too.
const graph = [ws('a'), ws('b', ['a']), ws('c', ['b']), ws('d'), ws('x', ['a'])];
const print = (packages = [], files = [], patterns = []) => ({
  packages: new Set(packages),
  files: new Set(files),
  patterns,
  all: false,
});
const footprints = {
  'gpu/b': print(['b']),
  'gpu/d': print(['d']),
  'gpu/root/pages': print([], ['tests/page.html']),
  'gpu/root/catalog': print([], [], [/^docs\/(?!.*\.md$)/]),
  'gpu/root/unmapped': { ...print(), all: true },
};
const run = (files, extra = {}) => analyse({ files, workspaces: graph, footprints, ...extra });

test('dependents include the seeds and every transitive dependent, once', () => {
  assert.deepEqual([...dependents(graph, new Set(['a']))].sort(), ['a', 'b', 'c', 'x']);
  assert.deepEqual([...dependents(graph, new Set(['c']))], ['c']);
  assert.deepEqual([...dependents(graph, new Set(['d']))], ['d']);
  assert.deepEqual([...dependents(graph, new Set(['b', 'x']))].sort(), ['b', 'c', 'x']);
});

test('a change to one package affects it and its dependents, and runs the steps that touch them', () => {
  const result = run(['packages/a/src/index.ts']);
  assert.equal(result.mode, 'affected');
  assert.deepEqual(result.affected.sort(), ['a', 'b', 'c', 'x']);
  assert.deepEqual(result.hits.sort(), ['gpu/b', 'gpu/root/unmapped']);
  assert.deepEqual(run(['packages/d/README.md', 'packages/d/src/x.ts']).hits.sort(), ['gpu/d', 'gpu/root/unmapped']);
});

test('core, stage, shared and the margoengine umbrella run everything', () => {
  for (const dir of ['core', 'stage', 'shared', 'margoengine']) {
    const result = run([`packages/${dir}/src/x.ts`]);
    assert.equal(result.mode, 'full', dir);
    assert.match(result.reason, new RegExp(dir));
    assert.deepEqual(result.hits.sort(), Object.keys(footprints).sort());
  }
  assert.equal(run(['packages/shared/aces.wgsl']).mode, 'full');
});

test('build scripts, check scripts, package.json and lock files run everything', () => {
  for (const file of [
    'scripts/check-merge.mjs',
    'scripts/support/visual-demos.js',
    'package.json',
    'package-lock.json',
    'packages/b/package.json',
    'biome.json',
    '.github/workflows/ci.yml',
  ])
    assert.equal(run([file]).mode, 'full', file);
});

test('a WGSL file outside any package runs everything; inside a package it belongs to that package', () => {
  assert.equal(run(['shaders/common.wgsl']).mode, 'full');
  assert.equal(run(['packages/d/src/s.wgsl']).mode, 'affected');
});

test('a file nothing classifies runs everything, and says which', () => {
  const result = run(['packages/d/src/x.ts', 'tests/mystery.test.js']);
  assert.equal(result.mode, 'full');
  assert.match(result.reason, /cannot classify tests\/mystery\.test\.js/);
});

test('MARGO_FULL=1 runs everything even for a documents-only change', () => {
  const result = run(['docs/known-bugs.md'], { env: { MARGO_FULL: '1' } });
  assert.equal(result.mode, 'full');
  assert.equal(result.reason, 'MARGO_FULL=1');
  assert.equal(run(['docs/known-bugs.md'], { env: { MARGO_FULL: '0' } }).mode, 'affected');
});

test('more affected packages than the limit runs everything', () => {
  const wide = [ws('a'), ...['b', 'c', 'd', 'e'].map((n) => ws(n, ['a']))];
  assert.equal(analyse({ files: ['packages/a/x.ts'], workspaces: wide, footprints, max: 4 }).mode, 'full');
  const result = analyse({ files: ['packages/a/x.ts'], workspaces: wide, footprints, max: 5 });
  assert.equal(result.mode, 'affected');
});

test('documents, site pages and licences change nothing on the GPU; a catalog asset runs the catalog suite', () => {
  for (const file of [
    'docs/HANDOFF.md',
    'README.md',
    'packages/b/README.md',
    'site/index.html',
    'LICENSE',
    'AGENTS.md',
  ]) {
    const result = run([file]);
    assert.equal(result.mode, 'affected', file);
    assert.deepEqual(result.hits, [], file);
  }
  assert.deepEqual(run(['docs/catalog.json']).hits, ['gpu/root/catalog']);
  assert.deepEqual(run(['tests/page.html']).hits, ['gpu/root/pages']);
  assert.deepEqual(run([]).hits, []);
});

// ---- The real repository. ----
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const workspaces = loadWorkspaces(root);
const tests = plan();
const real = buildFootprints({ root, workspaces, tests, scripts: manifest.scripts });
const steps = manifest.scripts['check:merge:steps'].split(' && ');
const browserFiles = scan(root, ['tests/modern.html'], workspaces).files;
const closure = matrixClosure(root, workspaces);
const planFor = (files) => {
  const decision = analyse({ files, workspaces, footprints: real });
  const scope = packageScopes({ decision, files, workspaces, browserFiles, closure });
  return { decision, scope, planned: planSteps({ steps, decision, tests, workspaces, testId, scope }) };
};
const stepName = (command) => /^npm run (\S+)/.exec(command)?.[1];

test('every check:merge step is either narrowed GPU work or plain; a new step has to be classified', () => {
  const names = steps.map(stepName);
  for (const name of names)
    assert.ok(
      GPU_STEPS.includes(name) || PLAIN_STEPS.includes(name) || SCOPED_STEPS.includes(name),
      `classify ${name} in scripts/check-merge.mjs`,
    );
  for (const name of [...GPU_STEPS, ...PLAIN_STEPS, ...SCOPED_STEPS])
    assert.ok(names.includes(name), `${name} is not a check:merge step`);
  assert.equal(manifest.scripts['check:merge'], 'node scripts/check-merge.mjs');
  assert.equal(manifest.scripts['check:merge:full'], 'node scripts/check-merge.mjs --full');
});

test('a documents-only change skips every GPU step and the bundler matrix, and keeps the others', () => {
  const { decision, planned } = planFor(['docs/HANDOFF.md', 'AGENTS.md', 'packages/dof/README.md']);
  assert.equal(decision.mode, 'affected');
  for (const { command, skip } of planned) {
    const name = stepName(command);
    if (GPU_STEPS.includes(name) || name === 'modern:test:bundlers') assert.ok(skip, `${command} should be skipped`);
    else assert.equal(skip, undefined, `${command} should run`);
  }
  assert.equal(planned.length, steps.length);
  // The README of dof is the only package whose examples are type-checked; the umbrella smoke test is added by the script.
  assert.equal(
    planned.find((p) => stepName(p.command) === 'modern:test:packages').command,
    'npm run modern:test:packages -- --packages=dof',
  );
});

test('a documents-only change outside any package still runs the packed smoke test, with no package examples', () => {
  const { planned } = planFor(['docs/HANDOFF.md']);
  assert.equal(
    planned.find((p) => stepName(p.command) === 'modern:test:packages').command,
    'npm run modern:test:packages -- --packages=',
  );
});

test('a one-package change checks that package and its dependents, and leaves the bundler matrix alone', () => {
  const { decision, scope, planned } = planFor(['packages/dof/src/index.ts']);
  assert.ok(scope.packages.dirs.includes('dof'));
  for (const dir of scope.packages.dirs)
    assert.ok(decision.affected.includes(workspaces.find((w) => w.dir === `packages/${dir}`).name), dir);
  assert.ok(!scope.packages.full);
  assert.ok(scope.packages.dirs.includes('react'), 'react has dof as an optional peer, so its checks run');
  assert.equal(scope.bundlers.run, false);
  assert.ok(planned.find((p) => stepName(p.command) === 'modern:test:bundlers').skip);
});

test('every package is a dependent of the umbrella, which alone must not start the bundler matrix', () => {
  const { decision, scope } = planFor(['packages/dof/src/index.ts']);
  assert.ok(decision.affected.includes('margoengine'));
  assert.equal(scope.bundlers.run, false);
});

test('a change to a package the matrix builds or imports, or one of their dependencies, runs the matrix', () => {
  for (const name of ['@margoengine/react', '@margoengine/shadows', '@margoengine/controls', 'margoengine'])
    assert.ok(closure.has(name), name);
  for (const dir of MATRIX_DIRS) assert.ok(closure.has(workspaces.find((w) => w.dir === dir).name), dir);
  // The umbrella lists every package; following it would put all of them in the closure.
  assert.ok(!closure.has('@margoengine/dof'));
  for (const name of closure)
    if (name.startsWith('@margoengine/') && !['@margoengine/core', '@margoengine/stage'].includes(name)) {
      const dir = workspaces.find((w) => w.name === name).dir;
      const { scope } = planFor([`${dir}/src/index.ts`]);
      if (scope.packages.full) continue; // shared and friends run everything anyway
      assert.equal(scope.bundlers.run, true, `${name} is in the matrix closure`);
    }
});

test('a package README, or a React document, selects that package for the README and React checks', () => {
  assert.deepEqual(planFor(['packages/post/README.md']).scope.packages.dirs, ['post']);
  assert.deepEqual(planFor(['docs/react-cookbook.md']).scope.packages.dirs, ['react']);
  assert.deepEqual(planFor(['docs/react-r3f.md']).scope.packages.dirs, ['react']);
  assert.deepEqual(planFor(['docs/limits.md']).scope.packages.dirs, []);
});

test('a file the packed browser test serves makes the packed test run whole', () => {
  assert.ok(browserFiles.has('tests/modern.html'));
  const { scope } = planFor(['tests/modern.html']);
  assert.equal(scope.packages.full, true);
  assert.match(scope.packages.reason, /packed browser test/);
});

test('full decisions keep the package test whole and the bundler matrix on', () => {
  const decision = analyse({ files: [], workspaces, footprints: real, env: { MARGO_FULL: '1' } });
  const scope = packageScopes({ decision, files: [], workspaces, browserFiles, closure });
  assert.equal(scope.packages.full, true);
  assert.equal(scope.bundlers.run, true);
  const planned = planSteps({ steps, decision, tests, workspaces, testId, scope });
  for (const name of SCOPED_STEPS)
    assert.deepEqual(
      planned.find((p) => stepName(p.command) === name),
      { command: `npm run ${name}` },
    );
});

test('the bundler matrix does not take the GPU lock, and a render in a browser is the only reason it would', () => {
  assert.equal(manifest.scripts['modern:test:bundlers'], 'node scripts/bundler-matrix.mjs');
  assert.doesNotMatch(
    readFileSync(resolve(root, 'scripts/bundler-matrix.mjs'), 'utf8'),
    /requestAdapter|getContext|screenshot/,
  );
});

test('verify runs the same eleven checks as before, hygiene first, the build second, the rest after the build', () => {
  assert.equal(manifest.scripts.verify, 'node scripts/verify.mjs');
  assert.deepEqual(SERIAL, ['node scripts/hygiene.js --verify', 'npm run build:packages']);
  assert.deepEqual(
    PARALLEL.flat().sort(),
    [
      'npm run api:check',
      'npm run quality',
      'npm run build --workspace examples/gameplay-sandbox',
      'npm run test --workspace examples/gameplay-sandbox',
      'npm run build --workspace examples/voxel-sandbox',
      'npm run test --workspace examples/voxel-sandbox',
      `node --experimental-test-module-mocks --test --test-concurrency=${TEST_CONCURRENCY} tests/*.test.js packages/*/tests/*.test.js packages/*/test/*.test.js`,
      'npm run measure:size',
      'npm run proofs -- --current',
    ].sort(),
  );
  // A sandbox is built before its tests run.
  for (const chain of PARALLEL.filter((c) => c.length > 1)) assert.match(chain[0], /npm run build /);
  for (const command of [...SERIAL, ...PARALLEL.flat()]) {
    const script = /^npm run ([\w:-]+)/.exec(command)?.[1];
    if (script) assert.ok(manifest.scripts[script], `${script} is a package.json script`);
  }
});

test('MARGO_FULL=1 and core changes keep every step exactly as written', () => {
  for (const decision of [
    analyse({ files: ['docs/x.md'], workspaces, footprints: real, env: { MARGO_FULL: '1' } }),
    analyse({ files: ['packages/core/src/index.ts'], workspaces, footprints: real }),
  ]) {
    assert.equal(decision.mode, 'full');
    assert.deepEqual(
      planSteps({ steps, decision, tests, workspaces, testId }),
      steps.map((command) => ({ command })),
    );
  }
});

test('a one-package change narrows the visual demos, the GPU tests and the WGSL compile to what uses it', () => {
  const { decision, planned } = planFor(['packages/dof/src/index.ts']);
  assert.equal(decision.mode, 'affected');
  assert.ok(decision.affected.includes('@margoengine/dof'));
  const command = (name) => planned.find((p) => stepName(p.command) === name);
  assert.match(command('visual:check').command, /--only=.*\bdof\b/);
  assert.doesNotMatch(command('visual:check').command, /night-citadel|khronos/);
  assert.ok(command('check:views').skip === undefined, 'views draw DOF');
  assert.ok(command('check:depth').skip, 'depth does not use dof');
  assert.match(command('check:wgsl').command, /--packages=.*\bdof\b/);
  assert.match(command('check:gpu-packages').command, /--select=.*root\/modern:test:postfx:browser/);
  assert.doesNotMatch(command('check:gpu-packages').command, /gpu\/|water|voxel/);
});

test('every visual demo that is not a Khronos model maps to its sources, and the mapped sources exist', () => {
  for (const demo of demos) {
    const sources = demoSources(demo);
    assert.ok(sources, `${demo.id} (${demo.path}) has no source mapping in demoSources`);
    for (const source of sources) assert.ok(existsSync(resolve(root, source)), `${source} does not exist`);
  }
});

test('visual ids collapse to the khronos- prefix only when every model is in', () => {
  const khronos = demos.filter((d) => d.id.startsWith('khronos-')).map((d) => `visual/${d.id}`);
  assert.ok(khronos.length > 3);
  assert.deepEqual(visualIds(['visual/earth', ...khronos]), ['earth', 'khronos-']);
  assert.deepEqual(visualIds(['visual/earth', khronos[0]]), ['earth', khronos[0].slice(7)]);
});

test('wgsl packages are the affected package directories', () => {
  const some = [ws('a'), { name: '@x/app', dir: 'examples/app', deps: [] }];
  assert.deepEqual(wgslPackages(some, ['a', '@x/app']), ['a']);
});

test('the mode line names the mode and the reason', () => {
  assert.match(describe({ mode: 'full', reason: 'MARGO_FULL=1', affected: [] }), /FULL GPU run, because MARGO_FULL=1/);
  assert.match(
    describe({ mode: 'affected', reason: 'changed a', affected: ['a', 'b'] }, 'abcdef123456'),
    /AFFECTED GPU run vs abcdef12: changed a \[a, b\]/,
  );
});

test('the nightly job runs check:merge:full under the GPU lock, with a dated log name', () => {
  assert.equal(stamp(new Date(2026, 9, 25, 3, 5)), '2026-10-25T0305');
  const [, args] = nightlyCommand();
  assert.deepEqual(args.slice(0, 3), ['scripts/gpu-lock.mjs', 'run', '--owner=nightly-full']);
  assert.deepEqual(args.slice(-3), ['npm', 'run', 'check:merge:full']);
});
