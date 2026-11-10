import type { ExtensionHooks, FBXExtension } from './extension.js';

async function image(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  let pixels;
  if (bytes[0] === 66 && bytes[1] === 77) {
    const { parseBMP } = await import('@margoengine/decoders/bmp');
    pixels = parseBMP(bytes);
  } else if (bytes[0] === 68 && bytes[1] === 68 && bytes[2] === 83 && bytes[3] === 32) {
    const [{ parseDDS }, { textureFileToRGBA }] = await Promise.all([
      import('@margoengine/decoders/dds'),
      import('@margoengine/decoders/texture-rgba'),
    ]);
    const file = parseDDS(bytes);
    if (file.dimension !== '2d')
      throw new TypeError('FBX material DDS must be a 2D image; export each face as a separate texture');
    pixels = await textureFileToRGBA(file);
  } else if ((bytes[0] === 73 && bytes[1] === 73) || (bytes[0] === 77 && bytes[1] === 77)) {
    const { parseTIFF } = await import('@margoengine/decoders/tiff');
    const decoded = parseTIFF(bytes);
    if (decoded.data instanceof Uint8Array) pixels = { ...decoded, data: decoded.data };
    else {
      const { textureFileToRGBA } = await import('@margoengine/decoders/texture-rgba');
      const data = new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
      pixels = await textureFileToRGBA({
        ...decoded,
        target: 'dds',
        layers: 1,
        dimension: '2d',
        mipmaps: [{ width: decoded.width, height: decoded.height, data, byteLength: data.byteLength }],
        srgb: false,
        hasAlpha: true,
      });
    }
  } else if (bytes.length >= 18 && [1, 2, 3, 9, 10, 11].includes(bytes[2]) && bytes[1] <= 1) {
    const { parseTGA } = await import('@margoengine/decoders/tga');
    pixels = parseTGA(bytes);
  } else return undefined;
  const { encodePNG } = await import('@margoengine/exporters/capture');
  return encodePNG(pixels);
}

/** Decodes TGA, DDS, TIFF and BMP material images, embedded or external, through optional decoder entries. */
export const textures: FBXExtension = { name: 'textures', image } as ExtensionHooks;
