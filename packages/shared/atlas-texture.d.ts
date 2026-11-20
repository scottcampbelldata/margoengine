/** Straight-alpha RGBA8 texels, row by row from the top: `ImageData` fits. */
export interface AtlasPixels {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}
/** Where a 2D atlas's texels come from. */
export type AtlasSource = AtlasPixels | ImageBitmap | GPUTexture | ((device: GPUDevice) => GPUTexture);
/** An atlas texture; `owned` when the caller made it and must destroy it. */
export interface AtlasTexture {
  texture: GPUTexture;
  owned: boolean;
}
/** Makes an atlas texture. `invalid` builds the error thrown for pixels that do not fit their size. */
export function atlasTexture(device: GPUDevice, atlas: AtlasSource, invalid: () => Error): AtlasTexture;
/**
 * The atlas texture of a borrow slot: pixels and bitmaps are uploaded; a caller's texture or function is lent
 * (shared/borrowed.js), so a plain texture after a device restore gives undefined, reported once through `engine`.
 */
export function borrowedAtlas(
  slot: import('./borrowed.js').BorrowSlot<GPUTexture, AtlasSource>,
  device: GPUDevice,
  engine: { onError(error: unknown): void } | undefined,
  invalid: () => Error,
): AtlasTexture | undefined;
