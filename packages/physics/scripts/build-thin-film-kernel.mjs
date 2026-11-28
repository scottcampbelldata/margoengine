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

const crate = fileURLToPath(new URL('../thin-film-kernel/', import.meta.url));
// The linker base is zero. This kernel may import the arena only if it writes no static bytes.
const linker = { name: 'thin-film', slot: -1 };
const output = new URL('../src/thin-film/', import.meta.url);
mkdirSync(output, { recursive: true });

const variant = process.argv[2];
if (variant && variant !== 'plain' && variant !== 'shared' && variant !== 'threaded')
  throw new Error('Choose the plain, shared or threaded thin-film build.');
for (const name of variant ? [variant] : ['plain', 'shared', 'threaded']) {
  const shared = name !== 'plain';
  const threaded = name === 'threaded';
  const flags = rustFlags(linker, shared).replace('-C target-feature=', '-C target-feature=+simd128,');
  const manifest = join(crate, 'Cargo.toml');
  const result = await runWithTimeout(
    [
      'cargo',
      'build',
      '--locked',
      '--release',
      '--target',
      'wasm32-unknown-unknown',
      '--manifest-path',
      manifest,
      ...(threaded ? ['--features', 'threaded'] : []),
    ],
    { env: blueprintRustEnv(crate, flags), timeoutMs: 120_000 },
  );
  if (result.code !== 0) throw new Error('ThinFilm kernel build failed. Use the pinned Rust toolchain.');
  const file = join(crate, 'target/wasm32-unknown-unknown/release/margoengine_thin_film_kernel.wasm');
  const bytes = readFileSync(file);
  const { active, exports, imports } = inspectModule(bytes);
  const problems = moduleProblems(linker, bytes, shared).filter(
    (problem) => !threaded || !problem.startsWith('imports '),
  );
  if (threaded) {
    const memory = imports.find((entry) => entry.kind === 'memory');
    const join = imports.find((entry) => entry.kind === 'function');
    if (
      imports.length !== 2 ||
      memory?.module !== 'env' ||
      memory.field !== 'memory' ||
      !memory.shared ||
      memory.max !== MAX_MEMORY_PAGES ||
      join?.module !== 'env' ||
      join.field !== 'thin_film_join'
    )
      problems.push('the threaded lead uses only shared env.memory and the synchronous env.thin_film_join barrier');
  }
  if (active.length || exports.__data_end?.value !== globalBase(linker))
    problems.push('The stateless thin-film module must have an empty data section; move its state into world regions');
  if (problems.length)
    throw new Error('Invalid thin-film kernel placement. Use the arena for all mutable state. ' + problems.join('. '));
  const memory = new WebAssembly.Memory({ initial: DYNAMIC_BASE / PAGE, maximum: MAX_MEMORY_PAGES, shared });
  const sentinel = new Uint8Array(memory.buffer).fill(0xd7);
  const { exports: native } = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
    env: { memory, thin_film_join() {} },
  });
  if (typeof native.thin_film_thread_phase !== 'function' || typeof native.thin_film_step !== 'function')
    throw new Error('Build the thin-film module with its step and independent matrix phases.');
  if (!sentinel.every((value) => value === 0xd7))
    throw new Error('ThinFilm initialization overwrote the world; put all working data in solver-owned regions.');
  copyFileSync(file, new URL(name === 'plain' ? 'thin-film-kernel.wasm' : `thin-film-kernel-${name}.wasm`, output));
}
