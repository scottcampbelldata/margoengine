// The committed Wasm blueprints (scripts/wasm-blueprints.mjs): every shipped Rust crate is listed, and a record goes
// stale when anything that decides the blueprint's bytes changes, so a crate edited without a rebuild cannot land.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { blueprintRustEnv, hostSourcePath, portableRemaps } from '../scripts/rust-wasm-env.mjs';
import {
  BLUEPRINTS,
  blueprintBytes,
  NOT_SHIPPED,
  packedBlueprint,
  staleBlueprints,
  unlistedCrates,
  writeRecord,
} from '../scripts/wasm-blueprints.mjs';

test('every Rust crate under packages/ is listed as a shipped blueprint or as not shipped', () => {
  assert.deepEqual(unlistedCrates(), []);
  // One crate may build several blueprints (a SIMD and a scalar kernel), but each blueprint and each name once, and no
  // crate both shipped and not shipped.
  const shipped = new Set(BLUEPRINTS.map((entry) => entry.crate));
  for (const key of ['name', 'blueprint']) {
    const values = BLUEPRINTS.map((entry) => entry[key]);
    assert.equal(new Set(values).size, values.length, `a blueprint ${key} is listed twice`);
  }
  assert.equal(new Set(NOT_SHIPPED).size, NOT_SHIPPED.length, 'a crate is listed twice as not shipped');
  assert.deepEqual(
    NOT_SHIPPED.filter((crate) => shipped.has(crate)),
    [],
    'a crate is listed both as shipped and as not shipped',
  );
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
    'scripts/rust-wasm-env.mjs': "export const remaps = ['--remap-path-prefix=src=src/'];\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  // A repository, as the real one is: what git ignores is no source of a blueprint.
  writeFileSync(join(root, '.gitignore'), 'packages/p/common/Cargo.lock\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
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

test('a record goes stale when the crate, a path dependency, the build flags, the toolchain or the shared environment change', (t) => {
  for (const [file, text] of [
    ['packages/p/kernel/src/lib.rs', 'pub fn f() -> u32 { 3 }\n'],
    ['packages/p/kernel/src/new.rs', 'pub fn g() {}\n'],
    ['packages/p/common/src/lib.rs', 'pub const C: u32 = 4;\n'],
    ['packages/p/scripts/build.mjs', "const RUSTFLAGS = '';\n"],
    ['rust-toolchain.toml', '[toolchain]\nchannel = "1.100.0"\n'],
    ['scripts/rust-wasm-env.mjs', 'export const remaps = [];\n'],
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

test('a Cargo.lock git ignores (a local cargo test in a library crate) leaves a record fresh; one it keeps does not', (t) => {
  const { root, entry } = fixture(t);
  writeFileSync(join(root, 'packages/p/common/Cargo.lock'), '# written by cargo test\nversion = 4\n');
  assert.deepEqual(staleBlueprints(root, [entry]), [], 'an ignored lockfile in the path dependency');
  writeFileSync(join(root, 'packages/p/kernel/Cargo.lock'), 'version = 4\n');
  assert.match(staleBlueprints(root, [entry])[0] ?? '', /changed since/, "the kernel's own lockfile counts");
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

// Cargo names a crate's own files with the host separator, so panic locations read src\lib.rs on Windows and src/lib.rs
// elsewhere: the same sources gave different committed bytes by system (known-bugs, "other committed Wasm blueprints
// differed by build system"). Every build runs in scripts/rust-wasm-env.mjs, and no blueprint may hold such a path.
test('no committed blueprint holds a host-specific Rust source path', () => {
  for (const entry of BLUEPRINTS)
    assert.equal(hostSourcePath(blueprintBytes(entry)), null, `${entry.name}: ${entry.blueprint}`);
});

// Not only the listed blueprints: every .wasm git holds (vendored decoders and encoders included) must be free of a
// host-specific Rust source path, so none can be rebuilt differently by system.
test('no committed .wasm file in the repository holds a host-specific Rust source path', () => {
  const files = execFileSync('git', ['ls-files', '-z', '*.wasm'], { encoding: 'utf8', maxBuffer: 1 << 24 })
    .split('\0')
    .filter(Boolean);
  assert.ok(files.length >= 25, `found ${files.length} committed .wasm files`);
  for (const file of files) assert.equal(hostSourcePath(readFileSync(file)), null, file);
});

test('a blueprint with a backslash source path is stale and cannot be recorded', (t) => {
  const { root, entry } = fixture(t);
  const name = Buffer.from(' panicked at src\\lib.rs');
  const section = Buffer.concat([Buffer.from([1, 0x6e]), name]);
  writeFileSync(
    join(root, entry.blueprint),
    Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0, section.length]), section]),
  );
  assert.throws(() => writeRecord(entry, root), { code: 'WASM_BLUEPRINT_HOST_PATH' });
  assert.match(
    staleBlueprints(root, [entry])[0] ?? '',
    /holds the host path src\\lib\.rs, so its bytes differ by system/,
  );
});

test('the build environment maps every source folder onto forward slashes and drops what changes the build', (t) => {
  const crate = mkdtempSync(join(tmpdir(), 'margo-rust-env-'));
  t.after(() => rmSync(crate, { recursive: true, force: true }));
  for (const file of ['src/lib.rs', 'src/b/m.rs', 'src/a/x/y.rs']) {
    mkdirSync(dirname(join(crate, file)), { recursive: true });
    writeFileSync(join(crate, file), '');
  }
  assert.deepEqual(portableRemaps(crate), [
    '--remap-path-prefix=src=src/',
    '--remap-path-prefix=src/a=src/a/',
    '--remap-path-prefix=src/b=src/b/',
    '--remap-path-prefix=src/a/x=src/a/x/',
  ]);
  const env = blueprintRustEnv(crate, '-C target-feature=+simd128', {
    base: {
      PATH: 'p',
      RUSTC: 'other-rustc',
      RUSTUP_TOOLCHAIN: 'nightly',
      CARGO_ENCODED_RUSTFLAGS: '-Copt-level=0',
      CARGO_PROFILE_RELEASE_LTO: 'false',
      CARGO_BUILD_RUSTFLAGS: '-g',
      CARGO_TARGET_DIR: '/elsewhere',
    },
  });
  assert.deepEqual(Object.keys(env).sort(), ['CARGO_TARGET_DIR', 'PATH', 'RUSTFLAGS']);
  assert.equal(env.CARGO_TARGET_DIR, join(crate, 'target'));
  assert.equal(env.RUSTFLAGS, `${portableRemaps(crate).join(' ')} -C target-feature=+simd128`);
});

test('every blueprint build script builds through the shared environment', () => {
  for (const script of new Set(BLUEPRINTS.filter((entry) => entry.name !== 'meshopt-simd').map((e) => e.script)))
    assert.match(readFileSync(script, 'utf8'), /blueprintRustEnv\(/, script);
});

test('a gzip blueprint names no build system in its header', () => {
  const machinery = BLUEPRINTS.find((entry) => entry.deflated === 'gzip');
  // RFC 1952 2.3.1: byte 9 is the OS of the compressing system; 255 is unknown.
  assert.equal(packedBlueprint(machinery)[9], 255);
});

// Regression: the formatter wraps a long assignment after `=`, and a pattern that expected one line found nothing.
test('a TypeScript blueprint is read however its assignment wraps', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'margo-wasm-wrapped-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const module = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
    entry = { blueprint: 'wasm.ts', deflated: 'gzip', exportName: 'machineryWasm' },
    base64 = gzipSync(module).toString('base64');
  for (const head of [
    'machineryWasm: string = ',
    'machineryWasm: string =\n  ',
    'machineryWasm: string =\r\n  ',
    'machineryWasm:\n  string\n  =\n  ',
    'machineryWasm =\n  ',
  ]) {
    writeFileSync(join(root, entry.blueprint), `export const ${head}'${base64}';\n`);
    assert.deepEqual(blueprintBytes(entry, root), module, JSON.stringify(head));
    assert.deepEqual(packedBlueprint(entry, root), Buffer.from(base64, 'base64'), JSON.stringify(head));
  }
  writeFileSync(join(root, entry.blueprint), `export const oldmachineryWasm = '${base64}';\n`);
  assert.throws(() => packedBlueprint(entry, root), { code: 'WASM_BLUEPRINT_UNREADABLE' });
});
