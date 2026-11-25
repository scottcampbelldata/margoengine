import { Line, type LineOptions } from './line.js';
import type { Lines } from './lines.js';

/** Draw an illustrative flow along a polyline with dashes and an optional stationary guide. */
export interface FlowPathOptions extends Pick<LineOptions, 'color' | 'width' | 'worldUnits' | 'mesh' | 'matrix'> {
  /** Ordered x, y, z coordinates. Coincident points are allowed if the route has nonzero length. */
  positions: ArrayLike<number>;
  /** World units per second. Negative reverses the flow, zero holds it still. Default 0.5. */
  speed?: number;
  /** Initial advance along the line in world units. Default 0. */
  phase?: number;
  /** Length of a dash in world units. Default 0.14. */
  dashSize?: number;
  /** Gap between dashes in world units. Default 0.2. */
  gapSize?: number;
  /** Dash opacity, from 0 to 1. Default 1. */
  opacity?: number;
  /** Guide opacity, from 0 to 1. Zero omits the guide. Default 0.28. */
  guideOpacity?: number;
  /** Guide width as a fraction of dash width, above 0 and at most 1. Default 0.38. */
  guideWidth?: number;
  /** Fraction of local route length used to fade in at the first point. Default 0.12. */
  startFade?: number;
  /** Fraction of local route length used to fade out at the last point. Default 0.14. */
  endFade?: number;
}

const unitInterval = (x: number): boolean => x >= 0 && x <= 1;
const smooth = (x: number): number => Math.min(1, x) ** 2 * (3 - 2 * Math.min(1, x));

// Add points inside the end fades so even a two-point line has a visible middle.
function taperedPath(input: ArrayLike<number>, startFade: number, endFade: number) {
  const count = input.length / 3;
  if (!Number.isInteger(count) || count < 2 || count > 3_999_992)
    throw new RangeError('FlowPath needs 2 to 3,999,992 x, y, z points');
  const points = new Float32Array(input);
  const distances = new Float64Array(count);
  if (!points.every(Number.isFinite)) throw new RangeError('FlowPath coordinates must be finite float32 numbers');
  for (let i = 1; i < count; i++) {
    const k = i * 3;
    distances[i] =
      distances[i - 1] +
      Math.hypot(points[k] - points[k - 3], points[k + 1] - points[k - 2], points[k + 2] - points[k - 1]);
  }
  const length = distances[count - 1];
  if (length === 0) throw new RangeError('FlowPath must have nonzero length');
  const start = length * startFade;
  const end = length * endFade;
  const stations = [
    ...[0.25, 0.5, 0.75, 1].map((u) => start * u),
    ...[1, 0.75, 0.5, 0.25].map((u) => length - end * u),
  ].filter((s, i, a) => s > 0 && s < length && s !== a[i - 1]);
  const positions: number[] = [];
  const colors: number[] = [];
  const add = (x: number, y: number, z: number, distance: number) => {
    positions.push(x, y, z);
    const alphaIn = start === 0 ? 1 : smooth(distance / start);
    const alphaOut = end === 0 ? 1 : smooth((length - distance) / end);
    colors.push(1, 1, 1, alphaIn * alphaOut);
  };
  add(points[0], points[1], points[2], 0);
  let station = 0;
  for (let i = 1; i < count; i++) {
    const at = distances[i];
    const before = distances[i - 1];
    const k = i * 3;
    if (at === before) continue;
    while (station < stations.length && stations[station] < at) {
      const u = (stations[station] - before) / (at - before);
      add(
        points[k - 3] + (points[k] - points[k - 3]) * u,
        points[k - 2] + (points[k + 1] - points[k - 2]) * u,
        points[k - 1] + (points[k + 2] - points[k - 1]) * u,
        stations[station++],
      );
    }
    if (stations[station] === at) station++;
    add(points[k], points[k + 1], points[k + 2], at);
  }
  return { positions, colors };
}

/**
 * Animated dashes for airflow, fluid feeds or signal paths. The caller supplies the route and time.
 * Uses the owning Lines plugin's camera, depth test and optional mesh transform.
 */
export class FlowPath {
  private readonly guide: Line | undefined;
  private readonly pulse: Line;
  private readonly period: number;
  private readonly speed: number;
  private readonly phase: number;
  private readonly opacity: number;
  private readonly guideOpacity: number;

  constructor(lines: Lines, options: FlowPathOptions) {
    const {
      positions,
      color = '#57c6ff',
      width = 5,
      worldUnits,
      mesh,
      matrix,
      speed = 0.5,
      phase = 0,
      dashSize = 0.14,
      gapSize = 0.2,
      opacity = 1,
      guideOpacity = 0.28,
      guideWidth = 0.38,
      startFade = 0.12,
      endFade = 0.14,
    } = options;
    const period = dashSize + gapSize;
    if (!Number.isFinite(speed) || !Number.isFinite(phase) || !Number.isFinite(period) || dashSize <= 0 || gapSize < 0)
      throw new RangeError(
        'FlowPath needs finite speed, phase and dash spacing, with positive dashSize and non-negative gapSize',
      );
    if (
      ![opacity, guideOpacity, guideWidth, startFade, endFade].every(unitInterval) ||
      guideWidth === 0 ||
      startFade + endFade > 1
    )
      throw new RangeError(
        'FlowPath opacity, guide width and fades must be in range, with a positive guide width and fades totaling at most 1',
      );

    const style = { ...taperedPath(positions, startFade, endFade), color, worldUnits, mesh, matrix };
    this.guide = guideOpacity > 0 ? new Line({ ...style, width: width * guideWidth }) : undefined;
    this.pulse = new Line({ ...style, width, dashed: true, dashSize, gapSize, dashCap: 'round' });
    this.period = period;
    this.speed = speed;
    this.phase = phase % period;
    this.opacity = opacity;
    this.guideOpacity = guideOpacity;
    this.seek(0);
    try {
      if (this.guide) lines.add(this.guide);
      lines.add(this.pulse);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /** Seek to absolute seconds. The optional 0..1 gain fades both layers; at zero they issue no draws. */
  seek(seconds: number, gain = 1): this {
    const distance = seconds * this.speed;
    if (!Number.isFinite(distance) || !unitInterval(gain))
      throw new RangeError('FlowPath seek needs finite travel and gain from 0 to 1');
    const offset = -(((distance % this.period) + this.phase) % this.period);
    this.pulse.material.dashOffset = offset === 0 ? 0 : offset;
    this.pulse.material.opacity = this.opacity * gain;
    this.pulse.visible = this.pulse.material.opacity > 0;
    if (this.guide) {
      this.guide.material.opacity = this.guideOpacity * gain;
      this.guide.visible = this.guide.material.opacity > 0;
    }
    return this;
  }

  /** Remove both owned lines and release their GPU resources. */
  dispose(): void {
    this.pulse.dispose();
    this.guide?.dispose();
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
