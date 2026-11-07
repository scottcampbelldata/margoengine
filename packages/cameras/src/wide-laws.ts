// The projection laws `WideAngle` and `WideAngleCube` share: the usual fisheye mappings r = f g(theta).

/** The projection to draw: Panini, or a fisheye with the named radius law. */
export type WideAngleMode = 'panini' | 'equidistant' | 'equisolid' | 'stereographic' | 'orthographic';

export const MODES: Record<WideAngleMode, number> = {
  panini: 0,
  equidistant: 1,
  equisolid: 2,
  stereographic: 3,
  orthographic: 4,
};
// Radius law g(theta) of a fisheye and its inverse; null outside the domain the law reaches.
export const GAIN: Record<string, (theta: number) => number> = {
  equidistant: (t) => t,
  equisolid: (t) => 2 * Math.sin(t / 2),
  stereographic: (t) => 2 * Math.tan(t / 2),
  orthographic: (t) => Math.sin(t),
};
export const INVERSE: Record<string, (r: number) => number | null> = {
  equidistant: (r) => r,
  equisolid: (r) => (r <= 2 ? 2 * Math.asin(r / 2) : null),
  stereographic: (r) => 2 * Math.atan(r / 2),
  orthographic: (r) => (r <= 1 ? Math.asin(r) : null),
};
