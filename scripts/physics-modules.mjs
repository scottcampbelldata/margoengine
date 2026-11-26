// The module table of the physics world's one shared memory (docs/physics-framework.md, section 3). Every solver module
// imports the world's `WebAssembly.Memory` and is linked with a `--global-base` of its own slot, so the static data of
// two modules never overlaps:
//
//   0 .. 64 KiB              never used (a null pointer reads nothing of anyone's)
//   64 KiB + slot * 64 KiB   the module's static window: its read-only tables and the flag of its one-time data copy
//   DYNAMIC_BASE ..          the world's regions (packages/physics/src/world/memory.ts, Arena): solver state, ports,
//                            and one stack region per module instance (each thread's instance its own)
//
// A module keeps no state in statics and has no allocator (`#![no_std]`, no `alloc`), so it never grows the memory and
// the world alone snapshots its state. Its stack is linked at size 0 and the loader points its exported
// `__stack_pointer` at a stack region (rustc links `--stack-first`, which would put every module's stack at address 0).
// Each module is built twice with the same layout: shared memory (atomics, for worker threads; it needs a
// cross-origin-isolated page) and plain memory (any page, one thread); the loader takes the one the memory is.
//
//   node scripts/physics-modules.mjs            checks the committed builds: current with their sources, and placed
//   node scripts/physics-modules.mjs --build    builds every module with cargo and writes the committed builds
//
// The constants here are packages/physics/src/world/memory.ts's MODULE_BASE, MODULE_WINDOW, MODULE_SLOTS and
// MAX_MEMORY_PAGES; packages/physics/tests/world-modules.test.js holds them equal.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blueprintRustEnv } from './rust-wasm-env.mjs';

const repository = resolve(import.meta.dirname, '..');

/** Bytes a WebAssembly page holds. */
export const PAGE = 65536;
/** Where the first module window starts: the first page is never used. */
export const MODULE_BASE = PAGE;
/** Bytes of static data a module may place: one page. */
export const MODULE_WINDOW = PAGE;
/** How many module windows the layout holds. */
export const MODULE_SLOTS = 16;
/** Where the world's regions start, above every module window. */
export const DYNAMIC_BASE = MODULE_BASE + MODULE_SLOTS * MODULE_WINDOW;
/** The memory's maximum in pages (4 GiB, all of wasm32): every module declares it, so any world memory fits. */
export const MAX_MEMORY_PAGES = 65536;

/**
 * Every module of the shared memory, with its slot. `crate` is the crate folder, `lib` the name of the .wasm it builds,
 * `record` the committed builds. The two prototype modules prove the layout; solver families join with slots of their own.
 */
export const MODULES = [
  {
    name: 'proto-source',
    slot: 0,
    crate: 'packages/physics/tests/modules/source',
    lib: 'margoengine_proto_source',
    record: 'packages/physics/tests/modules/built.json',
  },
  {
    name: 'proto-reader',
    slot: 1,
    crate: 'packages/physics/tests/modules/reader',
    lib: 'margoengine_proto_reader',
    record: 'packages/physics/tests/modules/built.json',
  },
];

/**
 * Kernels that keep their own build script and committed blueprint but live in the world's memory all the same: each takes a
 * slot of the table, so no module's window lands on its data. The rigid kernel is built by
 * packages/physics/scripts/build-kernel.mjs with `rustFlags` of its entry, plain memory (one thread) for now.
 */
export const KERNEL_SLOTS = [{ name: 'rigid', slot: 15, crate: 'packages/physics/kernel' }];

/** A module's global base: the start of its slot's window. */
export const globalBase = (entry) => MODULE_BASE + entry.slot * MODULE_WINDOW;

/**
 * The flags a module is built with. Both builds import the memory, place their data at the slot's base, link no stack and
 * export the symbols the loader checks; the shared build adds the atomics it needs to import a shared memory.
 */
export function rustFlags(entry, shared) {
  const link = [
    '--import-memory',
    `--max-memory=${MAX_MEMORY_PAGES * PAGE}`,
    `--global-base=${globalBase(entry)}`,
    '-zstack-size=0',
    '--export=__stack_pointer',
    '--export=__global_base',
    '--export=__data_end',
    ...(shared ? ['--shared-memory'] : []),
  ];
  const features = shared ? '+atomics,+bulk-memory,+mutable-globals' : '+bulk-memory,+mutable-globals';
  return [`-C target-feature=${features}`, ...link.map((flag) => `-C link-arg=${flag}`)].join(' ');
}

