// Snapshot interpolation of any field: each field names how it blends, so scale, colour and animation time ride in
// the same snapshots as the pose.
import { LinearToSRGB, SRGBToLinear } from '@margoengine/math/color';
import { blendAngle, normalizeQuaternion, slerpInto, TimeRing } from './timeline.js';

/**
 * How one field blends between snapshots.
 * - `linear`: a straight line, for scale, opacity, a blend weight. Holds past the newest snapshot.
 * - `hermite`: cubic through the two ends using the `velocity` field, which must be a `linear` field of the same
 *   size. Runs on at that velocity past the newest snapshot, up to `maxPrediction`.
 * - `angle`: radians, the short way round.
 * - `quaternion`: `[x, y, z, w]`, normalized when pushed, shortest-arc slerp.
 * - `color`: RGB or RGBA from 0 to 1, blended in linear light. `space` says what you pass and get back: `'srgb'`
 *   (default) or `'linear'`. Alpha is always straight.
 * - `time`: animation time in seconds. With `period` it loops, so 0.9 to 0.1 of a 1 s clip goes forward through the
 *   seam. With `clip`, the name of a `step` field, it never blends across a change of clip. Runs on at its last rate
 *   past the newest snapshot, up to `maxPrediction`.
 * - `step`: no blend, for clip numbers and flags. Changes when the next snapshot's time is reached.
 *
 * `size` is how many numbers the field has. Left out, `linear` and `step` hold one plain number, `hermite` and `color`
 * hold 3.
 */
export type FieldSpec =
  | { readonly type: 'linear' | 'step'; readonly size?: number }
  | { readonly type: 'hermite'; readonly velocity: string; readonly size?: number }
  | { readonly type: 'angle' }
  | { readonly type: 'quaternion' }
  | { readonly type: 'color'; readonly size?: 3 | 4; readonly space?: 'srgb' | 'linear' }
  | { readonly type: 'time'; readonly period?: number; readonly clip?: string };

/** The fields of a {@link FieldBuffer}, by name. */
export type FieldSpecs = Readonly<Record<string, FieldSpec>>;

/** What a sample holds: a plain number for one-number fields, a Float64Array for the rest. */
export type FieldValues<F extends FieldSpecs> = {
  [K in keyof F]: F[K] extends { readonly size: number }
    ? Float64Array
    : F[K] extends { readonly type: 'quaternion' | 'color' | 'hermite' }
      ? Float64Array
      : number;
};

/** What a snapshot passes: a number or an array per field. */
export type FieldInput<F extends FieldSpecs> = {
  readonly [K in keyof F]?: F[K] extends { readonly size: number }
    ? ArrayLike<number>
    : F[K] extends { readonly type: 'quaternion' | 'color' | 'hermite' }
      ? ArrayLike<number>
      : number;
};

interface Plan {
  name: string;
  type: FieldSpec['type'];
  offset: number;
  size: number;
  scalar: boolean;
  velocity: number;
  period: number;
  clip: number;
  srgb: boolean;
}

const fault = (name: string, problem: string): TypeError =>
  new TypeError(`FieldBuffer field '${name}' ${problem}; fix the field list`);

function plans(fields: FieldSpecs): { plans: Plan[]; floats: number } {
  const list: Plan[] = [];
  let offset = 1;
  for (const [name, spec] of Object.entries(fields)) {
    if (!['linear', 'step', 'hermite', 'angle', 'quaternion', 'color', 'time'].includes(spec?.type))
      throw fault(name, `has type ${spec?.type}`);
    const size = spec.type === 'quaternion' ? 4 : spec.type === 'angle' || spec.type === 'time' ? undefined : spec.size;
    const fallback = spec.type === 'hermite' || spec.type === 'color' ? 3 : 1;
    const count = size ?? fallback;
    if (!Number.isInteger(count) || count < 1 || count > 64) throw fault(name, `has size ${count}; pass 1 to 64`);
    if (spec.type === 'color' && count !== 3 && count !== 4) throw fault(name, 'needs size 3 or 4');
    const period = spec.type === 'time' ? (spec.period ?? 0) : 0;
    if (!(period >= 0) || !Number.isFinite(period)) throw fault(name, `has period ${period}`);
    list.push({
      name,
      type: spec.type,
      offset,
      size: count,
      scalar: size === undefined && fallback === 1,
      velocity: -1,
      period,
      clip: -1,
      srgb: spec.type === 'color' && (spec.space ?? 'srgb') === 'srgb',
    });
    offset += count;
  }
  list.forEach((plan, index) => {
    const spec = Object.values(fields)[index];
    if (spec.type === 'hermite') {
      const other = list.find((p) => p.name === spec.velocity);
      if (other?.type !== 'linear' || other.size !== plan.size)
        throw fault(plan.name, `needs velocity '${spec.velocity}' to be a linear field of size ${plan.size}`);
      plan.velocity = other.offset;
    }
    if (spec.type === 'time' && spec.clip !== undefined) {
      const other = list.find((p) => p.name === spec.clip);
      if (other?.type !== 'step' || other.size !== 1) throw fault(plan.name, `needs clip '${spec.clip}' to be a step field`);
      plan.clip = other.offset;
    }
  });
  return { plans: list, floats: offset };
}

