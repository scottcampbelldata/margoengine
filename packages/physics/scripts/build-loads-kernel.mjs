import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DYNAMIC_BASE,
  inspectModule,
  MAX_MEMORY_PAGES,
  moduleProblems,
  PAGE,
  rustFlags,
} from '../../../scripts/physics-modules.mjs';
import { runWithTimeout } from '../../../scripts/run-with-timeout.mjs';
import { blueprintRustEnv } from '../../../scripts/rust-wasm-env.mjs';

const crate = fileURLToPath(new URL('../loads-kernel/', import.meta.url));
const manifest = join(crate, 'Cargo.toml');
// This kernel stores everything in caller regions and its allocated stack. It can link at zero without claiming a slot.
const dataFree = { name: 'loads', slot: -1 };
const variant = process.argv[2];
if (variant && variant !== 'plain' && variant !== 'shared')
  throw new Error('Choose the plain or shared loads kernel build.');

for (const shared of variant ? [variant === 'shared'] : [false, true]) {
  const flags = rustFlags(dataFree, shared).replace('-C target-feature=', '-C target-feature=+simd128,');
  const result = await runWithTimeout(
    ['cargo', 'build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', manifest],
    { env: blueprintRustEnv(crate, flags), timeoutMs: 120_000 },
  );
  if (result.code !== 0) throw new Error('Loads kernel build failed. Use the pinned Rust toolchain.');
  const file = join(crate, 'target/wasm32-unknown-unknown/release/margoengine_loads_kernel.wasm');
  const bytes = readFileSync(file);
  const problems = moduleProblems(dataFree, bytes, shared);
  if (problems.length) throw new Error(`Rebuild the loads kernel with its arena link flags. ${problems.join('. ')}`);
  const { active, exports } = inspectModule(bytes);
  if (active.length || exports.__data_end?.value !== 0)
    throw new Error('Keep all loads kernel data in caller regions or on its assigned stack.');
  const memory = new WebAssembly.Memory({ initial: DYNAMIC_BASE / PAGE, maximum: MAX_MEMORY_PAGES, shared });
  const marked = new Uint8Array(memory.buffer).fill(0x75);
  new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
  if (!marked.every((byte) => byte === 0x75))
    throw new Error('Keep loads kernel instantiation free of writes to the shared arena.');
  const output = shared ? 'loads-kernel-shared.wasm' : 'loads-kernel.wasm';
  copyFileSync(file, new URL(`../src/loads/${output}`, import.meta.url));
}
