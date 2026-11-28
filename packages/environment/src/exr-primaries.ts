// The colour attributes of an OpenEXR header and the conversion of a file's RGB to linear sRGB / Rec.709 (D65).
// Which attribute names the colour space follows the Color Interop Forum's "OpenEXR Files" recommendation, "Reading
// OpenEXR Files" (ASWF, v1.0.0, 2026-07-14,
// https://github.com/AcademySoftwareFoundation/ColorInterop/blob/main/Recommendations/04_OpenEXRFiles/OpenEXRFiles.md):
//   1. an ACES container (`acesImageContainerFlag` 1, SMPTE ST 2065-4) is ACES2065-1;
//   2. the `colorInteropID` `data` is not colour managed;
//   3. a known `colorInteropID` names the space;
//   4. otherwise (absent, `unknown` or unrecognised) the older `chromaticities` attribute is the fallback.
// OpenEXR 3.4 says the ID supersedes `chromaticities` for most purposes ("Technical Introduction", "RGB Color",
// https://openexr.com/en/latest/TechnicalIntroduction.html). IDs, primaries and transfer functions: "Color Space
// Encodings for Texture Assets and CG Rendering" (ASWF, v1.1.0, 2026-07-14,
// https://github.com/AcademySoftwareFoundation/ColorInterop/blob/main/Recommendations/01_TextureAssetColorSpaces/TextureAssetColorSpaces.md).
// `chromaticities` is red, green, blue and white CIE xy as eight float32 values (OpenEXR standard attributes,
// https://openexr.com/en/latest/StandardAttributes.html); the white is adapted to D65 with the Bradford transform, as
// parseHDR does for Radiance PRIMARIES (SMPTE RP 177 for the primaries matrix). Shared by parseEXR, parseTiledEXR and the
// exr-codecs worker; parseEXR and parseTiledEXR read the attributes in their own header pass (readEXRHeader), the worker
// with exrColorAttributes, since the prebuilt decoder's header leaves them out.
import { primariesToLinearSRGB } from '@margoengine/math/color';

/** The header attributes that name a part's colour space. @internal */
export interface EXRColorAttributes {
  /** `chromaticities`, null when absent or not eight finite numbers. */
  primaries: number[] | null;
  /** `colorInteropID`, null when absent, empty or longer than 255 bytes. */
  colorInteropID: string | null;
  /** True when `acesImageContainerFlag` is 1. */
  acesImageContainer: boolean;
}

/** No colour attributes: a fresh record to read a header into. @internal */
export const noColorAttributes = (): EXRColorAttributes => ({
  primaries: null,
  colorInteropID: null,
  acesImageContainer: false,
});

/**
 * Takes one header attribute (`size` bytes at `position`, already known to lie in the file) into `into` when it is a
 * colour attribute. The last one counts when a header repeats it.
 * @internal
 */
export function readColorAttribute(
  into: EXRColorAttributes,
  name: string,
  type: string,
  view: DataView,
  position: number,
  size: number,
): void {
  if (name === 'chromaticities' && type === 'chromaticities' && size === 32) {
    const values = Array.from({ length: 8 }, (_, i) => view.getFloat32(position + i * 4, true));
    into.primaries = values.every(Number.isFinite) ? values : null;
  } else if (name === 'colorInteropID' && type === 'string') {
    let text = '';
    if (size <= 255) for (let i = 0; i < size; i++) text += String.fromCharCode(view.getUint8(position + i));
    into.colorInteropID = text || null;
  } else if (name === 'acesImageContainerFlag' && type === 'int' && size === 4)
    into.acesImageContainer = view.getInt32(position, true) === 1;
}

/**
 * The colour attributes that apply to header `part` (0 for a single-part file). In a multi-part file the first part's
 * `colorInteropID` describes every part that names none, and `data` there covers the whole file; the ACES flag and
 * `chromaticities` of a part are its own, the flag also taken from the first part. Reads only the headers; a damaged
 * header gives no attributes, and the decoder reports the damage.
 * @internal
 */
export function exrColorAttributes(bytes: Uint8Array, part = 0): EXRColorAttributes {
  if (bytes.length < 8) return noColorAttributes();
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
  let first: EXRColorAttributes | undefined;
  for (let header = 0; header <= part; header++) {
    const found = noColorAttributes();
    for (let attributes = 0; attributes <= 1024; attributes++) {
      const name = string();
      if (name === null) return noColorAttributes();
      if (name === '') break;
      const type = string();
      if (type === null || position + 4 > bytes.length) return noColorAttributes();
      const size = view.getInt32(position, true);
      position += 4;
      if (size < 0 || position + size > bytes.length) return noColorAttributes();
      readColorAttribute(found, name, type, view, position, size);
      position += size;
    }
    first ??= found;
    if (header === part) {
      if (first.colorInteropID === 'data') found.colorInteropID = 'data';
      found.colorInteropID ??= first.colorInteropID;
      found.acesImageContainer ||= first.acesImageContainer;
      return found;
    }
    // Multi-part: the next header follows; an empty header ends the list.
    if (!multi || position >= bytes.length || bytes[position] === 0) break;
  }
  return noColorAttributes();
}

/** How a file's RGB becomes linear sRGB: the transfer function is undone first, then the matrix applies. @internal */
export interface EXRConversion {
  decode: ((value: number) => number) | null;
  matrix: readonly number[] | null;
}

