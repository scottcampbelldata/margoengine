import type { Vec3Like } from './types.js';

/** y-up spherical coordinates: `phi` is the polar angle from +y, `theta` the azimuth around +y from +z. Handy for orbit cameras. */
export class Spherical {
  constructor(
    public radius = 1,
    public phi = 0,
    public theta = 0,
  ) {}

  set(radius: number, phi: number, theta: number): this {
    this.radius = radius;
    this.phi = phi;
    this.theta = theta;
    return this;
  }
  copy(s: Spherical): this {
    return this.set(s.radius, s.phi, s.theta);
  }
  clone(): Spherical {
    return new Spherical().copy(this);
  }
  /** Keeps phi just inside (0, π) so a look-at built from it never goes exactly vertical. */
  makeSafe(epsilon = 1e-6): this {
    this.phi = Math.max(epsilon, Math.min(Math.PI - epsilon, this.phi));
    return this;
  }
  setFromVector3(v: Vec3Like): this {
    return this.setFromCartesianCoords(v.x, v.y, v.z);
  }
  setFromCartesianCoords(x: number, y: number, z: number): this {
    this.radius = Math.hypot(x, y, z);
    if (this.radius === 0) {
      this.phi = this.theta = 0;
      return this;
    }
    this.theta = Math.atan2(x, z);
    this.phi = Math.acos(Math.max(-1, Math.min(1, y / this.radius)));
    return this;
  }
}
