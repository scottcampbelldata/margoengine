import type { Mesh } from '@margoengine/core/extension';
import { invertMatrixStable, multiplyMatrices } from '@margoengine/math/mat4';
import { BodyDistance, newDistance, type Point } from './body-distance';
import { armHeadHulls } from './arm-head-shape';
import { headLocalHull } from './body-head-shape';
import { hypot3Into, hypot4Into } from './norm';

const padding = 0.0031;

/** Head-only envelope: mounted parts and blended upper-arm skin remain excluded from torso contact. */
export class ArmHeadClearance {
  private readonly inverse = new Float64Array(16);
  private readonly workspace = new Float64Array(52);
  private readonly matrices = [new Float64Array(16), new Float64Array(16)];
  private readonly headMatrix = new Float64Array(16);
  private readonly localMatrix = new Float32Array(16);
  private readonly worldMatrix = new Float32Array(16);
  private readonly quaternion = new Float32Array(4);
  private readonly length = new Float64Array(1);
  private readonly armPoint: Point = [0, 0, 0];
  private readonly headPoint: Point = [0, 0, 0];
  private readonly result = newDistance();
  private readonly cachedMatrices = new Float64Array(48);
  private readonly cachedDistance = new Float64Array(1);
  private cached = false;
  private readonly kernel = new BodyDistance((direction) => this.supportHead(direction));
  private readonly support = (direction: Point): Point => this.supportArm(direction);

  constructor(
    readonly frame: Mesh,
    readonly head: Mesh,
    readonly shoulder: Mesh,
    readonly elbow: Mesh,
  ) {
    for (const node of [frame, head, shoulder, elbow]) {
      node.check();
      if (node.engine !== frame.engine) throw new Error('Arm/head clearance nodes must share one engine');
    }
  }

