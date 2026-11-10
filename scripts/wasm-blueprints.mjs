// Committed Wasm blueprints: every Rust crate that ships as Wasm is built once, by whoever changes it, and the .wasm is
// committed, so installing, building (`npm run build:packages`) and testing need no Rust toolchain. Rust is only needed
// to change a crate. Each blueprint has a record beside it (`<blueprint>.json`, or the crate's own record where it had
// one first) holding a hash of everything that decides its bytes: the crate's sources (and the crates it reaches by a
// `path =` dependency), rust-toolchain.toml and the build script that sets its flags. `npm run hygiene` fails when a
// record no longer matches, so a crate change without a rebuild cannot land.
//   node scripts/wasm-blueprints.mjs                       check every record (what hygiene runs)
//   node scripts/wasm-blueprints.mjs --rebuild             rebuild every blueprint from source and write its record
//   node scripts/wasm-blueprints.mjs --rebuild --only=avif,poisson   just those
//   node scripts/wasm-blueprints.mjs --rebuild --compare   rebuild and fail when any bytes differ from the committed ones
//                                                          (proves the committed blueprints are current and reproducible)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { margoError } from '../packages/shared/errors.js';

const repository = resolve(import.meta.dirname, '..');

/** Every shipped Wasm crate. `crate` is the crate folder, `blueprint` the committed file, `script` (+ `args`) the build
 * that writes it; `deflated` marks a TypeScript module holding the raw-deflate base64 blueprint; `own` names the crate's
 * own record check, older than this list, which then stays the one check of that crate. */
