import type { SlamGeometry, SlamStation } from './slamming.js';
import type { HullSlammingWorkerWork } from './slamming-table.js';

export interface SlammingJob {
  readonly module: WebAssembly.Module;
  readonly sections: readonly SlamGeometry[];
  readonly density: number;
  readonly nodes: Float64Array;
}

export interface SlammingResult {
  readonly profiles: readonly SlamStation[];
  readonly work: HullSlammingWorkerWork;
}

export type SlammingReply = SlammingResult | { readonly invalid: true } | { readonly error: string };

interface SlammingKernel {
  readonly memory: WebAssembly.Memory;
  slam_allocate(words: number): number;
  slam_free(offset: number, words: number): void;
  slam_station(heights: number, half: number, length: number, nodes: number, density: number, output: number): number;
}

export function openSlammingBatch({ module, sections, density, nodes }: SlammingJob) {
  const native = new WebAssembly.Instance(module).exports as unknown as SlammingKernel;
  const levels = sections.reduce((max, section) => Math.max(max, section.heights.length), 0);
  const words = nodes.length + 4 * levels + 4;
  const pointer = native.slam_allocate(words);
  const heightsOffset = pointer + nodes.length * 8;
  const halfOffset = heightsOffset + levels * 8;
  const outputOffset = halfOffset + levels * 8;
  try {
    new Float64Array(native.memory.buffer, pointer, nodes.length).set(nodes);
  } catch (error) {
    native.slam_free(pointer, words);
    throw error;
  }
  const profiles: SlamStation[] = [];
  const work = { stations: 0, samples: 0, bisections: 0, quadraturePairs: 0, profileComparisons: 0 };
  return {
    add({ x, width, keel, heights, half }: SlamGeometry): boolean {
      const length = heights.length;
      new Float64Array(native.memory.buffer, heightsOffset, length).set(heights);
      new Float64Array(native.memory.buffer, halfOffset, length).set(half);
      if (!native.slam_station(heightsOffset, halfOffset, length, pointer, density, outputOffset)) return false;
      const result = new Float64Array(native.memory.buffer, outputOffset, 2 * length + 4);
      profiles.push({
        x,
        width,
        keel,
        heights,
        wetted: result.slice(0, length),
        slope: result.slice(length, 2 * length),
      });
      work.stations++;
      work.samples += result[2 * length]!;
      work.bisections += result[2 * length + 1]!;
      work.quadraturePairs += result[2 * length + 2]!;
      work.profileComparisons += result[2 * length + 3]!;
      return true;
    },
    result(): SlammingResult {
      return { profiles, work };
    },
    close() {
      native.slam_free(pointer, words);
    },
  };
}