/** The crate's files a build depends on, as repository paths, sorted. */
function crateFiles(entry) {
  const root = resolve(repository, entry.crate),
    files = ['Cargo.toml', 'Cargo.lock'],
    walk = (dir) => {
      for (const item of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : 1,
      ))
        if (item.isDirectory()) walk(join(dir, item.name));
        else if (item.name.endsWith('.rs')) files.push(join(dir, item.name));
    };
  walk('src');
  return files.map((file) => relative(repository, join(root, file)).replaceAll('\\', '/'));
}

/** A hash of what a module's two builds come from: its sources (line ends normalised), both sets of flags and the toolchain file. */
export function sourceHash(entry) {
  const hash = createHash('sha256');
  for (const file of [...crateFiles(entry), 'rust-toolchain.toml'])
    hash.update(`${file}\0${readFileSync(resolve(repository, file), 'utf8').replace(/\r\n/g, '\n')}\0`);
  hash.update(`${rustFlags(entry, true)}\0${rustFlags(entry, false)}`);
  return hash.digest('hex');
}

/**
 * What the loader and the layout depend on in a module's bytes: its imports, its memory import's limits and sharing, its
 * exported globals and their values, and whether it holds an active data segment outside its window.
 * @throws Error for bytes that are not a WebAssembly module.
 */
