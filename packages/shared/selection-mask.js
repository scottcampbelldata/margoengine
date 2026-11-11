// Selection masks for @margoengine/points and @margoengine/lines: one bit an element after a 4-word header (mode,
// fade, highlight colour and amount, present), so a selection change uploads count/8 bytes and touches no material or
// pipeline. The look is defined on the displayed sRGB colour, so a GPU draw and a vector export (maskColor) agree.
import { MargoError } from '@margoengine/math/errors';

/** 32-bit words before the bits: mode, fade (f32 bits), highlight RGBA8 (sRGB colour, amount in alpha), 1 (present). */
export const MASK_HEADER = 4;
const MODES = ['fade', 'highlight', 'filter'];
const f32 = new Float32Array(1),
  u32 = new Uint32Array(f32.buffer);
// 8 bits of a 0..1 value; `srgb` encodes a linear channel first (the sRGB transfer function, IEC 61966-2-1).
const byte = (v, srgb) =>
  Math.round(255 * Math.min(1, Math.max(0, srgb ? (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) : v)));

/** Validates a mask style over `base` and returns a complete frozen copy. */
const maskStyle = (style, base) => {
  if (!style || typeof style !== 'object') throw new TypeError('A mask style is an object; pass { mode, fade }');
  const s = { ...base, ...style };
  if (!MODES.includes(s.mode)) throw new RangeError("Unknown mask mode; use 'fade', 'highlight' or 'filter'");
  for (const v of [s.fade, s.highlightAmount])
    if (typeof v !== 'number' || !(v >= 0 && v <= 1)) throw new RangeError('Mask fade and amount must be in [0, 1]');
  if (!(s.highlight?.length === 3) || ![...s.highlight].every((v) => v >= 0 && v < Infinity))
    throw new RangeError('Mask highlight is a linear [r, g, b] of finite values of 0 or more; pass such an array');
  return Object.freeze(s);
};

/** Writes the header of a mask style into `words`. A zeroed stand-in reads 0 at word 3, so shaders skip it. */
export function writeMaskHeader(words, style) {
  const c = style.highlight;
  f32[0] = style.fade;
  words[0] = MODES.indexOf(style.mode);
  words[1] = u32[0];
  words[2] =
    (byte(c[0], 1) | (byte(c[1], 1) << 8) | (byte(c[2], 1) << 16) | (byte(style.highlightAmount) << 24)) >>> 0;
  words[3] = 1;
  return words;
}

/** Sets bits `start ..` of `words` from `values`: an element is selected when its value is true or above 0. */
export function writeMaskBits(words, values, start = 0) {
  for (let i = 0; i < values.length; i++) {
    const w = MASK_HEADER + ((start + i) >>> 5),
      bit = 1 << ((start + i) & 31),
      v = values[i];
    if (typeof v !== 'boolean' && (typeof v !== 'number' || v !== v))
      throw new TypeError('Mask values are booleans or numbers; pass true or a value above 0 to select');
    words[w] = (v > 0 ? words[w] | bit : words[w] & ~bit) >>> 0;
  }
  return words;
}

const selected = (words, i) => ((words[MASK_HEADER + (i >>> 5)] >>> (i & 31)) & 1) === 1;

/**
 * The displayed sRGB colour of element `index` (and, for a segment, element `other` too) under the packed mask
 * `words`, exactly as the shader draws it, or null when the mask hides it. `rgb` is its sRGB colour in 0..1 without
 * the mask. A free function so only the vector exporters that use it carry it.
 */
export function maskColor(words, rgb, index, other = index) {
  if (!words) return [rgb[0], rgb[1], rgb[2]];
  const mode = words[0];
  if (selected(words, index) && selected(words, other)) {
    const amount = mode === 1 ? (words[2] >>> 24) / 255 : 0;
    return [0, 1, 2].map((k) => rgb[k] + (((words[2] >>> (8 * k)) & 255) / 255 - rgb[k]) * amount);
  }
  if (mode === 2) return null;
  u32[0] = words[1];
  return [0, 1, 2].map((k) => rgb[k] * f32[0]);
}

/**
 * The selection mask of a point cloud or line: `setMask` (in each class) packs it, the rest is shared. The mask is a
 * 4-word style header, then one bit an element.
 */
export class SelectionMasked {
  /** The selection mask (see `setMask`): a 4-word style header, then one bit an element; or null. */
  mask = null;
  /** Bumped when the mask bits or style change, so the next frame uploads them once. @internal */
  maskVersion = 0;
  #style = Object.freeze({ mode: 'fade', fade: 0.12, highlight: Object.freeze([1, 0.4508, 0.0194]), highlightAmount: 0.7 });

  /** How the mask shows elements: mode 'fade' (default), 'highlight' or 'filter', fade 0.12, highlight [1, 0.4508, 0.0194] (#ffb326) at 0.7. */
  get maskStyle() {
    return this.#style;
  }

  /** Changes how the mask shows elements, without touching its bits. */
  setMaskStyle(style) {
    this.#style = maskStyle(style, this.#style);
    if (this.mask) writeMaskHeader(this.mask, this.#style);
    this.maskVersion++;
    return this;
  }

  /** Overwrites the mask of elements `start ..`; one upload of the mask at the next frame. */
  updateMask(start, values) {
    if (!this.mask) throw new MargoError('state', 'There is no selection mask; call setMask first');
    if (!Number.isInteger(start) || start < 0 || start + values.length > this.count)
      throw new RangeError(
        `Mask values ${start}..${start + values.length} pass the ${this.count} elements; pass fewer`,
      );
    writeMaskBits(this.mask, values, start);
    this.maskVersion++;
    return this;
  }

  /** Whether element `index` is selected by the mask; true without a mask. */
  isSelected(index) {
    return !this.mask || selected(this.mask, index);
  }

  /** Validates `style` and makes it the mask style, for `setMask`. @internal */
  takeMaskStyle(style) {
    if (style) this.#style = maskStyle(style, this.#style);
    return this.#style;
  }
}
