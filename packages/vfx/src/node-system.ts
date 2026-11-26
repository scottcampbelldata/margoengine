import { VFX } from '@margoengine/vfx';
import type { VFXEmitter, VFXEvents, VFXNode, VFXOptions } from './base.js';
import { lowbias32 } from './hash.js';

/** Current node-system document version. Unknown versions reject instead of loading half a graph. */
export const NODE_SYSTEM_VERSION = 1;
/** Most blocks in one graph. */
export const MAX_NODE_SYSTEM_BLOCKS = 512;
/** Most particle systems in one graph. */
export const MAX_NODE_SYSTEMS = 32;
const HELP = 'https://margoengine.com/errors#vfx-node-system';

/**
 * Why a node-system graph was refused. Stable across releases: branch on `code`, not on message text.
 * - `format`, `version`: the JSON is not a node-system document, or its version is not 1.
 * - `limit`: more blocks or systems than the limits allow.
 * - `duplicate-id`, `unknown-block`, `unknown-ref`: block ids are not unique, a block has an unknown `type`, or a wire names a missing block.
 * - `wrong-type`: a wire feeds a block whose output does not fit the input (a color into a lifetime).
 * - `bad-param`: a literal is missing, not finite or out of range.
 * - `cycle`: value wires or start/end triggers loop back on themselves.
 * - `no-system`: the graph has no system block, or no system that starts by itself.
 * - `trigger`: a trigger names a block that is not a system, or an event trigger cannot be built (see its message).
 * - `invalid-options`: the compiled options were refused by `VFX` (a size or rate out of range).
 */
export type VFXNodeSystemCode =
  | 'format'
  | 'version'
  | 'limit'
  | 'duplicate-id'
  | 'unknown-block'
  | 'unknown-ref'
  | 'wrong-type'
  | 'bad-param'
  | 'cycle'
  | 'no-system'
  | 'trigger'
  | 'invalid-options';

/** A refused node-system graph. `block` is the id of the offending block when there is one. */
export class VFXNodeSystemError extends Error {
  declare readonly code: VFXNodeSystemCode;
  declare readonly block: string | undefined;
  constructor(code: VFXNodeSystemCode, message: string, block?: string, options?: { cause?: unknown }) {
    super(`${message}; see ${HELP}`, options);
    this.name = 'VFXNodeSystemError';
    this.code = code;
    this.block = block;
  }
}
const fail = (code: VFXNodeSystemCode, message: string, block?: string): never => {
  throw new VFXNodeSystemError(code, message, block);
};

/** A literal or the id of a value block that produces it. */
export type NodeRef<T> = T | string;
type Num = NodeRef<number>;
type Vec3 = NodeRef<readonly [Num, Num, Num]>;

/** `number`: a number. As a lifetime it is the range [v, v]. */
export interface NumberBlock {
  id: string;
  type: 'number';
  value: Num;
}
/** `vector`: three numbers, for velocity, position, gravity, shape axes. */
export interface VectorBlock {
  id: string;
  type: 'vector';
  value: readonly [Num, Num, Num];
}
/** `color`: linear RGBA, each 0..1 (the stock range of the options it feeds). */
export interface ColorBlock {
  id: string;
  type: 'color';
  value: readonly [Num, Num, Num, Num];
}
/**
 * `random`: a number drawn between `min` and `max` once per compile, deterministically from `seed` and the graph's
 * seed (default seed: the block's position). Fed to a range input (a lifetime) it stays the range [min, max], so
 * the GPU draws a fresh value per particle. With `vector: true` it is three independent draws.
 */
export interface RandomBlock {
  id: string;
  type: 'random';
  min: Num;
  max: Num;
  seed?: number;
  vector?: boolean;
}
/** `math`: `add`, `sub`, `mul`, `min`, `max` of `a` and `b`, or `mix` of `a` to `b` by `t` (default 0.5). */
export interface MathBlock {
  id: string;
  type: 'math';
  op: 'add' | 'sub' | 'mul' | 'min' | 'max' | 'mix';
  a: Num;
  b: Num;
  t?: Num;
}
/** `gradient`: 2..8 stops ascending by `at` (0..1) with a linear RGB `color` (each 0..16); feeds `update-color`. */
export interface GradientBlock {
  id: string;
  type: 'gradient';
  stops: readonly { at: Num; color: readonly [Num, Num, Num] }[];
}
/** `curve`: 2..32 evenly spaced samples over normalized life; feeds the `update-*` curve blocks. */
export interface CurveBlock {
  id: string;
  type: 'curve';
  samples: readonly Num[];
}
/** The value blocks, which only feed other blocks. */
export type NodeSystemValueBlock =
  | NumberBlock
  | VectorBlock
  | ColorBlock
  | RandomBlock
  | MathBlock
  | GradientBlock
  | CurveBlock;

