// Rebuild the one optional encoder feature from its own clean-room Rust source.
import { execFileSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../native/basis/', import.meta.url);
execFileSync(
  'cargo',
  [
    'build',
    '--manifest-path',
    fileURLToPath(new URL('Cargo.toml', root)),
    '--target',
    'wasm32-unknown-unknown',
    '--release',
  ],
  {
    stdio: 'inherit',
    windowsHide: true,
    timeout: 180000,
    env: { ...process.env, RUSTFLAGS: '-C target-feature=+simd128' },
  },
);
copyFileSync(
  new URL('target/wasm32-unknown-unknown/release/margoengine_basis_encoder.wasm', root),
  new URL('margo_basis_encoder.wasm', root),
);
