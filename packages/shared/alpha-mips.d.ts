/** The smallest alpha byte an alpha test `byte / 255 * factor >= cutoff` keeps, or 0 when it keeps every byte or none. */
export function maskKeepByte(cutoff: number, factor: number): number;
/**
 * Fills mip levels 1 to `levels - 1` of an rgba8 texture so an alpha test at `cutoff` (alpha times `factor`) keeps
 * level 0's share of texels at every level, with alpha-weighted linear colour; otherwise as `generateMipmaps`.
 */
export function generateMaskMipmaps(
  device: GPUDevice,
  texture: GPUTexture,
  levels: number,
  cache: Map<unknown, unknown> & { sampler?: GPUSampler },
  cutoff: number,
  factor: number,
  sampler?: GPUSampler,
): void;
