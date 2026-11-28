// The colour text 3MF takes, shared by the writer and its lazy volumetric part.
import { hexColor } from '@margoengine/math/color';

/** True for a '#RRGGBB' or '#RRGGBBAA' colour: math's hex parser, without the '#RGB' short form 3MF does not have. @internal */
export const isMixColor = (color: unknown): boolean =>
  typeof color === 'string' && color.length > 4 && !!hexColor(color);
