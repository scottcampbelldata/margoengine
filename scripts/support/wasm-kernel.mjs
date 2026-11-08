// How the Rust kernels that ship as Wasm are built (scripts/rust-kernel-tests.mjs, scripts/physics2d-kernel-browsers.mjs).
// It imports node:path only, so a suite that uses it takes on no other script's ports or files.
import { posix } from 'node:path';

/** The file name cargo gives a crate's library: the package name its Cargo.toml declares, dashes to underscores. */
export const crateFile = (text) => /^\s*name\s*=\s*"([^"]+)"/m.exec(text)[1].replaceAll('-', '_');

/** The Wasm target and flags the kernels ship with (packages/physics/scripts/build-kernel.mjs builds the 3D one so). */
export const WASM_TARGET = 'wasm32-unknown-unknown';
export const WASM_RUSTFLAGS = '-C target-feature=+simd128';

/** The cargo arguments of a crate's Wasm build as shipped: release, the Wasm target, the lock file as committed. */
export const wasmBuildArgs = (manifest) => ['build', '--locked', '--release', '--target', WASM_TARGET, '--manifest-path', manifest];

/** Where `wasmBuildArgs` puts a crate's module (the crate's own target folder); `text` is its Cargo.toml. */
export const wasmModule = (manifest, text) =>
  posix.join(posix.dirname(manifest), 'target', WASM_TARGET, 'release', `${crateFile(text)}.wasm`);
