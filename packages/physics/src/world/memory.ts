// The world's memory (docs/physics-framework.md, section 3): one WebAssembly.Memory that every solver module imports, and
// a region allocator over it. Regions are handed out in allocation order, each aligned to 8 bytes and zeroed, and never
// move, so a region's offset is fixed for the life of the world and a reader reads a port in place. The memory grows by
// whole 64 KiB pages when a region does not fit; views over it are made afresh at each use, as growing replaces the buffer.
//
// The memory's low part belongs to the solver modules (scripts/physics-modules.mjs holds the module table): the first page
// is never used, then each module has a static window of one page at its slot, where its linker placed its read-only data
// (`--global-base`). Regions start above the last window, at DYNAMIC_BASE, so no region overlaps a module's data. A module
// keeps no state of its own and has no allocator; it works in the regions the world gives it, and each instance of it (one
// per thread) runs on a stack region of its own.
import { MargoError } from '@margoengine/math/errors';
import type { ElementType, Region } from './solver.js';

/** Bytes a word of each element type takes. */
export const BYTES: Readonly<Record<ElementType, number>> = { f64: 8, f32: 4, i32: 4, u32: 4, u8: 1 };

const PAGE = 65536;

/** Where the first module's static window starts: the first page is never used. */
export const MODULE_BASE = PAGE;
/** Bytes of static data each module may place: one page. */
export const MODULE_WINDOW = PAGE;
/** How many module windows the memory holds below its regions. */
export const MODULE_SLOTS = 16;
/** Where the regions start, above every module window. */
export const DYNAMIC_BASE = MODULE_BASE + MODULE_SLOTS * MODULE_WINDOW;
/** The memory's maximum in pages (4 GiB, all of wasm32): every module declares it, so a world memory fits any module. */
export const MAX_MEMORY_PAGES = 65536;
/** Bytes of each module instance's stack region (default). */
export const STACK_BYTES = 65536;

/** The typed array of each element type. */
export type RegionWords = Float64Array | Float32Array | Int32Array | Uint32Array | Uint8Array;

/** One memory and the regions allocated in it. */
export class Arena {
  /** The memory every region lies in. */
  readonly memory: WebAssembly.Memory;

  private next = DYNAMIC_BASE;

  /**
   * @param memory The memory to allocate in; by default {@link worldMemory}'s plain memory. It grows to hold the module
   * windows at once, and its maximum must be {@link MAX_MEMORY_PAGES} for a solver module to import it.
   */
  constructor(memory: WebAssembly.Memory = worldMemory()) {
    this.memory = memory;
    const have = memory.buffer.byteLength;
    if (have >= DYNAMIC_BASE) return;
    try {
      memory.grow((DYNAMIC_BASE - have) / PAGE);
    } catch (cause) {
      // The module windows sit below every region, so a memory whose maximum cannot reach them cannot hold a world.
      throw new RangeError(
        `The world's memory must hold the solver modules' windows, ${DYNAMIC_BASE} bytes (${DYNAMIC_BASE / PAGE} pages), before any region; it has ${have} bytes and cannot grow there. Pass worldMemory(), or a memory whose maximum is MAX_MEMORY_PAGES.`,
        { cause },
      );
    }
  }

  /** Bytes allocated so far, padding included, counted from {@link DYNAMIC_BASE}. */
  get used(): number {
    return this.next - DYNAMIC_BASE;
  }

