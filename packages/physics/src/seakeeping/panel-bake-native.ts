import type { Vec3 } from './wetted.js';

export interface PanelBakeInput {
  readonly geometry: Float64Array;
  readonly count: number;
  readonly centre: Vec3;
  readonly depth: number;
  readonly headings: number;
}

export interface PanelFrequency {
  readonly index: number;
  readonly k: number;
  readonly headings: number;
}

export interface PanelFrequencyResult {
  readonly index: number;
  readonly words: Float64Array<ArrayBuffer>;
  readonly pairs: number;
  readonly tail: number;
}

export interface PanelBakeRequest {
  readonly module: WebAssembly.Module;
  readonly input: PanelBakeInput;
  readonly jobs: readonly PanelFrequency[];
}

export type PanelBakeReply =
  | { readonly results: readonly PanelFrequencyResult[] }
  | { readonly invalid: true }
  | { readonly error: string };

interface PanelKernel {
  readonly memory: WebAssembly.Memory;
  hull_panel_allocate(words: number): number;
  hull_panel_free(offset: number, words: number): void;
  hull_panel_coefficients_with_work(
    vertices: number,
    count: number,
    x: number,
    y: number,
    z: number,
    k: number,
    depth: number,
    direction: number,
    headings: number,
    output: number,
    work: number,
  ): number;
}

export function openPanelKernel(module: WebAssembly.Module, input: PanelBakeInput) {
  const native = new WebAssembly.Instance(module).exports as unknown as PanelKernel;
  const resultWords = 72 + 12 * input.headings;
  const outputOffset = input.geometry.length * 8;
  const workOffset = outputOffset + resultWords * 8;
  const length = workOffset / 8 + 2;
  const pointer = native.hull_panel_allocate(length);
  try {
    new Float64Array(native.memory.buffer, pointer, input.geometry.length).set(input.geometry);
  } catch (error) {
    native.hull_panel_free(pointer, length);
    throw error;
  }
  return {
    solve({ index, k, headings }: PanelFrequency): PanelFrequencyResult | undefined {
      if (
        !native.hull_panel_coefficients_with_work(
          pointer,
          input.count,
          input.centre[0],
          input.centre[1],
          input.centre[2],
          k,
          input.depth,
          pointer + input.count * 9 * 8,
          headings,
          pointer + outputOffset,
          pointer + workOffset,
        )
      )
        return undefined;
      const work = new Float64Array(native.memory.buffer, pointer + workOffset, 2);
      const words = new Float64Array(native.memory.buffer, pointer + outputOffset, 72 + 12 * headings).slice();
      return { index, words, pairs: work[0]!, tail: work[1]! };
    },
    close() {
      native.hull_panel_free(pointer, length);
    },
  };
}
