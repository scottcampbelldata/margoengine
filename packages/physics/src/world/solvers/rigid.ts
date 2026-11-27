// The rigid kernel as a solver of the physics framework (docs/physics-framework.md, sections 4, 5 and 8): a `Physics` stepped
// by the world. Each step is today's `physics.step()`, so the public API, its events and attachments, and the replay goldens
// are what they were.
//
// Fields. The solver owns `bodies` and `bodyImpulses`:
// - `bodies` (a body set, one record of `BODY_WORDS` f32 per kernel body row): the origin's position, the rotation, the
//   centre of mass, the linear and angular velocity, the inverse mass and the inverse inertia in world axes (its six distinct
//   entries), whether the row is a moving body, and the substeps its last step took (the world's substeps times 2^k for its
//   island's level, `substepLevel`): a held force (`bodyForces`) moves a body by (v + F dt (s + 1) / (2 s m)) dt over a step of
//   s symplectic-Euler substeps, so a solver that holds a load from the body's pose takes it where that pose is energy-neutral
//   (a hull's load at (s - 1) / (2 s) of the step). A reader reads it at the coupling tick.
// - `bodyImpulses` (a body set, `IMPULSE_WORDS` words per row): what other solvers push the bodies with, as a linear impulse
//   (N s) and an angular impulse about the body's centre of mass (N m s), world axes. A load at a point p is the pair
//   (J, (p - c) x J), c the centre of mass in `bodies`: pairs add, so the world sums the contributions by contributor and then
//   by element, and the solver applies the sum at the next step. A point and an impulse would not add.
// - `bodyForces` (a body set, `FORCE_WORDS` words per row): what other solvers hold the bodies with over the next step, as a
//   force (N) and a torque about the centre of mass (N m), world axes, summed as `bodyImpulses` is. The solver adds the sum to
//   the bodies' forces for its next step only and takes it off after, so a push held over a step (a soft body holding up a
//   box, a hull's load) is a force through the step rather than an impulse at its start.
//
// State. The kernel's state is the words its own hash covers (`KernelWorld.stateRanges`), named by column and row capacity
// (`positionX[64]`), in the world's memory when the Physics was made on the world's arena (`new Physics(null, {arena:
// world.arena})`), else in the kernel's own memory, which the regions then name (`Region.memory`, transitional). A
// snapshot restored into a world built with other capacities or another column table is refused before anything is
// written: the regions' names carry the capacities, and their layout version is a fingerprint of the column table.
import { MargoError } from '@margoengine/math/errors';
import type { Physics, PhysicsAttachment } from '../../physics.js';

/** Bits of the kernel's `flags` column (kernel/src/layout.rs): a live row, and the kind bits, 2 for a dynamic body. */
const ALIVE = 1,
  KIND = 6,
  DYNAMIC = 2;
