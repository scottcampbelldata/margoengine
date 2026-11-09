import { spawn } from 'node:child_process';
import { copyFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { endTree } from '../../../scripts/support/shutdown.mjs';
const root = new URL('../', import.meta.url);
const manifest = new URL('mesh-kernel/Cargo.toml', root);
const args = process.argv.includes('--test')
  ? ['test', '--locked']
  : ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown'];
const child = spawn('cargo', [...args, '--manifest-path', fileURLToPath(manifest)], {
  stdio: 'inherit',
  windowsHide: true,
  detached: process.platform !== 'win32',
  env: { ...process.env, RUSTFLAGS: '-C target-feature=+simd128' },
});
let expired = false,
  killed;
const timer = setTimeout(() => {
  expired = true;
  killed = endTree(child.pid);
}, 300000);
try {
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  await killed;
  if (expired || code !== 0)
    throw Error(`Mesh kernel cargo ${expired ? 'exceeded five minutes' : 'failed with ' + code}`);
} finally {
  clearTimeout(timer);
}
if (!process.argv.includes('--test')) {
  const path = new URL('mesh-kernel/target/wasm32-unknown-unknown/release/margo_trace_mesh.wasm', root);
  if (!WebAssembly.validate(readFileSync(path))) throw Error('Invalid mesh Wasm');
  copyFileSync(path, new URL('src/mesh.wasm', root));
}
