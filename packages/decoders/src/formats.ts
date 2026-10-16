import type { TranscodeTarget } from './protocol.js';

/** Basis transcoder enum, WebGPU format, block edge in pixels and bytes per block for each target. */
export const transcodeFormats: Record<
  TranscodeTarget,
  { basis: number; gpu: string; block: number; blockBytes: number }
> = {
  'bc7': { basis: 6, gpu: 'bc7-rgba-unorm', block: 4, blockBytes: 16 },
  'astc-4x4': { basis: 10, gpu: 'astc-4x4-unorm', block: 4, blockBytes: 16 },
  'etc2': { basis: 1, gpu: 'etc2-rgba8unorm', block: 4, blockBytes: 16 },
  'rgba8': { basis: 13, gpu: 'rgba8unorm', block: 1, blockBytes: 4 },
};
