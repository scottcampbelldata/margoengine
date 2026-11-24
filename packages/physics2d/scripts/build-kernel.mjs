import { spawn } from 'node:child_process';
import { copyFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { endTree } from '../../../scripts/support/shutdown.mjs';
import { blueprintRustEnv } from '../../../scripts/rust-wasm-env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// The shared kernel parts are a path dependency outside the crate: cargo names their files by absolute path, so that
// folder is remapped too, and the bytes do not depend on where the repository is checked out.
const common = fileURLToPath(new URL('../../physics/kernel-common', import.meta.url)).replace(/[\\/]$/, '');
const env = blueprintRustEnv(root + 'kernel', '-C target-feature=+simd128');
env.RUSTFLAGS += ` --remap-path-prefix=${common}=physics/kernel-common`;
const child = spawn(
  'cargo',
  [
    'build',
    '--locked',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
    '--manifest-path',
    root + 'kernel/Cargo.toml',
  ],
  {
    stdio: 'inherit',
    windowsHide: true,
    env,
  },
);
let expired = false,
  ended;
const timer = setTimeout(() => {
  expired = true;
  ended = endTree(child.pid);
}, 300000);
try {
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  await ended;
  if (expired || code !== 0) throw new Error(`Physics2D kernel build ${expired ? 'exceeded 5 minutes' : `exited ${code}`}`);
  const source = root + 'kernel/target/wasm32-unknown-unknown/release/margoengine_physics2d_kernel.wasm';
  if (!WebAssembly.validate(readFileSync(source))) throw new Error('Invalid physics2d kernel Wasm');
  copyFileSync(source, root + 'src/physics2d-kernel.wasm');
} finally {
  clearTimeout(timer);
}
