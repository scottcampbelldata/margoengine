// Correction smoothing: when a snapshot corrects the prediction, the simulation jumps to the truth at once, and only
// what is drawn eases over. Each number keeps an error offset that shrinks over time, drawn as value + offset, and a
// correction folds into the offset so the drawn value does not move at that moment (Fiedler, "State Synchronization",
// 2015, "Visual Smoothing"). The simulation never sees any of this, so prediction stays exact.
import type { GameClient } from './client.js';
import type { NormalizedField, UntypedSchema } from './schema.js';

/** Options of {@link CorrectionSmoother}. */
export interface SmoothingOptions {
  /** Milliseconds for an error to halve (default 50: gone from sight in about 6 frames at 60 Hz). */
  halfLife?: number;
  /**
   * A second, faster half life for big errors, so one long stall does not drag on: `from` is the error size where it
   * starts to blend in and `to` where it has taken over, in world units. Default none.
   */
  fast?: { readonly from: number; readonly to: number; readonly halfLife: number };
  /** An error over this distance is not blended: a teleport or respawn jumps at once (default never). */
  snap?: number;
  /** An offset smaller than this is cleared (default 0.0001). */
  settle?: number;
  /** The clock in milliseconds (default `performance.now`). */
  now?: () => number;
}

/** An offset of the same shape as the value it belongs to; undefined where nothing is off. */
type Offset = number | { [key: string]: Offset } | Map<number, Offset> | Offset[] | undefined;

const TURN = 2 * Math.PI;
const wrap = (a: number): number => a - TURN * Math.round(a / TURN);

const blends = (field: NormalizedField): field is NormalizedField & { interpolate: 'linear' | 'angle' } =>
  'interpolate' in field && field.interpolate !== 'none';

/**
 * Draws a {@link GameClient}'s prediction with its corrections blended away instead of snapping. Every field the
 * schema interpolates eases (`'linear'` in a line, `'angle'` the short way); the others, and everything in
 * `client.predicted`, keep their exact values.
 *
 * @example
 * ```ts
 * const smooth = new CorrectionSmoother(client);
 * engine.onFrame(() => {
 *   client.update();
 *   drawMe(smooth.state().boxes.get(client.player));
 * });
 * ```
 */
export class CorrectionSmoother<State, Input = unknown> {
  private offset: Offset;
  private readonly schema: UntypedSchema;
  private readonly stateType: string;
  private readonly halfLife: number;
  private readonly fast: SmoothingOptions['fast'];
  private readonly snap: number;
  private readonly settle: number;
  private readonly now: () => number;
  private readonly chained: GameClient<State, Input>['oncorrection'];
  private last = Number.NaN;
  private largest = 0;
  private closed = false;

  /** @throws RangeError for an option out of range; TypeError when `client` is not a GameClient. */
  constructor(
    private readonly client: GameClient<State, Input>,
    options: SmoothingOptions = {},
  ) {
    if (!client?.game) throw new TypeError('CorrectionSmoother needs a GameClient; pass what GameClient.join gave you');
    this.schema = client.game.schema;
    this.stateType = client.game.stateType;
    this.halfLife = options.halfLife ?? 50;
    this.fast = options.fast;
    this.snap = options.snap ?? Infinity;
    this.settle = options.settle ?? 1e-4;
    this.now = options.now ?? (() => performance.now());
    if (!(this.halfLife > 0)) throw new RangeError(`CorrectionSmoother halfLife is ${this.halfLife}; pass ms above 0`);
    if (!(this.snap > 0)) throw new RangeError(`CorrectionSmoother snap is ${this.snap}; pass a distance above 0`);
    if (!(this.settle > 0)) throw new RangeError(`CorrectionSmoother settle is ${this.settle}; pass a size above 0`);
    const fast = this.fast;
    if (fast && !(fast.halfLife > 0 && fast.from >= 0 && fast.to > fast.from))
      throw new RangeError('CorrectionSmoother fast needs halfLife above 0 and to above from; fix it');
    this.chained = client.oncorrection;
    client.oncorrection = (before, after) => {
      this.correct(before, after);
      this.chained?.(before, after);
    };
  }

  /** The largest distance left to blend away after the newest {@link CorrectionSmoother.state}, 0 when settled. */
  get error(): number {
    return this.largest;
  }

  private struct(name: string): { [field: string]: NormalizedField } {
    return this.schema.json.types[name];
  }

  /** The offset that keeps `before + old` on screen now the value is `after`. */
  private fold(field: NormalizedField, before: unknown, after: unknown, old: Offset): Offset {
    if (before === undefined || after === undefined) return undefined;
    if (blends(field)) {
      const gap = (before as number) - (after as number),
        sum = ((old as number | undefined) ?? 0) + (field.interpolate === 'angle' ? wrap(gap) : gap);
      return sum === 0 ? undefined : sum;
    }
    switch (field.type) {
      case 'struct': {
        const out: { [key: string]: Offset } = {},
          a = before as Record<string, unknown>,
          b = after as Record<string, unknown>,
          was = old as { [key: string]: Offset } | undefined;
        let any = false;
        for (const [key, inner] of Object.entries(this.struct(field.name))) {
          const value = this.fold(inner, a[key], b[key], was?.[key]);
          if (value === undefined) continue;
          out[key] = value;
          any = true;
        }
        return any ? out : undefined;
      }
      case 'map': {
        const out = new Map<number, Offset>(),
          a = before as Map<number, unknown>,
          was = old as Map<number, Offset> | undefined;
        for (const [id, value] of after as Map<number, unknown>) {
          const offset = this.fold(field.of, a.get(id), value, was?.get(id));
          if (offset !== undefined) out.set(id, offset);
        }
        return out.size ? out : undefined;
      }
      case 'array': {
        const a = before as unknown[],
          b = after as unknown[];
        if (a.length !== b.length) return undefined;
        const out = b.map((value, i) => this.fold(field.of, a[i], value, (old as Offset[] | undefined)?.[i]));
        return out.some((v) => v !== undefined) ? out : undefined;
      }
      case 'optional':
        return this.fold(field.of, before, after, old);
      default:
        return undefined;
    }
  }

