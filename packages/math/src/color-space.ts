import { linearP3ToLinearSRGB, linearSRGBToLinearP3 } from './color.js';
import { encodeSRGB, decodeSRGB } from './srgb.js';
import type { ColorSpace, NumberArray } from './types.js';

/** Encoded sRGB, the colour space of CSS hex colours and most images. */
export const SRGBColorSpace = 'srgb';
/** Linear sRGB, Margo's working space. */
export const LinearSRGBColorSpace = 'srgb-linear';
/** Encoded Display P3: the DCI-P3 primaries, D65 white and the sRGB transfer function. */
export const DisplayP3ColorSpace = 'display-p3';
/** Linear Display P3. */
export const LinearDisplayP3ColorSpace = 'display-p3-linear';

const isEncoded = (space: ColorSpace): boolean => space === 'srgb' || space === 'display-p3';
const isP3 = (space: ColorSpace): boolean => space === 'display-p3' || space === 'display-p3-linear';
function check(space: ColorSpace): void {
  if (!isEncoded(space) && !isP3(space) && space !== 'srgb-linear')
    throw new TypeError(`Color space '${space}' is unknown; use srgb, srgb-linear, display-p3 or display-p3-linear`);
}

/**
 * Components `rgb` in space `from` as components in space `to`, in `out` (default a new array, which may be `rgb`
 * itself) at `offset`. Not clamped: a colour outside `to` keeps channels below 0 or above 1, so it converts back
 * unchanged; bring it inside sRGB with `clipToSRGB`. The same space on both sides copies the numbers exactly.
 * @throws TypeError for a name that is no colour space.
 */
export function convertColor<T extends NumberArray = number[]>(
  rgb: ArrayLike<number>,
  from: ColorSpace,
  to: ColorSpace,
  out?: T,
  offset = 0,
): T {
  check(from);
  check(to);
  const target = out ?? ([0, 0, 0] as unknown as T),
    v = [rgb[0], rgb[1], rgb[2]];
  if (from !== to) {
    if (isEncoded(from)) for (let k = 0; k < 3; k++) v[k] = decodeSRGB(v[k]);
    if (isP3(from)) linearP3ToLinearSRGB(v, v);
    if (isP3(to)) linearSRGBToLinearP3(v, v);
    if (isEncoded(to)) for (let k = 0; k < 3; k++) v[k] = encodeSRGB(v[k]);
  }
  for (let k = 0; k < 3; k++) target[offset + k] = v[k];
  return target;
}