import {
  type FieldDescriptor,
  type Port,
  RATE_LEVELS,
  type RateLevel,
  type Region,
  rateOf,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from '../solver.js';

/** f32 words of a body's record in the `bodies` port. */
export const BODY_WORDS = 25;
/** f64 words of a body's record in the `bodyImpulses` port: linear impulse then angular impulse about the centre of mass. */
export const IMPULSE_WORDS = 6;
/** f64 words of a body's record in the `bodyForces` port: force then torque about the centre of mass. */
export const FORCE_WORDS = 6;
/** The layout version of the `bodies` port (contributors to `bodyImpulses` lay out their own regions as `IMPULSE_WORDS` per row). */
const BODIES_LAYOUT = 2;

/** The `bodies` field: every rigid body's pose, velocity, mass and inertia. */
export const BODIES_FIELD: FieldDescriptor = {
  name: 'bodies',
  kind: 'bodySet',
  quantity: 'bodyState',
  unit: 'm, rad, m/s, rad/s, 1/kg, 1/(kg m^2)',
  centring: 'particle',
};
/** The `bodyImpulses` field: linear and angular impulses other solvers push the bodies with, summed by contributor. */
export const BODY_IMPULSES_FIELD: FieldDescriptor = {
  name: 'bodyImpulses',
  kind: 'bodySet',
  quantity: 'impulse',
  unit: 'N s',
  centring: 'particle',
};

/** The `bodyForces` field: forces and torques other solvers hold the bodies with over the next step, summed by contributor. */
export const BODY_FORCES_FIELD: FieldDescriptor = {
  name: 'bodyForces',
  kind: 'bodySet',
  quantity: 'force',
  unit: 'N',
  centring: 'particle',
};

/** What a {@link RigidSolver} is made from. */
export interface RigidSolverParams {
  /** The world to step. Its `fixedTimestep` must be a framework rate: 1/60, 1/120, ... 1/7680 s. */
  readonly physics: Physics;
  /** Body rows the two ports hold (default the kernel's body capacity at `init`). A world with more bodies refuses to publish. */
  readonly capacity?: number;
}

/** FNV-1a of a kernel's column table (names and element types, in layout order): the layout version of its state regions. */
function columnTableVersion(columns: Record<string, Float32Array | Uint32Array>): number {
  let hash = 0x811c9dc5;
  for (const [name, view] of Object.entries(columns))
    for (const char of `${name}:${view instanceof Float32Array ? 'f' : 'u'};`)
      hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash;
}

/**
 * The rate level whose step is `step` seconds.
 * @throws RangeError for a step no level has, naming the nearest levels.
 */
/**
 * The world's body rows for solver `who` pushing on bodies at kernel rows `rows` (`SolverHost.bodyRows`), checked: every row
 * inside them, and a `capacity` given equal to them. A solver sizes its body-set regions by what this returns.
 * @throws MargoError `state` when the world has not fixed its body rows or a row is past them; RangeError for a `capacity`
 * that is not the world's.
 */
export function bodyRowsOf(host: SolverHost, who: string, rows: readonly number[], capacity?: number): number {
  const n = host.bodyRows();
  if (capacity !== undefined && capacity !== n)
    throw new RangeError(
      `${who}'s capacity of ${capacity} body rows is not the world's ${n}; leave it out: a solver that pushes on bodies covers the world's body rows.`,
    );
  for (const row of rows)
    if (!(row < n))
      throw new MargoError(
        'state',
        `${who} pushes on body row ${row} and the world has ${n} body rows; make the world with {bodyRows: ${row + 1}} or more.`,
      );
  return n;
}

export function rateLevelOf(step: number): RateLevel {
  for (let level = 0; level < RATE_LEVELS; level++)
    if (rateOf(level as RateLevel) * step === 1) return level as RateLevel;
  const hz = 1 / step;
  let below = 0;
  for (let level = 0; level < RATE_LEVELS; level++) if (rateOf(level as RateLevel) <= hz) below = level;
  const above = Math.min(below + 1, RATE_LEVELS - 1);
  throw new RangeError(
    `A fixedTimestep of ${step} s (${hz} steps a second) is not a framework rate; use 1/${rateOf(below as RateLevel)} s (level ${below}) or 1/${rateOf(above as RateLevel)} s (level ${above}).`,
  );
}

/** The rigid kernel as a framework solver. `id` is `'rigid'` unless a world holds more than one. */
export class RigidSolver implements Solver<RigidSolverParams> {
  private physics: Physics | null = null;
  private host: SolverHost | null = null;
  private level: RateLevel = 0;
  private bodies: Region | null = null;
  /**
   * The Physics's step count, one f64, kept as extra state so a snapshot, a restore and the hash carry it: anything clocked
   * by `stepCount * fixedTimestep` (a wind, a sail's gusts, `Physics.advance`) reads the restored time after a seek.
   */
  private clock: Region | null = null;
  /** The count the solver last wrote to `clock`: a restore that changed it is put back into the Physics. */
  private written = 0;
  /**
   * The Physics's stateful attachments (a rod's wake oscillators, `Physics.statefulAttachments`) and their words, one f64
   * region after one another, kept as state so a snapshot, a restore and the hash carry them; `kept` is what the solver last
   * wrote, and a restore that changed the region is put back into the attachments before the next step.
   */
  private holders: readonly PhysicsAttachment[] = [];
  private lengths: number[] = [];
  private attached: Region | null = null;
  private kept = new Float64Array(0);
  private capacity = 0;
  private layout = 0;
  /** The forces and torques `importPorts` added for this tick's step, taken off after it (`FORCE_WORDS` a body row). */
  private held = new Float64Array(0);
  private holding = false;

  constructor(readonly id = 'rigid') {}

  describe(): SolverDescription {
    const level = this.physics ? this.level : 0;
    return {
      id: this.id,
      fields: [
        { field: BODIES_FIELD, access: 'write' },
        { field: BODY_IMPULSES_FIELD, access: 'write' },
        { field: BODY_FORCES_FIELD, access: 'write' },
      ],
      rate: level,
      // Asked after init, which sets the level (describe comes first, before the Physics is known).
      stableRate: () => (this.physics ? this.level : 0),
    };
  }

  init(host: SolverHost, params: RigidSolverParams): void {
    const physics = params?.physics;
    if (!physics || typeof physics.step !== 'function')
      throw new TypeError('A RigidSolver is made from a Physics: world.add(new RigidSolver(), {physics}).');
    this.level = rateLevelOf(physics.fixedTimestep);
    this.physics = physics;
    this.host = host;
    this.layout = columnTableVersion(physics.kernel.columns);
    const wanted = params.capacity ?? physics.kernel.capacity;
    if (!(Number.isInteger(wanted) && wanted > 0))
      throw new RangeError(`A RigidSolver's capacity is a whole number of body rows above 0; got ${wanted}.`);
    // The world's body rows: fixed by this solver (its kernel's capacity, or the capacity given) unless already set.
    const capacity = host.bodyRows(wanted);
    this.capacity = capacity;
    this.bodies = host.allocate('bodies', capacity * BODY_WORDS * 4, 'f32', BODIES_LAYOUT);
    this.clock = host.allocate('stepCount', 8, 'f64', 1);
    this.writeClock(physics.stepCount);
    this.holders = physics.statefulAttachments();
    this.lengths = this.holders.map((holder) => holder.takeState!().length);
    const words = this.lengths.reduce((sum, n) => sum + n, 0);
    this.kept = new Float64Array(words);
    if (words > 0) {
      this.attached = host.allocate('attachmentState', words * 8, 'f64', 1);
      this.writeAttachments();
    }
  }

  /** The attachments' words in the world's memory. */
  private attachmentWords(): Float64Array {
    return new Float64Array(this.host!.memory.buffer, this.attached!.byteOffset, this.kept.length);
  }

  /** Copies each stateful attachment's state into the region, and keeps what was written. */
  private writeAttachments(): void {
    let at = 0;
    for (let i = 0; i < this.holders.length; i++) {
      const state = this.holders[i]!.takeState!();
      if (state.length !== this.lengths[i])
        throw new MargoError(
          'state',
          `An attachment's state changed length from ${this.lengths[i]} to ${state.length} words; keep takeState() one length from the moment it is attached.`,
        );
      this.kept.set(state, at);
      at += state.length;
    }
    if (this.attached) this.attachmentWords().set(this.kept);
  }

  /** The attachments the world was set up with, still the Physics's; a restore since the last step is put back into them. */
  private readAttachments(physics: Physics): void {
    const now = physics.statefulAttachments();
    if (now.length !== this.holders.length || now.some((holder, i) => holder !== this.holders[i]))
      throw new MargoError(
        'state',
        'A stateful attachment (a rod with water loads) was added to or removed from the Physics after it joined the world; attach them first, then world.add(new RigidSolver(), {physics}).',
      );
    if (!this.attached) return;
    const words = this.attachmentWords();
    let changed = false;
    for (let k = 0; k < words.length && !changed; k++) changed = !Object.is(words[k], this.kept[k]);
    if (!changed) return;
    let at = 0;
    for (let i = 0; i < this.holders.length; i++) {
      this.holders[i]!.restoreState!(words.slice(at, at + this.lengths[i]!));
      at += this.lengths[i]!;
    }
    this.kept.set(words);
  }

  private live(): Physics {
    if (!this.physics)
      throw new MargoError('state', 'RigidSolver is not in a world yet; add it with world.add(solver, {physics}).');
    return this.physics;
  }

  step(_context: StepContext, dt: number): void {
    const physics = this.live();
    if (dt !== physics.fixedTimestep)
      throw new MargoError(
        'state',
        `RigidSolver steps ${physics.fixedTimestep} s, and the world asked for ${dt} s; keep the Physics's fixedTimestep as it was added.`,
      );
    // A restore since the last step put another count in the clock: the Physics goes on from it.
    const clock = this.clockWords();
    if (clock[0] !== this.written) physics.stepCount = clock[0]!;
    this.readAttachments(physics);
    physics.step();
    this.writeClock(physics.stepCount);
    this.writeAttachments();
    this.letGo();
  }

  private clockWords(): Float64Array {
    return new Float64Array(this.host!.memory.buffer, this.clock!.byteOffset, 1);
  }

  private writeClock(count: number): void {
    this.clockWords()[0] = count;
    this.written = count;
  }

  /** Takes the forces of `bodyForces` off the bodies again: they hold for one step. */
  private letGo(): void {
    if (!this.holding) return;
    const c = this.live().kernel.columns,
      held = this.held,
      rows = held.length / FORCE_WORDS;
    for (let row = 0; row < rows; row++) {
      const at = row * FORCE_WORDS;
      if (
        held[at] === 0 &&
        held[at + 1] === 0 &&
        held[at + 2] === 0 &&
        held[at + 3] === 0 &&
        held[at + 4] === 0 &&
        held[at + 5] === 0
      )
        continue;
      c.forceX[row] -= held[at]!;
      c.forceY[row] -= held[at + 1]!;
      c.forceZ[row] -= held[at + 2]!;
      c.torqueX[row] -= held[at + 3]!;
      c.torqueY[row] -= held[at + 4]!;
      c.torqueZ[row] -= held[at + 5]!;
    }
    held.fill(0);
    this.holding = false;
  }

  exportPorts(tick: number): readonly Port[] {
    const physics = this.live(),
      kernel = physics.kernel,
      rows = kernel.capacity;
    if (rows > this.capacity)
      throw new MargoError(
        'state',
        `The world has ${rows} body rows and the RigidSolver's ports hold ${this.capacity}; make the solver with a capacity of ${rows} or more.`,
      );
    const out = new Float32Array(this.host!.memory.buffer, this.bodies!.byteOffset, this.capacity * BODY_WORDS),
      c = kernel.columns;
    out.fill(0);
    for (let row = 0; row < rows; row++) {
      const at = row * BODY_WORDS,
        moving = (c.flags![row]! & (ALIVE | KIND)) === (ALIVE | DYNAMIC) ? 1 : 0;
      out[at] = c.positionX[row]!;
      out[at + 1] = c.positionY[row]!;
      out[at + 2] = c.positionZ[row]!;
      out[at + 3] = c.rotationX[row]!;
      out[at + 4] = c.rotationY[row]!;
      out[at + 5] = c.rotationZ[row]!;
      out[at + 6] = c.rotationW[row]!;
      out[at + 7] = c.centerX[row]!;
      out[at + 8] = c.centerY[row]!;
      out[at + 9] = c.centerZ[row]!;
      out[at + 10] = c.linearX[row]!;
      out[at + 11] = c.linearY[row]!;
      out[at + 12] = c.linearZ[row]!;
      out[at + 13] = c.angularX[row]!;
      out[at + 14] = c.angularY[row]!;
      out[at + 15] = c.angularZ[row]!;
      out[at + 16] = moving ? c.inverseMass[row]! : 0;
      if (moving) worldInverseInertia(c, row, out, at + 17);
      out[at + 23] = moving;
      out[at + 24] = moving ? kernel.substeps * (1 << c.substepLevel![row]!) : 0;
    }
    // The world sets the cell of every port to the solver's own.
    return [{ field: BODIES_FIELD.name, region: this.bodies!, tick, cell: [0, 0, 0] }];
  }

  importPorts(_tick: number): void {
    this.importForces();
    const physics = this.live(),
      sum = this.host!.port(BODY_IMPULSES_FIELD.name);
    if (!sum) return;
    const kernel = physics.kernel,
      words = new Float64Array(this.host!.memory.buffer, sum.region.byteOffset, sum.region.byteLength / 8),
      c = kernel.columns,
      rows = Math.min(kernel.capacity, words.length / IMPULSE_WORDS);
    for (let row = 0; row < rows; row++) {
      const at = row * IMPULSE_WORDS;
      let any = false;
      for (let k = 0; k < IMPULSE_WORDS; k++) any ||= words[at + k] !== 0;
      if (!any || (c.flags![row]! & (ALIVE | KIND)) !== (ALIVE | DYNAMIC)) continue;
      kernel.wake(row);
      c.impulseX[row] += words[at]!;
      c.impulseY[row] += words[at + 1]!;
      c.impulseZ[row] += words[at + 2]!;
      c.angularImpulseX[row] += words[at + 3]!;
      c.angularImpulseY[row] += words[at + 4]!;
      c.angularImpulseZ[row] += words[at + 5]!;
    }
  }

  /** Adds the summed `bodyForces` to the moving bodies' forces and torques for the next step, waking them. */
  private importForces(): void {
    const sum = this.host!.port(BODY_FORCES_FIELD.name);
    if (!sum) return;
    const kernel = this.live().kernel,
      words = new Float64Array(this.host!.memory.buffer, sum.region.byteOffset, sum.region.byteLength / 8),
      c = kernel.columns,
      rows = Math.min(kernel.capacity, words.length / FORCE_WORDS);
    if (this.held.length < rows * FORCE_WORDS) {
      const grown = new Float64Array(rows * FORCE_WORDS);
      grown.set(this.held);
      this.held = grown;
    }
    for (let row = 0; row < rows; row++) {
      const at = row * FORCE_WORDS;
      let any = false;
      for (let k = 0; k < FORCE_WORDS; k++) any ||= words[at + k] !== 0;
      if (!any || (c.flags![row]! & (ALIVE | KIND)) !== (ALIVE | DYNAMIC)) continue;
      kernel.wake(row);
      // What the f32 columns took is what comes off after: the difference of two f32 values is exact, so the body keeps what
      // it held before to the bit, where taking off the f64 sum would leave its rounding behind a little more every step.
      const columns = [c.forceX, c.forceY, c.forceZ, c.torqueX, c.torqueY, c.torqueZ];
      for (let k = 0; k < FORCE_WORDS; k++) {
        const column = columns[k]!,
          before = column[row]!;
        column[row] = before + words[at + k]!;
        this.held[at + k]! += column[row]! - before;
      }
      this.holding = true;
    }
  }

  /** The memory a region of the kernel's names: none when the kernel lives in the world's, else its own (transitional). */
  private kernelMemory(): { memory?: WebAssembly.Memory } {
    const { memory } = this.live().kernel;
    return memory === this.host?.memory ? {} : { memory };
  }

  /** The kernel's state words, named by column and row capacity. */
  stateRegions(): readonly Region[] {
    const kernel = this.live().kernel,
      byOffset = new Map<number, string>(),
      memory = this.kernelMemory();
    this.layout = columnTableVersion(kernel.columns);
    for (const [name, view] of Object.entries(kernel.columns)) byOffset.set(view.byteOffset, name);
    let header = 0;
    // A column of no rows holds no state, and shares its offset with the next: it is left out.
    return kernel
      .stateRanges()
      .filter(({ byteLength }) => byteLength > 0)
      .map(({ byteOffset, byteLength }) => {
        const column = byOffset.get(byteOffset),
          name = column === undefined ? `header${header++}` : `${column}[${byteLength / 4}]`;
        return { name, byteOffset, byteLength, type: 'u32' as const, layout: this.layout, ...memory };
      });
  }

  /**
   * What the kernel carries from one step into the next beyond its state: its scratch columns (the island lists a step leaves
   * and the next starts from), the multibody walk stamp and the Physics's step count. Left out of the kernel's own hash, they are still history a
   * restored run needs to go on bit for bit (docs/physics-framework.md, section 8), so they are snapshotted as extra state.
   */
  extraState(): readonly Region[] {
    const kernel = this.live().kernel,
      memory = this.kernelMemory(),
      ranges = kernel.stateRanges(),
      covered = new Set(ranges.map((range) => range.byteOffset)),
      out: Region[] = this.clock ? [this.clock] : [];
    if (this.attached) out.push(this.attached);
    // The stamp is the one word between the header's two state ranges.
    const [first] = ranges;
    if (first)
      out.push({
        name: 'multibodyStamp',
        byteOffset: first.byteOffset + first.byteLength,
        byteLength: 4,
        type: 'u32',
        layout: this.layout,
        ...memory,
      });
    for (const [name, view] of Object.entries(kernel.columns))
      if (view.byteLength > 0 && !covered.has(view.byteOffset))
        out.push({
          name: `${name}[${view.length}]`,
          byteOffset: view.byteOffset,
          byteLength: view.byteLength,
          type: 'u32',
          layout: this.layout,
          ...memory,
        });
    return out;
  }
}

/** The six distinct entries of R diag(inverse inertia) R^T (xx, xy, xz, yy, yz, zz), R the body's rotation times its inertia frame. */
function worldInverseInertia(
  c: Record<string, Float32Array | Uint32Array>,
  row: number,
  out: Float32Array,
  at: number,
): void {
  // q = rotation * inertia frame, as a quaternion product; then the matrix of q, built from products only.
  const ax = c.rotationX![row]!,
    ay = c.rotationY![row]!,
    az = c.rotationZ![row]!,
    aw = c.rotationW![row]!,
    bx = c.inertiaFrameX![row]!,
    by = c.inertiaFrameY![row]!,
    bz = c.inertiaFrameZ![row]!,
    bw = c.inertiaFrameW![row]!,
    x = aw * bx + ax * bw + ay * bz - az * by,
    y = aw * by - ax * bz + ay * bw + az * bx,
    z = aw * bz + ax * by - ay * bx + az * bw,
    w = aw * bw - ax * bx - ay * by - az * bz,
    r00 = 1 - 2 * (y * y + z * z),
    r01 = 2 * (x * y - w * z),
    r02 = 2 * (x * z + w * y),
    r10 = 2 * (x * y + w * z),
    r11 = 1 - 2 * (x * x + z * z),
    r12 = 2 * (y * z - w * x),
    r20 = 2 * (x * z - w * y),
    r21 = 2 * (y * z + w * x),
    r22 = 1 - 2 * (x * x + y * y),
    ix = c.inverseInertiaX![row]!,
    iy = c.inverseInertiaY![row]!,
    iz = c.inverseInertiaZ![row]!;
  out[at] = r00 * r00 * ix + r01 * r01 * iy + r02 * r02 * iz;
  out[at + 1] = r00 * r10 * ix + r01 * r11 * iy + r02 * r12 * iz;
  out[at + 2] = r00 * r20 * ix + r01 * r21 * iy + r02 * r22 * iz;
  out[at + 3] = r10 * r10 * ix + r11 * r11 * iy + r12 * r12 * iz;
  out[at + 4] = r10 * r20 * ix + r11 * r21 * iy + r12 * r22 * iz;
  out[at + 5] = r20 * r20 * ix + r21 * r21 * iy + r22 * r22 * iz;
}
