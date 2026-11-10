import type { EngineKernel } from '@margoengine/core';
import type { FrameGraph } from '@margoengine/core/extension';
import { Line, type LineOptions } from './line.js';
import { LineBatch, LineBatches, type LineBatchesOptions } from './batch.js';
import { parseColor, type ColorInput } from './color.js';
import { finiteArray } from './math.js';

/** Shape of an arc between world-space XYZ points. */
export interface ArcOptions {
  /** Tessellated segments, 2..8192. Default 64. */
  segments?: number;
  /** Midpoint rise in world units. Default a quarter of chord length, or 0 for a great circle. */
  height?: number;
  /** Preferred rise direction, projected perpendicular to the chord. Default +Y. */
  up?: ArrayLike<number>;
  /** Rotation around the chord in radians. Default 0. */
  tilt?: number;
  /** Interpolate directions on a sphere around center, with linearly varying endpoint radius. Default false. */
  greatCircle?: boolean;
  /** Sphere center for greatCircle. Default [0,0,0]. */
  center?: ArrayLike<number>;
}
const point = (p: ArrayLike<number>, label: string): number[] => {
  if (p.length !== 3) throw new RangeError(`${label} needs three XYZ coordinates`);
  finiteArray(p, label);
  return Array.from(p);
};
const perpendicular = (axis: number[], preferred: number[]): number[] => {
  const dot = axis.reduce((s, v, i) => s + v * preferred[i], 0);
  let result = preferred.map((v, i) => v - axis[i] * dot),
    size = Math.hypot(...result);
  if (size < 1e-12) {
    const smallest = axis.map(Math.abs).indexOf(Math.min(...axis.map(Math.abs)));
    const unit = [0, 0, 0];
    unit[smallest] = 1;
    const d = axis[smallest];
    result = unit.map((v, i) => v - axis[i] * d);
    size = Math.hypot(...result);
  }
  return result.map((v) => v / size);
};

/** Sample a parabolic or spherical arc, including exact endpoints. Antipodes choose a deterministic plane. */
export function arcPositions(start: ArrayLike<number>, end: ArrayLike<number>, options: ArcOptions = {}): Float32Array {
  const a = point(start, 'Arc start'),
    b = point(end, 'Arc end'),
    center = point(options.center ?? [0, 0, 0], 'Arc center'),
    up = point(options.up ?? [0, 1, 0], 'Arc up');
  const segments = options.segments ?? 64,
    tilt = options.tilt ?? 0,
    greatCircle = options.greatCircle ?? false;
  if (!Number.isInteger(segments) || segments < 2 || segments > 8192)
    throw new RangeError('Arc segments must be an integer in 2..8192');
  if (typeof greatCircle !== 'boolean') throw new TypeError('Arc greatCircle must be boolean');
  const chord = b.map((v, i) => v - a[i]),
    length = Math.hypot(...chord),
    height = options.height ?? (greatCircle ? 0 : length / 4);
  if (!Number.isFinite(height) || !Number.isFinite(tilt) || Math.hypot(...up) === 0)
    throw new RangeError('Arc height and tilt must be finite; provide a nonzero up direction');
  const axis = length > 0 ? chord.map((v) => v / length) : [1, 0, 0],
    rise = perpendicular(axis, up);
  const across = [
    axis[1] * rise[2] - axis[2] * rise[1],
    axis[2] * rise[0] - axis[0] * rise[2],
    axis[0] * rise[1] - axis[1] * rise[0],
  ];
  const normal = rise.map((v, i) => v * Math.cos(tilt) + across[i] * Math.sin(tilt));
  const aa = a.map((v, i) => v - center[i]),
    bb = b.map((v, i) => v - center[i]),
    ra = Math.hypot(...aa),
    rb = Math.hypot(...bb);
  if (greatCircle && (ra === 0 || rb === 0))
    throw new RangeError('Great-circle endpoints must differ from the sphere center');
  let u = [1, 0, 0],
    v = [0, 1, 0],
    angle = 0;
  if (greatCircle) {
    u = aa.map((x) => x / ra);
    const target = bb.map((x) => x / rb),
      dot = Math.max(
        -1,
        Math.min(
          1,
          u.reduce((s, x, i) => s + x * target[i], 0),
        ),
      );
    const tangent = target.map((x, i) => x - u[i] * dot),
      size = Math.hypot(...tangent);
    angle = Math.atan2(size, dot);
    v = size > 1e-12 ? tangent.map((x) => x / size) : perpendicular(u, up);
  }
  const out = new Float32Array((segments + 1) * 3);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments,
      r = ra + (rb - ra) * t + 4 * height * t * (1 - t);
    for (let j = 0; j < 3; j++)
      out[i * 3 + j] = greatCircle
        ? center[j] + r * (u[j] * Math.cos(angle * t) + v[j] * Math.sin(angle * t))
        : a[j] + chord[j] * t + normal[j] * 4 * height * t * (1 - t);
  }
  out.set(a, 0);
  out.set(b, segments * 3);
  finiteArray(out, 'Arc output');
  return out;
}

/** Persistent arc with all ordinary Line material, attachment and picking options. */
export class ArcLine extends Line {
  constructor(
    start: ArrayLike<number>,
    end: ArrayLike<number>,
    options: ArcOptions & Omit<LineOptions, 'positions' | 'mode'> = {},
  ) {
    const { segments, height, up, tilt, greatCircle, center, ...line } = options;
    super({
      ...line,
      positions: arcPositions(start, end, { segments, height, up, tilt, greatCircle, center }),
      mode: 'strip',
    });
  }
  /** Replace the curve while keeping its material and attachment. */
  setArc(start: ArrayLike<number>, end: ArrayLike<number>, options?: ArcOptions): this {
    return this.setPositions(arcPositions(start, end, options));
  }
}

