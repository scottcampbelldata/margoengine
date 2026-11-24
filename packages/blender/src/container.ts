import { parseJSON } from "../../shared/json.js";

/** Largest .margo file, decoded geometry and decoded image total, in bytes. */
export const maxBytes = 256 * 1024 * 1024;
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
/** Header flag of a file with skins, morph targets or animations (FORMAT.md, "Animated files"). */
export const animatedFlag = 1;
/** Header flag of a file with curves, point clouds or volumes (FORMAT.md, "Curves, points and volumes"). */
export const shapesFlag = 2;
/** Header flag for lossless meshopt geometry sections, read only by the optional meshopt entry. */
export const meshoptFlag = 4;

/** One entry of the section table: its type, the element stride its flags select and its bytes in the file. */
export interface MargoSection {
  readonly type: number;
  readonly stride: number;
  readonly flags: number;
  /** Byte offset from the start of the file. */
  readonly offset: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}
/** The checked container: the file's storage, its section table and its parsed (not yet checked) manifest. */
export interface MargoContainer {
  readonly buffer: ArrayBuffer;
  readonly base: number;
  readonly length: number;
  readonly flags: number;
  readonly sections: readonly MargoSection[];
  readonly manifest: unknown;
}

/**
 * Checks the header and section table of `.margo` bytes and parses the manifest. `accept` is the one header flag the
 * caller reads besides a static file (0 for none): each reader refuses the other kinds by name.
 */
export function readContainer(
  input: ArrayBuffer | ArrayBufferView,
  accept: 0 | typeof animatedFlag | typeof shapesFlag | typeof meshoptFlag,
): MargoContainer {
  if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input))
    throw new TypeError(
      "Expected .margo bytes; pass an ArrayBuffer or a typed array holding the file",
    );
  const buffer = input instanceof ArrayBuffer ? input : input.buffer,
    base = input instanceof ArrayBuffer ? 0 : input.byteOffset,
    length = input.byteLength;
  if (!(buffer instanceof ArrayBuffer) || base % 4 || !littleEndian)
    throw new TypeError(
      ".margo requires aligned, little-endian ArrayBuffer storage; pass an ArrayBuffer (not a SharedArrayBuffer) whose byte offset is a multiple of 4",
    );
  if (length < 64 || length > maxBytes || length % 4)
    throw new RangeError(
      "Invalid .margo size; the file must be 64 bytes to 256 MiB and a multiple of 4, so re-export it from Blender",
    );
  const view = new DataView(buffer, base, length);
  if (
    view.getUint32(0, true) !== 0x4f47524d ||
    view.getUint32(4, true) !== 1 ||
    view.getUint32(8, true) !== length ||
    view.getUint32(16, true) !== 64 ||
    view.getUint32(24, true) !== 80
  )
    throw new TypeError(
      "Invalid .margo header/version/stride; the input is not a version 1 .margo file, so export it again with the Margo Blender add-on",
    );
  const flags = view.getUint32(20, true);
  if (flags === animatedFlag && accept !== animatedFlag)
    throw new TypeError(
      "Animated .margo (skins, shape keys or actions); load it with parseAnimatedMargo or loadAnimatedMargo from @margoengine/blender/anim",
    );
  if (flags === shapesFlag && accept !== shapesFlag)
    throw new TypeError(
      ".margo with curves, point clouds or volumes; load it with parseMargoCurves or loadMargoCurves from @margoengine/blender/curves",
    );
  if (flags === meshoptFlag && accept !== meshoptFlag)
    throw new TypeError('Meshopt .margo geometry; expand it with expandMargoMeshopt or load it with loadMargoMeshopt from @margoengine/blender/meshopt');
  for (let at = 20; at < 64; at += 4)
    if (
      at !== 24 &&
      view.getUint32(at, true) !== 0 &&
      !(at === 20 && flags === accept)
    )
      throw new TypeError(
        "Unsupported .margo flags; the file was written by a newer exporter, so update @margoengine/blender or re-export it",
      );
  const count = view.getUint32(12, true);
  if (count < 3 || count > 4096 || 64 + count * 16 > length)
    throw new RangeError(
      "Invalid .margo section count; the file is truncated or corrupt, so download or export it again",
    );
  const sections: MargoSection[] = [],
    types =
      flags === meshoptFlag
        ? [1, 2, 3, 4, 5, 6, 7, 8, 9]
        : flags === animatedFlag
        ? [1, 2, 3, 4, 5]
        : flags === shapesFlag
          ? [1, 2, 3, 4, 6, 7]
          : [1, 2, 3, 4, 8];
  let end = 64 + count * 16;
  for (let i = 0; i < count; i++) {
    const at = 64 + i * 16,
      type = view.getUint32(at, true),
      offset = view.getUint32(at + 4, true),
      size = view.getUint32(at + 8, true),
      sectionFlags = view.getUint32(at + 12, true),
      stride =
        type === 2
          ? sectionFlags === 1
            ? 24
            : 80
          : sectionFlags === 1
            ? 2
            : 4;
    if (
      !types.includes(type) ||
      sectionFlags > (type === 2 ? 1 : type === 3 ? 2 : 0) ||
      !size ||
      offset !== end ||
      offset + size > length
    )
      throw new RangeError(
        "Invalid .margo section bounds/type/alignment; the file is truncated or corrupt, so download or export it again",
      );
    if (
      (i === 0) !== (type === 1) ||
      (type === 1 && size > 1024 * 1024) ||
      (type === 2 && size % stride) ||
      (type === 3 && size % (stride * 3))
    )
      throw new RangeError(
        "Invalid .margo section layout; the file is corrupt, so re-export it from Blender",
      );
    sections.push({
      type,
      stride,
      flags: sectionFlags,
      offset,
      bytes: new Uint8Array(buffer, base + offset, size),
    });
    end = (offset + size + 3) & ~3;
  }
  if (end !== length)
    throw new RangeError(
      "Trailing/truncated .margo data; the file has missing or extra bytes, so download or export it again",
    );
  let manifest: unknown;
  try {
    manifest = parseJSON(
      new TextDecoder("utf-8", { fatal: true }).decode(sections[0].bytes),
    );
  } catch {
    // Malformed UTF-8 or JSON: a named error, not TextDecoder's TypeError or JSON.parse's SyntaxError.
    throw new TypeError(
      "Invalid .margo scene JSON; the scene section is not UTF-8 JSON, so re-export the file from Blender",
    );
  }
  return { buffer, base, length, flags, sections, manifest };
}