/** `shape`: where births start (the `emitter` option). `shape` is one of `sphere`, `cone`, `hemisphere`, `cylinder`, `torus`, `rectangle-edge`, `grid`; the other fields are that shape's own, each a literal or a wire. */
export interface ShapeBlock {
  id: string;
  type: 'shape';
  shape: 'sphere' | 'cone' | 'hemisphere' | 'cylinder' | 'torus' | 'rectangle-edge' | 'grid';
  radius?: Num;
  shell?: boolean;
  speed?: Num;
  angle?: Num;
  axis?: Vec3;
  height?: Num;
  tube?: Num;
  width?: Num;
  columns?: Num;
  rows?: Num;
  layers?: Num;
  spacing?: Vec3;
}

/** Creation blocks: the settings a particle is born with. */
export type NodeSystemCreateBlock =
  | { id: string; type: 'create-capacity'; value: Num }
  | { id: string; type: 'create-rate'; value: Num }
  | { id: string; type: 'create-initial'; value: Num }
  | { id: string; type: 'create-lifetime'; value: NodeRef<readonly [Num, Num] | Num> }
  | { id: string; type: 'create-size'; value: Num }
  | { id: string; type: 'create-color'; value: NodeRef<readonly [Num, Num, Num, Num]> }
  | { id: string; type: 'create-position'; value: Vec3 }
  | { id: string; type: 'create-velocity'; value: Vec3; spread?: Num }
  | { id: string; type: 'create-prewarm'; seconds: Num; seed?: number }
  | { id: string; type: 'create-burst'; time: Num; count: Num; cycles?: Num; interval?: Num; probability?: Num };

/** Update blocks: what happens to a particle while it lives. */
export type NodeSystemUpdateBlock =
  | { id: string; type: 'update-size'; curve: NodeRef<readonly Num[]> }
  | { id: string; type: 'update-alpha'; curve: NodeRef<readonly Num[]> }
  | { id: string; type: 'update-color'; gradient: NodeRef<GradientBlock['stops']> }
  | { id: string; type: 'update-spin'; curve: NodeRef<readonly Num[]> }
  | { id: string; type: 'update-speed'; curve: NodeRef<readonly Num[]> }
  | { id: string; type: 'update-velocity-limit'; value: Num }
  | { id: string; type: 'update-gravity'; value: Vec3 }
  | { id: string; type: 'update-turbulence'; strength: Num; frequency?: Num }
  | { id: string; type: 'update-ground'; height: Num; bounce?: Num }
  | { id: string; type: 'update-forces'; graph: readonly VFXNode[] };

/**
 * `system`: one particle system. `shape` names a shape block, `create` and `update` list creation and update blocks.
 * `duration` is the seconds it runs after it starts (0..1,000,000, default 0: until the set is stopped); the `end`
 * triggers fire when it passes.
 */
export interface SystemBlock {
  id: string;
  type: 'system';
  name?: string;
  duration?: number;
  shape?: string;
  create?: readonly string[];
  update?: readonly string[];
}

/**
 * `trigger`: starts or chains another system.
 * - `start`: `target` starts `delay` seconds (0..1,000,000, default 0) after `source` starts.
 * - `end`: `target` starts `delay` seconds after `source`'s duration ends.
 * - `birth`, `death`, `collision`: `target`'s creation blocks become `source`'s sub-emitter (the `events` option):
 *   `count` children (1..64, default 8) are born on the GPU where a particle is born, dies or hits the ground faster
 *   than `speed` (default 0.5), with `inherit` of its velocity (-10..10, default 0). A source has at most one.
 *   The target is then a child, not a system of its own: it takes its lifetime, size, velocity, spread and color
 *   from its creation blocks, and may have no shape, update blocks or triggers.
 */
