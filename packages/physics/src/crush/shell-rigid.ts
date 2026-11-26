import { MargoError } from '@margoengine/math/errors';
import { regionWords } from '../world/memory.js';
import type { Cell, Region, SolverHost, StepContext } from '../world/solver.js';
import { BODIES_FIELD, BODY_WORDS, FORCE_WORDS, IMPULSE_WORDS } from '../world/solvers/rigid.js';
import { add, type CrushVector, dot, rowIndex, scale, sub, triple } from './rigid-contact.js';

/** A centered rigid sphere whose contact is resolved against the live shell surface. */
export interface CrushShellSphere {
  readonly body: number;
  /** Sphere radius in metres. Half the shell thickness is added at contact. */
  readonly radius: number;
  /** Effective contact Young modulus in Pa, combining the sphere and sheet materials. */
  readonly contactModulus: number;
}

export interface CrushShellContact {
  /** Integrated impulse applied to the rigid body during the last interval, N·s. */
  readonly impulse: CrushVector;
  /** Endpoint normal compression in metres. */
  readonly compression: number;
  /** Endpoint recoverable interface energy in joules. */
  readonly energy: number;
}

interface SphereSettings {
  readonly body: number;
  readonly radius: number;
  readonly stiffness: number;
}

const SPHERE_WORDS = 20;
const CONTACT_WORDS = 5;

function f64(host: SolverHost, region: Region): Float64Array {
  return regionWords(host.memory, region) as Float64Array;
}

function cellOffset(from: Cell, to: Cell, cellSize: number | undefined): CrushVector {
  const delta = sub(from, to);
  if (cellSize === undefined && delta.some((value) => value !== 0))
    throw new MargoError('state', 'Set cellSize to couple different rigid and shell origin cells.');
  return scale(delta, cellSize ?? 1);
}

/** World bridge for native sphere work, same-tick rigid impulses and replay readings. */
export class ShellRigid {
  readonly work: Region;
  readonly reactions: Region;
  readonly forces: Region;
  readonly readings: Region;
  readonly spheres: readonly SphereSettings[];
  private readonly capacity: number;
  private readonly rigidSubsteps: Uint32Array;

  constructor(
    private readonly host: SolverHost,
    config: readonly CrushShellSphere[],
    thickness: number,
    private readonly cellSize: number | undefined,
  ) {
    this.capacity = host.bodyRows();
    this.rigidSubsteps = new Uint32Array(config.length);
    if (cellSize !== undefined && !(cellSize > 0 && Number.isFinite(cellSize)))
      throw new MargoError('state', 'Use a positive finite shell cell size in metres.');
    const seen = new Set<number>();
    this.spheres = config.map((sphere) => {
      const body = rowIndex(sphere.body, this.capacity);
      if (seen.has(body)) throw new MargoError('state', 'Give each rigid shell sphere a different body row.');
      seen.add(body);
      const radius = sphere.radius + 0.5 * thickness;
      const stiffness = (4 / 3) * sphere.contactModulus * Math.sqrt(sphere.radius);
      if (!(radius > 0 && Number.isFinite(radius) && stiffness > 0 && Number.isFinite(stiffness)))
        throw new MargoError('state', 'Use positive finite radii and contact moduli for rigid shell spheres.');
      return { body, radius, stiffness };
    });
    this.work = host.allocate('shell-sphere-work', SPHERE_WORDS * this.spheres.length * 8, 'f64', 1);
    this.reactions = host.allocate('shell-sphere-reactions', IMPULSE_WORDS * this.capacity * 8, 'f64', 1);
    this.forces = host.allocate('shell-sphere-forces', FORCE_WORDS * this.capacity * 8, 'f64', 1);
    this.readings = host.allocate('shell-sphere-readings', CONTACT_WORDS * this.spheres.length * 8, 'f64', 1);
  }

