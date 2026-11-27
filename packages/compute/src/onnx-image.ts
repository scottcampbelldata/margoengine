// ai.onnx ImageDecoder (opset 20, https://onnx.ai/onnx/operators/onnx__ImageDecoder.html). The stream's own signature
// picks a reader of @margoengine/decoders, an optional peer that loads only when a model decodes that format. The grey
// weights are the luma of Rec. ITU-R BT.601 (https://www.itu.int/rec/R-REC-BT.601); the operator names none.
import { fault } from '../../shared/errors.js';

/** What ImageDecoder returns: bytes in height, width, channel order. */
export interface ImagePixels {
  data: Uint8Array;
  shape: [number, number, number];
}
interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}
type Reader = (bytes: Uint8Array) => Rgba;

const unsupported = (what: string) =>
  fault(
    'unsupported',
    `ONNX ImageDecoder does not read ${what}; convert the image to PNG, JPEG, JPEG 2000, WebP, BMP, TIFF or PNM`,
    'compute',
  );

/** The reader for a stream's signature, loaded on demand; undefined when the bytes are no image format the operator names. */
async function reader(bytes: Uint8Array): Promise<Reader | undefined> {
  const starts = (...signature: number[]) => signature.every((v, i) => bytes[i] === v);
  if (starts(0x89, 0x50, 0x4e, 0x47)) {
    const { decodePNG } = await import('@margoengine/decoders/png');
    return (b) => decodePNG(b);
  }
  if (starts(0xff, 0xd8, 0xff)) return (await import('@margoengine/decoders/jpeg')).decodeJPEG;
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP')
    return (await import('@margoengine/decoders/webp')).parseWebP;
  if (starts(0x42, 0x4d)) return (await import('@margoengine/decoders/bmp')).parseBMP;
  if (starts(0x49, 0x49, 43, 0) || starts(0x4d, 0x4d, 0, 43)) throw unsupported('BigTIFF');
  if (starts(0x49, 0x49, 42, 0) || starts(0x4d, 0x4d, 0, 42)) {
    const [{ parseTIFF }, { loadTIFFCodecs }] = await Promise.all([
      import('@margoengine/decoders/tiff'),
      import('@margoengine/decoders/tiff-codecs'),
    ]);
    // A directory too damaged to scan leaves the codecs out; parseTIFF then reports the damage.
    const codecs = await loadTIFFCodecs(bytes).catch((error: unknown) => {
      if (isDecodeFailure(error)) return {};
      throw error;
    });
    return (b) => {
      const image = parseTIFF(b, { codecs });
      if (image.format === 'rgba8unorm') return image;
      // Floating-point samples: 0 to 1 spans the byte range.
      const data = Uint8Array.from(image.data, (v) => (v > 0 ? Math.min(255, Math.round(v * 255)) : 0));
      return { width: image.width, height: image.height, data };
    };
  }
  if (bytes[0] === 0x50 && bytes[1] >= 0x31 && bytes[1] <= 0x36)
    return (await import('@margoengine/decoders/pnm')).parsePNM;
  // A raw codestream (SOC then SIZ) or a JP2 file (the signature box).
  if (starts(0xff, 0x4f, 0xff, 0x51) || starts(0, 0, 0, 12, 0x6a, 0x50, 0x20, 0x20)) {
    const { loadJPEG2000 } = await import('@margoengine/decoders/jpeg2000');
    const read = await loadJPEG2000();
    // The default depth is 8, so the samples are bytes.
    return (b) => read(b) as Rgba;
  }
  return undefined;
}

/** True for a decoder's report that these bytes give no picture: damaged, over its pixel limit, or an unread coding. */
function isDecodeFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return error instanceof RangeError || code === 'failed' || code === 'unsupported';
}

/**
 * Decodes one encoded image to `[height, width, 3]` (RGB or BGR) or `[height, width, 1]` (Grayscale) bytes, alpha
 * dropped. A stream that cannot be decoded gives the empty matrix `[0, 0, channels]`, as the operator specifies.
 */
export async function decodeImagePixels(bytes: Uint8Array, format: string): Promise<ImagePixels> {
  const channels = format === 'Grayscale' ? 1 : 3,
    empty: ImagePixels = { data: new Uint8Array(0), shape: [0, 0, channels] };
  const read = await reader(bytes);
  if (!read) return empty;
  let image: Rgba;
  try {
    image = read(bytes);
  } catch (error) {
    if (isDecodeFailure(error)) return empty;
    throw error;
  }
  const { width, height, data: rgba } = image,
    data = new Uint8Array(width * height * channels),
    first = format === 'BGR' ? 2 : 0;
  for (let from = 0, to = 0; to < data.length; from += 4, to += channels)
    if (channels === 1) data[to] = ((rgba[from] * 299 + rgba[from + 1] * 587 + rgba[from + 2] * 114 + 500) / 1000) | 0;
    else {
      data[to] = rgba[from + first];
      data[to + 1] = rgba[from + 1];
      data[to + 2] = rgba[from + 2 - first];
    }
  return { data, shape: [height, width, channels] };
}
