// One link of a steel chain: a round wire bent into a stadium (two straight legs joined by half circles), long along
// +Y and lying in the XY plane, centred on the origin. Its centre line is exact (straight legs, circular ends) and
// parametrised by arc length, so the tube rings are evenly spaced and the wire stays round. Turn every other link a
// quarter turn about Y to interleave them, as a real chain hangs.
import type { GeometryData } from './data.js';
import { Curve } from './curve.js';
import type { MutableVec3 } from './math.js';
import { tubeGeometry } from './primitives.js';

export interface ChainLinkOptions {
  /** Outside length of the link along Y, wire included (default 0.06). */
  length?: number;
  /** Outside width of the link along X, wire included (default 40 percent of `length`). */
  width?: number;
  /** Wire radius (default 9 percent of `width`). */
  wire?: number;
  /** Rings along the centre line (default 48). */
  segments?: number;
  /** Sides around the wire (default 10). */
  radialSegments?: number;
}

/** The stadium centre line: right leg up, top half circle, left leg down, bottom half circle. */
class Stadium extends Curve<MutableVec3> {
  constructor(
    private readonly half: number,
    private readonly radius: number,
  ) {
    super();
  }
  getPoint(t: number): MutableVec3 {
    const r = this.radius,
      leg = 2 * this.half,
      arc = Math.PI * r;
    let s = (((t % 1) + 1) % 1) * (2 * leg + 2 * arc);
    if (s < leg) return [r, s - this.half, 0];
    if ((s -= leg) < arc) return [r * Math.cos(s / r), this.half + r * Math.sin(s / r), 0];
    if ((s -= arc) < leg) return [-r, this.half - s, 0];
    s -= leg;
    return [-r * Math.cos(s / r), -this.half - r * Math.sin(s / r), 0];
  }
}

/** A chain link as a closed tube. Throws `RangeError` for a non-positive size or a wire too thick for the link. */
export function chainLinkGeometry(options: ChainLinkOptions = {}): GeometryData {
  const length = options.length ?? 0.06;
  const width = options.width ?? 0.4 * length;
  const wire = options.wire ?? 0.09 * width;
  for (const [name, value] of [
    ['length', length],
    ['width', width],
    ['wire', wire],
  ] as const)
    if (!Number.isFinite(value) || value <= 0)
      throw new RangeError(`chainLinkGeometry: ${name} must be a positive finite number, got ${value}`);
  if (width > length) throw new RangeError('chainLinkGeometry: width must not exceed length');
  if (4 * wire >= width) throw new RangeError('chainLinkGeometry: make wire smaller than a quarter of width so the link has an opening');
  const radius = width / 2 - wire;
  const half = Math.max(0, length / 2 - wire - radius);
  return tubeGeometry(new Stadium(half, radius), options.segments ?? 48, wire, options.radialSegments ?? 10, true);
}
