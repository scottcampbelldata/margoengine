// Rust kernel tests of the workspace packages (`npm run check:rust-kernels`, part of check:merge; CPU only, no GPU
// lock): `cargo test --locked` for every workspace package that holds a Rust kernel, `<dir>/kernel/Cargo.toml` or
// `<dir>/Cargo.toml` (today packages/physics and packages/physics2d, the suites behind `test:physics-kernel` and
// `test:physics2d-kernel`). The core kernel (packages/kernel, not a workspace) is `npm run test:kernel`. A crate that
// reaches another package's folder by a `path =` dependency (the 2D kernel uses packages/physics/kernel-common) runs
// when that package changes too, so a change to shared kernel code reaches every kernel built on it.
//   node scripts/rust-kernel-tests.mjs                      every package kernel
//   node scripts/rust-kernel-tests.mjs --packages=physics   only those package directories (check:merge passes the
//                                                           changed ones; a kernel folder counts as its package)
//   --minutes=<n>                                           hard limit per crate (default 20); past it the process
//                                                           tree is ended and the run fails
//   --run-wasm=<module.wasm>                                runs one Wasm check module's checks (the child step)
// A kernel that ships as Wasm (its Cargo.toml lists a `cdylib` crate type) is also built for wasm32-unknown-unknown
// with the shipped flags (`WASM_RUSTFLAGS`), so a kernel that builds natively but not for Wasm fails here: the 2D kernel
// once called `f64::sqrt`, which a no_std Wasm build lacks, and had no memory allocator, and no check saw it. A kernel
// with a `wasm-check/` crate beside its Cargo.toml then builds that crate the same way and runs it in Node: it exports
// `checks()` and `check(i)` (0 = pass); the 2D kernel's steps the pinned-bits scenes of tests/bits.rs in Wasm against
// the native hashes. The Wasm run is a child process under the same hard limit.
// cargo is started directly, not through a shell, so the command search is the operating system's and not cmd.exe's.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { margoError } from '../packages/shared/errors.js';
import { loadWorkspaces } from './support/affected-gpu.mjs';
import { endTree } from './support/shutdown.mjs';

const root = resolve(import.meta.dirname, '..');

/** Default hard limit for one crate's tests, in minutes. */
export const DEFAULT_KERNEL_MINUTES = 20;

/** Workspace names, other than `own`, whose folders hold a crate that `text` (a Cargo.toml at repo path `manifest`)
 * names by a `path = "..."` dependency. */
export function pathDependencies(text, manifest, workspaces, own) {
  const base = posix.dirname(manifest);
  const paths = [...text.matchAll(/\bpath\s*=\s*"([^"]+)"/g)].map((m) => posix.normalize(posix.join(base, m[1])));
  return workspaces
    .filter((w) => w.name !== own && paths.some((p) => p === w.dir || p.startsWith(`${w.dir}/`)))
    .map((w) => w.name);
}

/** True when a Cargo.toml's text lists a `cdylib` crate type: the crate ships as a Wasm module. */
export const shipsWasm = (text) => /^\s*crate-type\s*=\s*\[[^\]]*"cdylib"/m.test(text);

/** The file name cargo gives a crate's library: the package name its Cargo.toml declares, dashes to underscores. */
export const crateFile = (text) => /^\s*name\s*=\s*"([^"]+)"/m.exec(text)[1].replaceAll('-', '_');

/** [{ name, dir, manifest, uses, wasm, wasmCheck }] for every workspace package with a Rust kernel; `manifest` is
 * repo-relative, `uses` names the packages its path dependencies live in, `wasm` is true when it ships as Wasm and
 * `wasmCheck` is the repo path of its `wasm-check/Cargo.toml`, or null. */
export function rustKernels(workspaces, dir = root, exists = existsSync, read = (p) => readFileSync(p, 'utf8')) {
  return workspaces.flatMap((w) => {
    const manifest = [`${w.dir}/kernel/Cargo.toml`, `${w.dir}/Cargo.toml`].find((m) => exists(join(dir, m)));
    if (!manifest) return [];
    const text = read(join(dir, manifest)),
      check = posix.join(posix.dirname(manifest), 'wasm-check/Cargo.toml'),
      wasm = shipsWasm(text);
    const uses = pathDependencies(text, manifest, workspaces, w.name);
    return [{ name: w.name, dir: w.dir, manifest, uses, wasm, wasmCheck: wasm && exists(join(dir, check)) ? check : null }];
  });
}

/** Package directories (after `packages/`) of the kernels whose package, or a package one of their path dependencies
 * lives in, is in `changed` (workspace names). */
export function changedKernelDirs(kernels, changed) {
  return kernels
    .filter((k) => (changed.includes(k.name) || (k.uses ?? []).some((u) => changed.includes(u))) && k.dir.startsWith('packages/'))
    .map((k) => k.dir.slice('packages/'.length));
}

/** The cargo arguments for one kernel. */
export const cargoArgs = (manifest) => ['test', '--locked', '--manifest-path', manifest];

