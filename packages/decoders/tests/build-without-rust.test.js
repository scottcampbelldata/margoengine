// Regression: the package build ran cargo for the native decoders every time, so `npm run build:packages` failed with
// "spawn cargo ENOENT" on a machine without Rust. The build must use the committed blueprints and never need cargo.
// It runs in a mirror of the repository (this package copied, everything else linked) so the real dist is untouched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(pkg, '../..');
// Folders are linked (a junction on Windows needs no privilege); files are copied.
const link = (target, path) =>
  statSync(target).isDirectory() ? symlinkSync(target, path, 'junction') : copyFileSync(target, path);

/** PATH without any folder that holds cargo. */
function pathWithoutCargo() {
  const names = process.platform === 'win32' ? ['cargo.exe', 'cargo.cmd', 'cargo.bat', 'cargo'] : ['cargo'];
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const kept = (process.env[key] ?? '')
    .split(delimiter)
    .filter((dir) => dir && !names.some((name) => existsSync(join(dir, name))));
  return { key, value: kept.join(delimiter) };
}

test('the package build needs no Rust toolchain: cargo absent from PATH, committed blueprints copied', {
  timeout: 300_000,
}, (t) => {
  const mirror = mkdtempSync(join(tmpdir(), 'margo-decoders-no-rust-'));
  t.after(() => rmSync(mirror, { recursive: true, force: true }));
  for (const name of [
    'node_modules',
    'scripts',
    'tsconfig.json',
    'tsconfig.base.json',
    'package.json',
    'LICENSE',
    'NOTICE',
  ])
    if (existsSync(join(repository, name))) link(join(repository, name), join(mirror, name));
  mkdirSync(join(mirror, 'packages'));
  for (const name of readdirSync(join(repository, 'packages')))
    if (name !== 'decoders') link(join(repository, 'packages', name), join(mirror, 'packages', name));
  const copy = join(mirror, 'packages/decoders');
  mkdirSync(copy);
  for (const name of readdirSync(pkg)) {
    if (name === 'dist' || name === 'node_modules') continue;
    const from = join(pkg, name);
    // node runs the build script by its real path, so the scripts are copied, not linked; the rest is read only.
    if (name === 'scripts') cpSync(from, join(copy, name), { recursive: true });
    else if (statSync(from).isDirectory()) link(from, join(copy, name));
    else copyFileSync(from, join(copy, name));
  }
  const path = pathWithoutCargo();
  const env = { ...process.env, [path.key]: path.value };
  delete env.MARGOENGINE_WASM_FROM_SOURCE;
  delete env.CARGO;
  assert.equal(spawnSync('cargo', ['--version'], { env }).error?.code, 'ENOENT', 'cargo must be absent for this test');
  const run = spawnSync(process.execPath, ['scripts/build.js'], { cwd: copy, env, encoding: 'utf8', timeout: 280_000 });
  assert.equal(run.status, 0, `build failed without cargo:\n${run.stdout}\n${run.stderr}`);
  for (const file of ['draco-native.wasm', 'hdr6.wasm', 'avif.wasm'])
    assert.deepEqual(
      readFileSync(join(copy, 'dist', file)),
      readFileSync(join(pkg, 'src', file)),
      `${file} is the committed blueprint`,
    );
});
