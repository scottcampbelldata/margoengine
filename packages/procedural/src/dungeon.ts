import { fault } from '../../shared/errors.js';
import { loadKernel } from './wasm.js';

/** Seeded, bounded integer-grid BSP layout settings. */
export interface DungeonOptions {
  /** Grid width in cells, 6..1024 and at least minRoomSize + 4. Default 64. */
  width?: number;
  /** Grid height in cells, 6..1024 and at least minRoomSize + 4. Default 48. */
  height?: number;
  /** Unsigned 32-bit seed; zero shares seed one's stream. Default 1. */
  seed?: number;
  /** Minimum room width and height, 2..64 cells. Default 4. */
  minRoomSize?: number;
  /** Upper bound on room count, 1..256; small grids may fit fewer. Default 32. */
  maxRooms?: number;
  /** Checked before synchronous generation; use a worker to interrupt work in flight. */
  signal?: AbortSignal;
}
/** A rectangular room; integer coordinates include its top-left cell. */
export interface DungeonRoom {
  /** Leftmost cell. */
  x: number;
  /** Topmost cell. */
  y: number;
  /** Width in cells. */
  width: number;
  /** Height in cells. */
  height: number;
}
/** One orthogonal, one-cell-wide path between room centres; crossings are allowed. */
export interface DungeonCorridor {
  /** Index of the first room. */
  from: number;
  /** Index of the second room. */
  to: number;
  /** The corner of the two axis-aligned segments. */
  bend: readonly [number, number];
}
/** Caller-owned blockout data, independent of any renderer. */
export interface DungeonLayout {
  /** Width of the grid. */
  width: number;
  /** Height of the grid. */
  height: number;
  /** X fastest, 0 wall, 1 walkable. All walkable cells form one four-neighbour component. */
  cells: Uint8Array;
  /** Nonoverlapping rooms, each with at least a one-cell partition margin. */
  rooms: readonly DungeonRoom[];
  /** Room-count minus one links forming a spanning tree; paths can cross other rooms. */
  corridors: readonly DungeonCorridor[];
  /** Raster cells written, including repeated writes at overlaps; excludes zero initialization. */
  rasterVisits: number;
}
interface Kernel {
  memory: WebAssembly.Memory;
  generate(width: number, height: number, seed: number, minimum: number, maximum: number): number;
  release(pointer: number, length: number): void;
}
const invalid = () =>
  fault(
    'failed',
    'Dungeon requires integer width/height 6..1024, minRoomSize 2..64, width/height >= minRoomSize + 4, maxRooms 1..256 and uint32 seed',
    'procedural',
  );
const integer = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;

/** Lifecycle of one lazy Rust/Wasm dungeon generator. */
export interface DungeonGenerator {
  /** Generate a connected BSP blockout with owned output arrays. */
  generate(options?: DungeonOptions): DungeonLayout;
  /** Release the instance. Existing layouts remain usable. */
  dispose(): void;
  [Symbol.dispose](): void;
}
class Generator implements DungeonGenerator {
  private kernel: Kernel | undefined;
  constructor(kernel: Kernel) {
    this.kernel = kernel;
  }
  generate(options: DungeonOptions = {}): DungeonLayout {
    const kernel = this.kernel;
    if (!kernel) throw fault('disposed', 'DungeonGenerator is disposed; create a new generator', 'procedural');
    options?.signal?.throwIfAborted();
    const width = options?.width ?? 64,
      height = options?.height ?? 48,
      seed = options?.seed ?? 1,
      minimum = options?.minRoomSize ?? 4,
      maximum = options?.maxRooms ?? 32;
    if (
      !integer(width, 6, 1024) ||
      !integer(height, 6, 1024) ||
      !integer(seed, 0, 0xffffffff) ||
      !integer(minimum, 2, 64) ||
      !integer(maximum, 1, 256) ||
      width < minimum + 4 ||
      height < minimum + 4
    )
      throw invalid();
    const pointer = kernel.generate(width, height, seed, minimum, maximum);
    const header = new Uint32Array(kernel.memory.buffer, pointer, 4),
      length = header[0],
      count = header[1],
      rasterVisits = header[3];
    try {
      if (!count) throw invalid();
      const data = new Uint32Array(kernel.memory.buffer, pointer, length),
        rooms: DungeonRoom[] = [],
        corridors: DungeonCorridor[] = [];
      let at = 4;
      for (let i = 0; i < count; i++, at += 4)
        rooms.push({ x: data[at], y: data[at + 1], width: data[at + 2], height: data[at + 3] });
      for (let i = 1; i < count; i++, at += 4)
        corridors.push({ from: data[at], to: data[at + 1], bend: [data[at + 2], data[at + 3]] });
      return { width, height, cells: Uint8Array.from(data.subarray(at)), rooms, corridors, rasterVisits };
    } finally {
      kernel.release(pointer, length);
    }
  }
  dispose(): void {
    this.kernel = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Load one feature-local Wasm asset on demand. No GPU context is required. */
export async function createDungeonGenerator(options: { signal?: AbortSignal } = {}): Promise<DungeonGenerator> {
  const url = new URL(/* @vite-ignore */ './dungeon.wasm?no-inline', import.meta.url);
  return new Generator(await loadKernel<Kernel>(url, 'Dungeon', options.signal));
}