  /**
   * A new region of `byteLength` bytes of `type` words, zeroed, aligned to 8 bytes.
   * @throws RangeError for a length that is not a whole number of `type` words, a layout version that is not a whole number,
   * or an unknown type.
   */
  allocate(name: string, byteLength: number, type: ElementType, layout: number): Region {
    const size = BYTES[type];
    if (size === undefined) throw new RangeError(`Region "${name}" has type "${type}"; use f64, f32, i32, u32 or u8.`);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength % size !== 0)
      throw new RangeError(
        `Region "${name}" asks for ${byteLength} bytes, not a whole number of ${type} words; pass a multiple of ${size}.`,
      );
    if (!Number.isSafeInteger(layout) || layout < 0)
      throw new RangeError(`Region "${name}" has layout version ${layout}; pass a whole number.`);
    const byteOffset = this.next,
      end = byteOffset + byteLength,
      have = this.memory.buffer.byteLength;
    if (end > have) this.memory.grow(Math.ceil((end - have) / PAGE));
    new Uint8Array(this.memory.buffer, byteOffset, byteLength).fill(0);
    this.next = Math.ceil(end / 8) * 8;
    return { name, byteOffset, byteLength, type, layout };
  }

  /** The words of `region`, as the typed array of its element type, over the memory as it is now. */
  words(region: Region): RegionWords {
    return regionWords(this.memory, region);
  }
}

/**
 * The words of `region` of `memory`, as the typed array of its element type.
 * @throws RangeError for a region outside the memory or not aligned to its words.
 */
export function regionWords(memory: WebAssembly.Memory, region: Region): RegionWords {
  const size = BYTES[region.type];
  if (region.byteOffset % size !== 0 || region.byteLength % size !== 0)
    throw new RangeError(
      `Region "${region.name}" is not aligned to its ${region.type} words; allocate it through the world.`,
    );
  if (region.byteOffset < 0 || region.byteOffset + region.byteLength > memory.buffer.byteLength)
    throw new RangeError(
      `Region "${region.name}" lies outside the world's memory; it was allocated in another memory.`,
    );
  const { buffer } = memory,
    at = region.byteOffset,
    n = region.byteLength / size;
  switch (region.type) {
    case 'f64':
      return new Float64Array(buffer, at, n);
    case 'f32':
      return new Float32Array(buffer, at, n);
    case 'i32':
      return new Int32Array(buffer, at, n);
    case 'u32':
      return new Uint32Array(buffer, at, n);
    default:
      return new Uint8Array(buffer, at, n);
  }
}

/**
 * A new world memory that every solver module can import: the module windows and nothing else at first, growing to 4 GiB.
 * `shared` makes it a shared memory, which worker threads can step in parallel; a browser gives one only to a
 * cross-origin-isolated page (`crossOriginIsolated`), so the default is shared exactly where it can be.
 */
export function worldMemory(shared: boolean = canShareMemory()): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: DYNAMIC_BASE / PAGE, maximum: MAX_MEMORY_PAGES, shared });
}

/** Whether this page may make a shared memory: SharedArrayBuffer exists and the page is not refused cross-origin isolation. */
export function canShareMemory(): boolean {
  return (
    typeof SharedArrayBuffer === 'function' &&
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== false
  );
}

/** Whether `memory` is shared. */
export const isShared = (memory: WebAssembly.Memory): boolean =>
  typeof SharedArrayBuffer === 'function' && memory.buffer instanceof SharedArrayBuffer;

/** A solver module's place in the module table (scripts/physics-modules.mjs): its name and its slot. */
export interface ModuleSlot {
  readonly name: string;
  /** Its window is MODULE_BASE + slot * MODULE_WINDOW. */
  readonly slot: number;
}

/** A module's two builds, of the same layout: `shared` imports a shared memory, `plain` a plain one. */
export interface ModuleBuilds {
  readonly shared: BufferSource | WebAssembly.Module;
  readonly plain: BufferSource | WebAssembly.Module;
}

/** A solver module loaded into a world's memory. */
export interface SolverModule {
  readonly name: string;
  readonly slot: number;
  /** The compiled build that fits the memory: post it to a worker to make the worker's own instance. */
  readonly module: WebAssembly.Module;
  /** This thread's instance's exports. */
  readonly exports: WebAssembly.Exports;
  /** This thread's instance's stack region. */
  readonly stack: Region;
}

/** The start of a module slot's window. @throws RangeError for a slot outside 0 to MODULE_SLOTS - 1. */
export function moduleBase(slot: number): number {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MODULE_SLOTS)
    throw new RangeError(`A module slot is a whole number from 0 to ${MODULE_SLOTS - 1}; got ${slot}.`);
  return MODULE_BASE + slot * MODULE_WINDOW;
}

