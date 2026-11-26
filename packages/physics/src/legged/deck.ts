import type { Bed, BedSample } from '@margoengine/math/fields';
import type { GroundAnimalContact } from '../locomotion/index.js';
import type { Cell, Port, Region, SolverHost } from '../world/solver.js';
import { BODY_WORDS, IMPULSE_WORDS } from '../world/solvers/rigid.js';

type V = readonly [number, number, number];
type MutableV = [number, number, number];
type Q = readonly [number, number, number, number];
const UP: V = [0, 1, 0];
const X: V = [1, 0, 0];
const Z: V = [0, 0, 1];

const cross = (a: V, b: V): MutableV => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function rotate(q: Q, x: V): MutableV {
  const axis: V = [q[0], q[1], q[2]];
  const v = cross(axis, x);
  const twice: V = [2 * v[0], 2 * v[1], 2 * v[2]];
  const w = cross(axis, twice);
  return [x[0] + q[3] * twice[0] + w[0], x[1] + q[3] * twice[1] + w[1], x[2] + q[3] * twice[2] + w[2]];
}

/** A flat rectangular support rigidly attached to one actual RigidSolver body. */
export interface LeggedDeck {
  /** Row of the body defining the support. Register the rigid solver before the legs. */
  readonly body: number;
  /** Full width along the body's local X, m. */
  readonly width: number;
  /** Full depth along the body's local Z, m. */
  readonly depth: number;
  /** Top surface along the body's local Y, m relative to its origin. */
  readonly top: number;
}

export class DeckBed implements Bed {
  readonly columns = 1;
  readonly rows = 1;
  readonly width: number;
  readonly depth: number;
  private current: Cell;
  private origin: MutableV = [0, 0, 0];
  private normal: MutableV = [0, 1, 0];
  private axisX: MutableV = [1, 0, 0];
  private axisZ: MutableV = [0, 0, 1];
  private massCentre: MutableV = [0, 0, 0];
  private linear: MutableV = [0, 0, 0];
  private angular: MutableV = [0, 0, 0];
  private values: MutableV = [0, 0, 0];
  private armed = false;

  constructor(
    private readonly geometry: LeggedDeck,
    private readonly cellSize: number,
    cell: Cell,
    private readonly fallback: Bed | undefined,
    private readonly height: number,
  ) {
    if (
      !Number.isInteger(geometry.body) ||
      geometry.body < 0 ||
      !Number.isFinite(geometry.top) ||
      !(geometry.width > 0 && Number.isFinite(geometry.width)) ||
      !(geometry.depth > 0 && Number.isFinite(geometry.depth))
    )
      throw new RangeError('Pass a body row, positive finite deck dimensions and a top offset in metres.');
    this.width = geometry.width;
    this.depth = geometry.depth;
    this.current = cell;
  }

  get cell(): Cell {
    return this.current;
  }

  get centre(): readonly [number, number] {
    return [this.origin[0], this.origin[2]];
  }

  get elevations(): ArrayLike<number> {
    const [x, z] = this.centre;
    return [
      this.plane(x - this.width / 2, z - this.depth / 2),
      this.plane(x - this.width / 2, z + this.depth / 2),
      this.plane(x + this.width / 2, z - this.depth / 2),
      this.plane(x + this.width / 2, z + this.depth / 2),
    ];
  }

