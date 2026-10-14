import {parseColor as parse} from '@margoengine/math/color';

/** A color: '#rrggbb' or '#rgb' (sRGB), a 0xrrggbb number (sRGB), or [r, g, b] in linear RGB 0..1 like PbrMaterial. */
export type ColorInput = string | number | readonly number[];

/** Converts a ColorInput to linear RGB (`@margoengine/math/color` parseColor). */
export const parseColor: (value: ColorInput, out?: Float32Array | number[], offset?: number) => Float32Array | number[] = parse;
