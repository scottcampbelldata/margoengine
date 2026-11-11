/** How a selection mask shows unselected and selected elements. */
export interface MaskStyle {
  /**
   * 'fade' darkens unselected elements to `fade` of their displayed sRGB colour; 'highlight' does that and also moves
   * selected elements `highlightAmount` of the way to `highlight`; 'filter' hides unselected elements. Default 'fade'.
   */
  readonly mode?: 'fade' | 'highlight' | 'filter';
  /** Displayed brightness of unselected elements, in [0, 1]. Default 0.12. */
  readonly fade?: number;
  /** Highlight colour, linear `[r, g, b]`, stored as 8-bit sRGB. Default `[1, 0.4508, 0.0194]` (#ffb326). */
  readonly highlight?: readonly [number, number, number];
  /** How far selected elements move to `highlight`, in [0, 1], stored in 8 bits. Default 0.7. */
  readonly highlightAmount?: number;
}

export const MASK_HEADER: 4;
export function writeMaskHeader(words: Uint32Array, style: Required<MaskStyle>): Uint32Array;
export function writeMaskBits(words: Uint32Array, values: ArrayLike<number | boolean>, start?: number): Uint32Array;
/**
 * The displayed sRGB colour of element `index` (and, for a segment, element `other` too) under the packed mask
 * `words`, exactly as the shader draws it, or null when the mask hides it. `rgb` is its sRGB colour in 0..1 without
 * the mask.
 */
export function maskColor(
  words: Uint32Array | null,
  rgb: ArrayLike<number>,
  index: number,
  other?: number,
): number[] | null;

/**
 * The selection mask of a point cloud or line: `setMask` (in each class) packs it, the rest is shared. The mask is a
 * 4-word style header, then one bit an element.
 */
export abstract class SelectionMasked {
  /** Element count the mask covers. */
  abstract readonly count: number;
  /** The selection mask (see `setMask`): a 4-word style header, then one bit an element; or null. */
  mask: Uint32Array | null;
  /** Bumped when the mask bits or style change, so the next frame uploads them once. @internal */
  maskVersion: number;
  /** How the mask shows elements: mode 'fade' (default), 'highlight' or 'filter', fade 0.12, highlight [1, 0.4508, 0.0194] (#ffb326) at 0.7. */
  get maskStyle(): Readonly<Required<MaskStyle>>;
  /** Changes how the mask shows elements, without touching its bits. */
  setMaskStyle(style: MaskStyle): this;
  /** Overwrites the mask of elements `start ..`; one upload of the mask at the next frame. */
  updateMask(start: number, values: ArrayLike<number | boolean>): this;
  /** Whether element `index` is selected by the mask; true without a mask. */
  isSelected(index: number): boolean;
  /** Validates `style` and makes it the mask style, for `setMask`. @internal */
  takeMaskStyle(style?: MaskStyle): Readonly<Required<MaskStyle>>;
}