export function inspectModule(bytes) {
  const b = Buffer.from(bytes);
  if (b.readUInt32LE(0) !== 0x6d736100) throw new Error('not a WebAssembly module');
  let p = 8;
  const uleb = () => {
    let value = 0,
      shift = 0,
      byte;
    do {
      byte = b[p++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  const sleb = () => {
    let value = 0,
      shift = 0,
      byte;
    do {
      byte = b[p++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return shift < 32 && byte & 0x40 ? value | (-1 << shift) : value;
  };
  const name = () => {
    const n = uleb(),
      text = b.subarray(p, p + n).toString('utf8');
    p += n;
    return text;
  };
  const imports = [],
    globals = [],
    exports = {},
    active = [];
  let importedGlobals = 0;
  while (p < b.length) {
    const id = b[p++],
      size = uleb(),
      end = p + size;
    if (id === 2)
      for (let n = uleb(); n--; ) {
        const module = name(),
          field = name(),
          kind = b[p++];
        if (kind === 2) {
          const flags = uleb(),
            min = uleb(),
            max = flags & 1 ? uleb() : undefined;
          imports.push({ module, field, kind: 'memory', shared: (flags & 2) === 2, min, max });
        } else {
          imports.push({ module, field, kind: ['function', 'table', 'memory', 'global'][kind] ?? kind });
          if (kind === 0) uleb();
          else if (kind === 3) {
            importedGlobals++;
            p += 2;
          } else {
            p = end;
            break;
          }
        }
      }
    else if (id === 6)
      for (let n = uleb(); n--; ) {
        const mutable = b[p + 1] === 1;
        p += 2;
        const op = b[p++],
          value = op === 0x41 ? sleb() : undefined;
        p++; // end
        globals.push({ mutable, value });
      }
    else if (id === 7)
      for (let n = uleb(); n--; ) {
        const field = name(),
          kind = b[p++],
          index = uleb();
        if (kind === 3) exports[field] = globals[index - importedGlobals];
        else exports[field] = { kind: ['function', 'table', 'memory', 'global'][kind] };
      }
    else if (id === 11)
      for (let n = uleb(); n--; ) {
        const flags = uleb();
        if (flags === 1) p += uleb();
        else {
          if (flags === 2) uleb();
          p++; // i32.const
          const offset = sleb();
          p++; // end
          const length = uleb();
          active.push({ offset, length });
          p += length;
        }
      }
    p = end;
  }
  return { imports, exports, active };
}

/**
 * What is wrong with a module's build for its slot: its only import must be the memory, shared as the build is, with the
 * layout's maximum; its data must start at its slot's base and end inside its window; its stack pointer must be exported
 * and mutable. An empty list is a build the loader can place.
 */
export function moduleProblems(entry, bytes, shared) {
  const { imports, exports, active } = inspectModule(bytes),
    base = globalBase(entry),
    problems = [],
    memory = imports.find((i) => i.kind === 'memory');
  if (imports.length !== 1 || !memory || memory.module !== 'env' || memory.field !== 'memory')
    problems.push(
      `imports ${imports.map((i) => `${i.module}.${i.field}`).join(', ')}; a module imports env.memory alone`,
    );
  else {
    if (memory.shared !== shared) problems.push(`its memory import is ${memory.shared ? '' : 'not '}shared`);
    if (memory.max !== MAX_MEMORY_PAGES)
      problems.push(`its memory maximum is ${memory.max} pages, not ${MAX_MEMORY_PAGES}`);
  }
  if (exports.__global_base?.value !== base)
    problems.push(`its data starts at ${exports.__global_base?.value}, not its slot's base ${base}`);
  const end = exports.__data_end?.value;
  if (!(end >= base && end <= base + MODULE_WINDOW))
    problems.push(`its data ends at ${end}, outside its window ${base} to ${base + MODULE_WINDOW}`);
  for (const segment of active)
    if (segment.offset < base || segment.offset + segment.length > base + MODULE_WINDOW)
      problems.push(`a data segment at ${segment.offset} (${segment.length} bytes) lies outside its window`);
  if (!exports.__stack_pointer?.mutable) problems.push('it exports no mutable __stack_pointer');
  return problems;
}

/** The problems of the committed builds: a stale record, a build that is not placed for its slot, two modules on one slot. */
export function checkRecords(modules = MODULES) {
  const problems = [],
    slots = new Map();
  for (const entry of modules) {
    if (!Number.isInteger(entry.slot) || entry.slot < 0 || entry.slot >= MODULE_SLOTS)
      problems.push(`${entry.name}: slot ${entry.slot} is not 0 to ${MODULE_SLOTS - 1}`);
    if (slots.has(entry.slot)) problems.push(`${entry.name}: slot ${entry.slot} is ${slots.get(entry.slot)}'s too`);
    slots.set(entry.slot, entry.name);
    const record = JSON.parse(readFileSync(resolve(repository, entry.record), 'utf8'))[entry.name];
    if (!record) {
      problems.push(`${entry.name}: no build in ${entry.record}; run node scripts/physics-modules.mjs --build`);
      continue;
    }
    if (record.source !== sourceHash(entry))
      problems.push(`${entry.name}: its build is older than its sources; run node scripts/physics-modules.mjs --build`);
    for (const shared of [true, false])
      for (const problem of moduleProblems(entry, Buffer.from(record[shared ? 'shared' : 'plain'], 'base64'), shared))
        problems.push(`${entry.name} (${shared ? 'shared' : 'plain'}): ${problem}`);
  }
  return problems;
}

/** Builds one module's two builds with cargo; returns their bytes. */
function build(entry) {
  const crate = resolve(repository, entry.crate),
    out = {};
  for (const shared of [true, false]) {
    const target = resolve(crate, 'target', shared ? 'shared' : 'plain');
    execFileSync(
      'cargo',
      [
        'build',
        '--locked',
        '--release',
        '--target',
        'wasm32-unknown-unknown',
        '--manifest-path',
        join(crate, 'Cargo.toml'),
      ],
      { stdio: 'inherit', env: blueprintRustEnv(crate, rustFlags(entry, shared), { target }) },
    );
    out[shared ? 'shared' : 'plain'] = readFileSync(
      join(target, 'wasm32-unknown-unknown/release', `${entry.lib}.wasm`),
    );
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--build')) {
    const records = new Map();
    for (const entry of MODULES) {
      const { shared, plain } = build(entry);
      for (const [bytes, isShared] of [
        [shared, true],
        [plain, false],
      ]) {
        const problems = moduleProblems(entry, bytes, isShared);
        if (problems.length) throw new Error(`${entry.name}: ${problems.join('; ')}`);
      }
      const record = records.get(entry.record) ?? {};
      record[entry.name] = {
        slot: entry.slot,
        source: sourceHash(entry),
        shared: shared.toString('base64'),
        plain: plain.toString('base64'),
      };
      records.set(entry.record, record);
    }
    for (const [file, record] of records)
      writeFileSync(resolve(repository, file), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`physics modules: ${MODULES.length} built, each placed in its window`);
  }
  const problems = checkRecords();
  if (problems.length) {
    console.error(`physics modules:\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  } else
    console.log(
      `physics modules: ${MODULES.length} builds current and placed (windows of ${MODULE_WINDOW} bytes from ${MODULE_BASE})`,
    );
}
