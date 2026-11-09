// The physics kernels' Rust tests (`test:physics-kernel`, `test:physics2d-kernel`) ran in no check: not verify, not
// check:merge, not local CI, while claims cite them. check:merge now runs `check:rust-kernels`
// (scripts/rust-kernel-tests.mjs) for each package with a Rust kernel whose own files changed. The 2D kernel then did not
// build for Wasm, its shipped target (an f64 square root no_std lacks, no memory allocator), and no check built it: a
// kernel that ships as Wasm is now built for wasm32 with the shipped flags, and its wasm-check crate run in Node.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { planContext, planFiles } from '../scripts/check-merge.mjs';
import {
  WASM_RUSTFLAGS,
  cargoArgs,
  changedKernelDirs,
  pathDependencies,
  runWasmChecks,
  rustKernels,
  selectKernels,
  shipsWasm,
  wasmBuildArgs,
  wasmModule,
} from '../scripts/rust-kernel-tests.mjs';
import { RUSTFLAGS as PHYSICS_RUSTFLAGS } from '../packages/physics/scripts/build-kernel.mjs';
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

test('feature-local crates all reach the merge gate once per owning package', () => {
  const sciviz = kernels.filter((k) => k.dir === 'packages/sciviz');
  assert.deepEqual(sciviz.map((k) => k.manifest).sort(), [
    'packages/sciviz/flow-kernel/Cargo.toml',
    'packages/sciviz/kernel/Cargo.toml',
  ]);
  assert.deepEqual(changedKernelDirs(sciviz, ['@margoengine/sciviz']), ['sciviz']);
  assert.equal(selectKernels(kernels, 'sciviz').length, 2);
  assert.equal(
    step(['packages/sciviz/flow-kernel/src/lib.rs']).command,
    'npm run check:rust-kernels -- --packages=sciviz',
  );
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

test("a kernel built on another package's crate runs when that package changes (the 2D kernel on kernel-common)", () => {
  const twoD = kernels.find((k) => k.dir === 'packages/physics2d');
  assert.deepEqual(
    twoD.uses,
    ['@margoengine/physics'],
    'packages/physics2d/kernel/Cargo.toml uses ../../physics/kernel-common',
  );
  assert.deepEqual(kernels.find((k) => k.dir === 'packages/physics').uses, []);
  const workspaces = [
    { name: '@x/a', dir: 'packages/a' },
    { name: '@x/b', dir: 'packages/b' },
    { name: '@x/ab', dir: 'packages/ab' },
  ];
  const text = '[dependencies]\nshared = { path = "../../a/kernel-common" }\nself = { path = "../own" }\n';
  assert.deepEqual(
    pathDependencies(text, 'packages/b/kernel/Cargo.toml', workspaces, '@x/b'),
    ['@x/a'],
    'a prefix of another folder name is not a match',
  );
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

test('every kernel that ships as Wasm is built for wasm32 with the shipped flags, the 2D one checked in Wasm too', () => {
  for (const dir of ['packages/physics', 'packages/physics2d'])
    assert.ok(kernels.find((k) => k.dir === dir).wasm, `${dir} ships as Wasm`);
  assert.equal(WASM_RUSTFLAGS, PHYSICS_RUSTFLAGS, 'the flags of the 3D kernel blueprint');
  assert.deepEqual(wasmBuildArgs('k/Cargo.toml'), [
    'build',
    '--locked',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
    '--manifest-path',
    'k/Cargo.toml',
  ]);
  assert.ok(shipsWasm('[lib]\ncrate-type = ["cdylib", "rlib"]\n'));
  assert.ok(!shipsWasm('[lib]\ncrate-type = ["rlib"]\n'));
  const twoD = kernels.find((k) => k.dir === 'packages/physics2d');
  assert.equal(twoD.wasmCheck, 'packages/physics2d/kernel/wasm-check/Cargo.toml');
  assert.equal(kernels.find((k) => k.dir === 'packages/physics').wasmCheck, null);
  const check = readFileSync(resolve(root, twoD.wasmCheck), 'utf8');
  assert.equal(
    wasmModule(twoD.wasmCheck, check),
    'packages/physics2d/kernel/wasm-check/target/wasm32-unknown-unknown/release/margoengine_physics2d_wasm_check.wasm',
  );
  // The Wasm check and the native pinned-bits test step one scene file against one set of hashes.
  const scenes = '#[path = "support/bits_scenes.rs"]';
  assert.ok(readFileSync(resolve(root, 'packages/physics2d/kernel/tests/bits.rs'), 'utf8').includes(scenes));
  assert.ok(
    readFileSync(resolve(root, 'packages/physics2d/kernel/wasm-check/src/lib.rs'), 'utf8').includes(
      '#[path = "../../tests/support/bits_scenes.rs"]',
    ),
  );
});

test('a Wasm check module fails on the checks that return nonzero', async () => {
  // (func checks (result i32) 2) (func check (param i32) (result i32) local.get 0): check 0 passes, check 1 fails.
  const module = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x0a, 0x02, 0x60, 0x00, 0x01, 0x7f, 0x60, 0x01, 0x7f, 0x01,
    0x7f, 0x03, 0x03, 0x02, 0x00, 0x01, 0x07, 0x12, 0x02, 0x06, 0x63, 0x68, 0x65, 0x63, 0x6b, 0x73, 0x00, 0x00, 0x05,
    0x63, 0x68, 0x65, 0x63, 0x6b, 0x00, 0x01, 0x0a, 0x0b, 0x02, 0x04, 0x00, 0x41, 0x02, 0x0b, 0x04, 0x00, 0x20, 0x00,
    0x0b,
  ]);
  assert.deepEqual(await runWasmChecks(module), [1]);
});
