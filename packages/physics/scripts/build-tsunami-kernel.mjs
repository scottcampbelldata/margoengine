import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

const crate = fileURLToPath(new URL('../tsunami-kernel/', import.meta.url));
// The linker base is zero. This kernel may import the arena only if it writes no static bytes.
const linker = { name: 'tsunami', slot: -1 };
const output = new URL('../src/tsunami/', import.meta.url);
mkdirSync(output, { recursive: true });

const variant = process.argv[2];
if (variant && variant !== 'plain' && variant !== 'shared')
  throw new Error('Choose the plain or shared tsunami build.');
for (const shared of variant ? [variant === 'shared'] : [false, true]) {
  const flags = rustFlags(linker, shared).replace('-C target-feature=', '-C target-feature=+simd128,');
  const manifest = join(crate, 'Cargo.toml');
  const result = await runWithTimeout(
    ['cargo', 'build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', manifest],
    { env: blueprintRustEnv(crate, flags), timeoutMs: 120_000 },
  );
  if (result.code !== 0) throw new Error('Tsunami kernel build failed. Use the pinned Rust toolchain.');
  const file = join(crate, 'target/wasm32-unknown-unknown/release/margoengine_tsunami_kernel.wasm');
  const bytes = readFileSync(file);
  const problems = moduleProblems(linker, bytes, shared);
  const { active, exports } = inspectModule(bytes);
  if (active.length || exports.__data_end?.value !== globalBase(linker))
    problems.push('The stateless tsunami module must have an empty data section; move its state into world regions');
  if (problems.length)
    throw new Error('Invalid tsunami kernel placement. Use the arena for all mutable state. ' + problems.join('. '));
  const memory = new WebAssembly.Memory({ initial: DYNAMIC_BASE / PAGE, maximum: MAX_MEMORY_PAGES, shared });
  const sentinel = new Uint8Array(memory.buffer).fill(0xd7);
  new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
  if (!sentinel.every((value) => value === 0xd7))
    throw new Error('Tsunami initialization overwrote the world; put all working data in solver-owned regions.');
  copyFileSync(file, new URL(shared ? 'tsunami-kernel-shared.wasm' : 'tsunami-kernel.wasm', output));
}
