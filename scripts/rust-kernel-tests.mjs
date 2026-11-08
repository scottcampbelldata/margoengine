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

/** [{ name, dir, manifest, uses }] for every workspace package with a Rust kernel; `manifest` is repo-relative and
 * `uses` names the packages its path dependencies live in. */
export function rustKernels(workspaces, dir = root, exists = existsSync, read = (p) => readFileSync(p, 'utf8')) {
  return workspaces.flatMap((w) => {
    const manifest = [`${w.dir}/kernel/Cargo.toml`, `${w.dir}/Cargo.toml`].find((m) => exists(join(dir, m)));
    if (!manifest) return [];
    return [{ name: w.name, dir: w.dir, manifest, uses: pathDependencies(read(join(dir, manifest)), manifest, workspaces, w.name) }];
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

function runCargo(manifest, limitMs) {
  return new Promise((done) => {
    const t0 = performance.now();
    const child = spawn('cargo', cargoArgs(manifest), { cwd: root, stdio: 'inherit', shell: false });
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
  const minutes = Number(arg('minutes') ?? DEFAULT_KERNEL_MINUTES);
  if (!(minutes > 0)) throw new RangeError(`--minutes must be a positive number, got ${arg('minutes')}`);
  const kernels = selectKernels(rustKernels(loadWorkspaces(root)), arg('packages'));
  let failed = 0;
  for (const { manifest } of kernels) {
    console.log(`\n# cargo ${cargoArgs(manifest).join(' ')} (limit ${minutes} min)`);
    const { ok, timedOut, error, seconds } = await runCargo(manifest, minutes * 60_000);
    const why = timedOut ? `TIMEOUT after ${minutes} min, process tree ended` : error ? error.message : '';
    console.log(`# ${manifest}: ${ok ? 'pass' : `FAIL ${why}`} in ${seconds.toFixed(1)} s`);
    if (!ok) failed++;
  }
  console.log(`\nrust kernels: ${kernels.length - failed} of ${kernels.length} passed`);
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
