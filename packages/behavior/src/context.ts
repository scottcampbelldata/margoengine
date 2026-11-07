// Context steering after A. Fray, "Context Steering: Behavior-Driven Steering at the Macro Scale", Game AI Pro 2,
// chapter 18, 2015. Each behaviour says what it would like and fear in every direction instead of deciding, so nothing
// has to average two decisions into a stall: the lowest danger masks the interest, and the strongest interest left is
// the heading. Behaviours stay small and stateless and know nothing of each other.
import type { MutableVec3 } from '@margoengine/math';

/** A position or direction, `[x, y, z]`. */
export type Point = ArrayLike<number>;

/** What a context behaviour needs to know about the agent. */
export interface ContextAgent {
  /** World position. */
  readonly position: Point;
  /** World velocity, for {@link ContextSteering.steer} (default at rest). */
  readonly velocity?: Point;
  /** Top speed, for {@link ContextSteering.steer}. */
  maxSpeed?: number;
}

/** Writes what it wants into `interest` and what it fears into `danger`, and decides nothing. */
export type ContextBehavior<A extends ContextAgent = ContextAgent> = (
  interest: ContextMap,
  danger: ContextMap,
  agent: A,
) => void;

/** The outcome of {@link ContextSteering.decide}. */
export interface ContextDecision {
  /** Unit heading on the ground plane, `[x, 0, z]`, or zero when nothing was of interest. */
  readonly direction: readonly [number, number, number];
  /** How much interest was left in that heading, 0 to 1: the share of top speed to move at. */
  readonly strength: number;
  /** The lowest danger found. Above 0 means every heading was dangerous and this was the least bad. */
  readonly danger: number;
}

/** Options of {@link ContextSteering}. */
export interface ContextSteeringOptions {
  /** Headings around the circle, 4 or more; it can be low, since the result lands between slots (default 16). */
  resolution?: number;
  /** Passes of a 1, 2, 1 blur over the interest map, to soften spikes (default 0). */
  blur?: number;
  /** Share of last update's interest kept, 0 up to 1: high values emerge over time, so a moment's peak does not turn the agent (default 0). */
  memory?: number;
  /** Danger within this much of the lowest counts as the lowest, so a faint hint does not mask a heading (default 0). */
  slack?: number;
}

const TAU = 2 * Math.PI;

/** A ring of slots, one per heading, each holding how strongly something feels about that heading. */
export class ContextMap {
  /** One value per slot. Slot `i` is heading `i / resolution` of a turn from +X toward +Z. */
  readonly slots: Float64Array;

  /** @param resolution Number of slots. */
  constructor(resolution: number) {
    if (!Number.isInteger(resolution) || resolution < 4) throw new RangeError('Context resolution must be 4 or more');
    this.slots = new Float64Array(resolution);
  }

  /** Number of slots. */
  get resolution(): number {
    return this.slots.length;
  }

  /**
   * Write `value` along heading `angle` in radians, keeping the higher of old and new in each slot: a second obstacle
   * behind the first adds no danger. Within `spread` radians either side the value falls linearly to zero, or with
   * `flat` stays full across the spread.
   */
  write(angle: number, value: number, spread = 0, flat = false): void {
    const { slots } = this;
    const count = slots.length;
    const width = TAU / count;
    const reach = Math.ceil(Math.max(spread, width) / width);
    const center = angle / width;
    const first = Math.floor(center);
    const span = Math.max(spread, width);
    for (let i = first - reach; i <= first + reach + 1 && i - first - reach < count; i++) {
      const off = Math.abs(i - center) * width;
      if (off > span) continue;
      const amount = flat ? value : value * (1 - off / span);
      const slot = ((i % count) + count) % count;
      if (amount > (slots[slot] as number)) slots[slot] = amount;
    }
  }

  /** Keep the higher of this map and `other` in each slot. */
  merge(other: ContextMap): this {
    const { slots } = this;
    for (let i = 0; i < slots.length; i++) slots[i] = Math.max(slots[i] as number, other.slots[i] as number);
    return this;
  }

