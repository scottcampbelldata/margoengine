import { Plane } from './plane.js';
import type { MatrixLike, NumberArray, Vec3Like } from './types.js';

interface SphereLike {
  center: Vec3Like;
  radius: number;
}
interface BoxLike {
  min: Vec3Like;
  max: Vec3Like;
}

/**
 * Six inward-facing planes in the same order and layout as core `camera.planes`
 * (left, right, bottom, top, then the two depth planes), so `fromArray(engine.camera.planes)` and
 * `setFromProjectionMatrix({elements: engine.camera.matrix})` describe the same volume.
 */
export class Frustum {
  readonly planes: [Plane, Plane, Plane, Plane, Plane, Plane];
  constructor(
    p0 = new Plane(),
    p1 = new Plane(),
    p2 = new Plane(),
    p3 = new Plane(),
    p4 = new Plane(),
    p5 = new Plane(),
  ) {
    this.planes = [p0, p1, p2, p3, p4, p5];
  }
  set(p0: Plane, p1: Plane, p2: Plane, p3: Plane, p4: Plane, p5: Plane): this {
    const planes = this.planes;
    planes[0].copy(p0);
    planes[1].copy(p1);
    planes[2].copy(p2);
    planes[3].copy(p3);
    planes[4].copy(p4);
    planes[5].copy(p5);
    return this;
  }
  copy(frustum: Frustum): this {
    return this.set(...frustum.planes);
  }
  clone(): Frustum {
    return new Frustum().copy(this);
  }

  /** Extracts planes from a view-projection matrix. `zeroToOne` (default) is WebGPU depth [0, 1], including core's reversed-Z; false is WebGL [-1, 1]. */
  setFromProjectionMatrix(m: MatrixLike, zeroToOne = true): this {
    const e = m.elements;
    for (let i = 0; i < 6; i++) {
      const row = i >> 1,
        sign = i % 2 === 0 ? 1 : -1,
        depthOnly = i === 4 && zeroToOne;
      this.planes[i]
        .setComponents(
          depthOnly ? e[2] : e[3] + sign * e[row],
          depthOnly ? e[6] : e[7] + sign * e[4 + row],
          depthOnly ? e[10] : e[11] + sign * e[8 + row],
          depthOnly ? e[14] : e[15] + sign * e[12 + row],
        )
        .normalize();
    }
    return this;
  }
  containsPoint(p: Vec3Like): boolean {
    for (const plane of this.planes) if (plane.distanceToPoint(p) < 0) return false;
    return true;
  }
  intersectsSphere(sphere: SphereLike): boolean {
    for (const plane of this.planes) if (plane.distanceToPoint(sphere.center) < -sphere.radius) return false;
    return true;
  }
  /** Conservative: may report true for boxes just outside a frustum corner. */
  intersectsBox(box: BoxLike): boolean {
    for (const { normal: n, constant } of this.planes) {
      // Test the box corner furthest along the plane normal.
      const x = n.x > 0 ? box.max.x : box.min.x,
        y = n.y > 0 ? box.max.y : box.min.y,
        z = n.z > 0 ? box.max.z : box.min.z;
      if (n.x * x + n.y * y + n.z * z + constant < 0) return false;
    }
    return true;
  }

  /** Reads 24 numbers (nx, ny, nz, d per plane), e.g. core `camera.planes`. */
  fromArray(array: ArrayLike<number>, offset = 0): this {
    for (let i = 0; i < 6; i++) {
      const o = offset + i * 4;
      this.planes[i].setComponents(array[o], array[o + 1], array[o + 2], array[o + 3]);
    }
    return this;
  }
  toArray(): number[];
  toArray<T extends NumberArray>(out: T, offset?: number): T;
  toArray(out: NumberArray = [], offset = 0): NumberArray {
    for (let i = 0; i < 6; i++) {
      const { normal, constant } = this.planes[i],
        o = offset + i * 4;
      out[o] = normal.x;
      out[o + 1] = normal.y;
      out[o + 2] = normal.z;
      out[o + 3] = constant;
    }
    return out;
  }
}
