// The world's memory (docs/physics-framework.md, section 3): one WebAssembly.Memory that every solver module imports, and
// a region allocator over it. Regions are handed out in allocation order, each aligned to 8 bytes and zeroed, and never
// move, so a region's offset is fixed for the life of the world and a reader reads a port in place. The memory grows by
// whole 64 KiB pages when a region does not fit; views over it are made afresh at each use, as growing replaces the buffer.
import type { ElementType, Region } from './solver.js';

/** Bytes a word of each element type takes. */
export const BYTES: Readonly<Record<ElementType, number>> = { f64: 8, f32: 4, i32: 4, u32: 4, u8: 1 };

const PAGE = 65536;

/** The typed array of each element type. */
export type RegionWords = Float64Array | Float32Array | Int32Array | Uint32Array | Uint8Array;

/** One memory and the regions allocated in it. */
export class Arena {
  /** The memory every region lies in. */
  readonly memory: WebAssembly.Memory;
  private next = 0;

  /** @param memory The memory to allocate in; by default a new one of one page that may grow to 4 GiB. */
  constructor(memory: WebAssembly.Memory = new WebAssembly.Memory({ initial: 1, maximum: 65536 })) {
    this.memory = memory;
  }

  /** Bytes allocated so far, padding included. */
  get used(): number {
    return this.next;
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
