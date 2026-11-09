import { spawn } from 'node:child_process';
import { copyFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { endTree } from '../../../scripts/support/shutdown.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
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
    env: { ...process.env, RUSTFLAGS: '-C target-feature=+simd128' },
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
  if (expired || code !== 0) throw new Error(`Erosion build ${expired ? 'exceeded 5 minutes' : `exited ${code}`}`);
  const source = root + 'kernel/target/wasm32-unknown-unknown/release/margo_biomes_erosion.wasm';
  if (!WebAssembly.validate(readFileSync(source))) throw new Error('Invalid erosion Wasm');
  copyFileSync(source, root + 'src/erosion.wasm');
} finally {
  clearTimeout(timer);
}
