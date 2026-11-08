// The physics kernels' Rust tests (`test:physics-kernel`, `test:physics2d-kernel`) ran in no check: not verify, not
// check:merge, not local CI, while claims cite them. check:merge now runs `check:rust-kernels`
// (scripts/rust-kernel-tests.mjs) for each package with a Rust kernel whose own files changed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { planContext, planFiles } from '../scripts/check-merge.mjs';
import { cargoArgs, changedKernelDirs, pathDependencies, rustKernels, selectKernels } from '../scripts/rust-kernel-tests.mjs';
import { loadWorkspaces } from '../scripts/support/affected-gpu.mjs';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const kernels = rustKernels(loadWorkspaces(root));
const ctx = await planContext(root);
const step = (files, env) =>
  planFiles(ctx, files, env).planned.find((p) => /^npm run check:rust-kernels\b/.test(p.command));

test('every workspace package with a Rust kernel is found, physics and physics2d among them', () => {
  const dirs = kernels.map((k) => k.dir);
  for (const dir of ['packages/physics', 'packages/physics2d']) assert.ok(dirs.includes(dir), dir);
  for (const k of kernels) assert.match(k.manifest, /(^|\/)Cargo\.toml$/);
});

test('the kernel npm scripts run the same cargo command check:rust-kernels runs, so a claim citing one is checked', () => {
  const byScript = { 'test:physics-kernel': 'packages/physics', 'test:physics2d-kernel': 'packages/physics2d' };
  for (const [script, dir] of Object.entries(byScript)) {
    const kernel = kernels.find((k) => k.dir === dir);
    assert.equal(manifest.scripts[script], `cargo ${cargoArgs(kernel.manifest).join(' ')}`, script);
  }
  assert.equal(manifest.scripts['check:rust-kernels'], 'node scripts/rust-kernel-tests.mjs');
  assert.ok(manifest.scripts['check:merge:steps'].split(' && ').includes('npm run check:rust-kernels'));
});

test('check:merge runs the kernel tests of a changed package, its kernel folder included, and nothing else', () => {
  const only2d = 'npm run check:rust-kernels -- --packages=physics2d';
  assert.equal(step(['packages/physics2d/kernel/src/lib.rs']).command, only2d, 'a kernel folder counts as its package');
  assert.equal(step(['packages/physics2d/src/index.ts']).command, only2d);
  // physics has more dependents than an affected run allows, so a change to it is a full run: every kernel.
  assert.deepEqual(step(['packages/physics/kernel/src/lib.rs']), { command: 'npm run check:rust-kernels' });
  assert.ok(step(['docs/known-bugs.md']).skip, 'documents only');
  assert.ok(step(['packages/dof/src/index.ts']).skip, 'a package without a kernel');
});

test('a kernel built on another package\'s crate runs when that package changes (the 2D kernel on kernel-common)', () => {
  const twoD = kernels.find((k) => k.dir === 'packages/physics2d');
  assert.deepEqual(twoD.uses, ['@margoengine/physics'], 'packages/physics2d/kernel/Cargo.toml uses ../../physics/kernel-common');
  assert.deepEqual(kernels.find((k) => k.dir === 'packages/physics').uses, []);
  const workspaces = [
    { name: '@x/a', dir: 'packages/a' },
    { name: '@x/b', dir: 'packages/b' },
    { name: '@x/ab', dir: 'packages/ab' },
  ];
  const text = '[dependencies]\nshared = { path = "../../a/kernel-common" }\nself = { path = "../own" }\n';
  assert.deepEqual(pathDependencies(text, 'packages/b/kernel/Cargo.toml', workspaces, '@x/b'), ['@x/a'], 'a prefix of another folder name is not a match');
  const some = [
    { name: '@x/a', dir: 'packages/a', manifest: 'packages/a/kernel/Cargo.toml', uses: [] },
    { name: '@x/b', dir: 'packages/b', manifest: 'packages/b/kernel/Cargo.toml', uses: ['@x/a'] },
  ];
  assert.deepEqual(changedKernelDirs(some, ['@x/a']), ['a', 'b']);
  assert.deepEqual(changedKernelDirs(some, ['@x/b']), ['b']);
});

test('check:merge runs every kernel when its script changed and in the full run', () => {
  assert.deepEqual(step(['scripts/rust-kernel-tests.mjs']), { command: 'npm run check:rust-kernels' });
  assert.deepEqual(step(['docs/known-bugs.md'], { MARGO_FULL: '1' }), { command: 'npm run check:rust-kernels' });
});

test('changedKernelDirs and selectKernels: changed names map to directories; an unknown name throws', () => {
  const some = [
    { name: '@x/a', dir: 'packages/a', manifest: 'packages/a/kernel/Cargo.toml' },
    { name: '@x/b', dir: 'packages/b', manifest: 'packages/b/Cargo.toml' },
  ];
  assert.deepEqual(changedKernelDirs(some, ['@x/b', '@x/c']), ['b']);
  assert.deepEqual(
    selectKernels(some, 'a').map((k) => k.dir),
    ['packages/a'],
  );
  assert.equal(selectKernels(some, undefined), some);
  assert.throws(() => selectKernels(some, 'a,zz'), /zz, which hold no Rust kernel/);
  assert.throws(() => selectKernels(some, ''), /names nothing/);
});
