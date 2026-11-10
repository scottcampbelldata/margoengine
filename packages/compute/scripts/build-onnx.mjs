import { execFileSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const cargo =
  process.env.CARGO ?? join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
execFileSync(
  cargo,
  [
    'build',
    '--locked',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
    '--manifest-path',
    root + 'onnx-kernel/Cargo.toml',
  ],
  {
    stdio: 'inherit',
    timeout: 120000,
    env: { ...process.env, RUSTFLAGS: '-C target-feature=+simd128 -C link-arg=--max-memory=2147483648' },
  },
);
copyFileSync(
  root + 'onnx-kernel/target/wasm32-unknown-unknown/release/margo_compute_onnx.wasm',
  root + 'src/onnx-kernel.wasm',
);
