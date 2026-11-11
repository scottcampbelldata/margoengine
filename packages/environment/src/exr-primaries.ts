// The `chromaticities` header attribute of an OpenEXR file (OpenEXR "Technical Introduction", standard attributes:
// red, green, blue and white CIE xy as eight float32 values; a file without it is Rec.709 with the D65 white) and the
// conversion of its RGB to linear sRGB / Rec.709 (D65), white adapted with the Bradford transform, as parseHDR does for
// Radiance PRIMARIES (SMPTE RP 177 for the primaries matrix). Shared by parseEXR, parseTiledEXR and the exr-codecs worker.
import { primariesToLinearSRGB } from '@margoengine/math/color';

// Rec.709 / sRGB primaries with the D65 white (ITU-R BT.709-6, IEC 61966-2-1).
const REC709 = [0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329];

/**
 * The `chromaticities` of header `part` (0 for a single-part file), or null when the header has none or it is not
 * eight finite numbers. Reads only the header; a damaged header gives null, and the decoder reports the damage.
 * @internal
 */
export function exrChromaticities(bytes: Uint8Array, part = 0): number[] | null {
  if (bytes.length < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    multi = (view.getUint32(4, true) & 0x1000) !== 0;
  let position = 8;
  const string = (): string | null => {
    const start = position;
    while (position < bytes.length && bytes[position] !== 0) {
      if (position - start > 255) return null;
      position++;
    }
    if (position >= bytes.length) return null;
    let text = '';
    for (let i = start; i < position; i++) text += String.fromCharCode(bytes[i]);
    position++;
    return text;
  };
  for (let header = 0; header <= part; header++) {
    let found: number[] | null = null;
    for (let attributes = 0; attributes <= 1024; attributes++) {
      const name = string();
      if (name === null) return null;
      if (name === '') break;
      const type = string();
      if (type === null || position + 4 > bytes.length) return null;
      const size = view.getInt32(position, true);
      position += 4;
      if (size < 0 || position + size > bytes.length) return null;
      if (name === 'chromaticities' && type === 'chromaticities' && size === 32) {
        const values = Array.from({ length: 8 }, (_, i) => view.getFloat32(position + i * 4, true));
        found = values.every(Number.isFinite) ? values : null;
      }
      position += size;
    }
    if (header === part) return found;
    // Multi-part: the next header follows; an empty header ends the list.
    if (!multi || position >= bytes.length || bytes[position] === 0) return null;
  }
  return null;
}

/**
 * The row-major matrix taking linear RGB in primaries `p` to linear sRGB, or null when `p` is Rec.709 (within 0.0015,
 * the precision files round to) or spans no colour space.
 * @internal
 */
export function exrToSRGB(p: number[] | null): number[] | null {
  if (!p || REC709.every((v, i) => Math.abs(v - p[i]) < 0.0015)) return null;
  const m = primariesToLinearSRGB(p);
  return m.every(Number.isFinite) ? m : null;
}

/**
 * Converts the RGB of interleaved RGBA `data` by row-major `m` in place. Colours outside the sRGB gamut keep their
 * negative components, as parseHDR's do.
 * @internal
 */
export function convertRGBA(data: Float32Array, m: readonly number[]): void {
  for (let o = 0; o < data.length; o += 4) {
    const r = data[o],
      g = data[o + 1],
      b = data[o + 2];
    data[o] = m[0] * r + m[1] * g + m[2] * b;
    data[o + 1] = m[3] * r + m[4] * g + m[5] * b;
    data[o + 2] = m[6] * r + m[7] * g + m[8] * b;
  }
}