  /** Write a signed authored-frame gap for an absolute proposed local Head quaternion; never change the scene. */
  evaluate(rotation: readonly number[], out: Float64Array): void {
    if (!rotation || rotation.length !== 4) throw new TypeError('Quaternion: 4 values');
    for (let i = 0; i < 4; i++)
      if (typeof rotation[i] !== 'number' || !Number.isFinite(Math.fround(rotation[i])))
        throw new RangeError('Quaternion: finite values');
    hypot4Into(rotation, this.length);
    if (!this.length[0]) throw new RangeError('Quaternion nonzero');
    this.prepare();
    for (let i = 0; i < 4; i++) this.quaternion[i] = rotation[i] / this.length[0];
    // Match the transform kernel: normalize the stored Float32 quaternion, then round the local/world matrices.
    const q = this.quaternion,
      size = Math.sqrt(0 + q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]),
      x = q[0] / size,
      y = q[1] / size,
      z = q[2] / size,
      w = q[3] / size,
      t = this.head.engine.store.transforms,
      id = this.head.id,
      m = this.localMatrix;
    m[0] = (1 - 2 * (y * y + z * z)) * t.sx[id];
    m[1] = 2 * (x * y + w * z) * t.sx[id];
    m[2] = 2 * (x * z - w * y) * t.sx[id];
    m[3] = 0;
    m[4] = 2 * (x * y - w * z) * t.sy[id];
    m[5] = (1 - 2 * (x * x + z * z)) * t.sy[id];
    m[6] = 2 * (y * z + w * x) * t.sy[id];
    m[7] = 0;
    m[8] = 2 * (x * z + w * y) * t.sz[id];
    m[9] = 2 * (y * z - w * x) * t.sz[id];
    m[10] = (1 - 2 * (x * x + y * y)) * t.sz[id];
    m[11] = 0;
    m[12] = t.x[id];
    m[13] = t.y[id];
    m[14] = t.z[id];
    m[15] = 1;
    const parentId = this.head.engine.store.parents[id];
    if (parentId === -1) this.worldMatrix.set(m);
    else {
      const parent = this.head.engine.meshes.get(parentId)!;
      parent.check();
      for (let c = 0; c < 4; c++)
        for (let r = 0; r < 3; r++)
          this.worldMatrix[c * 4 + r] =
            0 +
            parent.matrix[r] * m[c * 4] +
            parent.matrix[4 + r] * m[c * 4 + 1] +
            parent.matrix[8 + r] * m[c * 4 + 2] +
            (c === 3 ? parent.matrix[12 + r] : 0);
      this.worldMatrix[3] = this.worldMatrix[7] = this.worldMatrix[11] = 0;
      this.worldMatrix[15] = 1;
    }
    multiplyMatrices(this.inverse, this.worldMatrix, this.headMatrix);
    this.query(out);
  }

  /** Check the exact currently presented Head matrix, including its stored Float32 rotation. */
  evaluateCurrent(out: Float64Array): void {
    this.prepare();
    multiplyMatrices(this.inverse, this.head.matrix, this.headMatrix);
    this.query(out);
  }

  private prepare(): void {
    this.check(this.frame);
    this.check(this.head);
    this.check(this.shoulder);
    this.check(this.elbow);
    this.frame.engine.store.tick(false);
    if (!invertMatrixStable(this.frame.matrix, this.inverse, this.workspace))
      throw new Error('Singular arm/head clearance frame');
    multiplyMatrices(this.inverse, this.shoulder.matrix, this.matrices[0]);
    multiplyMatrices(this.inverse, this.elbow.matrix, this.matrices[1]);
  }

  private check(node: Mesh): void {
    node.check();
    const store = node.engine.store,
      t = store.transforms;
    let count = 0;
    for (let id = node.id; id !== -1; id = store.parents[id]) {
      if (++count > 64) throw new RangeError('Parent depth: 64');
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
        throw new RangeError('Arm/head clearance requires positive uniform ancestor scales');
    }
  }

  private query(out: Float64Array): void {
    let same = this.cached;
    for (let i = 0; i < 16; i++)
      if (
        this.headMatrix[i] !== this.cachedMatrices[i] ||
        this.matrices[0][i] !== this.cachedMatrices[16 + i] ||
        this.matrices[1][i] !== this.cachedMatrices[32 + i]
      )
        same = false;
    if (same) {
      out[0] = this.cachedDistance[0];
      return;
    }
    this.kernel.query(this.support, this.result);
    const distance = this.result[1] !== 0 ? -padding : this.result[0];
    if (!Number.isFinite(distance)) throw new RangeError('Arm/head clearance must be finite');
    this.cachedMatrices.set(this.headMatrix);
    this.cachedMatrices.set(this.matrices[0], 16);
    this.cachedMatrices.set(this.matrices[1], 32);
    this.cachedDistance[0] = distance;
    this.cached = true;
    out[0] = distance;
  }

  private supportArm(direction: Point): Point {
    let best = -Infinity,
      selected = armHeadHulls[0][0],
      matrix = this.matrices[0];
    for (let group = 0; group < armHeadHulls.length; group++) {
      const m = this.matrices[group],
        dx = m[0] * direction[0] + m[1] * direction[1] + m[2] * direction[2],
        dy = m[4] * direction[0] + m[5] * direction[1] + m[6] * direction[2],
        dz = m[8] * direction[0] + m[9] * direction[1] + m[10] * direction[2],
        translation = m[12] * direction[0] + m[13] * direction[1] + m[14] * direction[2];
      for (const point of armHeadHulls[group]) {
        const distance = point[0] * dx + point[1] * dy + point[2] * dz + translation;
        if (distance > best) {
          best = distance;
          selected = point;
          matrix = m;
        }
      }
    }
    hypot3Into(direction, this.length);
    const radius = padding / this.length[0],
      p = selected,
      m = matrix,
      out = this.armPoint;
    out[0] = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12] + direction[0] * radius;
    out[1] = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13] + direction[1] * radius;
    out[2] = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14] + direction[2] * radius;
    return out;
  }

  private supportHead(direction: Point): Point {
    const m = this.headMatrix,
      dx = m[0] * direction[0] + m[1] * direction[1] + m[2] * direction[2],
      dy = m[4] * direction[0] + m[5] * direction[1] + m[6] * direction[2],
      dz = m[8] * direction[0] + m[9] * direction[1] + m[10] * direction[2];
    let best = -Infinity,
      selected = headLocalHull[0];
    for (const point of headLocalHull) {
      const distance = point[0] * dx + point[1] * dy + point[2] * dz;
      if (distance > best) {
        best = distance;
        selected = point;
      }
    }
    const p = selected,
      out = this.headPoint;
    out[0] = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    out[1] = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    out[2] = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
    return out;
  }
}
