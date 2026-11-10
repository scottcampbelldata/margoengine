/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import { type Blackboard, type BlackboardKey, blackboardKey } from './blackboard.js';

/** World-space sphere region. Touching its boundary counts as inside. */
export interface SphereRegion {
  type: 'sphere';
  center: ArrayLike<number>;
  radius: number;
}
/** World-space axis-aligned box. Degenerate bounds are allowed. */
export interface BoxRegion {
  type: 'box';
  min: ArrayLike<number>;
  max: ArrayLike<number>;
}
/** Serializable spatial trigger shape. */
export type TriggerRegion = SphereRegion | BoxRegion;
/** Agent identity is stable across updates; the optional radius is its bounding sphere (default 0). */
export interface TriggerAgent {
  id: string | number;
  position: ArrayLike<number>;
  radius?: number;
  enabled?: boolean;
  blackboard?: Blackboard;
}
/** Exactly one phase per region/agent pair each update: first contact, retained contact, or departed contact. */
export type TriggerPhase = 'enter' | 'stay' | 'exit';
/** A spatial event with no agent object references, safe to serialize. */
export interface TriggerEvent {
  readonly agent: string | number;
  readonly region: string;
  readonly phase: TriggerPhase;
}
/** Last update for an agent, written to its optional blackboard. Shared squad boards use separate id keys. */
export interface TriggerMemory {
  readonly inside: readonly string[];
  readonly events: readonly TriggerEvent[];
}
const empty: TriggerMemory = Object.freeze({ inside: Object.freeze([]), events: Object.freeze([]) });
function identity(id: string | number): void {
  if (!(typeof id === 'string' && id.length > 0) && !(typeof id === 'number' && Number.isFinite(id)))
    throw new TypeError('Trigger agent id must be a nonempty string or finite number; provide a stable id');
}
function nonnegative(value: number): void {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError('Trigger radius must be finite and nonnegative; correct the radius');
}
function point(value: ArrayLike<number>): readonly [number, number, number] {
  if (!value || ![value[0], value[1], value[2]].every(Number.isFinite))
    throw new TypeError('Trigger position needs three finite coordinates; provide [x,y,z]');
  return Object.freeze([value[0], value[1], value[2]]);
}
/** Typed per-agent memory key; string and numeric ids are distinct. Namespace defaults to triggers.
 * @throws TypeError for an invalid id or empty namespace; supply stable names.
 */
export function triggerStateKey(id: string | number, namespace = 'triggers'): BlackboardKey<TriggerMemory> {
  identity(id);
  if (typeof namespace !== 'string' || !namespace)
    throw new TypeError('Trigger namespace must be nonempty; supply a name for this system');
  return blackboardKey(`triggers:${JSON.stringify([namespace, typeof id, id])}`, empty);
}
/** Create a detached sphere region.
 * @throws TypeError or RangeError for invalid coordinates/radius; provide a finite center and nonnegative radius.
 */
export function sphereRegion(center: ArrayLike<number>, radius: number): SphereRegion {
  nonnegative(radius);
  return Object.freeze({ type: 'sphere', center: point(center), radius });
}
/** Create a detached axis-aligned box.
 * @throws TypeError or RangeError for invalid coordinates/bounds; supply finite min <= max per axis.
 */
export function boxRegion(min: ArrayLike<number>, max: ArrayLike<number>): BoxRegion {
  const lo = point(min),
    hi = point(max);
  if (lo.some((value, i) => value > hi[i]))
    throw new RangeError('Trigger box min must be <= max on every axis; correct the bounds');
  return Object.freeze({ type: 'box', min: lo, max: hi });
}
function snapshot(region: TriggerRegion): TriggerRegion {
  if (region.type === 'sphere') return sphereRegion(region.center, region.radius);
  if (region.type === 'box') return boxRegion(region.min, region.max);
  throw new TypeError('Unknown trigger shape; use sphereRegion or boxRegion');
}
function intersects(region: TriggerRegion, position: ArrayLike<number>, radius: number): boolean {
  // Normalize before subtraction, so finite large coordinates never produce Infinity <= Infinity.
  let scale = Math.max(1, radius, Math.abs(position[0]), Math.abs(position[1]), Math.abs(position[2]));
  const lower = region.type === 'sphere' ? region.center : region.min;
  const upper = region.type === 'sphere' ? region.center : region.max;
  for (let i = 0; i < 3; i++) scale = Math.max(scale, Math.abs(lower[i]), Math.abs(upper[i]));
  if (region.type === 'sphere') scale = Math.max(scale, region.radius);
  const distances = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const at = position[i] / scale;
    distances[i] = at - Math.max(lower[i] / scale, Math.min(upper[i] / scale, at));
  }
  return Math.hypot(...distances) <= radius / scale + (region.type === 'sphere' ? region.radius / scale : 0);
}
/** Test a point or bounding sphere against a trigger region, including exact box corner distance.
 * @throws TypeError or RangeError for invalid shapes/positions/radius; supply finite geometry.
 */
