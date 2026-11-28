import { copyFileSync, readFileSync } from 'node:fs';
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

const crate = fileURLToPath(new URL('../crush-shell-kernel/', import.meta.url));
const linker = { name: 'crush-shell', slot: -1 };
const variant = process.argv[2];
if (variant && variant !== 'plain' && variant !== 'shared' && variant !== 'threaded')
  throw new Error('Choose the plain, shared or threaded crush-shell kernel build.');
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
  if (result.code !== 0) throw new Error('Crush shell kernel build failed. Use the pinned Rust toolchain.');
  const file = join(crate, 'target/wasm32-unknown-unknown/release/margoengine_crush_shell_kernel.wasm');
  const bytes = readFileSync(file);
  const problems = moduleProblems(linker, bytes, shared).filter(
    (problem) => !threaded || !problem.startsWith('imports '),
  );
  const { active, exports, imports } = inspectModule(bytes);
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
      join.field !== 'crush_shell_join'
    )
      problems.push('the threaded lead uses only shared env.memory and the synchronous env.crush_shell_join barrier');
  }
  if (active.length || exports.__data_end?.value !== globalBase(linker))
    problems.push('Move all crush shell data into its arena-owned regions');
  if (problems.length) throw new Error('Check the crush shell memory import and placement. ' + problems.join('. '));
  const memory = new WebAssembly.Memory({ initial: DYNAMIC_BASE / PAGE, maximum: MAX_MEMORY_PAGES, shared });
  const sentinel = new Uint8Array(memory.buffer).fill(0xd7);
  const { exports: native } = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
    env: { memory, crush_shell_join: () => 0 },
  });
  if (typeof native.crush_shell_thread_phase !== 'function' || typeof native.crush_shell_advance !== 'function')
    throw new Error('Build the shell module with its interval and per-face phase exports.');
  if (!sentinel.every((value) => value === 0xd7))
    throw new Error('Crush shell initialization overwrote the world. Keep working data in solver-owned regions.');
  const asset = name === 'plain' ? 'crush-shell-kernel.wasm' : `crush-shell-kernel-${name}.wasm`;
  copyFileSync(file, new URL(`../src/crush/${asset}`, import.meta.url));
}