  /** Set every slot to 0. */
  clear(): void {
    this.slots.fill(0);
  }
}

const angleTo = (from: Point, to: Point): number =>
  Math.atan2((to[2] as number) - (from[2] as number), (to[0] as number) - (from[0] as number));
const flatDistance = (from: Point, to: Point): number =>
  Math.hypot((to[0] as number) - (from[0] as number), (to[2] as number) - (from[2] as number));

/** Options of {@link chase}. */
export interface ChaseOptions {
  /** Distance at which a target stops being interesting; nearer means stronger (default 50). */
  range?: number;
  /** Radians either side over which interest falls to zero: just missing a target is still fine (default a quarter turn). */
  spread?: number;
}

/** Interest in every target, nearer ones stronger, without choosing one. The array is read on every update. */
export function chase(targets: readonly { position: Point }[], options: ChaseOptions = {}): ContextBehavior {
  const range = options.range ?? 50;
  const spread = options.spread ?? Math.PI / 2;
  if (!(range > 0)) throw new RangeError('Chase range must be above 0');
  if (!(spread >= 0)) throw new RangeError('Chase spread must be 0 or more');
  return (interest, _danger, agent) => {
    for (const target of targets) {
      const distance = flatDistance(agent.position, target.position);
      if (distance === 0 || distance >= range) continue;
      interest.write(angleTo(agent.position, target.position), 1 - distance / range, spread);
    }
  };
}

/** Options of {@link avoid}. */
export interface AvoidOptions {
  /** Gap to keep from an obstacle's edge; farther obstacles are ignored (default 2). */
  clearance?: number;
  /** The agent's own radius (default 0). */
  radius?: number;
}

/**
 * Danger over every heading that would enter an obstacle's exclusion zone, stronger the closer it is. The width written
 * is the heading needed to pass without entering. The array is read on every update.
 */
export function avoid(
  obstacles: readonly { position: Point; radius: number }[],
  options: AvoidOptions = {},
): ContextBehavior {
  const clearance = options.clearance ?? 2;
  const own = options.radius ?? 0;
  if (!(clearance > 0)) throw new RangeError('Avoid clearance must be above 0');
  if (!(own >= 0)) throw new RangeError('Avoid radius must be 0 or more');
  return (_interest, danger, agent) => {
    for (const obstacle of obstacles) {
      const distance = flatDistance(agent.position, obstacle.position);
      const zone = obstacle.radius + own + clearance;
      if (distance >= zone) continue;
      const gap = Math.max(0, distance - obstacle.radius - own);
      const value = 1 - gap / clearance;
      // Inside the zone every heading toward the half circle ahead would go deeper.
      const spread = Math.asin(Math.min(1, (obstacle.radius + own) / Math.max(distance, 1e-9)));
      danger.write(angleTo(agent.position, obstacle.position), value, Math.max(spread, TAU / danger.resolution), true);
    }
  };
}

/** Where a peak really is, between slots: two lines of the steeper side's slope through the neighbours meet there. */
const subslot = (slots: Float64Array, mask: Uint8Array, at: number): number => {
  const count = slots.length;
  const left = (at + count - 1) % count;
  const right = (at + 1) % count;
  if (mask[left] === 1 || mask[right] === 1) return 0;
  const here = slots[at] as number;
  const a = slots[left] as number;
  const b = slots[right] as number;
  const slope = Math.max(here - a, here - b);
  return slope > 0 ? Math.max(-0.5, Math.min(0.5, (b - a) / (2 * slope))) : 0;
};

/**
 * An agent's context behaviours and the step that turns their maps into a heading. Add behaviours, then call
 * {@link ContextSteering.decide} each update, or {@link ContextSteering.steer} to use it inside `Steering`.
 */
