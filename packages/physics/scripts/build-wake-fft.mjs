import { copyFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DYNAMIC_BASE,
  globalBase,
  inspectModule,
  MAX_MEMORY_PAGES,
  moduleProblems,
  PAGE,
  rustFlags,
} from '../../../scripts/physics-modules.mjs';
import { runWithTimeout } from '../../../scripts/run-with-timeout.mjs';
import { blueprintRustEnv } from '../../../scripts/rust-wasm-env.mjs';

const crate = fileURLToPath(new URL('../wake-fft/', import.meta.url));
const target = process.env.MARGO_WAKE_FFT_TARGET ? resolve(process.env.MARGO_WAKE_FFT_TARGET) : join(crate, 'target');
const variant = process.argv[2];
if (variant !== undefined && variant !== 'shared')
  throw new Error('Pass shared for the optional wake mode worker build.');
const shared = variant === 'shared';
const linker = { name: 'wake-modes', slot: -1 };
const flags = shared
  ? rustFlags(linker, true).replace('-C target-feature=', '-C target-feature=+simd128,')
  : '-C target-feature=+simd128';
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
    ...(shared ? ['--features', 'shared-modes'] : []),
  ],
  { env: blueprintRustEnv(crate, flags, { target }), timeoutMs: 120_000 },
);
if (result.code !== 0) throw new Error('Build the wake FFT with the pinned Rust toolchain and wasm32 target.');
const output = join(target, 'wasm32-unknown-unknown/release/margoengine_wake_fft.wasm');
const bytes = readFileSync(output);
const module = new WebAssembly.Module(bytes);
const exports = new Set(WebAssembly.Module.exports(module).map(({ name }) => name));
if (shared) {
  const problems = moduleProblems(linker, bytes, true);
  const inspected = inspectModule(bytes);
  if (inspected.active.length || inspected.exports.__data_end?.value !== globalBase(linker))
    problems.push('The shared wake mode asset must have no static bytes.');
  if (exports.has('wake_fft_init') || !exports.has('wake_mode_phase'))
    problems.push('Export the modal phase without duplicating the private FFT plan.');
  if (problems.length) throw new Error(`Rebuild the shared wake modes with an isolated arena. ${problems.join(' ')}`);
  const memory = new WebAssembly.Memory({ initial: DYNAMIC_BASE / PAGE, maximum: MAX_MEMORY_PAGES, shared: true });
  const sentinel = new Uint8Array(memory.buffer).fill(0xd7);
  for (let part = 0; part < 4; part++) new WebAssembly.Instance(module, { env: { memory } });
  if (!sentinel.every((value) => value === 0xd7))
    throw new Error('Keep all shared wake mode storage in its caller arena.');
} else if (
  WebAssembly.Module.imports(module).length ||
  !['memory', 'wake_fft_init', 'wake_fft_buffer', 'wake_fft_transform', 'wake_mode_buffer', 'wake_mode_phase'].every(
    (name) => exports.has(name),
  )
)
  throw new Error('Build the wake FFT with private memory and the transform and mode functions.');
copyFileSync(output, new URL(shared ? '../src/sea/wake-fft-shared.wasm' : '../src/sea/wake-fft.wasm', import.meta.url));