export interface TriggerBlock {
  id: string;
  type: 'trigger';
  on: 'start' | 'end' | 'birth' | 'death' | 'collision';
  source: string;
  target: string;
  delay?: number;
  count?: number;
  inherit?: number;
  speed?: number;
}

/** Every block a graph holds. */
export type NodeSystemBlock =
  | NodeSystemValueBlock
  | ShapeBlock
  | NodeSystemCreateBlock
  | NodeSystemUpdateBlock
  | SystemBlock
  | TriggerBlock;

/** A whole particle system as data. Wires are block ids. */
export interface NodeSystemGraph {
  format: 'margo-vfx-node-system';
  version: typeof NODE_SYSTEM_VERSION;
  blocks: readonly NodeSystemBlock[];
}

/** A system after compilation: ready to hand to `new VFX(options)` when it starts. */
export interface NodeSystemEntry {
  id: string;
  name: string;
  /** Seconds it runs; 0 runs until stopped. */
  duration: number;
  /** The effect options, validated by `VFX`. */
  options: VFXOptions;
  /** Systems that start when this one starts or ends. */
  triggers: readonly { on: 'start' | 'end'; target: string; delay: number }[];
}
/** A compiled graph. Systems that no trigger starts are `roots`; sub-emitter children are folded into their parent's options. */
export interface NodeSystemPlan {
  systems: ReadonlyMap<string, NodeSystemEntry>;
  roots: readonly string[];
}
/** Settings for compiling a graph. */
export interface NodeSystemCompileOptions {
  /** Unsigned 32-bit seed mixed into every `random` block. Default 0. */
  seed?: number;
}

const own = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const VALUE = new Set(['number', 'vector', 'color', 'random', 'math', 'gradient', 'curve']);
const CREATE = new Set([
  'create-capacity',
  'create-rate',
  'create-initial',
  'create-lifetime',
  'create-size',
  'create-color',
  'create-position',
  'create-velocity',
  'create-prewarm',
  'create-burst',
]);
const UPDATE = new Set([
  'update-size',
  'update-alpha',
  'update-color',
  'update-spin',
  'update-speed',
  'update-velocity-limit',
  'update-gravity',
  'update-turbulence',
  'update-ground',
  'update-forces',
]);
const TYPES = new Set([...VALUE, ...CREATE, ...UPDATE, 'shape', 'system', 'trigger']);
const EVENT_ON = new Set(['birth', 'death', 'collision']);

type Kind = 'number' | 'vec3' | 'color' | 'range' | 'curve' | 'gradient';
const OUT: Record<string, readonly Kind[]> = {
  number: ['number', 'range'],
  vector: ['vec3'],
  color: ['color'],
  random: ['number', 'range', 'vec3'],
  math: ['number', 'range'],
  gradient: ['gradient'],
  curve: ['curve'],
};

