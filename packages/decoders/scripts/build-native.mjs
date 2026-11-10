// Builds the clean-room native decoders (native/draco, native/hdr6, native/avif) from source into their committed
// blueprints src/draco-native.wasm, src/hdr6.wasm and src/avif.wasm, and writes each record beside it. Run it after
// changing a crate: `node scripts/build-native.mjs [draco|hdr6|avif ...]` (all three when none is named). Needs cargo and
// the wasm32-unknown-unknown target; the package build copies the committed files and needs neither
// (scripts/wasm-blueprints.mjs checks that each record still matches its crate).
import { spawn } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLUEPRINTS, writeRecord } from '../../../scripts/wasm-blueprints.mjs';
import { endTree } from '../../../scripts/support/shutdown.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The flags each crate ships with; a change here changes the blueprint's record too. */
export const NATIVE_FEATURES = {
  draco: { file: 'draco-native.wasm', rustflags: '' },
  hdr6: { file: 'hdr6.wasm', rustflags: '' },
  avif: { file: 'avif.wasm', rustflags: '-C target-feature=+simd128 -C link-arg=--max-memory=1073741824' },
};

/** Builds one feature's crate and copies the module to its committed blueprint. */
export async function buildNative(feature) {
  const { file, rustflags } = NATIVE_FEATURES[feature];
  const manifest = resolve(root, `native/${feature}/Cargo.toml`);
  const args = [
    'build',
    '--offline',
    '--locked',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
    '--manifest-path',
    manifest,
  ];
  const native = spawn('cargo', args, {
    windowsHide: true,
    stdio: 'inherit',
    env: { ...process.env, RUSTFLAGS: rustflags },
  });
  let nativeTimeout = false,
    nativeEnded = Promise.resolve([]);
  const nativeTimer = setTimeout(() => {
    nativeTimeout = true;
    if (native.pid) nativeEnded = endTree(native.pid);
  }, 300_000);
  try {
    const code = await new Promise((done, reject) => {
      native.once('error', reject);
      native.once('close', done);
    });
    const survivors = await nativeEnded;
    if (nativeTimeout || code !== 0 || survivors.length)
      throw new Error(`Clean-room ${feature} build failed or exceeded 300 s`);
  } finally {
    clearTimeout(nativeTimer);
  }
  await copyFile(
    resolve(root, `native/${feature}/target/wasm32-unknown-unknown/release/margoengine_${feature}.wasm`),
    resolve(root, 'src', file),
  );
  writeRecord(BLUEPRINTS.find((entry) => entry.name === feature));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const named = process.argv.slice(2);
  for (const feature of named.length ? named : Object.keys(NATIVE_FEATURES)) {
    if (!NATIVE_FEATURES[feature]) throw new Error(`Unknown native decoder ${feature}`);
    await buildNative(feature);
  }
}
