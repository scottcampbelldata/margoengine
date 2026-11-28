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

// The CPU route of @margoengine/physics/gpu-cloth (cloth-kernel): SIMD on, as every physics kernel.
const crate = fileURLToPath(new URL('../cloth-kernel/', import.meta.url));
// The linker base is zero. This kernel may import the arena only if it writes no static bytes.
const linker = { name: 'cloth', slot: -1 };
const output = new URL('../src/cloth/', import.meta.url);
mkdirSync(output, { recursive: true });

// Two builds: the plain one for a cloth on one thread, and the shared-memory one (atomics) for a cloth whose passes are
// shared by worker threads (`GPUCloth` `threads`, cloth/thread.ts). Each cloth keeps a memory of its own either way.
const variants = { plain: [false], shared: [true] }[process.argv[2]] ?? [false, true];
for (const shared of variants) {
  const flags = rustFlags(linker, shared).replace('-C target-feature=', '-C target-feature=+simd128,');
  const manifest = join(crate, 'Cargo.toml');
  const result = await runWithTimeout(
    ['cargo', 'build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', manifest],
    { env: blueprintRustEnv(crate, flags), timeoutMs: 120_000 },
  );
  if (result.code !== 0) throw new Error('Cloth kernel build failed. Use the pinned Rust toolchain.');
  const file = join(crate, 'target/wasm32-unknown-unknown/release/margoengine_cloth_kernel.wasm');
  const bytes = readFileSync(file);
  const problems = moduleProblems(linker, bytes, shared);
  const { active, exports } = inspectModule(bytes);
  if (active.length || exports.__data_end?.value !== globalBase(linker))
    problems.push('The stateless cloth module must have an empty data section; move its state into world regions');
  if (problems.length) throw new Error('Cloth kernel placement is invalid. ' + problems.join('. '));
  const memory = new WebAssembly.Memory({ initial: DYNAMIC_BASE / PAGE, maximum: MAX_MEMORY_PAGES, shared });
  const sentinel = new Uint8Array(memory.buffer).fill(0xd7);
  new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
  if (!sentinel.every((value) => value === 0xd7))
    throw new Error('Cloth initialization overwrote the world; put all working data in solver-owned regions.');
  copyFileSync(file, new URL(shared ? 'cloth-kernel-shared.wasm' : 'cloth-kernel.wasm', output));
}
