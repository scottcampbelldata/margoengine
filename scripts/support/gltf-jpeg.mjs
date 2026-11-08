// JPEG textures for the demo GLBs (scripts/optimize-demo-assets.js), kept apart so a test can check the encoding.
import sharp from 'sharp';

/**
 * A glTF image as a JPEG fitted inside `maxSize` (no enlargement; `size` instead forces exact dimensions), 4:4:4.
 *
 * JPEG holds no alpha. sharp writes an RGBA input to JPEG by compositing it over black, which multiplies every colour by
 * its alpha: the Khronos FlightHelmet's lens base colour (alpha 0.14 to 0.43) came out about 30 times too dark in
 * linear light, and the lenses rendered near black once the transmission tint read the base colour (6f0836ee3). glTF
 * ignores a base colour's alpha in OPAQUE mode (glTF 2.0, "Alpha Coverage"), so the colour is kept as authored and the
 * alpha is dropped. A caller must not pass the image of a BLEND or MASK material, whose alpha matters.
 * @param {Buffer|string} input  encoded image (PNG, JPEG...) or its path
 * @param {{ maxSize?: number, size?: { width: number, height: number }, quality: number }} options
 * @returns {Promise<Buffer>}
 */
export function jpegTexture(input, { maxSize, size, quality }) {
  const image = sharp(input);
  if (size) image.resize(size.width, size.height, { fit: 'fill' });
  else image.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true });
  return image.removeAlpha().jpeg({ quality, chromaSubsampling: '4:4:4' }).toBuffer();
}

/**
 * Images that lose information as JPEG: those used as the base colour of a BLEND or MASK material (by index).
 * @param {{ materials?: object[], textures?: { source: number }[] }} doc  glTF JSON
 * @returns {Set<number>}
 */
export function alphaImages(doc) {
  return new Set(
    (doc.materials ?? [])
      .filter((m) => m.alphaMode === 'BLEND' || m.alphaMode === 'MASK')
      .map((m) => m.pbrMetallicRoughness?.baseColorTexture)
      .filter(Boolean)
      .map((t) => doc.textures[t.index].source),
  );
}
