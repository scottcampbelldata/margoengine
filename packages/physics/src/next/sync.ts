// The mesh side of the own solver: where a body starts, and writing interpolated poses back. Off the step path, so `Math`
// is allowed here and only here: a render frame may differ between machines, the simulation never does.
import type { EngineKernel, Mesh } from '@margoengine/core';
import { Mesh as CoreMesh, meshRuntime, type Engine } from '@margoengine/core/extension';
import { invertMatrix } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';
import type { KernelWorld } from '../kernel.js';
import { eulerToQuat, type Quat, type Vec3 } from '../math.js';
import { depthOf, parentOf } from '../mesh-fit.js';
import { matrixRotation, matrixScale, worldMatrix, type TransformStoreLike } from '../transform.js';
import type { PhysicsBody } from './body.js';

/** Where a body on `mesh` starts. A child mesh gives its world pose, and its world scale for fitting colliders. */
export function meshPose(mesh: Mesh, engine: EngineKernel | null): { position: Vec3; rotation: Quat; fitScale?: [number, number, number] } {
  mesh.check();
  if (mesh instanceof CoreMesh && engine && meshRuntime(mesh).engine !== engine)
    throw new TypeError('Physics mesh belongs to another engine; add meshes from the engine this Physics is attached to.');
  if (parentOf(mesh) === -1)
    return {
      position: [mesh.position.x, mesh.position.y, mesh.position.z],
      rotation: eulerToQuat(mesh.rotation.x, mesh.rotation.y, mesh.rotation.z),
    };
  if (!(mesh instanceof CoreMesh))
    throw new MargoError('state', 'Non-core physics bodies need root-level meshes; use a core Mesh for child meshes.');
  const runtime = meshRuntime(mesh),
    pose = worldMatrix(runtime.engine.store, runtime.id, new Float64Array(16)),
    rotation: [number, number, number, number] = [0, 0, 0, 1];
  matrixRotation(pose, rotation);
  return {
    position: [pose[12], pose[13], pose[14]],
    rotation,
    fitScale: matrixScale(pose, [1, 1, 1]) as [number, number, number],
  };
}

/**
 * Writes bodies' poses to their meshes, reading the kernel's columns directly. It walks the kernel's awake list, not
 * every body: a sleeping or fixed body costs nothing unless it was moved by hand, was still moving when last written
 * (one final write at rest), sits on a child mesh (its parent may move) or its mesh just gained a parent (one Int32 read
 * of the store's parents a resting core body finds that). Core meshes at the root get one `engine.writePoses` a sync.
 * Allocates nothing per frame once its arrays fit the scene.
 */
export class MeshSync {
  private readonly nested: PhysicsBody[] = [];
  /** Bodies with a mesh, by kernel row: the awake list names rows. */
  private readonly rows: (PhysicsBody | undefined)[] = [];
  /** Core mesh id by row, -1 for none: the parent check of resting bodies reads the store's `parents` through it. */
  private meshIds = new Int32Array(0);
  /** The sync that last looked at each row, so a body named twice in one sync is written once. */
  private seen = new Uint32Array(0);
  private syncs = 0;
  /** The store of the core meshes while they all share one; `mixed` once they do not (the check then asks each mesh). */
  private store?: TransformStoreLike;
  private mixed = false;
  /** Bodies on meshes that are not core meshes: looked at every sync, as they have no slot in a store. */
  private readonly others = new Set<PhysicsBody>();
  /** Bodies to look at in the next sync whatever the awake list says, and the spare list it swaps with. */
  private pending: PhysicsBody[] = [];
  private spare: PhysicsBody[] = [];
  /** Bodies whose mesh was gone, removed once the walk is over: removing a body changes the awake list. */
  private readonly gone: PhysicsBody[] = [];
  /** One `writePoses` batch: mesh ids and x y z qx qy qz qw rows of core root meshes of `target`. */
  private ids = new Int32Array(64);
  private poses = new Float64Array(64 * 7);
  private batched = 0;
  private target?: Engine;
  private readonly out = [0, 0, 0, 1];
  private readonly position: [number, number, number] = [0, 0, 0];
  private readonly parentScratch = new Float64Array(16);
  private readonly inverseScratch = new Float64Array(16);
  private readonly parentRotation = [0, 0, 0, 1];
  private alpha = 1;

  /** @param removeBody Called for a body whose mesh is gone. */
  constructor(
    private readonly kernel: Pick<KernelWorld, 'columns' | 'awakeCount'>,
    private readonly removeBody: (body: PhysicsBody) => void,
  ) {}

