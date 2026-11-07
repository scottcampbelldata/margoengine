// Smart objects: world objects that describe their own uses, so agents need no code per object. The idea and the split
// into interaction positions, object state and behaviours is M. Kallmann and D. Thalmann, "Modeling Objects for
// Interaction Tasks", Eurographics Workshop on Animation and Simulation, 1998. Choosing a use by what it advertises
// against an agent's needs, faded by distance, with a check that hides a use and a routine run on the agent, is K.
// Forbus and W. Wright, "Some notes on programming objects in The Sims", 2001.
import { MargoError } from '@margoengine/math/errors';
import type { Status } from './spec.js';

/** A position or direction, `[x, y, z]`. */
export type Point = ArrayLike<number>;

/** An agent that uses smart objects. */
export interface SmartAgent {
  /** World position. */
  readonly position: Point;
  /** How much it wants each need met, 0 or more; a need it does not list counts 0 (default none). */
  needs?: Record<string, number>;
}

/** A place an agent stands or sits to use something, relative to the object. */
export interface SmartSlot {
  /** Offset from the object's position (default `[0, 0, 0]`). */
  readonly offset?: Point;
  /** Direction the agent should face there (default none). */
  readonly facing?: Point;
}

/** What one use of an object offers. */
export interface SmartUse<A extends SmartAgent = SmartAgent> {
  /** Name agents ask for: `'sit'`, `'open'`, `'repair'`. */
  readonly name: string;
  /** What it offers per need. A function can scale by the agent's personality. Needs fall by this on success. */
  readonly advertises?: Readonly<Record<string, number | ((agent: A) => number)>>;
  /** How fast the offer fades with distance `d`: it is divided by `1 + attenuation * d` (default 0.1; 0 never fades). */
  readonly attenuation?: number;
  /** Who can use it at once, and where (default one user at the object's position). */
  readonly slots?: readonly SmartSlot[];
  /** Needs the whole object: it waits until nobody is on any use, and blocks the rest while in use (default false). */
  readonly exclusive?: boolean;
  /** False hides this use for now, for example while the object's `state.broken` is set (default always there). */
  readonly available?: (object: SmartObject<A>, agent: A) => boolean;
  /** The routine, called from {@link SmartClaim.update} once the agent is in place (default finishes at once). */
  readonly run?: (agent: A, object: SmartObject<A>, delta: number) => Status;
}

/** Options of {@link SmartObject}. */
export interface SmartObjectOptions<A extends SmartAgent = SmartAgent> {
  /** Unique id. */
  id: string;
  /** World position; read live, so move the array's contents or the object with it. */
  position: Point;
  /** What it can be used for. */
  uses: readonly SmartUse<A>[];
  /** The object's own variables, for `available` and `run` to read and write (default empty). */
  state?: Record<string, unknown>;
}

/** An offer found by {@link SmartObjects.offers}. */
export interface SmartOffer<A extends SmartAgent = SmartAgent> {
  /** The object. */
  readonly object: SmartObject<A>;
  /** The use on offer. */
  readonly use: SmartUse<A>;
  /** How well it meets the agent's needs now, faded by distance. */
  readonly score: number;
  /** Straight distance from the agent to the object. */
  readonly distance: number;
}

/** Options of {@link SmartObjects.offers}. */
export interface SmartOfferOptions {
  /** Only this use, for an agent told to `'sit'`; then needs do not filter, and the nearest comes first. */
  use?: string;
  /** Only objects this close (default everywhere). */
  radius?: number;
}

/** A place held on an object. Release it when done; `using` works. */
export interface SmartClaim<A extends SmartAgent = SmartAgent> {
  /** The object. */
  readonly object: SmartObject<A>;
  /** The use claimed. */
  readonly use: SmartUse<A>;
  /** The agent holding it. */
  readonly agent: A;
  /** World position to go to, following the object. */
  position(out?: [number, number, number]): [number, number, number];
  /** Direction to face there, or `null`. */
  readonly facing: Point | null;
  /** False once released, or once its object left the world. */
  readonly active: boolean;
  /**
   * Run the use for `delta` seconds. On `'success'` the agent's needs fall by what was advertised, and on `'success'`
   * or `'failure'` the claim is released.
   * @throws MargoError with code `state` after release.
   */
  update(delta: number): Status;
  /** Give the place back. Safe to call twice. */
  release(): void;
  [Symbol.dispose](): void;
}

const checkPoint = (value: Point, label: string): void => {
  if (
    value == null ||
    value.length < 3 ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1]) ||
    !Number.isFinite(value[2])
  )
    throw new RangeError(`${label} must be [x, y, z] with finite numbers`);
};

const ONE_SLOT: readonly SmartSlot[] = [{}];

