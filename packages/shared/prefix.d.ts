/** One word per 16 of the level below: their sum. */
export const prefixUpShader: string;
/** The top level, at most 16 words: each index counts the words before it. */
export const prefixTopShader: string;
/** A lower level: each index is its parent's count plus the words before it under that parent. */
export const prefixDownShader: string;
/** The lengths of the levels for `words` flag words, from the flags up to the first of at most 16. */
export function prefixLevels(words: number): number[];
/**
 * The GPU state of one exact prefix count over `words` flag words, without atomics or workgroup memory. A kernel writes
 * `flags`; `encode` then leaves in `prefix` the flags before each index (`words + 1` words) and in word `totalWord` of
 * `total` their sum. With `totalOnly` only the total is made. Every buffer it makes is pushed to `owned`.
 */
export class PrefixCount {
  constructor(device: GPUDevice, words: number, owned: { destroy(): void }[], options?: { totalOnly?: boolean });
  readonly flags: GPUBuffer;
  readonly prefix: GPUBuffer;
  readonly total: GPUBuffer;
  readonly totalWord: number;
  encode(pass: GPUComputePassEncoder): void;
}
