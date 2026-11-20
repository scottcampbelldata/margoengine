// TIFF directory scanning shared by the TIFF reader (tiff.ts) and its codec loader (tiff-codecs.ts), from the Adobe
// TIFF Revision 6.0 specification (Section 2) and the BigTIFF design (64-bit offsets, version 43).
import { decodeFailed } from './errors.js';

export const corrupt = (problem: string): Error =>
  decodeFailed(`TIFF ${problem}; pass the complete bytes of a valid TIFF file`);

/** ASCII tags kept per directory besides ImageDescription's own `descriptions`: GeoAsciiParams, GDAL_METADATA, GDAL_NODATA. */
const KEPT_ASCII = new Set([270, 34737, 42112, 42113]);

/** Every directory of a classic TIFF or BigTIFF file, bounded and cycle-checked. */
export function scanTIFF(bytes: Uint8Array) {
  const little = bytes[0] === 73 && bytes[1] === 73;
  if (bytes.length < 8 || (!little && !(bytes[0] === 77 && bytes[1] === 77))) throw corrupt('header is missing');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bound = (at: number, size: number) => {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(size) || at < 0 || size < 0 || at + size > bytes.length)
      throw corrupt('offset or count exceeds the file');
  };
  const u16 = (at: number) => {
    bound(at, 2);
    return view.getUint16(at, little);
  };
  const u32 = (at: number) => {
    bound(at, 4);
    return view.getUint32(at, little);
  };
  const u64 = (at: number) => {
    bound(at, 8);
    const n = view.getBigUint64(at, little);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw corrupt('64-bit offset exceeds safe addressing');
    return Number(n);
  };
  const version = u16(2),
    bigTIFF = version === 43;
  if (version !== 42 && version !== 43) throw corrupt('version is invalid');
  if (bigTIFF && (u16(4) !== 8 || u16(6) !== 0)) throw corrupt('BigTIFF offset layout is invalid');
  const pointer = bigTIFF ? u64 : u32,
    head = bigTIFF ? 8 : 2,
    stride = bigTIFF ? 20 : 12,
    inline = bigTIFF ? 8 : 4;
  let ifd = pointer(bigTIFF ? 8 : 4);
  const directories: Map<number, number[]>[] = [],
    descriptions: string[] = [],
    asciiTags: Map<number, string>[] = [],
    seen = new Set<number>();
  const sizes: Record<number, number> = {
    1: 1,
    2: 1,
    3: 2,
    4: 4,
    5: 8,
    6: 1,
    7: 1,
    8: 2,
    9: 4,
    10: 8,
    11: 4,
    12: 8,
    13: 4,
    16: 8,
    17: 8,
    18: 8,
  };
  while (ifd) {
    if (seen.has(ifd)) throw corrupt('cyclic IFD chain');
    seen.add(ifd);
    const count = bigTIFF ? u64(ifd) : u16(ifd),
      tags = new Map<number, number[]>();
    bound(ifd + head, count * stride + inline);
    let description = '';
    const ascii = new Map<number, string>();
    for (let e = 0; e < count; e++) {
      const at = ifd + head + e * stride,
        id = u16(at),
        type = u16(at + 2),
        n = pointer(at + 4),
        size = sizes[type];
      if (!size) continue;
      const slot = at + (bigTIFF ? 12 : 8),
        offset = n * size <= inline ? slot : pointer(slot);
      bound(offset, n * size);
      if (type === 2) {
        if (KEPT_ASCII.has(id)) {
          const text = new TextDecoder().decode(bytes.subarray(offset, offset + n));
          if (id === 270) description = text.replace(/\0+$/, '');
          // GeoAsciiParams keeps its `|` terminators (GeoKeys index into it); the others end at their first NUL.
          ascii.set(id, id === 34737 ? text.replace(/\0+$/, '') : text.replace(/\0[\s\S]*$/, ''));
        }
        continue;
      }
      const values: number[] = [];
      for (let i = 0; i < n; i++) {
        const p = offset + i * size;
        values.push(
          type === 1 || type === 7
            ? bytes[p]
            : type === 3
              ? u16(p)
              : type === 4 || type === 13
                ? u32(p)
                : type === 6
                  ? view.getInt8(p)
                  : type === 8
                    ? view.getInt16(p, little)
                    : type === 9
                      ? view.getInt32(p, little)
                      : type === 11
                        ? view.getFloat32(p, little)
                        : type === 12
                          ? view.getFloat64(p, little)
                          : type === 16 || type === 18
                            ? u64(p)
                            : type === 17
                              ? Number(view.getBigInt64(p, little))
                              : type === 5
                                ? u32(p) / u32(p + 4)
                                : view.getInt32(p, little) / view.getInt32(p + 4, little),
        );
      }
      tags.set(id, values);
    }
    directories.push(tags);
    descriptions.push(description);
    asciiTags.push(ascii);
    ifd = pointer(ifd + head + count * stride);
  }
  if (!directories.length) throw corrupt('no image directories');
  return { little, bigTIFF, directories, descriptions, asciiTags };
}