export const BLUEPRINTS = [
  {
    name: 'core-kernel',
    crate: 'packages/kernel',
    blueprint: 'packages/core/src/wasm.ts',
    record: 'packages/kernel/wasm.json',
    script: 'scripts/build-core-kernel.mjs',
    deflated: true,
  },
  {
    name: 'physics-kernel',
    crate: 'packages/physics/kernel',
    blueprint: 'packages/physics/src/wasm.ts',
    script: 'packages/physics/scripts/build-kernel.mjs',
    deflated: true,
    own: 'packages/physics/tests/kernel-blueprint.test.js',
  },
  {
    name: 'erosion',
    crate: 'packages/biomes/kernel',
    blueprint: 'packages/biomes/src/erosion.wasm',
    script: 'packages/biomes/scripts/build-erosion.mjs',
  },
  {
    name: 'compute-cpu',
    crate: 'packages/compute/cpu-kernel',
    blueprint: 'packages/compute/src/cpu-kernel.wasm',
    script: 'packages/compute/scripts/build-cpu.mjs',
  },
  {
    name: 'compute-decomp',
    crate: 'packages/compute/decomp-kernel',
    blueprint: 'packages/compute/src/decomp-kernel.wasm',
    script: 'packages/compute/scripts/build-decomp.mjs',
  },
  {
    name: 'compute-onnx',
    crate: 'packages/compute/onnx-kernel',
    blueprint: 'packages/compute/src/onnx-kernel.wasm',
    script: 'packages/compute/scripts/build-onnx.mjs',
  },
  {
    name: 'draco',
    crate: 'packages/decoders/native/draco',
    blueprint: 'packages/decoders/src/draco-native.wasm',
    script: 'packages/decoders/scripts/build-native.mjs',
    args: ['draco'],
  },
  {
    name: 'hdr6',
    crate: 'packages/decoders/native/hdr6',
    blueprint: 'packages/decoders/src/hdr6.wasm',
    script: 'packages/decoders/scripts/build-native.mjs',
    args: ['hdr6'],
  },
  {
    name: 'avif',
    crate: 'packages/decoders/native/avif',
    blueprint: 'packages/decoders/src/avif.wasm',
    script: 'packages/decoders/scripts/build-native.mjs',
    args: ['avif'],
  },
  {
    name: 'meshopt-simd',
    crate: 'packages/decoders/native/meshopt-simd',
    blueprint: 'packages/decoders/src/meshopt-simd-wasm.ts',
    script: 'packages/decoders/scripts/meshopt-simd-build.mjs',
    own: 'packages/decoders/tests/meshopt-simd.test.js',
  },
  {
    name: 'draco-encoder',
    crate: 'packages/exporters/draco-kernel',
    blueprint: 'packages/exporters/src/draco-native-encoder.wasm',
    script: 'packages/exporters/scripts/build-draco.mjs',
  },
  {
    name: 'basis-encoder',
    crate: 'packages/exporters/native/basis',
    blueprint: 'packages/exporters/native/basis/margo_basis_encoder.wasm',
    script: 'packages/exporters/scripts/build-basis.mjs',
  },
  {
    name: 'navmesh-raster',
    crate: 'packages/navmesh/native/raster',
    blueprint: 'packages/navmesh/src/navmesh-raster.wasm',
    script: 'packages/navmesh/scripts/build-raster.mjs',
    own: 'packages/navmesh/scripts/copy-raster.mjs',
  },
  {
    name: 'buildings',
    crate: 'packages/procedural/buildings-kernel',
    blueprint: 'packages/procedural/src/buildings.wasm',
    script: 'packages/procedural/scripts/build-buildings.mjs',
  },
  {
    name: 'caves',
    crate: 'packages/procedural/caves-kernel',
    blueprint: 'packages/procedural/src/caves.wasm',
    script: 'packages/procedural/scripts/build-caves.mjs',
  },
  {
    name: 'dungeon',
    crate: 'packages/procedural/dungeon-kernel',
    blueprint: 'packages/procedural/src/dungeon.wasm',
    script: 'packages/procedural/scripts/build-dungeon.mjs',
  },
  {
    name: 'poisson',
    crate: 'packages/procedural/poisson-kernel',
    blueprint: 'packages/procedural/src/poisson.wasm',
    script: 'packages/procedural/scripts/build-poisson.mjs',
  },
  {
    name: 'sdf',
    crate: 'packages/procedural/sdf-kernel',
    blueprint: 'packages/procedural/src/sdf.wasm',
    script: 'packages/procedural/scripts/build-sdf.mjs',
  },
  {
    name: 'trees',
    crate: 'packages/procedural/trees-kernel',
    blueprint: 'packages/procedural/src/trees.wasm',
    script: 'packages/procedural/scripts/build-trees.mjs',
  },
  {
    name: 'sciviz-fallback',
    crate: 'packages/sciviz/kernel',
    blueprint: 'packages/sciviz/src/fallback.wasm',
    script: 'packages/sciviz/scripts/build-fallback.mjs',
  },
  {
    name: 'sciviz-flow',
    crate: 'packages/sciviz/flow-kernel',
    blueprint: 'packages/sciviz/src/flow.wasm',
    script: 'packages/sciviz/scripts/build-flow.mjs',
  },
  {
    name: 'trace-mesh',
    crate: 'packages/voxel-pathtracer/mesh-kernel',
    blueprint: 'packages/voxel-pathtracer/src/mesh.wasm',
    script: 'packages/voxel-pathtracer/scripts/build-mesh.mjs',
  },
  {
    name: 'wfc',
    crate: 'packages/wfc/native/solver',
    blueprint: 'packages/wfc/src/wfc.wasm',
    script: 'packages/wfc/scripts/build-wasm.mjs',
    own: 'packages/wfc/test/chunks.test.js',
  },
];

/** Crates that are Rust but ship no Wasm of their own: a library others reach by path, a test-only kernel, a check. */
export const NOT_SHIPPED = [
  'packages/physics/kernel-common',
  'packages/physics2d/kernel',
  'packages/physics2d/kernel/wasm-check',
];

/** The repo path of an entry's record. */
export const recordPath = (entry) => entry.record ?? `${entry.blueprint}.json`;

