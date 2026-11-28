import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DYNAMIC_BASE, inspectModule, MAX_MEMORY_PAGES, PAGE, rustFlags } from '../../../scripts/physics-modules.mjs';
import { runWithTimeout } from '../../../scripts/run-with-timeout.mjs';
import { blueprintRustEnv } from '../../../scripts/rust-wasm-env.mjs';

const crate = fileURLToPath(new URL('../accretion-kernel/', import.meta.url));
const variant = process.argv[2];
if (variant && variant !== 'plain' && variant !== 'shared')
  throw new Error('Choose a plain or shared accretion build.');
for (const shared of variant ? [variant === 'shared'] : [false, true]) {
  const flags = rustFlags({ slot: -1 }, shared).replace('-C target-feature=', '-C target-feature=+simd128,');
  const manifest = join(crate, 'Cargo.toml');
  const result = await runWithTimeout(
    ['cargo', 'build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', manifest],
    { env: blueprintRustEnv(crate, flags), timeoutMs: 120_000 },
  );
  if (result.code !== 0) throw new Error('Accretion kernel failed to build. Use the pinned toolchain.');
  const file = join(crate, 'target/wasm32-unknown-unknown/release/margoengine_accretion_kernel.wasm');
  const bytes = readFileSync(file);
  const memory = new WebAssembly.Memory({ initial: DYNAMIC_BASE / PAGE, maximum: MAX_MEMORY_PAGES, shared });
  const sentinel = new Uint8Array(memory.buffer).fill(0x4d);
  new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
  const { active, exports } = inspectModule(bytes);
  if (active.length || exports.__data_end?.value !== 0 || !sentinel.every((value) => value === 0x4d))
    throw new Error(
      'The accretion kernel needs no static data. Its initialization must leave every arena byte intact.',
    );
  const name = shared ? 'accretion-kernel-shared.wasm' : 'accretion-kernel.wasm';
  copyFileSync(file, new URL('../src/accretion/' + name, import.meta.url));
}