/** Immediate line style. Lines with the same style share one draw. */
export interface DebugLineOptions {
  /** Linear colour or CSS colour. Default white. */
  color?: ColorInput;
  /** Endpoint colour for a gradient. Default color. */
  endColor?: ColorInput;
  /** CSS pixel width. Default 1. */
  width?: number;
  /** Test scene depth. Default true. */
  depthTest?: boolean;
}
/** Immediate drawing limits and plugin placement. */
export interface DebugLinesOptions extends LineBatchesOptions {
  /** Maximum queued segments per rendered frame. Default 1,000,000. */
  maxSegments?: number;
}
interface Pending {
  positions: number[];
  colors: number[];
  width: number;
  onTop: boolean;
}
/** One rendered-frame debug queue. Additional views share it; picks never consume it. */
export class DebugLines extends LineBatches {
  /** Maximum queued segments per frame. */
  readonly maxSegments: number;
  private readonly pending = new Map<string, Pending>();
  private readonly active = new Map<string, LineBatch>();
  private queued = 0;
  private pendingFrame = true;
  static override attach(engine: EngineKernel, options?: DebugLinesOptions): DebugLines {
    const value = new DebugLines(options);
    engine.use(value);
    return value;
  }
  constructor(options: DebugLinesOptions = {}) {
    const { maxSegments = 1_000_000, ...plugin } = options;
    super({ name: 'debug-lines', ...plugin });
    if (!Number.isInteger(maxSegments) || maxSegments < 1 || maxSegments > 2 ** 26)
      throw new RangeError('Debug maxSegments must be an integer in 1..67108864');
    this.maxSegments = maxSegments;
  }
  /** Queue one segment for the next rendered frame. */
  drawLine(start: ArrayLike<number>, end: ArrayLike<number>, options: DebugLineOptions = {}): this {
    return this.enqueue([...point(start, 'Debug start'), ...point(end, 'Debug end')], options);
  }
  /** Queue independent XYZ endpoint pairs. */
  drawLines(positions: ArrayLike<number>, options: DebugLineOptions = {}): this {
    if (positions.length % 6) throw new RangeError('Debug positions need pairs of XYZ endpoints');
    finiteArray(positions, 'Debug positions');
    return this.enqueue(Array.from(positions), options);
  }
  /** Queue a sampled arc for the next rendered frame. */
  drawArc(start: ArrayLike<number>, end: ArrayLike<number>, options: ArcOptions & DebugLineOptions = {}): this {
    const p = arcPositions(start, end, options),
      pairs: number[] = [];
    for (let i = 0; i < p.length - 3; i += 3) pairs.push(...p.subarray(i, i + 6));
    return this.enqueue(pairs, options, true);
  }
  private enqueue(positions: number[], options: DebugLineOptions, gradient = false): this {
    const n = positions.length / 6,
      width = options.width ?? 1,
      depth = options.depthTest ?? true;
    if (!Number.isFinite(width) || width <= 0) throw new RangeError('Debug width must be positive and finite');
    if (typeof depth !== 'boolean') throw new TypeError('Debug depthTest must be boolean');
    if (this.queued + n > this.maxSegments)
      throw new RangeError('Debug queue exceeds maxSegments; increase the limit or draw fewer segments');
    const a = new Float32Array(3),
      b = new Float32Array(3);
    parseColor(options.color ?? '#ffffff', a);
    parseColor(options.endColor ?? options.color ?? '#ffffff', b);
    const colors: number[] = [];
    for (let i = 0; i < n; i++)
      for (let end = 0; end < 2; end++) {
        const t = gradient ? (i + end) / n : end;
        for (let j = 0; j < 3; j++) colors.push(a[j] + (b[j] - a[j]) * t);
      }
    const key = width + '|' + depth;
    let group = this.pending.get(key);
    if (!group) {
      group = { positions: [], colors: [], width, onTop: !depth };
      this.pending.set(key, group);
    }
    for (const value of positions) group.positions.push(value);
    for (const value of colors) group.colors.push(value);
    this.queued += n;
    return this;
  }
  /** Mark a frame without consuming queued work during a pick. */
  onPreUpdate(): void {
    this.pendingFrame = true;
  }
  override registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':frame',
      order: this.order - 0.001,
      execute: () => {
        if (this.pendingFrame) {
          this.flush();
          this.pendingFrame = false;
        }
      },
    });
    super.registerPasses(graph);
  }
  private flush(): void {
    for (const [key, batch] of this.active)
      if (!this.pending.has(key)) {
        this.remove(batch);
        this.active.delete(key);
      }
    for (const [key, p] of this.pending) {
      let batch = this.active.get(key);
      if (!batch) {
        batch = this.add(new LineBatch({ width: p.width, onTop: p.onTop }));
        this.active.set(key, batch);
      }
      batch.setSegments(p.positions, p.colors);
    }
    this.pending.clear();
    this.queued = 0;
  }
  /** Discard queued and visible debug lines immediately. */
  override clear(): void {
    this.pending.clear();
    this.queued = 0;
    this.active.clear();
    super.clear();
  }
  override dispose(): void {
    this.clear();
    super.dispose();
  }
}
