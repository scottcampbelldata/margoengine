/// <reference lib="esnext.disposable" preserve="true" />
// One rigid body per instance of an instanced mesh, the instance index naming the body (three.js's InstancedMesh physics
// examples, Babylon's thin instances). The bodies are ordinary bodies of the world; after each sync their interpolated
// poses go to the instance matrices in one write, so thousands of bodies are one draw call. Off the step path: `Math` is
// allowed, as in sync.ts (a render frame may differ between machines, the simulation never does).
import { MargoError } from '@margoengine/math/errors';
import type { BodyOptions, PhysicsBody } from './body.js';
import type { Physics, PhysicsAttachment } from './physics.js';
import { matrixRotation, matrixScale } from './transform.js';

/**
 * What {@link InstancedBodies} draws into: an instanced mesh whose `instances` hold one row of 24 floats per instance, the
 * first 16 a column-major matrix. `createInstancedMesh` of `@margoengine/materials` gives one.
 */
export interface InstancedTarget {
  readonly instances: {
    readonly data: Float32Array;
    readonly capacity: number;
    count: number;
    setMatrices(start: number, matrices: ArrayLike<number>): unknown;
  };
}

/** Options of {@link InstancedBodies}: every option of `physics.addBody` but the pose, which each instance's matrix gives. */
export interface InstancedBodiesOptions extends Omit<BodyOptions, 'position' | 'rotation' | 'follow'> {
  /** The collider of every body, in its own frame; required, as an instanced mesh has no geometry the physics reads. */
  colliders: NonNullable<BodyOptions['colliders']>;
  /** Bodies for the first `count` instances (default the mesh's `instances.count`). */
  count?: number;
}

const HELP = ' See https://margoengine.com/errors#physics-instances';
const fault = (code: 'unsupported' | 'state', message: string): MargoError => new MargoError(code, message + HELP);

/**
 * One body per instance of `mesh`: `bodies[i]` (or `body(i)`) moves instance `i`. Each body starts at its instance's
 * matrix (position and rotation; the instance's scale is kept for drawing and never given to the collider), and after
 * every sync the bodies' poses, interpolated as a mesh body's are, are written to the instance matrices in one
 * `setMatrices` call, skipped while every body sleeps. Instance matrices are world poses, so keep `mesh.root` at the
 * identity. `remove()` (or `using`) removes the bodies and stops writing.
 * @throws MargoError (code `unsupported`, linking margoengine.com/errors#physics-instances) for a mesh without instances,
 * a count past them or no colliders.
 */
export class InstancedBodies implements PhysicsAttachment {
  /** The body of each instance, by instance index. */
  readonly bodies: readonly PhysicsBody[];
  private readonly scales: Float64Array;
  private readonly matrices: Float32Array;
  private released = false;
  /** True until a write after every body fell asleep, so the resting poses land once. */
  private moving = true;

  constructor(
    private readonly physics: Physics,
    readonly mesh: InstancedTarget,
    options: InstancedBodiesOptions,
  ) {
    const instances = mesh?.instances;
    if (!instances || !(instances.data instanceof Float32Array) || typeof instances.setMatrices !== 'function')
      throw fault('unsupported', 'InstancedBodies needs an instanced mesh; make one with createInstancedMesh.');
    const count = options?.count ?? instances.count;
    if (!Number.isInteger(count) || count < 1 || count > instances.capacity)
      throw fault(
        'unsupported',
        `InstancedBodies count must be a whole number from 1 to the mesh's ${instances.capacity}.`,
      );
    if (options.colliders === undefined || (Array.isArray(options.colliders) && !options.colliders.length))
      throw fault(
        'unsupported',
        "InstancedBodies needs colliders, such as {shape: 'box', halfExtents: [0.5, 0.5, 0.5]}.",
      );
    const { count: _count, ...body } = options,
      rotation = [0, 0, 0, 1],
      scale = [1, 1, 1],
      bodies: PhysicsBody[] = [];
    this.scales = new Float64Array(count * 3);
    this.matrices = new Float32Array(count * 16);
    try {
      for (let i = 0; i < count; i++) {
        const m = instances.data.subarray(i * 24, i * 24 + 16);
        matrixRotation(m, rotation);
        matrixScale(m, scale);
        this.scales.set(scale, i * 3);
        bodies.push(
          physics.addBody(null, {
            ...body,
            position: [m[12]!, m[13]!, m[14]!],
            rotation: [rotation[0]!, rotation[1]!, rotation[2]!, rotation[3]!],
          }),
        );
      }
    } catch (error) {
      for (const b of bodies) physics.removeBody(b);
      throw error;
    }
    this.bodies = bodies;
    physics.attach(this);
  }