const SKIP_DIRS = new Set(['target', 'tests', 'benches', 'examples', 'wasm-check', 'node_modules']);

/** Repo paths of the files that decide a crate's bytes: its manifest, lock, build.rs, .cargo config and everything under
 * src, plus the same of every crate it reaches by a `path =` dependency. */
export function crateFiles(crate, root = repository, seen = new Set()) {
  if (seen.has(crate)) return [];
  seen.add(crate);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path);
      } else files.push(path);
    }
  };
  for (const name of ['Cargo.toml', 'Cargo.lock', 'build.rs', '.cargo/config.toml', '.cargo/config'])
    if (existsSync(join(root, crate, name))) files.push(posix.join(crate, name));
  if (existsSync(join(root, crate, 'src'))) walk(posix.join(crate, 'src'));
  const manifest = readFileSync(join(root, crate, 'Cargo.toml'), 'utf8');
  for (const [, path] of manifest.matchAll(/\bpath\s*=\s*"([^"]+)"/g)) {
    const dependency = posix.normalize(posix.join(crate, path));
    if (dependency !== crate && !dependency.startsWith(`${crate}/`)) files.push(...crateFiles(dependency, root, seen));
  }
  return files;
}

/** Text files hash without their line endings, so a CRLF checkout hashes as an LF one. */
const content = (bytes) =>
  bytes.includes(0) ? bytes : Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');

/** Hash of everything that decides an entry's blueprint bytes. */
export function sourceHash(entry, root = repository) {
  const files = [...new Set([...crateFiles(entry.crate, root), entry.script, 'rust-toolchain.toml'])]
    .filter((file) => existsSync(join(root, file)))
    .sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(`\0${file}\0`).update(content(readFileSync(join(root, file))));
  return hash.digest('hex');
}