/** Compile a graph into one validated option set per system. Throws {@link VFXNodeSystemError}. */
export function compileNodeSystem(graph: NodeSystemGraph, options: NodeSystemCompileOptions = {}): NodeSystemPlan {
  if (!own(graph) || graph.format !== 'margo-vfx-node-system')
    fail('format', 'Node system graph needs format "margo-vfx-node-system"; pass a saved or authored graph');
  if (graph.version !== NODE_SYSTEM_VERSION)
    fail('version', `Node system version ${String(graph.version)} is unsupported; migrate to version 1`);
  if (!Array.isArray(graph.blocks)) fail('format', 'Node system graph needs a blocks array; list every block');
  if (graph.blocks.length > MAX_NODE_SYSTEM_BLOCKS)
    fail('limit', `Node system has more than ${MAX_NODE_SYSTEM_BLOCKS} blocks; split it into several graphs`);
  const seed = options.seed ?? 0;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new RangeError('Node system seed must be an unsigned 32-bit integer; pass 0..4294967295');

  type RawBlock = Record<string, unknown> & { id: string; type: string };
  const blocks = new Map<string, RawBlock>();
  const index = new Map<string, number>();
  graph.blocks.forEach((block, at) => {
    if (!own(block) || typeof block.id !== 'string' || block.id === '')
      fail('format', `Node system block ${at} needs a non-empty string id`);
    if (blocks.has(block.id as string))
      fail('duplicate-id', `Node system block id "${block.id}" is used twice`, block.id as string);
    if (typeof block.type !== 'string' || !TYPES.has(block.type))
      fail(
        'unknown-block',
        `Node system block "${block.id}" has unknown type ${JSON.stringify(block.type)}`,
        block.id as string,
      );
    blocks.set(block.id as string, block as never);
    index.set(block.id as string, at);
  });
  const get = (id: unknown, where: string, from: string) => {
    const block = typeof id === 'string' ? blocks.get(id) : undefined;
    if (!block) fail('unknown-ref', `${where} names block ${JSON.stringify(id)}, which is not in the graph`, from);
    return block!;
  };

  // Value wires, evaluated once per compile. A wire that loops back through `math` is a cycle.
  const memo = new Map<string, unknown>();
  const open = new Set<string>();
  const draw = (block: { id: string; seed?: unknown }, n: number): number => {
    const own = typeof block.seed === 'number' ? block.seed : index.get(block.id)!;
    return lowbias32(lowbias32(seed ^ own) + Math.imul(n + 1, 0x9e3779b9)) / 4294967296;
  };
  const num = (value: unknown, where: string, block: string): number => {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('bad-param', `${where} must be a finite number`, block);
      return value;
    }
    if (typeof value === 'string') return fromBlock(value, 'number', where, block) as number;
    return fail('bad-param', `${where} needs a number or the id of a value block`, block);
  };
  const tuple = (value: unknown, n: 2 | 3 | 4, where: string, block: string): number[] => {
    if (typeof value === 'string')
      return fromBlock(value, n === 2 ? 'range' : n === 3 ? 'vec3' : 'color', where, block) as number[];
    if (!Array.isArray(value) || value.length !== n)
      fail('bad-param', `${where} needs ${n} numbers or the id of a value block`, block);
    return (value as unknown[]).map((v, i) => num(v, `${where}[${i}]`, block));
  };
  const list = (value: unknown, kind: 'curve' | 'gradient', where: string, block: string): unknown[] => {
    if (typeof value === 'string') return fromBlock(value, kind, where, block) as unknown[];
    if (!Array.isArray(value)) return fail('bad-param', `${where} needs an array or the id of a ${kind} block`, block);
    return kind === 'curve'
      ? value.map((v, i) => num(v, `${where}[${i}]`, block))
      : value.map((stop: unknown, i) => {
          if (!own(stop)) fail('bad-param', `${where}[${i}] needs {at, color}`, block);
          return {
            at: num((stop as Record<string, unknown>).at, `${where}[${i}].at`, block),
            color: tuple((stop as Record<string, unknown>).color, 3, `${where}[${i}].color`, block),
          };
        });
  };
  const fromBlock = (id: string, kind: Kind, where: string, from: string): unknown => {
    const b = get(id, where, from);
    if (!(OUT[b.type] ?? []).includes(kind))
      fail('wrong-type', `${where} reads block "${id}" (${b.type}), which gives no ${kind}`, from);
    const key = `${id}:${kind}`;
    if (memo.has(key)) return memo.get(key);
    if (open.has(id)) fail('cycle', `Value block "${id}" feeds itself`, id);
    open.add(id);
    let out: unknown;
    const at = `${b.type} "${id}"`;
    if (b.type === 'number')
      out = kind === 'range' ? [num(b.value, at, id), num(b.value, at, id)] : num(b.value, at, id);
    else if (b.type === 'vector') out = tuple(b.value, 3, at, id);
    else if (b.type === 'color') out = tuple(b.value, 4, at, id);
    else if (b.type === 'random') {
      const lo = num(b.min, `${at} min`, id),
        hi = num(b.max, `${at} max`, id);
      if (lo > hi) fail('bad-param', `${at} needs min <= max`, id);
      out =
        kind === 'range'
          ? [lo, hi]
          : kind === 'vec3' || b.vector
            ? [0, 1, 2].map((n) => lo + (hi - lo) * draw(b as never, n))
            : lo + (hi - lo) * draw(b as never, 0);
    } else if (b.type === 'math') {
      const a = num(b.a, `${at} a`, id),
        c = num(b.b, `${at} b`, id),
        op = b.op;
      const t = b.t === undefined ? 0.5 : num(b.t, `${at} t`, id);
      const v =
        op === 'add'
          ? a + c
          : op === 'sub'
            ? a - c
            : op === 'mul'
              ? a * c
              : op === 'min'
                ? Math.min(a, c)
                : op === 'max'
                  ? Math.max(a, c)
                  : op === 'mix'
                    ? a + (c - a) * t
                    : fail('bad-param', `${at} op must be add, sub, mul, min, max or mix`, id);
      out = kind === 'range' ? [v, v] : v;
    } else if (b.type === 'gradient') out = list(b.stops, 'gradient', `${at} stops`, id);
    else out = list(b.samples, 'curve', `${at} samples`, id);
    open.delete(id);
    memo.set(key, out);
    return out;
  };
  const vec3 = (v: unknown, where: string, block: string) =>
    tuple(v, 3, where, block) as unknown as [number, number, number];
  const rangeOf = (v: unknown, where: string, block: string): [number, number] =>
    typeof v === 'number' ? [v, v] : (tuple(v, 2, where, block) as [number, number]);

  const shapeOf = (id: unknown, from: string): VFXEmitter => {
    const b = get(id, 'system shape', from);
    if (b.type !== 'shape')
      fail('wrong-type', `System "${from}" shape must name a shape block, not ${b.type} "${id}"`, from);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(b)) {
      if (key === 'id' || key === 'type') continue;
      out[key] =
        key === 'shell'
          ? value === true
          : key === 'shape'
            ? value
            : key === 'axis' || key === 'spacing'
              ? vec3(value, `shape "${b.id}" ${key}`, b.id)
              : num(value, `shape "${b.id}" ${key}`, b.id);
    }
    return out as unknown as VFXEmitter;
  };

  const apply = (b: RawBlock, o: VFXOptions) => {
    const at = `${b.type} "${b.id}"`;
    switch (b.type) {
      case 'create-capacity':
        o.capacity = num(b.value, at, b.id);
        break;
      case 'create-rate':
        o.rate = num(b.value, at, b.id);
        break;
      case 'create-initial':
        o.initialCount = num(b.value, at, b.id);
        break;
      case 'create-lifetime':
        o.lifetime = rangeOf(b.value, at, b.id);
        break;
      case 'create-size':
        o.size = num(b.value, at, b.id);
        break;
      case 'create-color':
        o.color = tuple(b.value, 4, at, b.id) as never;
        break;
      case 'create-position':
        o.position = vec3(b.value, at, b.id);
        break;
      case 'create-velocity':
        o.velocity = vec3(b.value, at, b.id);
        if (b.spread !== undefined) o.spread = num(b.spread, `${at} spread`, b.id);
        break;
      case 'create-prewarm':
        o.schedule = { ...o.schedule, prewarm: num(b.seconds, at, b.id) };
        if (b.seed !== undefined) o.schedule!.seed = num(b.seed, `${at} seed`, b.id);
        break;
      case 'create-burst': {
        const burst: Record<string, number> = {
          time: num(b.time, `${at} time`, b.id),
          count: num(b.count, `${at} count`, b.id),
        };
        for (const key of ['cycles', 'interval', 'probability'])
          if (b[key] !== undefined) burst[key] = num(b[key], `${at} ${key}`, b.id);
        o.schedule = { ...o.schedule, bursts: [...(o.schedule?.bursts ?? []), burst as never] };
        break;
      }
      case 'update-size':
        o.curves = { ...o.curves, size: list(b.curve, 'curve', at, b.id) as number[] };
        break;
      case 'update-alpha':
        o.curves = { ...o.curves, alpha: list(b.curve, 'curve', at, b.id) as number[] };
        break;
      case 'update-color':
        o.curves = { ...o.curves, color: list(b.gradient, 'gradient', at, b.id) as never };
        break;
      case 'update-spin':
        o.overLife = { ...o.overLife, spin: list(b.curve, 'curve', at, b.id) as number[] };
        break;
      case 'update-speed':
        o.overLife = { ...o.overLife, speed: list(b.curve, 'curve', at, b.id) as number[] };
        break;
      case 'update-velocity-limit':
        o.overLife = { ...o.overLife, velocityLimit: num(b.value, at, b.id) };
        break;
      case 'update-gravity':
        o.gravity = vec3(b.value, at, b.id);
        break;
      case 'update-turbulence':
        o.turbulence = num(b.strength, `${at} strength`, b.id);
        if (b.frequency !== undefined) o.frequency = num(b.frequency, `${at} frequency`, b.id);
        break;
      case 'update-ground':
        o.ground = num(b.height, `${at} height`, b.id);
        if (b.bounce !== undefined) o.bounce = num(b.bounce, `${at} bounce`, b.id);
        break;
      case 'update-forces':
        if (!Array.isArray(b.graph)) fail('bad-param', `${at} needs a graph array of update-node operators`, b.id);
        // Each operator is checked by the force graph itself when the VFX is built (vfx/src/nodes.ts).
        o.nodes = { graph: b.graph as NonNullable<VFXOptions['nodes']>['graph'] };
        break;
    }
  };
  const members = (system: RawBlock, key: 'create' | 'update', set: Set<string>): RawBlock[] => {
    const ids = system[key] ?? [];
    if (!Array.isArray(ids)) fail('bad-param', `System "${system.id}" ${key} must be an array of block ids`, system.id);
    return (ids as unknown[]).map((id) => {
      const b = get(id, `System "${system.id}" ${key}`, system.id);
      if (!set.has(b.type))
        fail(
          'wrong-type',
          `System "${system.id}" ${key} lists "${id}" (${b.type}), which is not a ${key} block`,
          system.id,
        );
      return b;
    });
  };

  const systems = [...blocks.values()].filter((b) => b.type === 'system');
  if (systems.length === 0) fail('no-system', 'Node system has no system block; add one with type "system"');
  if (systems.length > MAX_NODE_SYSTEMS)
    fail('limit', `Node system has more than ${MAX_NODE_SYSTEMS} systems; split the graph`);
  const raw = new Map<string, VFXOptions>();
  for (const system of systems) {
    const o: VFXOptions = {};
    if (system.shape !== undefined) o.emitter = shapeOf(system.shape, system.id);
    for (const b of members(system, 'create', CREATE)) apply(b, o);
    for (const b of members(system, 'update', UPDATE)) apply(b, o);
    raw.set(system.id, o);
  }

  // Triggers: start and end chain systems on the CPU timeline; birth, death and collision fold the target in as the source's sub-emitter.
  const chain = new Map<string, { on: 'start' | 'end'; target: string; delay: number }[]>(
    systems.map((s) => [s.id, []]),
  );
  const targeted = new Set<string>();
  const children = new Set<string>();
  const hasEvents = new Set<string>();
  for (const t of [...blocks.values()].filter((b) => b.type === 'trigger')) {
    const at = `trigger "${t.id}"`;
    const [source, target] = [get(t.source, `${at} source`, t.id), get(t.target, `${at} target`, t.id)];
    if (source.type !== 'system' || target.type !== 'system')
      fail('trigger', `${at} source and target must be system blocks`, t.id);
    if (source === target) fail('trigger', `${at} cannot start its own source; name a second system`, t.id);
    // The resolved blocks' ids: the same strings as t.source and t.target, typed.
    const [from, to] = [source.id, target.id];
    if (t.on === 'start' || t.on === 'end') {
      const delay = t.delay === undefined ? 0 : num(t.delay, `${at} delay`, t.id);
      if (delay < 0 || delay > 1_000_000)
        throw new RangeError(`Node system ${at} delay must be 0..1000000 seconds; pass a finite value in range`);
      chain.get(from)!.push({ on: t.on, target: to, delay });
      targeted.add(to);
    } else if (typeof t.on === 'string' && EVENT_ON.has(t.on)) {
      if (hasEvents.has(from))
        fail('trigger', `System "${from}" already has an event trigger; a sub-emitter has one (on, count)`, t.id);
      const child = raw.get(to)!;
      if (
        child.emitter ||
        (Array.isArray(target.update) && target.update.length) ||
        chain.get(to)!.length ||
        targeted.has(to) ||
        children.has(from)
      )
        fail(
          'trigger',
          `${at} target "${to}" is a sub-emitter child: it takes its birth settings from create blocks only, with no shape, update blocks or triggers, and a child cannot itself raise events`,
          t.id,
        );
      const events: Record<string, unknown> = { on: t.on };
      for (const key of ['count', 'inherit', 'speed'] as const)
        if (t[key] !== undefined) events[key] = num(t[key], `${at} ${key}`, t.id);
      if (child.lifetime) events.lifetime = child.lifetime;
      if (child.size !== undefined) events.size = child.size;
      if (child.velocity) events.velocity = child.velocity;
      if (child.spread !== undefined) events.spread = child.spread;
      if (child.color) events.color = child.color;
      raw.get(from)!.events = events as unknown as VFXEvents;
      hasEvents.add(from);
      children.add(to);
    } else fail('trigger', `${at} on must be start, end, birth, death or collision`, t.id);
  }
  for (const child of children)
    if (targeted.has(child) || hasEvents.has(child))
      fail('trigger', `System "${child}" is both a sub-emitter child and a chained or event-raising system`, child);

  // Start and end triggers must not loop.
  const state = new Map<string, 1 | 2>();
  const visit = (id: string) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1)
      fail('cycle', `Triggers chain system "${id}" back to itself; remove one trigger of the loop`, id);
    state.set(id, 1);
    for (const next of chain.get(id)!) visit(next.target);
    state.set(id, 2);
  };
  systems.forEach((s) => visit(s.id));

  const out = new Map<string, NodeSystemEntry>();
  for (const system of systems) {
    if (children.has(system.id)) continue;
    const duration =
      system.duration === undefined ? 0 : num(system.duration, `System "${system.id}" duration`, system.id);
    if (duration < 0 || duration > 1_000_000)
      throw new RangeError(`System "${system.id}" duration must be 0..1000000 seconds; pass a finite value in range`);
    const opts = raw.get(system.id)!;
    try {
      new VFX(opts).dispose();
    } catch (cause) {
      throw new VFXNodeSystemError(
        'invalid-options',
        `System "${system.id}" options are refused: ${(cause as Error).message}`,
        system.id,
        { cause },
      );
    }
    out.set(system.id, {
      id: system.id,
      name: typeof system.name === 'string' ? system.name : system.id,
      duration,
      options: opts,
      triggers: chain.get(system.id)!,
    });
  }
  const roots = [...out.keys()].filter((id) => !targeted.has(id));
  if (roots.length === 0)
    fail('no-system', 'Node system has no system that starts by itself; every system is the target of a trigger');
  return { systems: out, roots };
}