const globalValue = (exports: WebAssembly.Exports, name: string): number | undefined => {
  const value = exports[name];
  return value instanceof WebAssembly.Global ? Number(value.value) : undefined;
};

/**
 * Loads a solver module into `arena`'s memory: takes the build that fits the memory (shared or plain), checks in a scratch
 * memory that its data lies in its slot's window and nowhere else, then instantiates it on the world's memory with a stack
 * region of `stackBytes` from the arena. A worker makes its own instance of `module` with {@link instantiateSolverModule}.
 * @throws MargoError `unsupported` for a build that imports more than the memory, places data outside its window or
 * exports no stack pointer; RangeError for a bad slot or stack size.
 */
export async function loadSolverModule(
  arena: Arena,
  slot: ModuleSlot,
  builds: ModuleBuilds,
  stackBytes: number = STACK_BYTES,
): Promise<SolverModule> {
  const shared = isShared(arena.memory),
    source = shared ? builds.shared : builds.plain,
    module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  await checkPlacement(module, slot, shared);
  const stack = stackRegion(arena, slot.name, stackBytes),
    exports = await instantiateSolverModule(arena.memory, module, stack);
  return { name: slot.name, slot: slot.slot, module, exports, stack };
}

/**
 * A stack region of `stackBytes` (a multiple of 16) for one instance of module `name`: one per thread. It is scratch, not
 * state: a snapshot leaves it out.
 * @throws RangeError for a size that is not a positive multiple of 16.
 */
export function stackRegion(arena: Arena, name: string, stackBytes: number = STACK_BYTES): Region {
  if (!Number.isSafeInteger(stackBytes) || stackBytes <= 0 || stackBytes % 16 !== 0)
    throw new RangeError(`A module stack is a positive multiple of 16 bytes; got ${stackBytes}.`);
  // The arena aligns to 8; 8 more bytes let the stack's top sit on 16.
  return arena.allocate(`stack:${name}`, stackBytes + 8, 'u8', 1);
}

/**
 * An instance of a checked solver module on `memory`, its stack pointer at the top of `stack`: the main thread's through
 * {@link loadSolverModule}, a worker's from the module and a stack region the main thread posts it.
 */
export async function instantiateSolverModule(
  memory: WebAssembly.Memory,
  module: WebAssembly.Module,
  stack: Region,
): Promise<WebAssembly.Exports> {
  const { exports } = await WebAssembly.instantiate(module, { env: { memory } }),
    pointer = exports.__stack_pointer;
  if (!(pointer instanceof WebAssembly.Global))
    throw new MargoError(
      'unsupported',
      'The module exports no __stack_pointer; build it with scripts/physics-modules.mjs.',
    );
  pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
  return exports;
}

/** Instantiates `module` on a scratch memory and checks where its data went, so a misplaced build never writes the world's. */
async function checkPlacement(module: WebAssembly.Module, slot: ModuleSlot, shared: boolean): Promise<void> {
  const base = moduleBase(slot.slot),
    imports = WebAssembly.Module.imports(module);
  if (
    imports.length !== 1 ||
    imports[0]!.module !== 'env' ||
    imports[0]!.name !== 'memory' ||
    imports[0]!.kind !== 'memory'
  )
    throw new MargoError(
      'unsupported',
      `Module "${slot.name}" imports ${imports.map((i) => `${i.module}.${i.name}`).join(', ')}; a solver module imports env.memory alone. Build it with scripts/physics-modules.mjs.`,
    );
  const { exports } = await WebAssembly.instantiate(module, { env: { memory: worldMemory(shared) } }),
    start = globalValue(exports, '__global_base'),
    end = globalValue(exports, '__data_end');
  if (start !== base || end === undefined || end < base || end > base + MODULE_WINDOW)
    throw new MargoError(
      'unsupported',
      `Module "${slot.name}" places its data at ${start} to ${end}, not inside slot ${slot.slot}'s window ${base} to ${base + MODULE_WINDOW}; build it with scripts/physics-modules.mjs for its slot.`,
    );
}
