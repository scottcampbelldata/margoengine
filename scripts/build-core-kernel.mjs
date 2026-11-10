// Builds the core kernel (packages/kernel) from source into its committed raw-deflate blueprint
// packages/core/src/wasm.ts and writes its record packages/kernel/wasm.json (scripts/wasm-blueprints.mjs). Run it after
// changing the kernel: `node scripts/build-core-kernel.mjs`. A from-source root build (`node scripts/build-modern.js`
// without --precompiled) runs it too; `npm run build:packages` keeps the committed blueprint and needs no Rust.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { BLUEPRINTS, writeRecord } from './wasm-blueprints.mjs';

const repository = resolve(import.meta.dirname, '..');
const wasmPath = resolve(repository, 'packages/kernel/target/wasm32-unknown-unknown/release/margoengine_kernel.wasm'),
  optimizedPath = wasmPath.replace('.wasm', '.optimized.wasm');

/** The committed blueprint's raw deflate settings; build-modern.js measures core + stage with the same ones. */
export const deflateKernel = (wasm) => deflateRawSync(wasm, { level: 9, memLevel: 6, windowBits: 12 });

export function buildCoreKernel() {
  execFileSync(
    'cargo',
    ['build', '--manifest-path', 'packages/kernel/Cargo.toml', '--target', 'wasm32-unknown-unknown', '--release'],
    {
      cwd: repository,
      stdio: 'inherit',
      env: {
        ...process.env,
        CARGO_TARGET_DIR: resolve(repository, 'packages/kernel/target'),
        RUSTFLAGS: '-C target-feature=+simd128',
      },
    },
  );
  // -ocimfs 300: keep the kernel's recompute path out of line so the per-entity unchanged path stays small (parts assembly, 100k entities: 3.5 vs 4.8 ms per tick).
  execFileSync(
    process.execPath,
    [
      'node_modules/binaryen/bin/wasm-opt',
      wasmPath,
      '-Oz',
      '-ocimfs',
      '300',
      '--enable-simd',
      '--enable-bulk-memory',
      '--enable-bulk-memory-opt',
      '--enable-nontrapping-float-to-int',
      '--strip-debug',
      '--strip-producers',
      '--strip-target-features',
      '--converge',
      '-o',
      optimizedPath,
    ],
    { cwd: repository, stdio: 'inherit' },
  );
  const wasm = readFileSync(optimizedPath);
  const compressed = deflateKernel(wasm);
  assert.deepEqual(inflateRawSync(compressed), wasm, 'Kernel compression must be lossless');
  writeFileSync(
    resolve(repository, 'packages/core/src/wasm.ts'),
    `// Generated raw-deflate blueprint; consumers need no Rust toolchain.\nexport const wasmBase64: string = '${compressed.toString('base64')}';\n`,
  );
  writeRecord(BLUEPRINTS.find((entry) => entry.name === 'core-kernel'));
  return wasm;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildCoreKernel();