  /** The body of instance `index`. */
  body(index: number): PhysicsBody {
    const body = this.bodies[index];
    if (!Number.isInteger(index) || !body)
      throw fault('unsupported', `Instance index must be a whole number from 0 to ${this.bodies.length - 1}.`);
    return body;
  }

  /** @internal Writes every body's interpolated pose to its instance matrix. */
  afterSync(): void {
    if (this.released) return;
    const { bodies, matrices, scales } = this,
      alpha = this.physics.alpha;
    let awake = false;
    for (let i = 0; i < bodies.length; i++) {
      const body = bodies[i]!;
      if (!body.valid) continue;
      if (!body.sleeping) awake = true;
      const p = body.pose,
        t = alpha;
      // Position lerp and shortest-arc normalised lerp of the two step rotations.
      const x = p[0]! + (p[7]! - p[0]!) * t,
        y = p[1]! + (p[8]! - p[1]!) * t,
        z = p[2]! + (p[9]! - p[2]!) * t,
        sign = p[3]! * p[10]! + p[4]! * p[11]! + p[5]! * p[12]! + p[6]! * p[13]! < 0 ? -1 : 1;
      let qx = p[3]! + (sign * p[10]! - p[3]!) * t,
        qy = p[4]! + (sign * p[11]! - p[4]!) * t,
        qz = p[5]! + (sign * p[12]! - p[5]!) * t,
        qw = p[6]! + (sign * p[13]! - p[6]!) * t;
      const n = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
      qx *= n;
      qy *= n;
      qz *= n;
      qw *= n;
      const sx = scales[i * 3]!,
        sy = scales[i * 3 + 1]!,
        sz = scales[i * 3 + 2]!,
        o = i * 16;
      matrices[o] = (1 - 2 * (qy * qy + qz * qz)) * sx;
      matrices[o + 1] = 2 * (qx * qy + qz * qw) * sx;
      matrices[o + 2] = 2 * (qx * qz - qy * qw) * sx;
      matrices[o + 3] = 0;
      matrices[o + 4] = 2 * (qx * qy - qz * qw) * sy;
      matrices[o + 5] = (1 - 2 * (qx * qx + qz * qz)) * sy;
      matrices[o + 6] = 2 * (qy * qz + qx * qw) * sy;
      matrices[o + 7] = 0;
      matrices[o + 8] = 2 * (qx * qz + qy * qw) * sz;
      matrices[o + 9] = 2 * (qy * qz - qx * qw) * sz;
      matrices[o + 10] = (1 - 2 * (qx * qx + qy * qy)) * sz;
      matrices[o + 11] = 0;
      matrices[o + 12] = x;
      matrices[o + 13] = y;
      matrices[o + 14] = z;
      matrices[o + 15] = 1;
    }
    if (!awake && !this.moving) return;
    this.moving = awake;
    this.mesh.instances.setMatrices(0, matrices);
  }

  /** @internal A body taken out by hand wakes the write once, so its instance keeps its last pose. */
  bodyRemoved(body: PhysicsBody): void {
    if (this.bodies.includes(body)) this.moving = true;
  }

  /** Removes every body of the instances and stops writing their matrices. */
  remove(): void {
    if (this.released) return;
    this.released = true;
    this.physics.detach(this);
    for (const body of this.bodies) if (body.valid) this.physics.removeBody(body);
  }

  /** @internal */
  dispose(): void {
    this.released = true;
  }

  [Symbol.dispose](): void {
    this.remove();
  }
}
