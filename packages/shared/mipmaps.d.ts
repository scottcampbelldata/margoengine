/**
 * WGSL of one area-filter step: entry points `vertex` (a fullscreen triangle) and `fragment`, which writes each texel
 * of a level from the level above, bound as a texture_2d<f32> at group 0 binding 0. `weighted` averages colour by alpha.
 */
export function mipShader(weighted: boolean): string;
/**
 * Fills mip levels 1 to `levels - 1` of the first `layers` (default 1) layers of a texture from level 0 by an area
 * filter (the exact box filter at every size).
 * `alpha: 'weighted'` averages colour weighted by alpha, for straight-alpha base colour maps of blended materials.
 * One pipeline per format and mode is kept in `cache`.
 */
export function generateMipmaps(
  device: GPUDevice,
  texture: GPUTexture,
  levels: number,
  cache: Map<unknown, unknown>,
  layers?: number,
  alpha?: 'plain' | 'weighted',
): void;