/** Save a graph as stable JSON. The graph is compiled first, so a document that saves also loads. */
export function serializeNodeSystem(graph: NodeSystemGraph, options: NodeSystemCompileOptions = {}): string {
  compileNodeSystem(graph, options);
  return JSON.stringify({ format: graph.format, version: graph.version, blocks: graph.blocks });
}

/** Read a saved graph. It does not compile: pass it to {@link compileNodeSystem} or {@link createNodeSystem}. */
export function parseNodeSystem(text: string, limits: { maxChars?: number } = {}): NodeSystemGraph {
  const maxChars = limits.maxChars ?? 16 * 1024 * 1024;
  if (typeof text !== 'string' || text.length > maxChars)
    throw new RangeError('Node system JSON needs text within maxChars; pass a smaller string');
  let document: unknown;
  try {
    document = JSON.parse(text, (key, value) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype')
        fail('format', `Node system JSON has reserved key ${key}; remove it`);
      return value;
    });
  } catch (cause) {
    if (cause instanceof VFXNodeSystemError) throw cause;
    throw new VFXNodeSystemError('format', 'Node system JSON syntax is invalid; correct the text', undefined, {
      cause,
    });
  }
  const doc = document as Record<string, unknown>;
  if (!own(document) || doc.format !== 'margo-vfx-node-system')
    fail('format', 'Node system JSON must be an object with format "margo-vfx-node-system"');
  if (doc.version !== NODE_SYSTEM_VERSION)
    fail('version', `Node system JSON version ${String(doc.version)} is unsupported; migrate to version 1`);
  if (!Array.isArray(doc.blocks)) fail('format', 'Node system JSON needs a blocks array');
  return document as unknown as NodeSystemGraph;
}