  stage(context: StepContext, dt: number, velocity: Float64Array, inverseMass: number): number {
    const port = context.inputs.get(BODIES_FIELD.name);
    if (!port || port.tick !== context.tick - 1)
      throw new MargoError(
        'state',
        'Use matching shell and rigid rates and place the shell first in their staggered coupling.',
      );
    if (
      port.region.type !== 'f32' ||
      port.region.layout !== 2 ||
      port.region.byteLength !== this.capacity * BODY_WORDS * 4
    )
      throw new MargoError(
        'state',
        'Use the layout-2 RigidSolver bodies port with the same body capacity as the shell.',
      );
    const bodies = regionWords(port.region.memory ?? this.host.memory, port.region) as Float32Array;
    const work = f64(this.host, this.work);
    const offset = cellOffset(port.cell, context.cell, this.cellSize);
    const gravity = Math.sqrt(dot(this.host.gravity, this.host.gravity));
    let maxNodeSpeedSquared = 0;
    for (let at = 0; at < velocity.length; at += 3) {
      const v = triple(velocity, at);
      maxNodeSpeedSquared = Math.max(maxNodeSpeedSquared, dot(v, v));
    }
    const maxNodeSpeed = Math.sqrt(maxNodeSpeedSquared);
    let maxStep = Number.POSITIVE_INFINITY;
    let rateSquared = 0;
    for (const [i, sphere] of this.spheres.entries()) {
      const at = sphere.body * BODY_WORDS;
      const quaternionNorm = dot(triple(bodies, at + 3), triple(bodies, at + 3)) + bodies[at + 6]! ** 2;
      const massCenter = triple(bodies, at + 7);
      const centerOffset = sub(massCenter, triple(bodies, at));
      if (!(quaternionNorm > 0 && Number.isFinite(quaternionNorm)) || centerOffset.some((value) => value !== 0))
        throw new MargoError(
          'state',
          'Use live centered rigid-body spheres with the center of mass at the local origin.',
        );
      const center = add(massCenter, offset);
      const v = triple(bodies, at + 10);
      const inv = bodies[at + 16]!;
      const steps = bodies[at + 24]!;
      if (inv > 0 && (!Number.isSafeInteger(steps) || steps < 2))
        throw new MargoError('state', 'Use at least two rigid substeps for moving sphere contact.');
      this.rigidSubsteps[i] = inv > 0 ? steps : 0;
      work.set(
        [...center, ...v, inv, sphere.radius, sphere.stiffness, 0, 0, 0, 0, 0, 0, 0, sphere.radius, 0, 0, 0],
        SPHERE_WORDS * i,
      );
      // Hertz's maximum normal tangent over 0 <= compression <= radius.
      const tangent = 1.5 * sphere.stiffness * Math.sqrt(sphere.radius);
      rateSquared += (inv + inverseMass) * tangent;
      const relativeSpeed = Math.sqrt(dot(v, v)) + maxNodeSpeed + 2 * dt * gravity;
      maxStep = Math.min(maxStep, sphere.radius / (4 * relativeSpeed));
    }
    return Math.min(maxStep, 0.5 / Math.sqrt(rateSquared));
  }

  publish(dt: number): void {
    const work = f64(this.host, this.work);
    const reactions = f64(this.host, this.reactions);
    const forces = f64(this.host, this.forces);
    const readings = f64(this.host, this.readings);
    reactions.fill(0);
    forces.fill(0);
    for (const [i, sphere] of this.spheres.entries()) {
      const at = i * SPHERE_WORDS;
      const impulse = triple(work, at + 12);
      const steps = this.rigidSubsteps[i]!;
      if (steps > 0) {
        // Rigid symplectic Euler integrates constant force through s substeps. The
        // force impulse acts at a mean fraction (s+1)/(2s) of the drift interval.
        // Match both total impulse and its first time moment with one held force
        // and one start impulse, using the existing rigid accumulator ports.
        const momentAsImpulse = scale(triple(work, at + 17), 1 / dt);
        const heldImpulse = scale(sub(impulse, momentAsImpulse), (2 * steps) / (steps - 1));
        reactions.set(sub(impulse, heldImpulse), sphere.body * IMPULSE_WORDS);
        forces.set(scale(heldImpulse, 1 / dt), sphere.body * FORCE_WORDS);
      }
      readings.set([...impulse, sphere.radius - work[at + 16]!, work[at + 15]!], i * CONTACT_WORDS);
    }
  }

  read(index: number): CrushShellContact {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.spheres.length)
      throw new MargoError('state', 'Choose the index of a configured shell sphere.');
    const words = f64(this.host, this.readings);
    const at = index * CONTACT_WORDS;
    return { impulse: triple(words, at), compression: words[at + 3]!, energy: words[at + 4]! };
  }
}