/** The blueprint's Wasm bytes (a deflated TypeScript blueprint is read back to its module). */
export function blueprintBytes(entry, root = repository) {
  const bytes = readFileSync(join(root, entry.blueprint));
  if (!entry.deflated) return bytes;
  const base64 = /wasmBase64(?::\s*string)?\s*=\s*'([^']+)'/.exec(bytes.toString('utf8'))?.[1];
  if (!base64) throw margoError('WASM_BLUEPRINT_UNREADABLE', `${entry.blueprint} holds no wasmBase64 blueprint`);
  return inflateRawSync(Buffer.from(base64, 'base64'));
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Writes an entry's record from its current sources and blueprint. A blueprint holding a build path is refused. */
export function writeRecord(entry, root = repository) {
  const wasm = blueprintBytes(entry, root);
  if (!WebAssembly.validate(wasm)) throw margoError('WASM_BLUEPRINT_INVALID', `${entry.blueprint} is not valid Wasm`);
  const text = wasm.toString('latin1');
  for (const leak of ['Users', 'Development', '.cargo', '.rustup'])
    if (text.includes(leak))
      throw margoError('WASM_BLUEPRINT_PATH', `${entry.blueprint} holds a build path (${leak}); strip or remap it`);
  const record = { sourceHash: sourceHash(entry, root), wasmHash: sha256(wasm), bytes: wasm.length };
  writeFileSync(join(root, recordPath(entry)), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Problems with the committed records, one line each; empty when every blueprint matches its sources. */
export function staleBlueprints(root = repository, entries = BLUEPRINTS) {
  const problems = [];
  for (const entry of entries) {
    if (entry.own) {
      if (!existsSync(join(root, entry.own))) problems.push(`${entry.name}: its own check ${entry.own} is missing`);
      continue;
    }
    const rebuild = `node scripts/wasm-blueprints.mjs --rebuild --only=${entry.name}`;
    if (!existsSync(join(root, entry.blueprint))) {
      problems.push(`${entry.name}: ${entry.blueprint} is missing; run ${rebuild}`);
      continue;
    }
    if (!existsSync(join(root, recordPath(entry)))) {
      problems.push(`${entry.name}: ${recordPath(entry)} is missing; run ${rebuild}`);
      continue;
    }
    const record = JSON.parse(readFileSync(join(root, recordPath(entry)), 'utf8'));
    if (record.sourceHash !== sourceHash(entry, root))
      problems.push(`${entry.name}: ${entry.crate} changed since ${entry.blueprint} was built; run ${rebuild}`);
    else if (record.wasmHash !== sha256(blueprintBytes(entry, root)))
      problems.push(`${entry.name}: ${entry.blueprint} differs from the build its record names; run ${rebuild}`);
  }
  return problems;
}

/** Repo folders of every tracked Cargo.toml under packages/ that the lists above do not name. */
export function unlistedCrates(root = repository) {
  const listed = new Set([...BLUEPRINTS.map((entry) => entry.crate), ...NOT_SHIPPED]);
  const out = spawnSync('git', ['ls-files', '-z', '--', 'packages/*Cargo.toml'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (out.status !== 0) throw margoError('WASM_BLUEPRINT_GIT', `git ls-files failed: ${out.stderr}`);
  return out.stdout
    .split('\0')
    .filter((file) => file.endsWith('/Cargo.toml'))
    .map((file) => posix.dirname(file))
    .filter((crate) => !listed.has(crate));
}

/** Hygiene's check: every crate listed, every record current. */
export function assertWasmBlueprintsCurrent(root = repository) {
  const problems = [
    ...unlistedCrates(root).map((crate) => `${crate}: a Rust crate missing from scripts/wasm-blueprints.mjs`),
    ...staleBlueprints(root),
  ];
  if (problems.length)
    throw margoError('WASM_BLUEPRINT_STALE', `Wasm blueprints out of date:\n  ${problems.join('\n  ')}`);
}

function rebuild(entries, compare) {
  const differ = [];
  for (const entry of entries) {
    const before = existsSync(join(repository, entry.blueprint)) ? blueprintBytes(entry) : null;
    console.log(`wasm blueprint ${entry.name}: building ${entry.crate}`);
    const run = spawnSync(process.execPath, [entry.script, ...(entry.args ?? [])], {
      cwd: repository,
      stdio: 'inherit',
      timeout: 15 * 60_000,
      windowsHide: true,
    });
    if (run.status !== 0)
      throw margoError(
        'WASM_BLUEPRINT_BUILD',
        `${entry.script} failed (${run.error?.message ?? `exit ${run.status}`})`,
      );
    const after = blueprintBytes(entry);
    if (!entry.own) writeRecord(entry);
    const same = before?.equals(after) ?? false;
    console.log(
      `wasm blueprint ${entry.name}: ${after.length} B, ${same ? 'identical to' : 'differs from'} the committed one`,
    );
    if (!same) differ.push(entry.name);
  }
  if (compare && differ.length)
    throw margoError(
      'WASM_BLUEPRINT_DIFFERS',
      `Rebuilt blueprints differ from the committed ones: ${differ.join(', ')}`,
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const only = process.argv
    .find((arg) => arg.startsWith('--only='))
    ?.slice('--only='.length)
    .split(',');
  const entries = only ? BLUEPRINTS.filter((entry) => only.includes(entry.name)) : BLUEPRINTS;
  if (only && entries.length !== only.length)
    throw margoError('WASM_BLUEPRINT_UNKNOWN', `Unknown blueprint in --only=${only.join(',')}`);
  if (process.argv.includes('--rebuild')) rebuild(entries, process.argv.includes('--compare'));
  else {
    assertWasmBlueprintsCurrent();
    console.log(
      `${BLUEPRINTS.length} Wasm blueprints match their sources (${relative(repository, dirname(fileURLToPath(import.meta.url)))}/wasm-blueprints.mjs)`,
    );
  }
}
