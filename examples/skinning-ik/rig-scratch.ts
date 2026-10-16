import type { Mesh, Vec3 } from '@margoengine/core/extension';
import { finiteVector } from '@margoengine/math/validate';
import { hypot3Into, hypot4Into } from './norm.ts';

type Point = [number, number, number];
const point = (): Point => [0.1, 0.1, 0.1];
const rotation = (): number[] => [0.1, 0.1, 0.1, 0.1];

/** Demo-private destination-passing version of rig-ik. Each controller owns its scratch. */
export class RigScratch {
  private readonly chain = new Int32Array(64);
  private readonly lengths = new Float64Array(2);
  private readonly boneOffset = point();
  private readonly bone = rotation();
  private readonly current = rotation();
  private readonly parent = rotation();
  private readonly inverse = rotation();
  private readonly product = rotation();
  private readonly local = rotation();
  private readonly delta = rotation();
  private readonly root = point();
  private readonly elbowPosition = point();
  private readonly wristPosition = point();
  private readonly seedUpper = point();
  private readonly seedEnd = point();
  private readonly target = point();
  private readonly pole = point();
  private readonly axis = point();
  private readonly normal = point();
  private readonly solvedElbow = point();
  private readonly solvedWrist = point();
  private readonly from = point();
  private readonly to = point();