  /** A body with a mesh joins: it is looked at in the next sync. */
  add(body: PhysicsBody): void {
    const { mesh, row } = body;
    if (!mesh) return;
    if (row >= this.seen.length) {
      const size = Math.max(64, row * 2 + 2),
        seen = new Uint32Array(size),
        ids = new Int32Array(size).fill(-1);
      seen.set(this.seen);
      ids.set(this.meshIds);
      this.seen = seen;
      this.meshIds = ids;
    }
    this.rows[row] = body;
    if (mesh instanceof CoreMesh) {
      const { engine, id } = meshRuntime(mesh);
      this.meshIds[row] = id;
      if ((this.store ??= engine.store) !== engine.store) this.mixed = true;
    } else this.others.add(body);
    this.pending.push(body);
  }
  /** A body leaves. */
  remove(body: PhysicsBody): void {
    if (this.rows[body.row] !== body) return;
    this.rows[body.row] = undefined;
    this.meshIds[body.row] = -1;
    this.others.delete(body);
  }
  /** A body was placed by hand or changed type: looked at in the next sync. */
  mark(body: PhysicsBody): void {
    if (body.mesh) this.pending.push(body);
  }

  /** Writes every body that moved, at `alpha` from the last step's start to its end, parents before their children. */
  write(alpha: number): void {
    this.alpha = alpha;
    const { nested, rows, kernel, gone } = this,
      { awake } = kernel.columns,
      list = this.pending,
      sync = ++this.syncs;
    this.pending = this.spare;
    nested.length = 0;
    for (let i = 0, count = kernel.awakeCount; i < count; i++) {
      const body = rows[awake[i]];
      if (body) this.visit(body, sync);
    }
    for (let i = 0; i < list.length; i++) if (list[i].valid) this.visit(list[i], sync);
    list.length = 0;
    this.spare = list;
    this.others.forEach(this.other);
    // A resting body whose mesh just gained a parent is written as a child from now on.
    const { meshIds, seen, store } = this;
    if (this.mixed) {
      for (let row = 0; row < meshIds.length; row++)
        if (meshIds[row] >= 0 && seen[row] !== sync && parentOf(rows[row]!.mesh!) !== -1) this.visit(rows[row]!, sync);
    } else if (store) {
      const { parents } = store;
      for (let row = 0; row < meshIds.length; row++)
        if (meshIds[row] >= 0 && parents[meshIds[row]] !== -1 && seen[row] !== sync) this.visit(rows[row]!, sync);
    }
    // Roots first: a child's pose is relative to its parent's current world transform.
    this.flush();
    for (let i = 1; i < nested.length; i++) {
      const body = nested[i];
      let j = i - 1;
      for (; j >= 0 && nested[j].depth > body.depth; j--) nested[j + 1] = nested[j];
      nested[j + 1] = body;
    }
    for (let i = 0; i < nested.length; i++) this.writeBody(nested[i]);
    nested.length = 0;
    for (let i = 0; i < gone.length; i++) this.removeBody(gone[i]);
    gone.length = 0;
  }

  /** True when the last step left the body where it was. */
  private still(row: number): boolean {
    const c = this.kernel.columns;
    return (
      c.positionX[row] === c.previousX[row] &&
      c.positionY[row] === c.previousY[row] &&
      c.positionZ[row] === c.previousZ[row] &&
      c.rotationX[row] === c.previousRotationX[row] &&
      c.rotationY[row] === c.previousRotationY[row] &&
      c.rotationZ[row] === c.previousRotationZ[row] &&
      c.rotationW[row] === c.previousRotationW[row]
    );
  }

  // A stable callback avoids creating a Set iterator during every synchronization.
  private readonly other = (body: PhysicsBody): void => this.visit(body, this.syncs);

  private visit(body: PhysicsBody, sync: number): void {
    const { mesh, row } = body;
    if (!mesh || this.seen[row] === sync) return;
    this.seen[row] = sync;
    const depth = depthOf(mesh);
    // A resting body on a child mesh is still rewritten: its parent may have moved, and the body keeps its world pose.
    if ((body.type === 'fixed' && !body.dirty) || (body.restWritten && depth === 0 && this.still(row))) return;
    body.depth = depth;
    if (depth) this.nested.push(body);
    else this.writeBody(body);
  }

