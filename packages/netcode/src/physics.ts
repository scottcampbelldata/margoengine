// Physics worlds in netcode: a deterministic physics world as the state of a rollback game, the difference between two
// snapshots of it, and a server's bodies as the snapshots its clients interpolate. Typed by shape, not by import: any
// world with `takeSnapshot`, `restoreSnapshot`, `step` and `fixedTimestep` (a `Physics` of `@margoengine/physics`) and any
// body with `position`, `rotation` and `linearVelocity` fit, so this entry pulls no physics code into a page.
//
// Rollback (Pusch, the GGPO documentation, ggpo.net; Fiedler, "Deterministic Lockstep", Gaffer On Games, 2014): every peer
// steps the same world from the same inputs, and a peer that learns an input it had guessed wrong loads the world as it
// was before that frame and steps it again. The world is its own state, saved as its snapshot, a copy of the kernel's whole
// block of memory, so a reload is exact and the same inputs give the same bits on every peer.
//
// Snapshot diffs (Fiedler, "Snapshot Compression", Gaffer On Games, 2015, delta against a baseline both ends have): the
// words of two snapshots XORed, the runs of zero words (what did not change) counted and the rest written as they are.
import type { Game } from './game.js';
import { createSnapshot, type Snapshot, SnapshotBuffer } from './interpolation.js';
import type { UntypedSchema } from './schema.js';

/** A physics world as {@link physicsGame} drives it: a `Physics` of `@margoengine/physics` fits. */
export interface RollbackWorld<S extends { readonly bytes: Uint8Array } = { readonly bytes: Uint8Array }> {
  /** The step's length in seconds; the game's tick rate is its inverse. */
  readonly fixedTimestep: number;
  takeSnapshot(): S;
  restoreSnapshot(snapshot: S): unknown;
  step(): unknown;
}

/** Options of {@link physicsGame}. */
export interface PhysicsGameOptions<Input, S extends { readonly bytes: Uint8Array }> {
  /** The world every peer builds the same way before the session starts, with every body it will ever hold. */
  world: RollbackWorld<S>;
  /** The schema with the input struct (the same on every peer). */
  schema: UntypedSchema;
  /** The name of the input struct in `schema`. */
  input: string;
  /** Drives the world for one tick from each player's input (forces, impulses, motor targets), before it steps. */
  apply(inputs: ReadonlyMap<number, Input>, tick: number): void;
}

/** The name the state of a {@link physicsGame} has in its schema. */
export const PHYSICS_STATE = 'PhysicsWorld';

/**
 * A rollback game whose state is a physics world: give it to `RollbackSession` (`@margoengine/netcode/rollback`). Its state is
 * the world's snapshot bytes; each tick loads them into the world, lets `apply` drive it from the players' inputs, steps it once
 * and keeps the snapshot it leaves, so rolling back is loading an older snapshot. Every peer must build the same world in the
 * same order and add or remove no body, collider or joint while the session runs (a snapshot restores into the world it was
 * taken from); keep bodies for players who may join, asleep or out of the way. The tick rate is the world's step rate,
 * `1 / world.fixedTimestep`, a whole number from 1 to 240.
 * @throws RangeError for a world whose step is not a whole tick rate, or a schema without the input struct.
 */