  /** How far a struct's own `'linear'` numbers are off, as one distance. */
  private distance(fields: { [field: string]: NormalizedField }, offset: { [key: string]: Offset }): number {
    let sum = 0;
    for (const [key, value] of Object.entries(offset)) {
      const field = fields[key];
      if (typeof value === 'number' && 'interpolate' in field && field.interpolate === 'linear') sum += value * value;
    }
    return Math.sqrt(sum);
  }

  /** What share of an error of size `size` is left after `ms`. */
  private keep(size: number, ms: number): number {
    const fast = this.fast;
    let half = this.halfLife;
    if (fast) {
      const t = Math.min(1, Math.max(0, (size - fast.from) / (fast.to - fast.from)));
      half += (fast.halfLife - half) * t;
    }
    return 2 ** (-ms / half);
  }

  /** `offset` after `ms`, undefined once nothing is left. Numbers of one struct shrink as one vector. */
  private shrink(field: NormalizedField, offset: Offset, ms: number, share: number): Offset {
    if (typeof offset === 'number') {
      const left = offset * (ms === 0 ? 1 : share);
      if (Math.abs(left) < this.settle) return undefined;
      this.largest = Math.max(this.largest, Math.abs(left));
      return left;
    }
    switch (field.type) {
      case 'struct': {
        const fields = this.struct(field.name),
          was = offset as { [key: string]: Offset },
          size = this.distance(fields, was),
          out: { [key: string]: Offset } = {};
        if (size > this.snap) {
          // A jump: the distance goes at once, and anything else in the struct eases on.
          for (const [key, value] of Object.entries(was)) {
            const inner = fields[key];
            if (typeof value === 'number' && 'interpolate' in inner && inner.interpolate === 'linear') delete was[key];
          }
        }
        const keep = this.keep(size, ms);
        let any = false;
        for (const [key, value] of Object.entries(was)) {
          const left = this.shrink(fields[key], value, ms, typeof value === 'number' ? keep : share);
          if (left === undefined) continue;
          out[key] = left;
          any = true;
        }
        return any ? out : undefined;
      }
      case 'map': {
        const out = new Map<number, Offset>();
        for (const [id, value] of offset as Map<number, Offset>) {
          const left = this.shrink(field.of, value, ms, share);
          if (left !== undefined) out.set(id, left);
        }
        return out.size ? out : undefined;
      }
      case 'array': {
        const out = (offset as Offset[]).map((v) => (v === undefined ? v : this.shrink(field.of, v, ms, share)));
        return out.some((v) => v !== undefined) ? out : undefined;
      }
      case 'optional':
        return this.shrink(field.of, offset, ms, share);
      default:
        return undefined;
    }
  }

  private add(field: NormalizedField, value: unknown, offset: Offset): unknown {
    if (offset === undefined || value === undefined) return value;
    if (typeof offset === 'number') return (value as number) + offset;
    switch (field.type) {
      case 'struct': {
        const fields = this.struct(field.name),
          out = { ...(value as Record<string, unknown>) };
        for (const [key, inner] of Object.entries(offset as { [key: string]: Offset }))
          out[key] = this.add(fields[key], out[key], inner);
        return out;
      }
      case 'map': {
        const out = new Map(value as Map<number, unknown>);
        for (const [id, inner] of offset as Map<number, Offset>)
          if (out.has(id)) out.set(id, this.add(field.of, out.get(id), inner));
        return out;
      }
      case 'array': {
        const list = value as unknown[],
          offsets = offset as Offset[];
        return list.length === offsets.length ? list.map((v, i) => this.add(field.of, v, offsets[i])) : list;
      }
      case 'optional':
        return this.add(field.of, value, offset);
      default:
        return value;
    }
  }

  private correct(before: State, after: State): void {
    if (this.closed) return;
    const type: NormalizedField = { type: 'struct', name: this.stateType };
    this.largest = 0;
    // Straight through shrink with no time passing, so a jump over `snap` goes at once.
    const offset = this.fold(type, before, after, this.offset);
    this.offset = offset === undefined ? undefined : this.shrink(type, offset, 0, 1);
  }

  /**
   * What to draw now: `client.predicted` plus what is left of the corrections, which it returns as it is once they
   * settled. Call it once per frame, after `client.update()`. Do not write to the result.
   */
  state(): State {
    const now = this.now(),
      ms = Number.isNaN(this.last) ? 0 : Math.max(0, now - this.last),
      type: NormalizedField = { type: 'struct', name: this.stateType };
    this.last = now;
    this.largest = 0;
    if (this.offset !== undefined) this.offset = this.shrink(type, this.offset, ms, this.keep(0, ms));
    return this.offset === undefined ? this.client.predicted : (this.add(type, this.client.predicted, this.offset) as State);
  }

  /** Clears what is left to blend, so the next frame draws the exact prediction. */
  reset(): void {
    this.offset = undefined;
    this.largest = 0;
  }

  /** Stops following the client. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.client.oncorrection = this.chained;
  }
  /** Same as {@link CorrectionSmoother.close}, for `using`. */
  [Symbol.dispose](): void {
    this.close();
  }
}
