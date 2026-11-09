import { fault } from '../../shared/errors.js';
import { loadKernel } from './wasm.js';

/** Bounded synchronous cellular automata settings. */
export interface CaveOptions {
  /** Width in cells, integer 3..1024. Default 64. */
  width?: number;
  /** Height in cells, integer 3..1024. Default 48. */
  height?: number;
  /** 1 for 2D, otherwise integer 3..256 for 3D; total cells <= 1048576. Default 1. */
  depth?: number;
  /** Unsigned 32-bit LCG seed, including zero. Default 1. */
  seed?: number;
  /** Synchronous generations, integer 0..64; cells * steps <= 16777216. Default 5. */
  steps?: number;
  /** Initial probability of state 1, 0..1. Default 0.45. Ignored with initial. */
  fill?: number;
  /** caves: fixed rock border (1); islands: fixed water border (0). Default caves. */
  mode?: 'caves' | 'islands';
  /** Minimum occupied neighbours for an empty cell to become occupied, 0..8 (2D) or 0..26 (3D). Default 5 or 14. */
  birth?: number;
  /** Minimum occupied neighbours for an occupied cell to remain occupied. Same bounds. Default 4 or 13. */
  survival?: number;
  /** Optional binary X-fastest grid. Copied; outermost cells are replaced by the mode's fixed border. */
  initial?: Uint8Array;
  /** Checked before work; use a worker to interrupt synchronous work in flight. */
  signal?: AbortSignal;
}
/** Owned binary map; no rendering context or GPU resources. */
export interface CaveMap {
  /** Width in cells. */
  width: number;
  /** Height in cells. */
  height: number;
  /** Depth in cells, 1 for 2D. */
  depth: number;
  /** X fastest, then Y, then Z. 1 rock/land; 0 floor/water. Components need not connect. */
  cells: Uint8Array;
  /** Stencil input reads, including intermediate sums and centre reads; excludes initialization and copies. */
  stencilReads: number;
  /** Reads for a direct Moore stencil with the same output and generation count. */
  directReads: number;
}
interface Kernel {
  memory: WebAssembly.Memory;
  allocate(length: number): number;
  generate(
    w: number,
    h: number,
    d: number,
    seed: number,
    steps: number,
    fill: number,
    border: number,
    birth: number,
    survival: number,
    initial: number,
  ): number;
  release(pointer: number, length: number): void;
}
const integer = (v: number, low: number, high: number) => Number.isInteger(v) && v >= low && v <= high;
const invalid = () =>
  fault(
    'failed',
    'Caves requires a bounded binary grid, valid mode, uint32 seed, fill 0..1 and integer rule/step limits; see procedural README',
    'procedural',
  );
/** Lifecycle of one independently loaded Rust/Wasm automaton. */
export interface CaveGenerator {
  /** Generate caves or islands by synchronous Moore-neighbour threshold rules. */
  generate(options?: CaveOptions): CaveMap;
  /** Release the instance; existing maps remain usable. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}
class Generator implements CaveGenerator {
  constructor(private kernel: Kernel | undefined) {}
  generate(options: CaveOptions = {}): CaveMap {
    const k = this.kernel;
    if (!k) throw fault('disposed', 'CaveGenerator is disposed; create a new generator', 'procedural');
    options?.signal?.throwIfAborted();
    const w = options?.width ?? 64,
      h = options?.height ?? 48,
      d = options?.depth ?? 1,
      seed = options?.seed ?? 1,
      steps = options?.steps ?? 5,
      fill = options?.fill ?? 0.45,
      mode = options?.mode ?? 'caves',
      neighbours = d === 1 ? 8 : 26,
      birth = options?.birth ?? (d === 1 ? 5 : 14),
      survival = options?.survival ?? (d === 1 ? 4 : 13),
      initial = options?.initial;
    if (!integer(w, 3, 1024) || !integer(h, 3, 1024) || !(d === 1 || integer(d, 3, 256))) throw invalid();
    const n = w * h * d;
    if (
      n > 1048576 ||
      !integer(seed, 0, 0xffffffff) ||
      !integer(steps, 0, 64) ||
      n * steps > 16777216 ||
      !Number.isFinite(fill) ||
      fill < 0 ||
      fill > 1 ||
      (mode !== 'caves' && mode !== 'islands') ||
      !integer(birth, 0, neighbours) ||
      !integer(survival, 0, neighbours) ||
      (initial !== undefined &&
        (!(initial instanceof Uint8Array) || initial.length !== n || initial.some((v) => v > 1)))
    )
      throw invalid();
    let input = 0;
    try {
      if (initial) {
        input = k.allocate(n);
        new Uint8Array(k.memory.buffer, input, n).set(initial);
      }
      const pointer = k.generate(w, h, d, seed, steps, fill, mode === 'caves' ? 1 : 0, birth, survival, input);
      const header = new DataView(k.memory.buffer, pointer, 16),
        length = header.getUint32(0, true);
      try {
        if (length !== n + 16) throw invalid();
        return {
          width: w,
          height: h,
          depth: d,
          stencilReads: header.getUint32(4, true),
          directReads: header.getUint32(8, true),
          cells: new Uint8Array(k.memory.buffer, pointer + 16, n).slice(),
        };
      } finally {
        k.release(pointer, length);
      }
    } finally {
      if (input) k.release(input, n);
    }
  }
  dispose(): void {
    this.kernel = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Load the feature-local asset lazily; importing this entry performs no fetch. */
export async function createCaveGenerator(options: { signal?: AbortSignal } = {}): Promise<CaveGenerator> {
  return new Generator(
    await loadKernel<Kernel>(
      new URL(/* @vite-ignore */ './caves.wasm?no-inline', import.meta.url),
      'Caves',
      options.signal,
    ),
  );
}