/**
 * A ring of timestamped snapshots of whatever fields you name, each blended its own way.
 *
 * @example
 * ```ts
 * import { FieldBuffer } from '@margoengine/net/fields';
 *
 * const buffer = new FieldBuffer({
 *   scale: { type: 'linear', size: 3 },
 *   tint: { type: 'color' },
 *   clip: { type: 'step' },
 *   clipTime: { type: 'time', period: 1.2, clip: 'clip' },
 * });
 * buffer.push(10, { scale: [1, 1, 1], tint: [1, 0, 0], clip: 2, clipTime: 1.1 });
 * buffer.push(10.1, { scale: [2, 2, 2], tint: [0, 0, 1], clip: 2, clipTime: 0.01 });
 * const now = buffer.sample(10.05);
 * console.log(now?.scale, now?.tint, now?.clipTime);
 * ```
 */
export class FieldBuffer<const F extends FieldSpecs> {
  /** Snapshots kept. */
  readonly capacity: number;
  /** Seconds `hermite` and `time` fields run on past the newest snapshot. */
  readonly maxPrediction: number;
  private readonly plans: Plan[];
  private readonly stride: number;
  private readonly rows: Float64Array;
  private readonly ring: TimeRing;
  private readonly scratch: Float64Array;
  private readonly output: FieldValues<F>;

  /**
   * @param fields The fields by name.
   * @param options `capacity` snapshots kept, an integer 2 to 65536 (default 32); `maxPrediction` in seconds, 0 to 10
   * (default 0.25).
   * @throws TypeError for a field that does not fit {@link FieldSpec}.
   * @throws RangeError for an option out of range.
   */
  constructor(
    fields: F,
    { capacity = 32, maxPrediction = 0.25 }: { capacity?: number; maxPrediction?: number } = {},
  ) {
    if (!(maxPrediction >= 0 && maxPrediction <= 10))
      throw new RangeError(`FieldBuffer maxPrediction is ${maxPrediction}; pass 0 to 10 seconds`);
    const planned = plans(fields);
    this.plans = planned.plans;
    this.stride = planned.floats;
    this.capacity = capacity;
    this.maxPrediction = maxPrediction;
    if (!Number.isInteger(capacity) || capacity < 2 || capacity > 65536)
      throw new RangeError(`FieldBuffer capacity is ${capacity}; pass an integer from 2 to 65536`);
    this.rows = new Float64Array(capacity * this.stride);
    this.ring = new TimeRing(capacity, this.rows, this.stride);
    this.scratch = new Float64Array(this.stride);
    this.output = this.create();
  }

  /** A blank sample, for use as a reusable `sample` output. */
  create(): FieldValues<F> {
    const values: Record<string, number | Float64Array> = {};
    for (const plan of this.plans) values[plan.name] = plan.scalar ? 0 : new Float64Array(plan.size);
    return values as FieldValues<F>;
  }

  /**
   * Adds a snapshot at `time` seconds. A field left out keeps its value from the snapshot before, so a snapshot need
   * only hold what changed; the first must hold every field.
   * @returns False for a time not newer than the newest, which changes nothing.
   * @throws RangeError for a time or value that is not finite, or a zero quaternion.
   * @throws TypeError for a value of the wrong shape, or a field missing from the first snapshot.
   */
  push(time: number, values: FieldInput<F>): boolean {
    if (!Number.isFinite(time)) throw new RangeError(`FieldBuffer time is ${time}; pass a finite number of seconds`);
    const row = this.scratch,
      last = this.ring.last,
      input = values as Record<string, number | ArrayLike<number> | undefined>;
    for (const plan of this.plans) {
      const value = input[plan.name];
      if (value === undefined) {
        if (last < 0) throw new TypeError(`FieldBuffer's first snapshot has no '${plan.name}'; pass every field`);
        for (let i = 0; i < plan.size; i++) row[plan.offset + i] = this.rows[last * this.stride + plan.offset + i];
        continue;
      }
      if (plan.scalar ? typeof value !== 'number' : typeof value === 'number' || value.length !== plan.size)
        throw new TypeError(`FieldBuffer field '${plan.name}' needs ${plan.scalar ? 'a number' : `${plan.size} numbers`}`);
      for (let i = 0; i < plan.size; i++) {
        const number = plan.scalar ? (value as number) : (value as ArrayLike<number>)[i];
        if (!Number.isFinite(number)) throw new RangeError(`FieldBuffer field '${plan.name}' must be finite`);
        row[plan.offset + i] = plan.srgb && i < 3 ? SRGBToLinear(number) : number;
      }
      if (plan.type === 'quaternion') normalizeQuaternion(value as ArrayLike<number>, row, plan.offset);
    }
    const slot = this.ring.push(time);
    if (slot < 0) return false;
    this.rows.set(row.subarray(1), slot * this.stride + 1);
    return true;
  }