/** The Wasm target and flags the kernels ship with (packages/physics/scripts/build-kernel.mjs builds the 3D one so). */
export const WASM_TARGET = 'wasm32-unknown-unknown';
export const WASM_RUSTFLAGS = '-C target-feature=+simd128';

/** The cargo arguments of a crate's Wasm build as shipped: release, the Wasm target, the lock file as committed. */
export const wasmBuildArgs = (manifest) => ['build', '--locked', '--release', '--target', WASM_TARGET, '--manifest-path', manifest];

/** Where `wasmBuildArgs` puts a crate's module (the crate's own target folder); `text` is its Cargo.toml. */
export const wasmModule = (manifest, text) =>
  posix.join(posix.dirname(manifest), 'target', WASM_TARGET, 'release', `${crateFile(text)}.wasm`);

/** Runs a Wasm check module's `check(i)` for every i below `checks()`, printing each; returns the failed indices. */
export async function runWasmChecks(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes);
  const { checks, check, bits } = instance.exports,
    failed = [];
  for (let i = 0; i < checks(); i++) {
    const t0 = performance.now(),
      code = check(i);
    const got = code !== 0 && bits ? ` (bits ${BigInt.asUintN(64, bits(i)).toString(16)})` : '';
    console.log(`  wasm check ${i}: ${code === 0 ? 'pass' : `FAIL code ${code}${got}`} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    if (code !== 0) failed.push(i);
  }
  return failed;
}

/** Kernels picked by `--packages=a,b`; a name with no kernel throws so a typo cannot pass as a green run. */
export function selectKernels(kernels, packages) {
  if (packages === undefined) return kernels;
  const names = packages.split(',').filter(Boolean),
    unknown = names.filter((n) => !kernels.some((k) => k.dir === `packages/${n}`));
  if (unknown.length || !names.length)
    throw margoError(
      'RUST_KERNEL_UNKNOWN',
      `--packages names ${unknown.length ? `${unknown.join(', ')}, which hold no Rust kernel` : 'nothing'}; use some of ${kernels.map((k) => k.dir.slice(9)).join(', ')}`,
    );
  return kernels.filter((k) => names.includes(k.dir.slice(9)));
}

function runTimed(command, args, limitMs, env = process.env) {
  return new Promise((done) => {
    const t0 = performance.now();
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false, env });
    let timedOut = false,
      ended = Promise.resolve([]);
    const timer = setTimeout(() => {
      timedOut = true;
      ended = endTree(child.pid);
    }, limitMs);
    const finish = async (code, error) => {
      clearTimeout(timer);
      await ended;
      done({ ok: !timedOut && !error && code === 0, timedOut, error, seconds: (performance.now() - t0) / 1000 });
    };
    child.once('error', (error) => finish(1, error));
    child.once('exit', (code) => finish(code));
  });
}

async function main(args) {
  const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (arg('run-wasm')) return (await runWasmChecks(readFileSync(arg('run-wasm')))).length ? 1 : 0;
  const minutes = Number(arg('minutes') ?? DEFAULT_KERNEL_MINUTES);
  if (!(minutes > 0)) throw new RangeError(`--minutes must be a positive number, got ${arg('minutes')}`);
  const kernels = selectKernels(rustKernels(loadWorkspaces(root)), arg('packages'));
  let failed = 0;
  const wasmEnv = { ...process.env, RUSTFLAGS: WASM_RUSTFLAGS };
  const step = async (label, command, args, env) => {
    console.log(`\n# ${label} (limit ${minutes} min)`);
    const { ok, timedOut, error, seconds } = await runTimed(command, args, minutes * 60_000, env);
    const why = timedOut ? `TIMEOUT after ${minutes} min, process tree ended` : error ? error.message : '';
    console.log(`# ${ok ? 'pass' : `FAIL ${why}`} in ${seconds.toFixed(1)} s`);
    return ok;
  };
  const wasmBuild = (manifest) =>
    step(`RUSTFLAGS="${WASM_RUSTFLAGS}" cargo ${wasmBuildArgs(manifest).join(' ')}`, 'cargo', wasmBuildArgs(manifest), wasmEnv);
  for (const { manifest, wasm, wasmCheck } of kernels) {
    let ok = await step(`cargo ${cargoArgs(manifest).join(' ')}`, 'cargo', cargoArgs(manifest));
    if (ok && wasm) ok = await wasmBuild(manifest);
    if (ok && wasmCheck) {
      const module = join(root, wasmModule(wasmCheck, readFileSync(join(root, wasmCheck), 'utf8')));
      ok = (await wasmBuild(wasmCheck)) && (await step(`wasm checks of ${wasmCheck}`, process.execPath, [import.meta.filename, `--run-wasm=${module}`]));
    }
    console.log(`# ${manifest}: ${ok ? 'pass' : 'FAIL'}`);
    if (!ok) failed++;
  }
  console.log(`\nrust kernels: ${kernels.length - failed} of ${kernels.length} passed`);
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