  /** Copies the public body row, returning its capacity without retaining a memory view. */
  refresh(host: SolverHost, port: Port | undefined, cell: Cell): number {
    if (!port || port.region.type !== 'f32' || port.region.layout !== 2 || port.region.byteLength % (4 * BODY_WORDS))
      throw new RangeError('Register a RigidSolver with its version-2 bodies field before adding a legged deck.');
    const capacity = port.region.byteLength / (4 * BODY_WORDS);
    if (this.geometry.body >= capacity) throw new RangeError('Set the deck body to a row in the rigid bodies field.');
    const source = new Float32Array(
      (port.region.memory ?? host.memory).buffer,
      port.region.byteOffset,
      capacity * BODY_WORDS,
    );
    const at = this.geometry.body * BODY_WORDS;
    const shift = (axis: 0 | 1 | 2) => (port.cell[axis] - cell[axis]) * this.cellSize;
    const q: Q = [source[at + 3]!, source[at + 4]!, source[at + 5]!, source[at + 6]!];
    const size = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (!(size > 0) || !Number.isFinite(size))
      throw new RangeError('Choose a live rigid body row with a unit orientation for the deck.');
    const unit: Q = [q[0] / size, q[1] / size, q[2] / size, q[3] / size];
    this.normal = rotate(unit, UP);
    this.axisX = rotate(unit, X);
    this.axisZ = rotate(unit, Z);
    this.current = cell;
    this.armed = this.normal[1] > 0;
    for (const axis of [0, 1, 2] as const) {
      this.origin[axis] = source[at + axis]! + shift(axis) + this.geometry.top * this.normal[axis];
      this.massCentre[axis] = source[at + 7 + axis]! + shift(axis);
      this.linear[axis] = source[at + 10 + axis]!;
      this.angular[axis] = source[at + 13 + axis]!;
    }
    return capacity;
  }

  private plane(x: number, z: number): number {
    const n = this.normal;
    const [cx, cy, cz] = this.origin;
    return this.armed ? cy - (n[0] * (x - cx) + n[2] * (z - cz)) / n[1] : this.height;
  }

  private covers(x: number, z: number, elevation: number): boolean {
    if (!this.armed) return false;
    const d: V = [x - this.origin[0], elevation - this.origin[1], z - this.origin[2]];
    return Math.abs(dot(d, this.axisX)) <= this.width / 2 && Math.abs(dot(d, this.axisZ)) <= this.depth / 2;
  }

  sample(x: number, z: number, out: BedSample = { elevation: 0, normal: [0, 1, 0] }): BedSample {
    const level = this.plane(x, z);
    if (this.covers(x, z, level)) {
      out.elevation = level;
      [out.normal[0], out.normal[1], out.normal[2]] = this.normal;
    } else if (this.fallback) {
      const [dx, dy, dz] = this.cell.map((value, axis) => (value - this.fallback!.cell[axis]!) * this.cellSize);
      const floor = this.fallback.sample(x + dx!, z + dz!, out);
      out.elevation = floor.elevation - dy!;
      [out.normal[0], out.normal[1], out.normal[2]] = floor.normal;
    } else {
      out.elevation = this.height;
      [out.normal[0], out.normal[1], out.normal[2]] = UP;
    }
    return out;
  }

  /** Approximate support point velocity, at the projected COM for this body's stance feet. */
  velocity(x: number, z: number): V {
    const y = this.plane(x, z);
    if (!this.covers(x, z, y)) return [0, 0, 0];
    const rotation = cross(this.angular, [x - this.massCentre[0], y - this.massCentre[1], z - this.massCentre[2]]);
    for (const axis of [0, 1, 2] as const) this.values[axis] = this.linear[axis] + rotation[axis];
    return this.values;
  }

  /** Opposite of the stance impulse and couple, in the rigid body's centre-of-mass frame. */
  react(impulses: Float64Array, contact: GroundAnimalContact, dt: number): void {
    const [x, y, z] = contact.position;
    if (!this.covers(x, z, this.plane(x, z))) return;
    const impulse: V = [-contact.force[0] * dt, -contact.force[1] * dt, -contact.force[2] * dt];
    const arm: V = [x - this.massCentre[0], y - this.massCentre[1], z - this.massCentre[2]];
    const torque = cross(arm, impulse);
    const at = this.geometry.body * IMPULSE_WORDS;
    for (const axis of [0, 1, 2] as const) {
      impulses[at + axis] = impulses[at + axis]! + impulse[axis];
      impulses[at + axis + 3] = impulses[at + axis + 3]! + torque[axis] - dt * contact.couple[axis];
    }
  }

  port(region: Region, tick: number): Port {
    return { field: 'bodyImpulses', region, tick, cell: this.cell };
  }
}
