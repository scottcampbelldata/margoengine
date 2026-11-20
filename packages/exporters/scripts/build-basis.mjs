// Rebuild the one optional encoder feature from its own clean-room Rust source: cargo against the committed lock,
// under a deadline that ends cargo's whole process tree, the output checked as Wasm before it replaces the
// committed blueprint, and the blueprint's record (margo_basis_encoder.wasm.json) written from what was built.
import { spawn } from 'node:child_process';
import { copyFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { endTree } from '../../../scripts/support/shutdown.mjs';
import { BLUEPRINTS, writeRecord } from '../../../scripts/wasm-blueprints.mjs';
import { blueprintRustEnv } from '../../../scripts/rust-wasm-env.mjs';

const root = new URL('../native/basis/', import.meta.url),
  LIMIT_MS = 180_000;
const child = spawn(
  'cargo',
  [
    'build',
    '--locked',
    '--manifest-path',
    fileURLToPath(new URL('Cargo.toml', root)),
    '--target',
    'wasm32-unknown-unknown',
    '--release',
  ],
  { stdio: 'inherit', windowsHide: true, env: blueprintRustEnv(fileURLToPath(root), '-C target-feature=+simd128') },
);
let expired = false,
  stopped;
// execFileSync's timeout signals cargo alone; on Windows its rustc children keep running, so end the whole tree.
const timer = setTimeout(() => {
  expired = true;
  stopped = endTree(child.pid);
}, LIMIT_MS);
try {
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  await stopped;
  if (expired || code !== 0)
    throw new Error(`Basis encoder build ${expired ? `exceeded ${LIMIT_MS / 1000} seconds` : `exited ${code}`}`);
  const built = new URL('target/wasm32-unknown-unknown/release/margoengine_basis_encoder.wasm', root);
  if (!WebAssembly.validate(readFileSync(built))) throw new Error('Invalid Basis encoder Wasm');
  copyFileSync(built, new URL('margo_basis_encoder.wasm', root));
  writeRecord(BLUEPRINTS.find((entry) => entry.name === 'basis-encoder'));
} finally {
  clearTimeout(timer);
}