const needOf = (agent: SmartAgent, need: string): number => {
  const { needs } = agent;
  if (needs == null || !Object.hasOwn(needs, need)) return 0;
  const value = needs[need] as number;
  if (!Number.isFinite(value)) throw new RangeError(`Agent need '${need}' must be a finite number`);
  return value;
};

class Claim<A extends SmartAgent> implements SmartClaim<A> {
  active = true;
  readonly facing: Point | null;
  constructor(
    readonly object: SmartObject<A>,
    readonly use: SmartUse<A>,
    readonly agent: A,
    private readonly slot: SmartSlot,
    private readonly drop: (claim: Claim<A>) => void,
  ) {
    this.facing = slot.facing ?? null;
  }
  get held(): SmartSlot {
    return this.slot;
  }
  position(out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    const at = this.object.position;
    const offset = this.slot.offset;
    out[0] = (at[0] as number) + ((offset?.[0] as number) ?? 0);
    out[1] = (at[1] as number) + ((offset?.[1] as number) ?? 0);
    out[2] = (at[2] as number) + ((offset?.[2] as number) ?? 0);
    return out;
  }
  update(delta: number): Status {
    if (!this.active) throw new MargoError('state', 'This claim was released; claim the object again');
    const status = this.use.run ? this.use.run(this.agent, this.object, delta) : 'success';
    if (status === 'running') return status;
    if (status === 'success') {
      const { needs } = this.agent;
      if (needs)
        for (const name of Object.keys(this.use.advertises ?? {}))
          if (Object.hasOwn(needs, name))
            needs[name] = Math.max(0, needOf(this.agent, name) - offerOf(this.use, name, this.agent));
    }
    this.release();
    return status;
  }
  release(): void {
    if (!this.active) return;
    this.active = false;
    this.drop(this);
  }
  [Symbol.dispose](): void {
    this.release();
  }
}

const offerOf = <A extends SmartAgent>(use: SmartUse<A>, need: string, agent: A): number => {
  const offer = use.advertises?.[need] ?? 0;
  const value = typeof offer === 'function' ? offer(agent) : offer;
  if (!Number.isFinite(value)) throw new RangeError(`Use '${use.name}' must advertise a finite amount of '${need}'`);
  return value;
};

// Held here, not on the object, so a place can only be taken through SmartObjects.claim, which checks `available`.
const allClaims = new WeakMap<object, Set<Claim<never>>>();
const claimsOf = <A extends SmartAgent>(object: SmartObject<A>): Set<Claim<A>> => {
  let claims = allClaims.get(object);
  if (!claims) {
    claims = new Set();
    allClaims.set(object, claims);
  }
  return claims as unknown as Set<Claim<A>>;
};

/** A world object that says what it can be used for. Add it to a {@link SmartObjects} to reach agents. */
export class SmartObject<A extends SmartAgent = SmartAgent> {
  /** Unique id. */
  readonly id: string;
  /** World position. */
  readonly position: Point;
  /** What it can be used for. */
  readonly uses: readonly SmartUse<A>[];
  /** The object's own variables. */
  readonly state: Record<string, unknown>;

  /** @throws TypeError or RangeError for a malformed option. */
  constructor(options: SmartObjectOptions<A>) {
    if (options == null || typeof options !== 'object')
      throw new TypeError('A smart object must be {id, position, uses}');
    if (typeof options.id !== 'string' || !options.id) throw new TypeError('A smart object must have a non-empty id');
    checkPoint(options.position, 'Smart object position');
    if (!Array.isArray(options.uses)) throw new TypeError('A smart object must list its uses in an array');
    const names = new Set<string>();
    for (const use of options.uses) {
      if (use == null || typeof use.name !== 'string' || !use.name)
        throw new TypeError('A smart object use must have a non-empty name');
      if (names.has(use.name)) throw new RangeError(`Use names must be unique on an object; rename '${use.name}'`);
      names.add(use.name);
      if (use.slots !== undefined && (!Array.isArray(use.slots) || use.slots.length === 0))
        throw new RangeError(`Use '${use.name}' slots must be an array with at least one slot`);
      for (const slot of use.slots ?? []) if (slot.offset != null) checkPoint(slot.offset, 'Slot offset');
      const attenuation = use.attenuation ?? 0.1;
      if (!(attenuation >= 0) || !Number.isFinite(attenuation))
        throw new RangeError(`Use '${use.name}' attenuation must be 0 or more`);
    }
    this.id = options.id;
    this.position = options.position;
    this.uses = options.uses;
    this.state = options.state ?? {};
  }

  /** How many agents hold a place on this object now, on one use or on all. */
  users(use?: string): number {
    let count = 0;
    for (const claim of claimsOf(this)) if (use === undefined || claim.use.name === use) count++;
    return count;
  }

