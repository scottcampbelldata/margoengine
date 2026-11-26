import { MargoError } from '@margoengine/math/errors';
import { type CrushVector, dot, scale } from './rigid-contact.js';

/** Hill-48 in-plane yield metric from three uniaxial Lankford ratios. */
export interface CrushShellAnisotropy {
  /** Rest-space rolling direction, projected onto each triangle. */
  readonly rollingDirection: CrushVector;
  /** Width/thickness plastic strain ratio for a 0° coupon. */
  readonly r0: number;
  /** Width/thickness plastic strain ratio for a 45° coupon. */
  readonly r45: number;
  /** Width/thickness plastic strain ratio for a 90° coupon. */
  readonly r90: number;
}

export function shellAnisotropy(input: CrushShellAnisotropy): {
  readonly rolling: CrushVector;
  readonly metric: readonly [number, number, number, number];
} {
  const { r0, r45, r90, rollingDirection } = input;
  const length = Math.sqrt(dot(rollingDirection, rollingDirection));
  if (![r0, r45, r90, length].every((value) => value > 0 && Number.isFinite(value)) || rollingDirection.length !== 3)
    throw new MargoError(
      'state',
      'Use finite positive Lankford ratios and a nonzero three-component rolling direction.',
    );
  const g = 1 / (1 + r0);
  const h = r0 * g;
  const f = h / r90;
  const n = (((r0 + r90) * g) / r90) * (r45 + 0.5);
  const det = f * g + h * (f + g);
  if (![f, g, h, n, det].every((value) => value > 0 && Number.isFinite(value)))
    throw new MargoError('state', 'Choose Lankford ratios with a finite positive plane-stress metric.');
  return { rolling: scale(rollingDirection, 1 / length), metric: [f, g, h, n] };
}
