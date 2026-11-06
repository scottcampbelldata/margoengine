// Trails: a line that follows something and fades behind it. It samples the target's world position each frame and
// rebuilds its points from the samples, cutting the far end exactly at the age or length limit so it shrinks smoothly.
import type { EngineKernel, Mesh } from '@margoengine/core';
import { meshWorldMatrix } from '@margoengine/math/mesh';
import { parseColor, type ColorInput } from './color.js';
import { Line, type LineOptions } from './line.js';
import { finiteArray, transformPoint } from './math.js';

/** Options for `new Trail(...)`: the trail's own plus any `LineMaterial` option. Out-of-range values throw a RangeError. */
export interface TrailOptions extends Omit<LineOptions, 'positions' | 'colors' | 'mode' | 'mesh' | 'matrix'> {
  /** What to follow: a mesh, or a function returning a world position (null to pause). Default none: call `moveTo`. */
  target?: Mesh | (() => ArrayLike<number> | null) | null;
  /** With a mesh target, the followed point in the mesh's local space, such as a sword tip. Default [0, 0, 0]. */
  offset?: ArrayLike<number>;
  /** Seconds a point lives. `Infinity` keeps points until `maxLength` or `maxPoints` drops them. Default 1. */
  lifetime?: number;
  /** World units from the head to the end of the trail. Default Infinity. */
  maxLength?: number;
  /** Points kept, 2 to 65,536. Past this the oldest goes, so raise it for long or slow-fading trails. Default 256. */
  maxPoints?: number;
  /** World units the head moves before it leaves a point behind. Default 0.05. */
  minDistance?: number;
  /** How opacity falls to 0 along the trail: 1 is linear, higher fades sooner, 0 does not fade. Default 1. */
  fade?: number;
  /** Colour at the head (the material's colour is the multiplier, white by default). Default white. */
  color?: ColorInput;
  /** Colour at the far end. Default the head's colour. */
  tailColor?: ColorInput;
  /** Width at the far end as a fraction of the head's, 0..1. Ignored on a dashed trail. Default 1. */
  tailWidth?: number;
}

const white = [1, 1, 1];
const rgb = (color: ColorInput | undefined, fallback: ArrayLike<number>): number[] =>
  Array.from((color === undefined ? fallback : parseColor(color)) as ArrayLike<number>);

/**
 * A line that follows a mesh, a function or `moveTo` calls and fades over time, distance or both: missiles, swords,
 * cursors. Add it to a `Lines` plugin; it advances with the plugin's frames. Its points are in world space and, like
 * every line, it faces the camera.
 * @throws RangeError for an out-of-range option.
 */
export class Trail extends Line {
  target: Mesh | (() => ArrayLike<number> | null) | null;
  lifetime: number;
  maxLength: number;
  minDistance: number;
  fade: number;
  tailWidth: number;
  private readonly offset: [number, number, number];
  private readonly head: number[];
  private readonly tail: number[];
  private readonly capacity: number;
  /** Sample ring, oldest first from `start`: x, y, z and the clock time it was made. The newest is the live head. */
  private readonly samples: Float64Array;
  private start = 0;
  private used = 0;
  private clock = 0;
  private readonly at = [0, 0, 0];
  private stale = false;

  constructor(options: TrailOptions = {}) {
    const {
      target = null,
      offset = [0, 0, 0],
      lifetime = 1,
      maxLength = Infinity,
      maxPoints = 256,
      minDistance = 0.05,
      fade = 1,
      color,
      tailColor,
      tailWidth = 1,
      ...style
    } = options;
    if (!(lifetime > 0) || !(maxLength > 0) || !(minDistance >= 0) || !(fade >= 0) || !Number.isFinite(fade))
      throw new RangeError('Invalid trail lifetime, maxLength, minDistance or fade; pass positive values');
    if (!Number.isInteger(maxPoints) || maxPoints < 2 || maxPoints > 65536)
      throw new RangeError('Invalid trail maxPoints; pass an integer from 2 to 65536');
    if (!(tailWidth >= 0 && tailWidth <= 1)) throw new RangeError('Invalid trail tailWidth; pass a value from 0 to 1');
    if (offset.length !== 3) throw new RangeError('Trail offset needs 3 values; pass [x, y, z]');
    finiteArray(offset, 'Trail offset');
    super({ ...style, positions: new Float32Array(maxPoints * 3), colors: new Float32Array(maxPoints * 4) });
    this.capacity = maxPoints;
    this.samples = new Float64Array(maxPoints * 4);
    this.target = target;
    this.offset = [offset[0], offset[1], offset[2]];
    this.lifetime = lifetime;
    this.maxLength = maxLength;
    this.minDistance = minDistance;
    this.fade = fade;
    this.tailWidth = tailWidth;
    this.head = rgb(color, white);
    this.tail = rgb(tailColor, this.head);
    this.pointWidths = true;
    this.resize(0);
  }

  /** Points in the trail's history, the live head included. */
  get length(): number {
    return this.used;
  }

  /** Sets the head and tail colours (the tail takes the head's when left out). */
  setColor(color: ColorInput, tailColor: ColorInput = color): this {
    this.head.splice(0, 3, ...rgb(color, white));
    this.tail.splice(0, 3, ...rgb(tailColor, white));
    this.stale = true;
    return this;
  }