/** What `create` returns for a started system: any object; its `stop` or `dispose` is called when the system ends or the set is disposed. */
export interface NodeSystemHandle {
  /** Called at the end of a system's `duration`; default: `dispose`. */
  stop?(): void;
  dispose?(): void;
}
/** Settings for a running set. */
export interface NodeSystemOptions extends NodeSystemCompileOptions {
  /** Makes the effect for a system when it starts, for example `(options) => engine.use(new VFX(options))`. */
  create(options: VFXOptions, id: string): NodeSystemHandle | void;
}

/**
 * Runs a compiled graph on a clock: roots start at `start()`, and `start`/`end` triggers start their targets after
 * their delays as `update(dt)` advances time. Nothing runs by itself; the caller owns the clock and the handles.
 */
export class NodeParticleSystem implements Disposable {
  readonly plan: NodeSystemPlan;
  #create: NodeSystemOptions['create'];
  #time = 0;
  #queue: { time: number; kind: 'start' | 'end'; id: string }[] = [];
  #started = new Set<string>();
  #live = new Map<string, NodeSystemHandle | undefined>();
  #disposed = false;
  constructor(plan: NodeSystemPlan, options: Pick<NodeSystemOptions, 'create'>) {
    if (typeof options?.create !== 'function')
      throw new TypeError('NodeParticleSystem needs a create(options, id) function; pass one');
    this.plan = plan;
    this.#create = options.create;
  }
  /** Seconds since `start()`. */
  get elapsed(): number {
    return this.#time;
  }
  /** Ids of the systems started and not yet ended. */
  get running(): readonly string[] {
    return [...this.#live.keys()];
  }
  /** Ids of every system that has started since `start()`, in start order. */
  get started(): readonly string[] {
    return [...this.#started];
  }
  /** Restart the clock at 0 and start the roots; ends whatever was running. */
  start(): this {
    this.#assert();
    this.#release();
    this.#time = 0;
    this.#queue = this.plan.roots.map((id) => ({ time: 0, kind: 'start' as const, id }));
    this.update(0);
    return this;
  }
  /** Advance by `dt` seconds (finite, 0..3600), starting and ending systems whose time has come, in time order. */
  update(dt: number): this {
    this.#assert();
    if (typeof dt !== 'number' || !Number.isFinite(dt) || dt < 0 || dt > 3600)
      throw new RangeError('NodeParticleSystem update needs dt of 0..3600 seconds; pass a finite step');
    this.#time += dt;
    for (;;) {
      let next = -1;
      this.#queue.forEach((e, i) => {
        if (e.time <= this.#time && (next < 0 || e.time < this.#queue[next].time)) next = i;
      });
      if (next < 0) break;
      const [event] = this.#queue.splice(next, 1);
      const entry = this.plan.systems.get(event.id)!;
      if (event.kind === 'start') {
        if (this.#started.has(event.id)) continue;
        this.#started.add(event.id);
        this.#live.set(event.id, this.#create(entry.options, event.id) ?? undefined);
        if (entry.duration > 0) this.#queue.push({ time: event.time + entry.duration, kind: 'end', id: event.id });
        for (const t of entry.triggers)
          if (t.on === 'start') this.#queue.push({ time: event.time + t.delay, kind: 'start', id: t.target });
      } else {
        const handle = this.#live.get(event.id);
        this.#live.delete(event.id);
        if (handle?.stop) handle.stop();
        else handle?.dispose?.();
        for (const t of entry.triggers)
          if (t.on === 'end') this.#queue.push({ time: event.time + t.delay, kind: 'start', id: t.target });
      }
    }
    return this;
  }
  #assert() {
    if (this.#disposed) throw new TypeError('NodeParticleSystem is disposed; create a new one');
  }
  #release() {
    for (const handle of this.#live.values()) handle?.dispose?.();
    this.#live.clear();
    this.#started.clear();
    this.#queue = [];
  }
  /** Dispose every effect still running. Safe to call twice. */
  dispose(): void {
    if (this.#disposed) return;
    this.#release();
    this.#disposed = true;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Compile (or parse, then compile) a graph into a set that is ready to `start()`. The caller disposes it. */
export function createNodeSystem(source: string | NodeSystemGraph, options: NodeSystemOptions): NodeParticleSystem {
  const graph = typeof source === 'string' ? parseNodeSystem(source) : source;
  return new NodeParticleSystem(compileNodeSystem(graph, options), options);
}

/** Fetch a saved graph and make a set from it. AbortSignal cancels the request and the build. */
export async function loadNodeSystem(
  url: string | URL,
  options: NodeSystemOptions & { signal?: AbortSignal },
): Promise<NodeParticleSystem> {
  options.signal?.throwIfAborted();
  const response = await fetch(url, { signal: options.signal });
  if (!response.ok)
    throw new VFXNodeSystemError('format', `Node system request returned ${response.status}; check the URL`);
  const text = await response.text();
  options.signal?.throwIfAborted();
  return createNodeSystem(text, options);
}
