// The committed Wasm blueprints (scripts/wasm-blueprints.mjs): every shipped Rust crate is listed, and a record goes
// stale when anything that decides the blueprint's bytes changes, so a crate edited without a rebuild cannot land.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { BLUEPRINTS, NOT_SHIPPED, staleBlueprints, unlistedCrates, writeRecord } from '../scripts/wasm-blueprints.mjs';

test('every Rust crate under packages/ is listed as a shipped blueprint or as not shipped', () => {
  assert.deepEqual(unlistedCrates(), []);
  const crates = [...BLUEPRINTS.map((entry) => entry.crate), ...NOT_SHIPPED];
  assert.equal(new Set(crates).size, crates.length, 'a crate is listed twice');
});

/** A one-crate repository with a valid blueprint and its record. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'margo-wasm-blueprints-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    'rust-toolchain.toml': '[toolchain]\nchannel = "1.99.0"\n',
    'packages/p/kernel/Cargo.toml': '[package]\nname = "k"\n[dependencies]\ncommon = { path = "../common" }\n',
    'packages/p/kernel/src/lib.rs': 'pub fn f() -> u32 { 1 }\n',
    'packages/p/kernel/tests/t.rs': '#[test] fn t() {}\n',
    'packages/p/kernel/target/release/k.wasm': 'build output',
    'packages/p/common/Cargo.toml': '[package]\nname = "common"\n',
    'packages/p/common/src/lib.rs': 'pub const C: u32 = 2;\n',
    'packages/p/scripts/build.mjs': "const RUSTFLAGS = '-C target-feature=+simd128';\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  writeFileSync(join(root, 'packages/p/src.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  const entry = {
    name: 'k',
    crate: 'packages/p/kernel',
    blueprint: 'packages/p/src.wasm',
    script: 'packages/p/scripts/build.mjs',
  };
  writeRecord(entry, root);
  return { root, entry };
}

test('a record goes stale when the crate, a path dependency, the build flags or the toolchain change', (t) => {
  for (const [file, text] of [
    ['packages/p/kernel/src/lib.rs', 'pub fn f() -> u32 { 3 }\n'],
    ['packages/p/kernel/src/new.rs', 'pub fn g() {}\n'],
    ['packages/p/common/src/lib.rs', 'pub const C: u32 = 4;\n'],
    ['packages/p/scripts/build.mjs', "const RUSTFLAGS = '';\n"],
    ['rust-toolchain.toml', '[toolchain]\nchannel = "1.100.0"\n'],
  ]) {
    const { root, entry } = fixture(t);
    assert.deepEqual(staleBlueprints(root, [entry]), [], 'fresh record');
    writeFileSync(join(root, file), text);
    const [problem] = staleBlueprints(root, [entry]);
    assert.match(
      problem ?? '',
      /changed since .* was built; run node scripts\/wasm-blueprints\.mjs --rebuild --only=k/,
      file,
    );
  }
});

test('line endings, crate tests and build output do not make a record stale; a swapped blueprint does', (t) => {
  const { root, entry } = fixture(t);
  const source = join(root, 'packages/p/kernel/src/lib.rs');
  writeFileSync(source, readFileSync(source, 'utf8').replaceAll('\n', '\r\n'));
  writeFileSync(join(root, 'packages/p/kernel/tests/t.rs'), '#[test] fn u() {}\n');
  writeFileSync(join(root, 'packages/p/kernel/target/release/k.wasm'), 'other output');
  assert.deepEqual(staleBlueprints(root, [entry]), []);
  writeFileSync(join(root, entry.blueprint), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0, 0]));
  assert.match(staleBlueprints(root, [entry])[0] ?? '', /differs from the build its record names/);
});

test('a blueprint that holds a build path is refused', (t) => {
  const { root, entry } = fixture(t);
  const name = Buffer.from('C:\\Users\\someone\\.cargo\\registry\\x.rs');
  // A custom section carries the text, as a panic location string would.
  const section = Buffer.concat([Buffer.from([1, 0x6e]), name]);
  const module = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0, section.length]), section]);
  writeFileSync(join(root, entry.blueprint), module);
  assert.throws(() => writeRecord(entry, root), { code: 'WASM_BLUEPRINT_PATH' });
});