/** Checks a PNG section's header (8-bit RGBA, non-interlaced, 1..4096 square bounds) and returns its size. */
export function pngSize(
  bytes: Uint8Array<ArrayBuffer>,
): [width: number, height: number] {
  const png = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 33 ||
    png.getUint32(0) !== 0x89504e47 ||
    png.getUint32(4) !== 0x0d0a1a0a ||
    png.getUint32(8) !== 13 ||
    png.getUint32(12) !== 0x49484452 ||
    bytes[24] !== 8 ||
    bytes[25] !== 6 ||
    bytes[26] ||
    bytes[27] ||
    bytes[28]
  )
    throw new TypeError(
      "Invalid .margo RGBA8 PNG; embed 8-bit RGBA, non-interlaced PNG images",
    );
  const width = png.getUint32(16),
    height = png.getUint32(20);
  if (!width || !height || width > 4096 || height > 4096)
    throw new RangeError(
      ".margo images exceed decoded size limit; use textures of at most 4096 x 4096 pixels",
    );
  return [width, height];
}

/** Decodes embedded PNG sections to bitmaps, checking each decoded size against its header; closes them on failure. */
export async function decodeImages(
  pngs: readonly Uint8Array<ArrayBuffer>[],
  signal: AbortSignal | undefined,
): Promise<ImageBitmap[]> {
  const images: ImageBitmap[] = [];
  try {
    for (const bytes of pngs) {
      signal?.throwIfAborted();
      const image = await createImageBitmap(
        new Blob([bytes], { type: "image/png" }),
        {
          colorSpaceConversion: "none",
          premultiplyAlpha: "none",
        },
      ).catch((error) => {
        // The browser rejects undecodable bytes with a DOMException: report it as the loader's own error.
        throw new TypeError(
          `.margo image ${images.length} could not be decoded (${error?.message ?? error}); re-export it as a valid PNG`,
        );
      });
      images.push(image);
      const [width, height] = pngSize(bytes);
      if (image.width !== width || image.height !== height)
        throw new RangeError(
          "Decoded .margo image size mismatch; the PNG header disagrees with its pixels, so re-export the image",
        );
    }
    signal?.throwIfAborted();
    return images;
  } catch (error) {
    for (const image of images) image.close();
    throw error;
  }
}

/** Expands compact 24-byte vertices to the renderer's 80-byte PBR layout: w = 1, zero tangents and UVs, white. */
export function expandCompact(
  packed: Float32Array,
  count: number,
): Float32Array<ArrayBuffer> {
  const expanded = new Float32Array(count * 20);
  for (let i = 0; i < count; i++) {
    for (let axis = 0; axis < 3; axis++) {
      expanded[i * 20 + axis] = packed[i * 6 + axis];
      expanded[i * 20 + 4 + axis] = packed[i * 6 + 3 + axis];
    }
    expanded[i * 20 + 3] = 1;
    expanded.fill(1, i * 20 + 16, i * 20 + 20);
  }
  return expanded;
}
