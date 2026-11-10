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
    '--lib',
    '--target',
    'wasm32-unknown-unknown',
    '--manifest-path',
    root + 'draco-kernel/Cargo.toml',
  ],
  { stdio: 'inherit', windowsHide: true, env: { ...process.env, RUSTFLAGS: '-C target-feature=+simd128' } },
);
let expired = false,
  stopped;
const timer = setTimeout(() => {
  expired = true;
  stopped = endTree(child.pid);
}, 180000);
try {
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  await stopped;
  if (expired || code !== 0)
    throw new Error(`Draco encoder build ${expired ? 'exceeded 180 seconds' : `exited ${code}`}`);
  const source = root + 'draco-kernel/target/wasm32-unknown-unknown/release/margo_draco_encoder.wasm';
  if (!WebAssembly.validate(readFileSync(source))) throw new Error('Invalid Draco encoder Wasm');
  copyFileSync(source, root + 'src/draco-native-encoder.wasm');
} finally {
  clearTimeout(timer);
}