export function physicsGame<Input, S extends { readonly bytes: Uint8Array }>(
  options: PhysicsGameOptions<Input, S>,
): Game<Uint8Array, Input> {
  const { world, schema, input, apply } = options,
    tickRate = Math.round(1 / world.fixedTimestep);
  if (!(tickRate >= 1 && tickRate <= 240) || Math.abs(tickRate * world.fixedTimestep - 1) > 1e-9)
    throw new RangeError(
      `A rollback physics world needs a step of 1 / n seconds for a whole n from 1 to 240 (got ${world.fixedTimestep} s); set fixedTimestep to 1 / 60, say.`,
    );
  if (!schema.names.includes(input))
    throw new RangeError(`The schema has no struct "${input}"; pass the name of its input struct.`);
  // The snapshot as taken, for its lists of rows: the world's bodies, colliders and joints, which a restore checks.
  const template = world.takeSnapshot(),
    size = template.bytes.byteLength,
    checked = (bytes: Uint8Array): Uint8Array => {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size)
        throw new RangeError(
          `A physics state is the ${size} bytes of the world's snapshot (got ${bytes?.byteLength ?? typeof bytes}); the world grew or another world sent it.`,
        );
      return bytes;
    },
    states: UntypedSchema = {
      json: schema.json,
      // A schema with the world's state is another schema: its hash says so.
      hash: (schema.hash ^ 0x5bd1e995 ^ size) >>> 0,
      names: [...schema.names, PHYSICS_STATE],
      encode: (name, value) =>
        name === PHYSICS_STATE ? checked(value as Uint8Array).slice() : schema.encode(name, value),
      decode: (name, bytes) => (name === PHYSICS_STATE ? checked(bytes).slice() : schema.decode(name, bytes)),
      encodeDelta: (name, value, baseline) =>
        name === PHYSICS_STATE
          ? snapshotDiff(checked(baseline as Uint8Array), checked(value as Uint8Array))
          : schema.encodeDelta(name, value, baseline),
      decodeDelta: (name, bytes, baseline) =>
        name === PHYSICS_STATE
          ? applySnapshotDiff(checked(baseline as Uint8Array), bytes)
          : schema.decodeDelta(name, bytes, baseline),
      equals: (name, a, b) =>
        name === PHYSICS_STATE ? sameBytes(a as Uint8Array, b as Uint8Array) : schema.equals(name, a, b),
      clone: (name, value) =>
        name === PHYSICS_STATE ? checked(value as Uint8Array).slice() : schema.clone(name, value),
      // A world is not blended: it steps to the newer one.
      interpolate: (name, a, b, t) =>
        name === PHYSICS_STATE ? ((t >= 1 ? b : a) as Uint8Array).slice() : schema.interpolate(name, a, b, t),
    };
  return {
    schema: states,
    stateType: PHYSICS_STATE,
    inputType: input,
    tickRate,
    tickMs: 1000 / tickRate,
    initial: () => template.bytes.slice(),
    step(state, inputs, tick) {
      world.restoreSnapshot({ ...template, bytes: checked(state) });
      apply(inputs, tick);
      world.step();
      state.set(world.takeSnapshot().bytes);
    },
    // The world holds every player's body from the start; joining and leaving change nothing in it.
    join() {},
    leave() {},
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Appends `value` as an unsigned LEB128 varint. */
function varint(out: number[], value: number): void {
  while (value >= 0x80) {
    out.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value);
}

/**
 * The difference from snapshot `base` to snapshot `next` (bytes of the same length): for each run, the count of 32-bit words
 * that did not change and of those that did, as varints, then the changed words XORed with the base's. What stood still costs
 * almost nothing, so a world where a few bodies move sends a few hundred bytes for what is a megabyte whole.
 * {@link applySnapshotDiff} undoes it exactly.
 * @throws RangeError for snapshots of different lengths.
 */
export function snapshotDiff(base: Uint8Array, next: Uint8Array): Uint8Array {
  if (base.byteLength !== next.byteLength)
    throw new RangeError(
      `A snapshot diff needs two snapshots of one world, the same length (got ${base.byteLength} and ${next.byteLength} bytes).`,
    );
  const out: number[] = [],
    length = base.byteLength,
    words = length >>> 2,
    word = (bytes: Uint8Array, i: number): number =>
      (bytes[4 * i]! | (bytes[4 * i + 1]! << 8) | (bytes[4 * i + 2]! << 16) | (bytes[4 * i + 3]! << 24)) >>> 0;
  varint(out, length);
  let i = 0;
  while (i < words) {
    let still = 0;
    while (i + still < words && word(base, i + still) === word(next, i + still)) still++;
    let moved = 0;
    while (i + still + moved < words && word(base, i + still + moved) !== word(next, i + still + moved)) moved++;
    varint(out, still);
    varint(out, moved);
    for (let k = 0; k < moved; k++) {
      const x = (word(base, i + still + k) ^ word(next, i + still + k)) >>> 0;
      out.push(x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, x >>> 24);
    }
    i += still + moved;
  }
  // Bytes past the last whole word, XORed.
  for (let b = words * 4; b < length; b++) out.push(base[b]! ^ next[b]!);
  return Uint8Array.from(out);
}

/**
 * The snapshot `diff` ({@link snapshotDiff}) makes of `base`: a new array, `base` untouched.
 * @throws RangeError for a diff of another length of snapshot, or one that is cut short or runs past the end.
 */
export function applySnapshotDiff(base: Uint8Array, diff: Uint8Array): Uint8Array {
  let at = 0;
  const read = (): number => {
    let value = 0,
      scale = 1;
    for (;;) {
      if (at >= diff.byteLength) throw new RangeError('This snapshot diff is cut short; send the whole diff.');
      const byte = diff[at++]!;
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 128;
    }
  };
  const length = read();
  if (length !== base.byteLength)
    throw new RangeError(
      `This diff is of a ${length} byte snapshot, not of this ${base.byteLength} byte one; apply it to the baseline it was made from.`,
    );
  const out = base.slice(),
    words = length >>> 2;
  let i = 0;
  while (i < words) {
    const still = read(),
      moved = read();
    i += still;
    if (i + moved > words || at + 4 * moved > diff.byteLength)
      throw new RangeError(
        'This snapshot diff runs past its snapshot; it was made from another baseline or is damaged.',
      );
    for (let k = 0; k < moved; k++, i++) for (let b = 0; b < 4; b++) out[4 * i + b] = out[4 * i + b]! ^ diff[at++]!;
  }
  for (let b = words * 4; b < length; b++) {
    if (at >= diff.byteLength) throw new RangeError('This snapshot diff is cut short; send the whole diff.');
    out[b] = out[b]! ^ diff[at++]!;
  }
  if (at !== diff.byteLength) throw new RangeError('This snapshot diff has bytes past its end; send it as made.');
  return out;
}

/** A body as {@link bodyStates} reads it: a `PhysicsBody` of `@margoengine/physics` fits. */
export interface StateBody {
  readonly position: ArrayLike<number>;
  readonly rotation: ArrayLike<number>;
  readonly linearVelocity: ArrayLike<number>;
}

/** One body's pose and speed in a server's state: position, rotation (x, y, z, w) and velocity. */
export interface BodyState {
  px: number;
  py: number;
  pz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  vx: number;
  vy: number;
  vz: number;
}

/**
 * The fields of a {@link BodyState}, for a struct of a schema (`defineSchema({types: {Body: BODY_STATE_FIELDS, State: {bodies: {type: 'map',
 * of: 'Body'}}}})`): positions and speeds as `f32`, rotations as `f32` too (a quaternion's parts are below 1, so they keep about
 * seven digits).
 */
export const BODY_STATE_FIELDS = {
  px: 'f32',
  py: 'f32',
  pz: 'f32',
  qx: 'f32',
  qy: 'f32',
  qz: 'f32',
  qw: 'f32',
  vx: 'f32',
  vy: 'f32',
  vz: 'f32',
} as const;

/**
 * A server's bodies as state for its clients (`GameServer` sends it, as deltas against what each client has): `bodies` gives
 * each an id, and the result maps each id to its {@link BodyState}, written into `out` when given (entries of ids no longer
 * given are removed).
 */
export function bodyStates(
  bodies: Iterable<readonly [number, StateBody]>,
  out: Map<number, BodyState> = new Map(),
): Map<number, BodyState> {
  const seen = new Set<number>();
  for (const [id, body] of bodies) {
    const p = body.position,
      q = body.rotation,
      v = body.linearVelocity,
      state = out.get(id) ?? ({} as BodyState);
    state.px = p[0]!;
    state.py = p[1]!;
    state.pz = p[2]!;
    state.qx = q[0]!;
    state.qy = q[1]!;
    state.qz = q[2]!;
    state.qw = q[3]!;
    state.vx = v[0]!;
    state.vy = v[1]!;
    state.vz = v[2]!;
    out.set(id, state);
    seen.add(id);
  }
  for (const id of [...out.keys()]) if (!seen.has(id)) out.delete(id);
  return out;
}

/** A body a client moves to where the server's was: a kinematic `PhysicsBody` fits (or anything with these two). */
export interface ProxyBody {
  setNextPosition(position: readonly [number, number, number]): unknown;
  setNextRotation(rotation: readonly [number, number, number, number]): unknown;
}

/** Options of {@link BodyInterpolator}. */
export interface BodyInterpolatorOptions {
  /** Snapshots kept a body (default 32). */
  capacity?: number;
  /** Most seconds a body is carried on past its newest snapshot by its velocity (default 0.25). */
  maxPrediction?: number;
}

/**
 * A client's view of a server's bodies: {@link BodyInterpolator.push} each state the server sends, with its time, and
 * {@link BodyInterpolator.sample} at the time you draw (the server's time less an interpolation delay a little over its send
 * interval). Each body plays through a `SnapshotBuffer`: Hermite positions from the positions and velocities, slerped
 * rotations, and a bounded run past the newest (Fiedler, "Snapshot Interpolation", Gaffer On Games, 2014). A body missing
 * from a state is dropped.
 */
export class BodyInterpolator {
  private readonly buffers = new Map<number, SnapshotBuffer>();
  private readonly outputs = new Map<number, Snapshot>();
  private readonly position = new Float64Array(3);
  private readonly rotation = new Float64Array(4);
  private readonly velocity = new Float64Array(3);
  constructor(private readonly options: BodyInterpolatorOptions = {}) {
    new SnapshotBuffer(options.capacity ?? 32, options.maxPrediction ?? 0.25);
  }
  /** The ids it holds. */
  get ids(): number[] {
    return [...this.buffers.keys()];
  }
  /** Takes the server's bodies at `time` seconds. Returns how many states it took (a repeated or late one is skipped). */
  push(time: number, states: ReadonlyMap<number, BodyState>): number {
    let taken = 0;
    for (const id of [...this.buffers.keys()])
      if (!states.has(id)) {
        this.buffers.delete(id);
        this.outputs.delete(id);
      }
    for (const [id, s] of states) {
      let buffer = this.buffers.get(id);
      if (!buffer) {
        buffer = new SnapshotBuffer(this.options.capacity ?? 32, this.options.maxPrediction ?? 0.25);
        this.buffers.set(id, buffer);
      }
      this.position.set([s.px, s.py, s.pz]);
      this.rotation.set([s.qx, s.qy, s.qz, s.qw]);
      this.velocity.set([s.vx, s.vy, s.vz]);
      if (buffer.push(time, this.position, this.rotation, this.velocity)) taken++;
    }
    return taken;
  }
  /** Where each body is at `time` seconds: its position, rotation and velocity, by id (each a reused snapshot). */
  sample(time: number): Map<number, Snapshot> {
    const out = new Map<number, Snapshot>();
    for (const [id, buffer] of this.buffers) {
      let snapshot = this.outputs.get(id);
      if (!snapshot) {
        snapshot = createSnapshot();
        this.outputs.set(id, snapshot);
      }
      if (buffer.sample(time, snapshot)) out.set(id, snapshot);
    }
    return out;
  }
  /** Moves each proxy to where its body is at `time` seconds, through the kinematic targets of its next step. */
  apply(time: number, proxies: ReadonlyMap<number, ProxyBody>): this {
    for (const [id, s] of this.sample(time)) {
      const proxy = proxies.get(id);
      if (!proxy) continue;
      proxy.setNextPosition([s.position[0]!, s.position[1]!, s.position[2]!]);
      proxy.setNextRotation([s.rotation[0]!, s.rotation[1]!, s.rotation[2]!, s.rotation[3]!]);
    }
    return this;
  }
}
