import { copyFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWithTimeout } from '../../../scripts/run-with-timeout.mjs';
import { blueprintRustEnv } from '../../../scripts/rust-wasm-env.mjs';

const crate = fileURLToPath(new URL('../mann-fft/', import.meta.url));
const target = process.env.MARGO_MANN_FFT_TARGET ? resolve(process.env.MARGO_MANN_FFT_TARGET) : join(crate, 'target');
const result = await runWithTimeout(
  [
    'cargo',
    'build',
    '--locked',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
    '--manifest-path',
    join(crate, 'Cargo.toml'),
  ],
  { env: blueprintRustEnv(crate, '-C target-feature=+simd128', { target }), timeoutMs: 120_000 },
);
if (result.code !== 0) throw new Error('Build Mann FFT with the pinned Rust toolchain and wasm32 target.');
const output = join(target, 'wasm32-unknown-unknown/release/margoengine_mann_fft.wasm');
const module = new WebAssembly.Module(readFileSync(output));
const exports = new Set(WebAssembly.Module.exports(module).map(({ name }) => name));
if (
  WebAssembly.Module.imports(module).length ||
  !['memory', 'mann_fft_init', 'mann_fft_buffer', 'mann_fft_transform'].every((name) => exports.has(name))
)
  throw new Error('Build Mann FFT with private memory and its three documented ABI functions.');
copyFileSync(output, new URL('../src/mann-fft.wasm', import.meta.url));
