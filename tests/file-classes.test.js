// The file classes behind `npm run check:merge` (scripts/support/file-classes.mjs, session rule 20): one case per
// class, and the class gate: every tracked file has a class, so the "cannot classify, run everything" net is only
// reached by a new file in a new place, and this test names that file and the fix.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { buildCheckCode, loadWorkspaces } from '../scripts/support/affected-gpu.mjs';
import { CLASSES, classify, CHECK_CODE, RUNNER, unknownFix } from '../scripts/support/file-classes.mjs';

const root = resolve(import.meta.dirname, '..');
const ws = (name, dir = `packages/${name}`) => ({ name, dir, deps: [] });
const graph = [ws('core'), ws('stage'), ws('shared'), ws('margoengine'), ws('dof'), ws('sandbox', 'examples/sandbox')];
const cls = (file, checkCode) => classify(file, { workspaces: graph, checkCode }).cls;

test('each class places the files it is meant for, checked in order', () => {
  const cases = {
    lock: ['package.json', 'package-lock.json', 'examples/next/package-lock.json', '.npmrc'],
    floor: [
      'packages/core/src/a.ts',
      'packages/stage/package.json',
      'packages/shared/aces.wgsl',
      'packages/kernel/src/lib.rs',
    ],
    package: ['packages/dof/src/a.ts', 'packages/dof/package.json', 'packages/dof/src/s.wgsl', 'examples/sandbox/x.js'],
    'build-config': ['biome.json', 'tsconfig.json', 'tsconfig.base.json', 'rust-toolchain.toml', 'vite.config.ts'],
    'check-code': [...CHECK_CODE],
    runner: [...RUNNER],
    'wgsl-loose': ['shaders/common.wgsl', 'tests/fixtures/x.wgsl'],
    unit: ['tests/power-status.test.js'],
    'visual-baseline': ['tests/visual/dof-high.png', 'tests/visual/profiles/p/khronos-a-model.png'],
    'visual-record': ['tests/visual/manifest.json', 'tests/visual/profiles/p/source-audit.json'],
    fixture: ['tests/fixtures/basic-scene/main.js', 'tests/fixtures/fuzz/draco-no-header.bin'],
    'root-browser': ['tests/browser/stats-native-passes.html'],
    proof: ['examples/package-benchmarks/proofs/run.mjs', 'examples/package-benchmarks/proofs/baselines/q.json'],
    'quality-baseline': ['scripts/quality/baselines/sizes.json'],
    python: ['python/margoengine/_figure.py', 'python/frontend/figure.ts'],
    asset: ['examples/assets/skinning-ik.glb'],
    script: [
      'scripts/quiet-gate.mjs',
      'scripts/support/msaa-blend-repeat.html',
      'scripts/fuzz/run.js',
      'tests/support/png.js',
      'tests/modern.html',
      'tests/tokyo_scene_check.py',
      'examples/split-screen.ts',
      'examples/package-benchmarks/entry-sizes.mjs',
      'bench/scenes/harness.js',
      'tools/create-margo/index.js',
    ],
    inert: [
      'README.md',
      'packages/core/README.md',
      'packages/dof/README.md',
      'docs/catalog.json',
      'site/index.html',
      'private/x.txt',
      'api/dof.api.md',
      'benchmarks/records/x.json',
      '.github/workflows/ci.yml',
      'public/favicon.ico',
      'LICENSE',
      'NOTICE',
      '.gitignore',
      '.gitattributes',
      '.editorconfig',
    ],
    unknown: ['mystery/x.bin', 'public/app.js', 'Makefile'],
  };
  assert.deepEqual(Object.keys(cases).sort(), Object.keys(CLASSES).sort(), 'every class has cases here');
  for (const [expected, files] of Object.entries(cases))
    for (const file of files) assert.equal(cls(file), expected, file);
  // The build:packages closure, passed as `checkCode`, is check code; RUNNER stays the runner.
  assert.equal(cls('scripts/build-x.js', new Set([...CHECK_CODE, 'scripts/build-x.js'])), 'check-code');
  assert.equal(cls('scripts/build-x.js'), 'script');
  // Windows separators are read as repo paths.
  assert.equal(cls('packages\\dof\\src\\a.ts'), 'package');
});

test('the classes that run everything give the reason, and the unknown fix names the file and the map', () => {
  for (const file of ['package.json', 'packages/core/src/a.ts', 'biome.json', 'scripts/verify.mjs', 'x.wgsl'])
    assert.ok(classify(file, { workspaces: graph }).reason, file);
  assert.match(classify('mystery/x.bin').reason, /cannot classify mystery\/x\.bin/);
  assert.match(unknownFix('mystery/x.bin'), /^mystery\/x\.bin: .*classify\(\) in scripts\/support\/file-classes\.mjs/);
});

// The tracked files; a copy without git (an unpacked tarball) walks the tree instead.
function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
      .split('\0')
      .filter(Boolean);
  } catch {
    const out = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist', 'test-results', 'target'].includes(e.name)) continue;
        const path = join(dir, e.name);
        if (e.isDirectory()) walk(path);
        else out.push(relative(root, path).replaceAll('\\', '/'));
      }
    };
    walk(root);
    return out;
  }
}

test('class gate: every tracked file has a class, and none of the runner files is checkCode', () => {
  const workspaces = loadWorkspaces(root),
    scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts,
    checkCode = buildCheckCode(root, workspaces, scripts),
    files = trackedFiles();
  assert.ok(files.length > 1000, `found only ${files.length} files`);
  const unplaced = files.filter((file) => classify(file, { workspaces, checkCode }).cls === 'unknown');
  assert.deepEqual(unplaced.map(unknownFix), [], `${unplaced.length} tracked file(s) no class places`);
  for (const file of RUNNER) assert.ok(!checkCode.has(file), `${file} is RUNNER, not check code`);
  // The build chain is check code, found by the scan rather than by hand.
  assert.ok(checkCode.has('scripts/build-modern.js'));
  for (const file of CHECK_CODE) assert.ok(checkCode.has(file), file);
});