export function touchesRegion(region: TriggerRegion, position: ArrayLike<number>, radius = 0): boolean {
  const shape = snapshot(region),
    at = point(position);
  nonnegative(radius);
  return intersects(shape, at, radius);
}
interface AgentState {
  agent: TriggerAgent;
  inside: Set<string>;
}
/** Deterministic spatial events and blackboard memory, stepped explicitly by the game loop. */
export class TriggerSystem {
  private readonly regions = new Map<string, { shape: TriggerRegion; enabled: boolean }>();
  private previous = new Map<string | number, AgentState>();
  private latest: readonly TriggerEvent[] = Object.freeze([]);
  private disposed = false;
  /** Namespace isolates several systems sharing a blackboard (default triggers).
   * @throws TypeError for an empty namespace; supply a stable name.
   */
  constructor(readonly namespace = 'triggers') {
    triggerStateKey('validation', namespace);
  }
  /** Events from the last update, in current agent/region order followed by removed-agent exits. */
  get events(): readonly TriggerEvent[] {
    return this.latest;
  }
  private live(): void {
    if (this.disposed) throw new MargoError('disposed', 'TriggerSystem is disposed; create a new system');
  }
  /** Add or move a region, retaining its identity. Geometry is detached; changes take effect on the next update.
   * @throws TypeError or RangeError for an invalid id/shape; supply a named finite shape. MargoError disposed after disposal.
   */
  set(id: string, region: TriggerRegion, enabled = true): this {
    this.live();
    if (typeof id !== 'string' || !id)
      throw new TypeError('Trigger region id must be nonempty; supply a stable region name');
    this.regions.set(id, { shape: snapshot(region), enabled });
    return this;
  }
  /** Enable/disable a registered region. Disabling raises exits on the next update.
   * @throws TypeError for an unknown id; register it with set. MargoError disposed after disposal.
   */
  setEnabled(id: string, enabled: boolean): void {
    this.live();
    const region = this.regions.get(id);
    if (!region) throw new TypeError(`Unknown trigger region '${id}'; register it with set before enabling`);
    region.enabled = enabled;
  }
  /** Remove a region; existing contacts exit on the next update.
   * @throws MargoError disposed after disposal; create a new system.
   */
  delete(id: string): boolean {
    this.live();
    return this.regions.delete(id);
  }
  /** Update all agents atomically after input validation. O(agents * regions), no renderer or implicit clock.
   * @throws TypeError or RangeError for duplicate ids or invalid geometry; correct the agents before updating.
   * MargoError disposed after disposal; create a new system.
   */
  update(agents: Iterable<TriggerAgent>): readonly TriggerEvent[] {
    this.live();
    const current = new Map<string | number, { agent: TriggerAgent; position: ArrayLike<number>; radius: number }>();
    for (const agent of agents) {
      identity(agent.id);
      const position = point(agent.position),
        radius = agent.radius ?? 0;
      nonnegative(radius);
      if (current.has(agent.id)) throw new TypeError(`Duplicate trigger agent '${agent.id}'; supply unique stable ids`);
      current.set(agent.id, { agent, position, radius });
    }
    const next = new Map<string | number, AgentState>(),
      events: TriggerEvent[] = [];
    const memories: { agent: TriggerAgent; inside: Set<string>; events: TriggerEvent[] }[] = [];
    const emit = (agent: TriggerAgent, region: string, phase: TriggerPhase, local: TriggerEvent[]): void => {
      const event = Object.freeze({ agent: agent.id, region, phase });
      local.push(event);
      events.push(event);
    };
    for (const [id, { agent, position, radius }] of current) {
      const before = this.previous.get(id),
        inside = new Set<string>(),
        local: TriggerEvent[] = [];
      if (agent.enabled !== false)
        for (const [region, entry] of this.regions)
          if (entry.enabled && intersects(entry.shape, position, radius)) {
            inside.add(region);
            emit(agent, region, before?.inside.has(region) ? 'stay' : 'enter', local);
          }
      for (const region of before?.inside ?? []) if (!inside.has(region)) emit(agent, region, 'exit', local);
      if (before?.agent.blackboard && before.agent.blackboard !== agent.blackboard)
        memories.push({ agent: before.agent, inside: new Set(), events: [] });
      memories.push({ agent, inside, events: local });
      next.set(id, { agent: { ...agent, position }, inside });
    }
    for (const [id, state] of this.previous)
      if (!current.has(id)) {
        const local: TriggerEvent[] = [];
        for (const region of state.inside) emit(state.agent, region, 'exit', local);
        memories.push({ agent: state.agent, inside: new Set(), events: local });
      }
    for (const memory of memories)
      memory.agent.blackboard?.set(
        triggerStateKey(memory.agent.id, this.namespace),
        Object.freeze({ inside: Object.freeze([...memory.inside]), events: Object.freeze(memory.events) }),
      );
    this.previous = next;
    this.latest = Object.freeze(events);
    return this.latest;
  }
  /** Emit final exits, clear agent blackboard membership and release all contacts. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.update([]);
    this.regions.clear();
    this.disposed = true;
  }
  /** Dispose for using declarations. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
