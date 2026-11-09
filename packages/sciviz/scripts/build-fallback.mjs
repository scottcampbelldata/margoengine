import { spawn } from 'node:child_process';
import { copyFileSync, readFileSync } from 'node:fs';
import { endTree } from '../../../scripts/support/shutdown.mjs';

const manifest = new URL('../kernel/Cargo.toml', import.meta.url);
const { fileURLToPath } = await import('node:url');
const testing = process.argv.includes('--test');
const args = testing
  ? ['test', '--locked', '--manifest-path', fileURLToPath(manifest)]
  : [
      'build',
      '--locked',
      '--release',
      '--target',
      'wasm32-unknown-unknown',
      '--manifest-path',
      fileURLToPath(manifest),
    ];
const child = spawn('cargo', args, {
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, ...(!testing && { RUSTFLAGS: '-C target-feature=+simd128' }) },
});
let timedOut = false;
let ended;
const timer = setTimeout(() => {
  timedOut = true;
  ended = endTree(child.pid);
}, 300_000);
try {
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  await ended;
  if (timedOut || code !== 0)
    throw new Error(`fallback kernel ${timedOut ? 'exceeded five minutes' : `exited ${code}`}`);
  if (!testing) {
    const source = new URL(
      '../kernel/target/wasm32-unknown-unknown/release/margo_sciviz_marching_cubes.wasm',
      import.meta.url,
    );
    if (!WebAssembly.validate(readFileSync(source))) throw new Error('Invalid marching cubes Wasm');
    copyFileSync(source, new URL('../src/fallback.wasm', import.meta.url));
  }
} finally {
  clearTimeout(timer);
}
