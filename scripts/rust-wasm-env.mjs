// The environment every committed Wasm blueprint (scripts/wasm-blueprints.mjs) is built in, so one source tree gives the
// same bytes on every system. scripts/wasm-blueprints.mjs hashes this file into every blueprint's record: a change here
// is a change to every blueprint.
//
// Two things made the bytes differ by system. (1) Rust keeps each source file's path for panic locations, and Cargo names
// a crate's own files relative to it with the host's separator (src\lib.rs on Windows, src/lib.rs elsewhere). rustc's
// --remap-path-prefix rewrites a path's leading components (The rustc book, "Command-line arguments": remap-path-prefix,
// the last matching mapping applies), so each source folder gets one mapping onto itself with forward slashes, the same
// flags on every system. (2) Variables from the building shell changed what Cargo and rustup build: CARGO_ENCODED_RUSTFLAGS
// replaces RUSTFLAGS outright, CARGO_PROFILE_* and CARGO_BUILD_* change the release profile and build settings, and
// RUSTC and RUSTUP_TOOLCHAIN pick another compiler than rust-toolchain.toml (The Cargo Book, "Environment variables" and
// "Configuration"; The rustup book, "Overrides"). Those are dropped, and the target folder is the one the build script
// copies from.
import { readdirSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';

/** The folders under a crate's src, shallow first, as forward-slash paths relative to the crate. */
export function sourceFolders(crate) {
  const folders = [];
  const walk = (relativeDir) => {
    folders.push(relativeDir);
    for (const entry of readdirSync(join(crate, relativeDir), { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    ))
      if (entry.isDirectory()) walk(posix.join(relativeDir, entry.name));
  };
  walk('src');
  return folders.sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
}

/** One --remap-path-prefix per source folder, mapping it onto itself with forward slashes. */
export const portableRemaps = (crate) =>
  sourceFolders(crate).map((folder) => `--remap-path-prefix=${folder}=${folder}/`);

const DROPPED = /^(RUSTC|CARGO_ENCODED_RUSTFLAGS|CARGO_TARGET_DIR|RUSTUP_TOOLCHAIN|CARGO_PROFILE_.*|CARGO_BUILD_.*)$/i;

/** The environment for building the crate at `crate` (an absolute folder) with its own `rustflags`, into `target` (the
 * folder the build script copies from; the crate's own target folder unless named). */
export function blueprintRustEnv(
  crate,
  rustflags = '',
  { target = resolve(crate, 'target'), base = process.env } = {},
) {
  const env = Object.fromEntries(Object.entries(base).filter(([name]) => !DROPPED.test(name)));
  env.CARGO_TARGET_DIR = target;
  env.RUSTFLAGS = [...portableRemaps(crate), rustflags].join(' ').trim();
  return env;
}

/** The first Rust source path with a backslash separator in a module's bytes, or null. */
export function hostSourcePath(bytes) {
  return /[\w.-]+\\[\w\\/.-]*\.rs/.exec(Buffer.from(bytes).toString('latin1'))?.[0] ?? null;
}