  private writeBody(body: PhysicsBody): void {
    const mesh = body.mesh!;
    try {
      mesh.check();
    } catch {
      this.gone.push(body);
      return;
    }
    const c = this.kernel.columns,
      { row } = body,
      { out, position, alpha } = this;
    position[0] = c.previousX[row] + (c.positionX[row] - c.previousX[row]) * alpha;
    position[1] = c.previousY[row] + (c.positionY[row] - c.previousY[row]) * alpha;
    position[2] = c.previousZ[row] + (c.positionZ[row] - c.previousZ[row]) * alpha;
    // Shortest-arc slerp of the two step rotations, inline: V8 boxes a fractional number passed to a call it does not
    // inline, and Math.hypot allocates an array for its arguments.
    const ax = c.previousRotationX[row],
      ay = c.previousRotationY[row],
      az = c.previousRotationZ[row],
      aw = c.previousRotationW[row];
    let bx = c.rotationX[row],
      by = c.rotationY[row],
      bz = c.rotationZ[row],
      bw = c.rotationW[row],
      cos = ax * bx + ay * by + az * bz + aw * bw,
      k0 = 1 - alpha,
      k1 = alpha;
    if (cos < 0) {
      cos = -cos;
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }
    if (cos <= 0.9995) {
      const angle = Math.acos(cos),
        sin = Math.sin(angle);
      k0 = Math.sin((1 - alpha) * angle) / sin;
      k1 = Math.sin(alpha * angle) / sin;
    }
    out[0] = ax * k0 + bx * k1;
    out[1] = ay * k0 + by * k1;
    out[2] = az * k0 + bz * k1;
    out[3] = aw * k0 + bw * k1;
    const length = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2] + out[3] * out[3]) || 1;
    for (let i = 0; i < 4; i++) out[i] /= length;
    let root: Engine | undefined;
    if (mesh instanceof CoreMesh) {
      const runtime = meshRuntime(mesh),
        { store } = runtime.engine,
        parent = store.parents[runtime.id];
      // A child mesh gets its pose relative to the parent's current world transform (no frame of lag).
      if (parent !== -1) this.toLocal(store, parent, position, out);
      else root = runtime.engine;
    } else if (parentOf(mesh) !== -1)
      throw new MargoError('state', 'Non-core physics bodies need root-level meshes; use a core Mesh for child meshes.');
    for (let i = 0; i < 4; i++)
      if (!Number.isFinite(Math.fround(out[i])) || (i < 3 && !Number.isFinite(Math.fround(position[i]))))
        throw new RangeError('A physics body pose must be finite; check the body for NaN or Infinity.');
    // The same bits as setPosition and setQuaternion (Engine.writePoses), in one call for every root mesh of a sync.
    if (root) this.batch(root, meshRuntime(mesh).id);
    else mesh.setPosition(position).setQuaternion(out);
    body.dirty = false;
    body.restWritten = this.still(row);
    // Still moving (one more write once it rests), or on a child mesh: looked at again in the next sync.
    if (!body.restWritten || body.depth) this.pending.push(body);
  }

  /** Adds the current pose of mesh `id` to the `writePoses` batch, sending a batch of another engine first. */
  private batch(engine: Engine, id: number): void {
    if (engine !== this.target) {
      this.flush();
      this.target = engine;
    }
    const at = this.batched++;
    if (at === this.ids.length) {
      const ids = new Int32Array(at * 2),
        poses = new Float64Array(at * 14);
      ids.set(this.ids);
      poses.set(this.poses);
      this.ids = ids;
      this.poses = poses;
    }
    const { poses, position, out } = this;
    this.ids[at] = id;
    poses[at * 7] = position[0];
    poses[at * 7 + 1] = position[1];
    poses[at * 7 + 2] = position[2];
    for (let i = 0; i < 4; i++) poses[at * 7 + 3 + i] = out[i];
  }

  /** Sends the batch: one `writePoses` for the root meshes written since the last flush. */
  private flush(): void {
    if (this.batched) this.target!.writePoses(this.ids, this.poses, this.batched);
    this.batched = 0;
  }

  /** World pose (in place) to the pose relative to `parent`: inverse parent matrix on the position, inverse parent rotation on the quaternion. */
  private toLocal(store: TransformStoreLike, parent: number, position: number[], rotation: number[]): void {
    const m = worldMatrix(store, parent, this.parentScratch),
      inverse = invertMatrix(m, this.inverseScratch);
    if (!inverse) throw new RangeError('Physics body parent has a singular world transform; give the parent a non-zero scale.');
    const x = position[0],
      y = position[1],
      z = position[2];
    for (let r = 0; r < 3; r++) position[r] = inverse[r] * x + inverse[4 + r] * y + inverse[8 + r] * z + inverse[12 + r];
    const q = this.parentRotation;
    matrixRotation(m, q);
    // conjugate(q) * rotation
    const ax = -q[0],
      ay = -q[1],
      az = -q[2],
      aw = q[3],
      bx = rotation[0],
      by = rotation[1],
      bz = rotation[2],
      bw = rotation[3];
    rotation[0] = aw * bx + ax * bw + ay * bz - az * by;
    rotation[1] = aw * by - ax * bz + ay * bw + az * bx;
    rotation[2] = aw * bz + ax * by - ay * bx + az * bw;
    rotation[3] = aw * bw - ax * bx - ay * by - az * bz;
  }
}
