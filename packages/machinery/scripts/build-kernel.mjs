// `node scripts/wasm-blueprints.mjs --rebuild --only=machinery-kernel`: cargo, wasm-opt, gzip, then src/wasm.ts, so
// consumers need no Rust toolchain. scripts/wasm-blueprints.mjs records a hash of the crate's sources beside the
// blueprint (src/wasm.ts.json); hygiene fails when the crate moved on without a rebuild. The Wasm keeps the toolchain's
// own /rustc/<commit>/library paths (panic locations in core); no path of the building machine.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const kernel = resolve(root, 'kernel');
const repository = resolve(root, '../..');

/** The flags the blueprint is built with; a change to them is a change to the blueprint. */
export const RUSTFLAGS = '-C target-feature=+simd128';

function build() {
  const target = resolve(kernel, 'target');
  execFileSync(
    'cargo',
    ['build', '--locked', '--manifest-path', resolve(kernel, 'Cargo.toml'), '--target', 'wasm32-unknown-unknown', '--release'],
    { stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: target, RUSTFLAGS } },
  );
  const wasmPath = resolve(target, 'wasm32-unknown-unknown/release/margoengine_machinery_kernel.wasm');
  const optimized = wasmPath.replace('.wasm', '.optimized.wasm');
  execFileSync(
    process.execPath,
    [
      resolve(repository, 'node_modules/binaryen/bin/wasm-opt'),
      wasmPath,
      '-O3',
      '--enable-simd',
      '--enable-bulk-memory',
      '--enable-nontrapping-float-to-int',
      '--strip-debug',
      '--strip-producers',
      '-o',
      optimized,
    ],
    { stdio: 'inherit' },
  );
  const wasm = readFileSync(optimized);
  assert.ok(WebAssembly.validate(wasm), 'Invalid Wasm artifact');
  const text = wasm.toString('latin1');
  for (const leak of ['Users', 'Development', '.cargo', '.rustup'])
    assert.ok(!text.includes(leak), `The blueprint holds a build path (${leak})`);
  const compressed = gzipSync(wasm);
  assert.deepEqual(gunzipSync(compressed), wasm, 'Kernel compression must be lossless');
  writeFileSync(
    resolve(root, 'src/wasm.ts'),
    `// Generated machinery kernel; consumers need no Rust toolchain.\nexport const machineryWasm: string = '${compressed.toString('base64')}';\n`,
  );
  console.log(`machinery kernel: ${wasm.length} B raw, ${compressed.length} B gzip`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) build();