  /** Moves the head to a world position, as a target does each frame. Throws RangeError for non-finite values. */
  moveTo(x: number, y: number, z: number): this {
    finiteArray([x, y, z], 'Trail position');
    const s = this.samples,
      capacity = this.capacity;
    const live = ((this.start + this.used - 1) % capacity) * 4;
    // A head at rest keeps its time, so a target that stops fades out with the rest of its trail.
    if (this.used && x === s[live] && y === s[live + 1] && z === s[live + 2]) return this;
    // Nothing left of the trail: this position starts a new one.
    if (!this.used || (this.used === 1 && this.clock - s[live + 3] >= this.lifetime)) {
      this.start = 0;
      this.place(0, x, y, z);
      this.stale = true;
      return this;
    }
    // The head leaves a point once it has moved far enough from the last one left behind.
    const from = this.used > 1 ? ((this.start + this.used - 2) % capacity) * 4 : live,
      moved = Math.hypot(x - s[from], y - s[from + 1], z - s[from + 2]);
    if (this.used === 1 || moved >= this.minDistance) {
      if (this.used === capacity) {
        this.start = (this.start + 1) % capacity;
        this.used--;
      }
      this.place(this.used, x, y, z);
    } else {
      s[live] = x;
      s[live + 1] = y;
      s[live + 2] = z;
      s[live + 3] = this.clock;
    }
    this.stale = true;
    return this;
  }

  private place(index: number, x: number, y: number, z: number): void {
    const o = ((this.start + index) % this.capacity) * 4,
      s = this.samples;
    s[o] = x;
    s[o + 1] = y;
    s[o + 2] = z;
    s[o + 3] = this.clock;
    this.used = index + 1;
  }

  /** Forgets the history, for a teleport or a respawn: the next position starts a new trail. */
  reset(): this {
    this.start = this.used = 0;
    this.stale = true;
    return this;
  }

  /** The target's world position in `at`, or false when it has none this frame. */
  private follow(engine: EngineKernel): boolean {
    const { target, at } = this;
    if (typeof target === 'function') {
      const p = target();
      if (!p) return false;
      at[0] = p[0];
      at[1] = p[1];
      at[2] = p[2];
      return true;
    }
    if (!target) return false;
    const m = meshWorldMatrix(engine, target);
    if (!m) return false;
    transformPoint(at, 0, m, this.offset[0], this.offset[1], this.offset[2]);
    return true;
  }

  /** Advances the clock by `delta` seconds, reads the target and rebuilds the points when anything changed. */
  override update(engine: EngineKernel, delta = 0): void {
    this.clock += delta;
    if (this.follow(engine)) this.moveTo(this.at[0], this.at[1], this.at[2]);
    if (delta > 0 && this.used) this.stale = true;
    if (this.stale) this.rebuild();
  }

  /** Writes the points head first, cutting the far end where the age or length limit falls inside a segment. */
  private rebuild(): void {
    this.stale = false;
    const { samples: s, capacity, clock, lifetime, maxLength, head, tail, fade, tailWidth, points } = this,
      colors = this.colors!,
      newest = ((this.start + this.used - 1) % capacity) * 4;
    // All of it has aged out: draw nothing, and keep the head for the move that starts a new trail.
    if (!this.used || clock - s[newest + 3] >= lifetime) {
      if (this.used) {
        this.start = newest / 4;
        this.used = 1;
      }
      if (this.count) this.resize(0);
      return;
    }
    let out = 0,
      length = 0,
      px = 0,
      py = 0,
      pz = 0,
      age = 0;
    const put = (x: number, y: number, z: number, along: number, old: number) => {
      const part = Math.min(1, Math.max(old / lifetime, along / maxLength)),
        o = out * 4;
      points[o] = x;
      points[o + 1] = y;
      points[o + 2] = z;
      points[o + 3] = 1 + (tailWidth - 1) * part;
      colors[o] = head[0] + (tail[0] - head[0]) * part;
      colors[o + 1] = head[1] + (tail[1] - head[1]) * part;
      colors[o + 2] = head[2] + (tail[2] - head[2]) * part;
      colors[o + 3] = fade ? (1 - part) ** fade : 1;
      out++;
    };
    for (let i = this.used - 1; i >= 0; i--) {
      const o = ((this.start + i) % capacity) * 4,
        x = s[o],
        y = s[o + 1],
        z = s[o + 2],
        old = clock - s[o + 3];
      if (i === this.used - 1) {
        put(x, y, z, 0, old);
      } else {
        const step = Math.hypot(x - px, y - py, z - pz),
          // The share of this step inside both limits; below 1, the trail ends there.
          byAge = old > lifetime ? (lifetime - age) / (old - age) : 1,
          byLength = length + step > maxLength ? (maxLength - length) / step : 1,
          keep = Math.min(byAge, byLength);
        if (keep < 1) {
          put(px + (x - px) * keep, py + (y - py) * keep, pz + (z - pz) * keep, length + step * keep, age + (old - age) * keep);
          // Samples past the limit never come back: age only grows, and only the head moves.
          if (byAge < 1) {
            this.start = (this.start + i) % capacity;
            this.used -= i;
          }
          break;
        }
        put(x, y, z, length + step, old);
        length += step;
      }
      px = x;
      py = y;
      pz = z;
      age = old;
    }
    if (out > 1 || this.count) this.resize(out > 1 ? out : 0);
  }
}