  /**
   * The fields at `time` seconds, or null while empty. Before the oldest snapshot it gives the oldest. The default
   * output is reused by every call.
   * @throws RangeError for a time that is not finite.
   */
  sample(time: number, output: FieldValues<F> = this.output): FieldValues<F> | null {
    if (!Number.isFinite(time)) throw new RangeError(`FieldBuffer time is ${time}; pass a finite number of seconds`);
    const ring = this.ring;
    if (!ring.locate(time)) return null;
    const rows = this.rows,
      row = this.scratch,
      a = ring.a * this.stride,
      b = ring.b * this.stride,
      u = ring.u,
      span = rows[b] - rows[a],
      ahead = Math.min(ring.past, this.maxPrediction);
    for (const plan of this.plans) {
      const at = plan.offset;
      switch (plan.type) {
        case 'step':
          for (let i = 0; i < plan.size; i++) row[at + i] = rows[a + at + i];
          break;
        case 'angle':
          row[at] = blendAngle(rows[a + at], rows[b + at], u);
          break;
        case 'quaternion':
          if (a === b) for (let i = 0; i < 4; i++) row[at + i] = rows[a + at + i];
          else slerpInto(row, at, rows, a + at, b + at, u);
          break;
        case 'hermite':
          this.hermite(plan, a, b, u, span, ahead);
          break;
        case 'time':
          row[at] = this.time(plan, a, b, u, ahead);
          break;
        default:
          for (let i = 0; i < plan.size; i++) row[at + i] = rows[a + at + i] + (rows[b + at + i] - rows[a + at + i]) * u;
      }
    }
    const result = output as Record<string, number | Float64Array>;
    for (const plan of this.plans) {
      if (plan.scalar) {
        result[plan.name] = row[plan.offset];
        continue;
      }
      const target = result[plan.name] as Float64Array;
      if (target?.length !== plan.size) throw new TypeError(`FieldBuffer output has no '${plan.name}'; use create()`);
      for (let i = 0; i < plan.size; i++)
        target[i] = plan.srgb && i < 3 ? LinearToSRGB(row[plan.offset + i]) : row[plan.offset + i];
    }
    return output;
  }

  private hermite(plan: Plan, a: number, b: number, u: number, span: number, ahead: number): void {
    const rows = this.rows,
      row = this.scratch,
      p = plan.offset,
      v = plan.velocity;
    if (a === b) {
      for (let i = 0; i < plan.size; i++) row[p + i] = rows[a + p + i] + rows[a + v + i] * ahead;
      return;
    }
    const u2 = u * u,
      u3 = u2 * u;
    for (let i = 0; i < plan.size; i++)
      row[p + i] =
        (2 * u3 - 3 * u2 + 1) * rows[a + p + i] +
        (u3 - 2 * u2 + u) * span * rows[a + v + i] +
        (-2 * u3 + 3 * u2) * rows[b + p + i] +
        (u3 - u2) * span * rows[b + v + i];
  }

  private time(plan: Plan, a: number, b: number, u: number, ahead: number): number {
    const rows = this.rows,
      at = plan.offset,
      period = plan.period,
      wrap = (value: number): number => (period ? value - Math.floor(value / period) * period : value),
      step = (from: number, to: number): number => {
        const delta = to - from;
        return period ? wrap(delta + period / 2) - period / 2 : delta;
      };
    if (a !== b) {
      if (plan.clip >= 0 && rows[a + plan.clip] !== rows[b + plan.clip]) return rows[a + at];
      return wrap(rows[a + at] + step(rows[a + at], rows[b + at]) * u);
    }
    if (!ahead || this.ring.previous < 0) return rows[a + at];
    const before = this.ring.previous * this.stride;
    if (plan.clip >= 0 && rows[before + plan.clip] !== rows[a + plan.clip]) return rows[a + at];
    return wrap(rows[a + at] + (step(rows[before + at], rows[a + at]) / (rows[a] - rows[before])) * ahead);
  }

  /** Drops every snapshot. */
  clear(): void {
    this.ring.clear();
  }
}
