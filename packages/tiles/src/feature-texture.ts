// Shared optional metadata texture sampling, authored from glTF 2.0 and EXT_mesh_features.
/** Unmodified linear RGBA8 texels, top row first (glTF v=0). */
export interface FeatureImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}
/** glTF texture addressing mode: clamp, mirrored repeat or repeat (default). */
export type TextureWrap = 33071 | 33648 | 10497;
function wrap(value: number, mode: TextureWrap): number {
  if (mode === 33071) return Math.max(0, Math.min(1, value));
  const floor = Math.floor(value),
    fraction = value - floor;
  return mode === 33648 && Math.abs(floor % 2) === 1 ? 1 - fraction : fraction;
}
/** Validates RGBA8 storage before picking, rendering or property decoding. */
export function checkFeatureImage(image: FeatureImage): void {
  if (
    !Number.isInteger(image.width) ||
    image.width < 1 ||
    !Number.isInteger(image.height) ||
    image.height < 1 ||
    image.data.length !== image.width * image.height * 4
  )
    throw new RangeError(
      'Metadata image needs width*height*4 RGBA8 values; decode the complete image without colour conversion',
    );
}
/** Samples a nearest texel with glTF addressing and no colour conversion. */
export function metadataTexel(
  image: FeatureImage,
  uv: readonly number[],
  wrapS: TextureWrap = 10497,
  wrapT: TextureWrap = 10497,
): Uint8Array {
  if (uv.length !== 2 || !uv.every(Number.isFinite))
    throw new TypeError('Metadata UV needs two finite coordinates; pass the hit texture coordinates');
  const x = Math.min(image.width - 1, Math.floor(wrap(uv[0], wrapS) * image.width)),
    y = Math.min(image.height - 1, Math.floor(wrap(uv[1], wrapT) * image.height));
  return Uint8Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));
}
/** Decodes 1..4 selected channels as a little-endian unsigned ID, retaining all 32 bits. */
export function textureFeatureId(texel: ArrayLike<number>, channels: readonly number[] = [0]): number {
  if (
    channels.length < 1 ||
    channels.length > 4 ||
    new Set(channels).size !== channels.length ||
    channels.some((c) => !Number.isInteger(c) || c < 0 || c > 3)
  )
    throw new RangeError(
      'Feature texture channels must be 1 to 4 distinct indices in 0..3; correct the feature ID texture',
    );
  return channels.reduce((id, c, i) => id + texel[c] * 2 ** (i * 8), 0);
}
/** Reads a decoded browser image without sRGB conversion or alpha premultiplication by the metadata layer. */
export function featureImage(source: { width: number; height: number }): FeatureImage {
  if (typeof OffscreenCanvas === 'undefined')
    throw new TypeError(
      'Metadata image decoding needs OffscreenCanvas; supply decoded RGBA8 texels with the image option',
    );
  const canvas = new OffscreenCanvas(source.width, source.height),
    context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(source as CanvasImageSource, 0, 0);
  const image = {
    width: source.width,
    height: source.height,
    data: context.getImageData(0, 0, source.width, source.height).data,
  };
  checkFeatureImage(image);
  return image;
}