export class ContextSteering<A extends ContextAgent = ContextAgent> {
  /** The merged interest of the last update, for drawing. */
  readonly interest: ContextMap;
  /** The merged danger of the last update, for drawing. */
  readonly danger: ContextMap;
  private readonly behaviors: ContextBehavior<A>[] = [];
  private readonly mask: Uint8Array;
  private readonly previous: Float64Array;
  private readonly scratch: Float64Array;
  private readonly blur: number;
  private readonly memory: number;
  private readonly slack: number;
  private readonly heading: [number, number, number] = [0, 0, 0];

  /** @throws RangeError for a malformed option. */
  constructor(options: ContextSteeringOptions = {}) {
    const resolution = options.resolution ?? 16;
    this.interest = new ContextMap(resolution);
    this.danger = new ContextMap(resolution);
    this.mask = new Uint8Array(resolution);
    this.previous = new Float64Array(resolution);
    this.scratch = new Float64Array(resolution);
    this.blur = options.blur ?? 0;
    if (!Number.isInteger(this.blur) || this.blur < 0)
      throw new RangeError('Context blur must be a whole number of 0 or more');
    this.memory = options.memory ?? 0;
    if (!(this.memory >= 0 && this.memory < 1)) throw new RangeError('Context memory must be 0 or more and below 1');
    this.slack = options.slack ?? 0;
    if (!(this.slack >= 0)) throw new RangeError('Context slack must be 0 or more');
  }

  /** Add a behaviour. */
  add(behavior: ContextBehavior<A>): this {
    if (typeof behavior !== 'function') throw new TypeError('A context behaviour must be a function');
    this.behaviors.push(behavior);
    return this;
  }

  /**
   * Run the behaviours and choose: find the lowest danger, mask every heading with more, take the strongest interest
   * left, and place it between slots.
   */
  decide(agent: A): ContextDecision {
    const { interest, danger, mask, previous, scratch, heading } = this;
    interest.clear();
    danger.clear();
    for (const behavior of this.behaviors) behavior(interest, danger, agent);
    const slots = interest.slots;
    const count = slots.length;
    for (let pass = 0; pass < this.blur; pass++) {
      for (let i = 0; i < count; i++)
        scratch[i] =
          ((slots[(i + count - 1) % count] as number) + 2 * (slots[i] as number) + (slots[(i + 1) % count] as number)) /
          4;
      slots.set(scratch);
    }
    if (this.memory > 0) {
      for (let i = 0; i < count; i++)
        slots[i] = (previous[i] as number) * this.memory + (slots[i] as number) * (1 - this.memory);
      previous.set(slots);
    }
    let lowest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i++) lowest = Math.min(lowest, danger.slots[i] as number);
    let best = -1;
    let strength = 0;
    for (let i = 0; i < count; i++) {
      const masked = (danger.slots[i] as number) > lowest + this.slack;
      mask[i] = masked ? 1 : 0;
      if (!masked && (slots[i] as number) > strength) {
        strength = slots[i] as number;
        best = i;
      }
    }
    if (best < 0) {
      heading[0] = heading[1] = heading[2] = 0;
      return { direction: heading, strength: 0, danger: lowest };
    }
    const angle = ((best + subslot(slots, mask, best)) / count) * TAU;
    heading[0] = Math.cos(angle);
    heading[1] = 0;
    heading[2] = Math.sin(angle);
    return { direction: heading, strength: Math.min(1, strength), danger: lowest };
  }

  /**
   * Decide and write the steering force toward that heading into `out`, ready to be a behaviour of `Steering` in
   * `@margoengine/behavior/steering`. Speed is `agent.maxSpeed` times the decision's strength.
   */
  steer(agent: A, out: MutableVec3): MutableVec3 {
    const { direction, strength } = this.decide(agent);
    const speed = (agent.maxSpeed ?? 1) * strength;
    out[0] = direction[0] * speed - ((agent.velocity?.[0] as number) ?? 0);
    out[1] = -((agent.velocity?.[1] as number) ?? 0);
    out[2] = direction[2] * speed - ((agent.velocity?.[2] as number) ?? 0);
    return out;
  }
}
