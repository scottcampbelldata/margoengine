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

/** A target for HDR KTX2 files: `bc6h`, `rgba16float` and `rgb9e5` upload to WebGPU; `astc-hdr-4x4` gives blocks for tools. */
export type HDRTranscodeTarget = 'bc6h' | 'astc-hdr-4x4' | 'rgba16float' | 'rgb9e5';

/** Basis transcoder enum and format name of each HDR target. WebGPU has no ASTC HDR format, so that name is Margo's own. */
export const hdrFormats: Record<HDRTranscodeTarget, { basis: number; gpu: string }> = {
  'bc6h': { basis: 22, gpu: 'bc6h-rgb-ufloat' },
  'astc-hdr-4x4': { basis: 23, gpu: 'astc-4x4-hdr' },
  'rgba16float': { basis: 25, gpu: 'rgba16float' },
  'rgb9e5': { basis: 26, gpu: 'rgb9e5ufloat' },
};