  /** The free slots of `use`: all of them less those held, none while something exclusive blocks it. */
  freeSlots(use: SmartUse<A>): SmartSlot[] {
    const taken = new Set<SmartSlot>();
    for (const claim of claimsOf(this)) {
      if (claim.use.exclusive || use.exclusive) return [];
      if (claim.use === use) taken.add(claim.held);
    }
    return (use.slots ?? ONE_SLOT).filter((slot) => !taken.has(slot));
  }
}

/** Hold the free slot of `use` nearest `agent`, or `null` when none is free. */
const hold = <A extends SmartAgent>(object: SmartObject<A>, use: SmartUse<A>, agent: A): SmartClaim<A> | null => {
  const free = object.freeSlots(use);
  if (free.length === 0) return null;
  let best = free[0] as SmartSlot;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const slot of free) {
    const distance = Math.hypot(
      (object.position[0] as number) + ((slot.offset?.[0] as number) ?? 0) - (agent.position[0] as number),
      (object.position[1] as number) + ((slot.offset?.[1] as number) ?? 0) - (agent.position[1] as number),
      (object.position[2] as number) + ((slot.offset?.[2] as number) ?? 0) - (agent.position[2] as number),
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      best = slot;
    }
  }
  const claims = claimsOf(object);
  const claim = new Claim(object, use, agent, best, (done) => claims.delete(done));
  claims.add(claim);
  return claim;
};

/** The smart objects of a world: what agents ask for what they can do. */
export class SmartObjects<A extends SmartAgent = SmartAgent> {
  private readonly objects = new Map<string, SmartObject<A>>();

  /**
   * Add an object.
   * @throws RangeError when the id is taken.
   */
  add(object: SmartObject<A>): SmartObject<A> {
    if (!(object instanceof SmartObject)) throw new TypeError('Add a SmartObject; build one with new SmartObject()');
    if (this.objects.has(object.id)) throw new RangeError(`Smart object ids must be unique; rename '${object.id}'`);
    this.objects.set(object.id, object);
    return object;
  }

  /** Take an object out of the world. Its claims end, so agents using it find `claim.active` false. */
  remove(id: string): boolean {
    const object = this.objects.get(id);
    if (!object) return false;
    for (const claim of [...claimsOf(object)]) claim.release();
    return this.objects.delete(id);
  }

  /** The object with this id, if any. */
  get(id: string): SmartObject<A> | undefined {
    return this.objects.get(id);
  }

  /** How many objects there are. */
  get size(): number {
    return this.objects.size;
  }

  /**
   * What the world offers `agent`, best first: uses that are available with a free slot, scored by the sum over needs
   * of need times advertised amount, divided by `1 + attenuation * distance`. Offers with no score are left out unless
   * `use` names what is wanted; then nearest comes first. Ties keep the order objects were added.
   */
  offers(agent: A, options: SmartOfferOptions = {}): SmartOffer<A>[] {
    if (agent == null || typeof agent !== 'object') throw new TypeError('A smart agent must be {position, needs}');
    checkPoint(agent.position, 'Agent position');
    const radius = options.radius ?? Number.POSITIVE_INFINITY;
    if (!(radius >= 0)) throw new RangeError('Offer radius must be 0 or more');
    const out: SmartOffer<A>[] = [];
    for (const object of this.objects.values()) {
      const distance = Math.hypot(
        (object.position[0] as number) - (agent.position[0] as number),
        (object.position[1] as number) - (agent.position[1] as number),
        (object.position[2] as number) - (agent.position[2] as number),
      );
      if (distance > radius) continue;
      for (const use of object.uses) {
        if (options.use !== undefined && use.name !== options.use) continue;
        if (use.available && !use.available(object, agent)) continue;
        if (object.freeSlots(use).length === 0) continue;
        let total = 0;
        for (const need of Object.keys(use.advertises ?? {})) total += needOf(agent, need) * offerOf(use, need, agent);
        const score = total / (1 + (use.attenuation ?? 0.1) * distance);
        if (options.use === undefined && !(score > 0)) continue;
        out.push({ object, use, score, distance });
      }
    }
    return out.sort(options.use === undefined ? (a, b) => b.score - a.score : (a, b) => a.distance - b.distance);
  }

  /** The best offer, or `null`. */
  best(agent: A, options?: SmartOfferOptions): SmartOffer<A> | null {
    return this.offers(agent, options)[0] ?? null;
  }

  /**
   * Hold a place on an offer, the free slot nearest the agent. Claim before walking there, so two agents do not head
   * for one chair.
   * @returns The claim, or `null` when the last slot went since the offer was made, or the use is no longer available.
   */
  claim(offer: SmartOffer<A>, agent: A): SmartClaim<A> | null {
    const { object, use } = offer;
    if (this.objects.get(object.id) !== object) return null;
    if (use.available && !use.available(object, agent)) return null;
    return hold(object, use, agent);
  }
}
