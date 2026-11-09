import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync(
  'cargo',
  [
    'build',
    '--manifest-path',
    root + 'native/solver/Cargo.toml',
    '--target',
    'wasm32-unknown-unknown',
    '--release',
    '--offline',
    '--locked',
  ],
  {
    stdio: 'inherit',
    timeout: 300000,
    env: { ...process.env, CARGO_TARGET_DIR: root + 'target', RUSTFLAGS: '-C target-feature=+simd128' },
  },
);
const bytes = readFileSync(root + 'target/wasm32-unknown-unknown/release/margo_wfc_solver.wasm');
writeFileSync(root + 'src/wfc.wasm', bytes);
const hash = (b) => createHash('sha256').update(b).digest('hex');
writeFileSync(
  root + 'native/solver/artifact.json',
  JSON.stringify(
    {
      source: hash(readFileSync(root + 'native/solver/src/lib.rs', 'utf8').replaceAll('\r\n', '\n')),
      manifest: hash(readFileSync(root + 'native/solver/Cargo.toml', 'utf8').replaceAll('\r\n', '\n')),
      wasm: hash(bytes),
      bytes: bytes.length,
    },
    null,
    2,
  ) + '\n',
);
console.log('WFC SIMD Wasm:', bytes.length, 'bytes');