// CIE xy of red, green, blue and white (the recommendation's table; its figures are used as written).
const D65 = [0.3127, 0.329];
const D60 = [0.32168, 0.33767];
// Rec.709 / sRGB primaries (ITU-R BT.709-6, IEC 61966-2-1).
const REC709 = [0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329];
// CIE XYZ relative to D65 needs no adaptation: this is the XYZ to linear Rec.709 matrix of those primaries (CSS Color 4,
// "Sample code for color conversions", https://www.w3.org/TR/css-color-4/#color-conversion-code).
const XYZ_D65 = [
  3.2409699419, -1.5373831776, -0.4986107603, -0.9692436363, 1.8759675015, 0.0415550574, 0.0556300797, -0.2039769589,
  1.0569715142,
];

// The piecewise sRGB decode with the recommendation's own break point and slope (Annex B, from 2.4 and 0.055); negative
// values follow the linear segment, values above 1 the power segment ("Handling Values Outside [0,1]").
function srgbDecode(v: number): number {
  const g = 2.4,
    k = 0.055,
    breakAt = k / (g - 1),
    slope = ((g * k) / ((g - 1) * (1 + k))) ** g / breakAt;
  return v <= breakAt ? v * slope : ((v + k) / (1 + k)) ** g;
}
// A pure power; the recommendation passes negative values through.
const power = (g: number, v: number): number => (v > 0 ? v ** g : v);

/** The conversion of a colour interop ID, or undefined for an ID that names no space listed here. */
function interopSpace(id: string): EXRConversion | undefined {
  const to = (primaries: number[], decode: EXRConversion['decode'] = null): EXRConversion => ({
    decode,
    matrix: toSRGB(primaries),
  });
  const ap1 = (decode?: EXRConversion['decode']) => to([0.713, 0.293, 0.165, 0.83, 0.128, 0.044, ...D60], decode),
    p3 = (decode?: EXRConversion['decode']) => to([0.68, 0.32, 0.265, 0.69, 0.15, 0.06, ...D65], decode),
    adobe = (decode?: EXRConversion['decode']) => to([0.64, 0.33, 0.21, 0.71, 0.15, 0.06, ...D65], decode);
  switch (id) {
    case 'lin_ap1_scene':
      return ap1();
    case 'lin_ap0_scene':
      return to([0.7347, 0.2653, 0, 1, 0.0001, -0.077, ...D60]);
    case 'lin_rec709_scene':
      return to(REC709);
    case 'lin_p3d65_scene':
      return p3();
    case 'lin_rec2020_scene':
      return to([0.708, 0.292, 0.17, 0.797, 0.131, 0.046, ...D65]);
    case 'lin_adobergb_scene':
      return adobe();
    case 'lin_ciexyzd65_scene':
      return { decode: null, matrix: XYZ_D65 };
    case 'srgb_rec709_scene':
      return to(REC709, srgbDecode);
    case 'g24_rec709_scene':
      return to(REC709, (v) => power(2.4, v));
    case 'g22_rec709_scene':
      return to(REC709, (v) => power(2.2, v));
    case 'g18_rec709_scene':
      return to(REC709, (v) => power(1.8, v));
    case 'srgb_ap1_scene':
      return ap1(srgbDecode);
    case 'g22_ap1_scene':
      return ap1((v) => power(2.2, v));
    case 'srgb_p3d65_scene':
      return p3(srgbDecode);
    case 'g22_adobergb_scene':
      return adobe((v) => power(563 / 256, v));
  }
  return undefined;
}

/**
 * The row-major matrix taking linear RGB in primaries `p` to linear sRGB, or null when `p` is Rec.709 (within 0.0015,
 * the precision files round to) or spans no colour space.
 */
function toSRGB(p: number[] | null): number[] | null {
  if (!p || REC709.every((v, i) => Math.abs(v - p[i]) < 0.0015)) return null;
  const m = primariesToLinearSRGB(p);
  return m.every(Number.isFinite) ? m : null;
}

/**
 * The conversion the attributes call for, or null when the RGB is already linear sRGB or is `data`. An ID with a
 * namespace the list does not hold (`studio:lin_ap1_scene`) is looked up once more without its leftmost namespace, as
 * the "Color Interop ID" recommendation resolves IDs
 * (https://github.com/AcademySoftwareFoundation/ColorInterop/blob/main/Recommendations/03_ColorInteropID/ColorInteropID.md).
 * @internal
 */
export function exrConversion(color: EXRColorAttributes): EXRConversion | null {
  const id = color.acesImageContainer ? 'lin_ap0_scene' : color.colorInteropID;
  if (id === 'data') return null;
  const named = id === null ? undefined : (interopSpace(id) ?? interopSpace(id.slice(id.indexOf(':') + 1)));
  const conversion = named ?? { decode: null, matrix: toSRGB(color.primaries) };
  return conversion.decode || conversion.matrix ? conversion : null;
}

/**
 * Converts the RGB of interleaved RGBA `data` in place. Colours outside the sRGB gamut keep their negative components,
 * as parseHDR's do.
 * @internal
 */
export function convertRGBA(data: Float32Array, { decode, matrix: m }: EXRConversion): void {
  for (let o = 0; o < data.length; o += 4) {
    let r = data[o],
      g = data[o + 1],
      b = data[o + 2];
    if (decode) {
      r = decode(r);
      g = decode(g);
      b = decode(b);
    }
    data[o] = m ? m[0] * r + m[1] * g + m[2] * b : r;
    data[o + 1] = m ? m[3] * r + m[4] * g + m[5] * b : g;
    data[o + 2] = m ? m[6] * r + m[7] * g + m[8] * b : b;
  }
}
