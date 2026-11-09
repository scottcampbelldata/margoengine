import { spawn } from 'node:child_process';
import { readFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { endTree } from '../../../scripts/support/shutdown.mjs';

const testing = process.argv.includes('--test');
const manifest = fileURLToPath(new URL('../flow-kernel/Cargo.toml', import.meta.url));
const child = spawn(
  'cargo',
  testing
    ? ['test', '--locked', '--manifest-path', manifest]
    : ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', manifest],
  {
    stdio: 'inherit',
    windowsHide: true,
  },
);
let expired = false,
  termination;
const deadline = setTimeout(() => {
  expired = true;
  termination = endTree(child.pid);
}, 300_000);
try {
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  await termination;
  if (expired || code !== 0) throw new Error(`Flow kernel ${expired ? 'exceeded five minutes' : `exited ${code}`}`);
  if (!testing) {
    const binary = new URL(
      '../flow-kernel/target/wasm32-unknown-unknown/release/margo_sciviz_flow.wasm',
      import.meta.url,
    );
    if (!WebAssembly.validate(readFileSync(binary))) throw new Error('Flow kernel is not valid Wasm');
    copyFileSync(binary, new URL('../src/flow.wasm', import.meta.url));
  }
} finally {
  clearTimeout(deadline);
}
