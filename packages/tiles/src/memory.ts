// GPU memory of a tile's model, so the renderer's memory budget counts what the device holds rather than the size of
// the tile file: a compressed b3dm of 1 MB can take 20 MB of vertex buffers and mipmapped textures. Counted from the
// model gltf-pro made: its vertex, index and uv arrays (uploaded as they are) and every texture its materials bind,
// as rgba8 with a full mip chain, or the transcoded levels of a KTX2 image.

/** The parts of a gltf-pro model (`PBRModel`) the count reads; all optional, so any model fits. */
export interface MeasurableModel {
  readonly primitives?: readonly MeasurablePrimitive[];
  readonly pointsAndLines?: readonly MeasurablePrimitive[];
  readonly asset?: { readonly doc?: { readonly textures?: readonly (TextureJSON | undefined)[] } };
  image?(index: number): unknown;
}
interface MeasurablePrimitive {
  readonly vertices?: ArrayBufferView;
  readonly indices?: ArrayBufferView;
  readonly uvs?: ArrayBufferView;
  readonly material?: { readonly maps?: readonly ({ readonly index: number } | null | undefined)[] };
}
interface TextureJSON {
  source?: number;
  extensions?: Record<string, { source?: number } | undefined>;
}

/** Bytes of an rgba8 texture of `width` x `height` with `levels` mip levels (all of them when omitted). */
export function textureBytes(width: number, height: number, levels?: number): number {
  const count = levels ?? Math.floor(Math.log2(Math.max(width, height, 1))) + 1;
  let bytes = 0;
  for (let level = 0; level < count; level++) bytes += Math.max(1, width >> level) * Math.max(1, height >> level) * 4;
  return bytes;
}

/** GPU bytes of one decoded image as gltf-pro uploads it, or 0 when there is none. */
function imageBytes(image: unknown): number {
  if (!image || typeof image !== 'object') return 0;
  const compressed =
    'ktx2' in image
      ? (image as { ktx2: { mipmaps: readonly { byteLength: number }[] } }).ktx2
      : 'mipmaps' in image
        ? (image as { mipmaps: readonly { byteLength: number }[] })
        : undefined;
  if (compressed) return compressed.mipmaps.reduce((sum, mip) => sum + mip.byteLength, 0);
  // A streamed image holds only the levels it has streamed in; its own budget governs it.
  if ('streamed' in image) return 0;
  const { width, height } = image as { width?: number; height?: number };
  return typeof width === 'number' && typeof height === 'number' ? textureBytes(width, height) : 0;
}

/**
 * GPU bytes a gltf-pro model of a tile takes: its unique vertex, index and uv arrays plus each texture its materials
 * bind once. A model with no `primitives` (a custom `loadModel`) returns `undefined`, and the renderer counts it by
 * its file size.
 */
export function modelGpuBytes(model: MeasurableModel): number | undefined {
  if (!Array.isArray(model.primitives)) return undefined;
  const arrays = new Set<ArrayBufferView>(),
    textures = new Set<number>();
  for (const primitive of [...model.primitives, ...(model.pointsAndLines ?? [])]) {
    for (const array of [primitive.vertices, primitive.indices, primitive.uvs]) if (array) arrays.add(array);
    for (const map of primitive.material?.maps ?? []) if (map) textures.add(map.index);
  }
  let bytes = 0;
  for (const array of arrays) bytes += array.byteLength;
  const defs = model.asset?.doc?.textures ?? [],
    images = new Set<number>();
  for (const index of textures) {
    const def = defs[index];
    if (!def) continue;
    // gltf-pro takes the first decoded of KHR_texture_basisu, EXT_texture_webp, EXT_texture_avif, then `source`.
    const decoded = (['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif'] as const)
      .map((name) => def.extensions?.[name]?.source)
      .find((source) => source !== undefined && imageAt(model, source) !== undefined);
    const source = decoded ?? def.source;
    if (source !== undefined) images.add(source);
  }
  for (const source of images) bytes += imageBytes(imageAt(model, source));
  return bytes;
}

/** The decoded image `index` of a model, or undefined when the loader left it undecoded (an unsupported format). */
function imageAt(model: MeasurableModel, index: number): unknown {
  const images = (model as { images?: readonly unknown[] }).images;
  if (Array.isArray(images)) return images[index];
  return model.image?.(index);
}