  multiply(a: ArrayLike<number>, b: ArrayLike<number>, out: number[]): void {
    const x = a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      y = a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      z = a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      w = a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2];
    out[0] = x;
    out[1] = y;
    out[2] = z;
    out[3] = w;
  }
  worldRotation(mesh: Mesh, out: number[]): void {
    mesh.check();
    const { transforms: t, parents } = mesh.engine.store;
    let count = 0;
    for (let id = mesh.id; id !== -1; id = parents[id]) {
      const x = t.sx[id],
        y = t.sy[id],
        z = t.sz[id],
        tolerance = Math.max(x, y, z) * 1e-5;
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(z) ||
        x <= 0 ||
        y <= 0 ||
        z <= 0 ||
        Math.abs(x - y) > tolerance ||
        Math.abs(x - z) > tolerance
      )
        throw new Error('Arm IK requires positive uniform bone and ancestor scales');
      if (count === this.chain.length) throw new RangeError('Parent depth: 64');
      this.chain[count++] = id;
    }
    out[0] = out[1] = out[2] = 0;
    out[3] = 1;
    for (let index = count - 1; index >= 0; index--) {
      const id = this.chain[index],
        q = this.bone;
      q[0] = t.qx[id];
      q[1] = t.qy[id];
      q[2] = t.qz[id];
      q[3] = t.qw[id];
      this.multiply(out, q, out);
    }
    hypot4Into(out, this.lengths);
    const length = this.lengths[0];
    for (let i = 0; i < 4; i++) out[i] = out[i] / length;
  }
  /** Same finite Float32 guard, normalization and Euler synchronization as Mesh.setQuaternion. */
  setQuaternion(mesh: Mesh, value: readonly number[]): void {
    mesh.check();
    if (value.length !== 4) throw new TypeError('Quaternion: 4 values');
    for (let i = 0; i < 4; i++)
      if (typeof value[i] !== 'number' || !Number.isFinite(Math.fround(value[i])))
        throw new RangeError('Quaternion: finite values');
    hypot4Into(value, this.lengths);
    const length = this.lengths[0];
    if (!length) throw new RangeError('Quaternion nonzero');
    const x = value[0] / length,
      y = value[1] / length,
      z = value[2] / length,
      w = value[3] / length,
      t = mesh.engine.store.transforms,
      id = mesh.id;
    t.qx[id] = x;
    t.qy[id] = y;
    t.qz[id] = z;
    t.qw[id] = w;
    mesh.euler[1] = Math.asin(Math.max(-1, Math.min(1, 2 * (x * z + w * y))));
    mesh.euler[0] = Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + y * y));
    mesh.euler[2] = Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z));
  }
  rotateWorld(mesh: Mesh, delta: readonly number[]): void {
    if (delta.length !== 4) throw new RangeError('Invalid arm IK rotation');
    for (let i = 0; i < 4; i++) if (!Number.isFinite(delta[i])) throw new RangeError('Invalid arm IK rotation');
    hypot4Into(delta, this.lengths);
    if (!this.lengths[0]) throw new RangeError('Invalid arm IK rotation');
    this.worldRotation(mesh, this.current);
    const parentId = mesh.engine.store.parents[mesh.id],
      parent = this.parent;
    if (parentId === -1) {
      parent[0] = parent[1] = parent[2] = 0;
      parent[3] = 1;
    } else this.worldRotation(mesh.engine.meshes.get(parentId)!, parent);
    const inverse = this.inverse;
    inverse[0] = -parent[0];
    inverse[1] = -parent[1];
    inverse[2] = -parent[2];
    inverse[3] = parent[3];
    this.multiply(delta, this.current, this.product);
    this.multiply(inverse, this.product, this.local);
    this.setQuaternion(mesh, this.local);
  }
  private position(mesh: Mesh, out: Point): void {
    mesh.check();
    const m = mesh.matrix;
    out[0] = m[12];
    out[1] = m[13];
    out[2] = m[14];
  }
  private between(): void {
    const from = this.from,
      to = this.to;
    hypot3Into(from, this.lengths);
    hypot3Into(to, this.lengths, 1);
    const a = this.lengths[0],
      b = this.lengths[1];
    if (a < 1e-8 || b < 1e-8) throw new RangeError('Zero arm IK direction');
    const x = from[0] / a,
      y = from[1] / a,
      z = from[2] / a,
      u = to[0] / b,
      v = to[1] / b,
      w = to[2] / b,
      r = x * u + y * v + z * w + 1,
      q = this.delta;
    if (r < 1e-8) {
      if (Math.abs(x) > Math.abs(z)) {
        q[0] = -y;
        q[1] = x;
        q[2] = 0;
        q[3] = 0;
      } else {
        q[0] = 0;
        q[1] = -z;
        q[2] = y;
        q[3] = 0;
      }
    } else {
      q[0] = y * w - z * v;
      q[1] = z * u - x * w;
      q[2] = x * v - y * u;
      q[3] = r;
    }
    const length = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (length) for (let i = 0; i < 4; i++) q[i] = q[i] / length;
    else {
      q[0] = q[1] = q[2] = 0;
      q[3] = 1;
    }
  }
  solve(shoulder: Mesh, elbow: Mesh, wrist: Mesh, target: Vec3, pole: Vec3): void {
    shoulder.check();
    elbow.check();
    wrist.check();
    if (shoulder.engine !== elbow.engine || shoulder.engine !== wrist.engine)
      throw new Error('Arm IK nodes must belong to the same engine');
    const store = shoulder.engine.store;
    if (store.parents[elbow.id] !== shoulder.id || store.parents[wrist.id] !== elbow.id)
      throw new Error('Arm IK requires a direct shoulder/elbow/wrist chain');
    this.worldRotation(wrist, this.current);
    store.tick(false);
    const t = store.transforms,
      root = this.root;
    this.position(shoulder, root);
    let scale = 1;
    for (let id = shoulder.id; id !== -1; id = store.parents[id]) scale *= t.sx[id];
    const offset = this.boneOffset;
    offset[0] = t.x[elbow.id];
    offset[1] = t.y[elbow.id];
    offset[2] = t.z[elbow.id];
    hypot3Into(offset, this.lengths);
    const upperLength = this.lengths[0] * scale;
    offset[0] = t.x[wrist.id];
    offset[1] = t.y[wrist.id];
    offset[2] = t.z[wrist.id];
    hypot3Into(offset, this.lengths);
    const lowerLength = this.lengths[0] * scale * t.sx[elbow.id];
    this.seedUpper[0] = upperLength;
    this.seedUpper[1] = this.seedUpper[2] = 0;
    this.seedEnd[0] = upperLength + lowerLength;
    this.seedEnd[1] = this.seedEnd[2] = 0;
    finiteVector(this.seedUpper, 3, 'IK point');
    finiteVector(this.seedEnd, 3, 'IK point');
    for (let i = 0; i < 3; i++) {
      this.target[i] = target[i] - root[i];
      this.pole[i] = pole[i] - root[i];
    }
    finiteVector(this.target, 3, 'IK point');
    finiteVector(this.pole, 3, 'IK point');
    const upper = Math.abs(upperLength - 0),
      lower = Math.abs(upperLength + lowerLength - upperLength);
    if (upper <= 1e-8 || lower <= 1e-8) throw new RangeError('IK bones have zero length');
    const axis = this.axis,
      normal = this.normal;
    hypot3Into(this.target, this.lengths);
    const targetDistance = this.lengths[0];
    let distance = targetDistance;
    for (let i = 0; i < 3; i++) axis[i] = this.target[i] - 0;
    if (distance < 1e-8) {
      axis[0] = upperLength + lowerLength;
      axis[1] = axis[2] = 0;
      hypot3Into(axis, this.lengths);
      distance = this.lengths[0];
      if (distance < 1e-8) {
        axis[0] = upperLength;
        axis[1] = axis[2] = 0;
        distance = upper;
      }
    }
    for (let i = 0; i < 3; i++) axis[i] = axis[i] / distance;
    const reach = Math.max(Math.abs(upper - lower) + 1e-8, Math.min(upper + lower - 1e-8, targetDistance)),
      bend = this.pole,
      dot = 0 + bend[0] * axis[0] + bend[1] * axis[1] + bend[2] * axis[2];
    for (let i = 0; i < 3; i++) normal[i] = bend[i] - dot * axis[i];
    hypot3Into(normal, this.lengths);
    let length = this.lengths[0];
    if (length < 1e-8) {
      const x = Math.abs(axis[1]) < 0.9 ? 0 : 1,
        y = Math.abs(axis[1]) < 0.9 ? 1 : 0,
        d = 0 + x * axis[0] + y * axis[1] + 0 * axis[2];
      normal[0] = x - d * axis[0];
      normal[1] = y - d * axis[1];
      normal[2] = 0 - d * axis[2];
      hypot3Into(normal, this.lengths);
      length = this.lengths[0];
    }
    const along = (upper * upper + reach * reach - lower * lower) / (2 * reach),
      height = Math.sqrt(Math.max(0, upper * upper - along * along));
    for (let i = 0; i < 3; i++) {
      this.solvedElbow[i] = 0 + axis[i] * along + (normal[i] / length) * height + root[i];
      this.solvedWrist[i] = 0 + axis[i] * reach + root[i];
    }
    this.position(elbow, this.elbowPosition);
    for (let i = 0; i < 3; i++) {
      this.from[i] = this.elbowPosition[i] - root[i];
      this.to[i] = this.solvedElbow[i] - root[i];
    }
    this.between();
    this.rotateWorld(shoulder, this.delta);
    store.tick(false);
    this.position(elbow, this.elbowPosition);
    this.position(wrist, this.wristPosition);
    for (let i = 0; i < 3; i++) {
      this.from[i] = this.wristPosition[i] - this.elbowPosition[i];
      this.to[i] = this.solvedWrist[i] - this.elbowPosition[i];
    }
    this.between();
    this.rotateWorld(elbow, this.delta);
    store.tick(false);
  }
}
