import type { Vec3Like } from './types.js';

/**
 * y-up cylindrical coordinates: `radius` from the y axis, `theta` the azimuth around +y from +z (as in `Spherical`),
 * and height `y`. Handy for turntable orbits, spiral layouts and anything that wraps a column.
 */
export class Cylindrical {
  constructor(
    public radius = 1,
    public theta = 0,
    public y = 0,
  ) {}

  set(radius: number, theta: number, y: number): this {
    this.radius = radius;
    this.theta = theta;
    this.y = y;
    return this;
  }
  copy(c: Cylindrical): this {
    return this.set(c.radius, c.theta, c.y);
  }
  clone(): Cylindrical {
    return new Cylindrical().copy(this);
  }
  setFromVector3(v: Vec3Like): this {
    return this.setFromCartesianCoords(v.x, v.y, v.z);
  }
  /** Reads a point; a point on the y axis gets `theta` 0. */
  setFromCartesianCoords(x: number, y: number, z: number): this {
    this.radius = Math.hypot(x, z);
    this.theta = this.radius === 0 ? 0 : Math.atan2(x, z);
    this.y = y;
    return this;
  }
  /** Writes the point into `out` and returns it. */
  toVector3<T extends Vec3Like>(out: T): T {
    out.x = this.radius * Math.sin(this.theta);
    out.y = this.y;
    out.z = this.radius * Math.cos(this.theta);
    return out;
  }
  equals(c: Cylindrical, epsilon = 0): boolean {
    return (
      Math.abs(this.radius - c.radius) <= epsilon &&
      Math.abs(this.theta - c.theta) <= epsilon &&
      Math.abs(this.y - c.y) <= epsilon
    );
  }
}
