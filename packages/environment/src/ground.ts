// Ground-projected environment background: the environment image is projected onto a floor disc and a dome around
// the point it was photographed above, so a product or car stands on the photographed floor (its floor stays put in
// the world as the camera moves) instead of floating inside an infinitely distant sphere.
import type { Vec3 } from '@margoengine/core/extension';
import { EnvironmentBackground, type EnvironmentBackgroundOptions } from './background.js';
import type { Environment } from './environment.js';
import type { EngineKernel } from '@margoengine/core';
import { backgroundShader } from './shaders.js';

/** `GroundProjectedBackground` settings: those of `EnvironmentBackground`, plus where and how high the image was taken. */
export interface GroundProjectionOptions extends EnvironmentBackgroundOptions {
  /** Height in metres above the floor at which the image was photographed (the tripod's height). Default 1.6. */
  height?: number;
  /** Radius in metres of the floor disc and of the dome it ends in. Default 50. */
  radius?: number;
  /** World position of the floor point under the photo's camera. Default [0, 0, 0]. */
  center?: Vec3;
}

// The ray from the eye meets the floor (y = 0 relative to the center) inside the dome, or else the dome (a sphere
// of `radius` around the center); the lookup direction runs from the photo's camera, `height` above the center, to
// that point. Exact ray-plane and ray-sphere geometry; outside the dome (no far hit) the plain view ray is used.
const PROJECT = /* wgsl */ `
fn project(ray: vec3f) -> vec3f {
  let e = u.eye.xyz - u.ground.xyz;
  let r = u.ground.w;
  let b = dot(e, ray);
  let disc = b * b - (dot(e, e) - r * r);
  if (disc < 0.0) { return ray; }
  var t = -b + sqrt(disc);
  if (ray.y < 0.0 && e.y > 0.0) { t = min(t, -e.y / ray.y); }
  if (t <= 0.0) { return ray; }
  return normalize(e + ray * t - vec3f(0.0, u.dome.x, 0.0));
}
`;

/**
 * Draws an Environment projected onto a floor disc and a dome (a "grounded skybox"): a model placed on the floor at
 * `center` stands on the photographed ground and sees it stay in place as the camera orbits. Everything else is
 * `EnvironmentBackground`: same pass, order, exposure, rotation, blur, depth test and outputs. Keep the camera inside
 * the dome and above the floor; the floor is flat at the center's height.
 */
export class GroundProjectedBackground extends EnvironmentBackground {
  private heightValue = 1.6;
  private radiusValue = 50;
  private readonly centerValue: [number, number, number] = [0, 0, 0];

  /** Same as `engine.use(new GroundProjectedBackground(...))`; returns the background. */
  static override attach(
    engine: EngineKernel,
    environment: Environment,
    options?: GroundProjectionOptions,
  ): GroundProjectedBackground {
    const value = new GroundProjectedBackground(environment, options);
    engine.use(value);
    return value;
  }
  constructor(environment: Environment, options: GroundProjectionOptions = {}) {
    super(environment, options);
    // Radius first unbounded, so the pair is checked against each other whatever the order of the defaults.
    this.radiusValue = Infinity;
    this.height = options.height ?? 1.6;
    this.radius = options.radius ?? 50;
    this.center = options.center ?? [0, 0, 0];
  }

  /** Photo camera height above the floor in metres (greater than 0, below `radius`). */
  get height(): number {
    return this.heightValue;
  }
  set height(value: number) {
    if (!(value > 0 && value < this.radiusValue))
      throw new RangeError('Invalid ground height; pass a number of metres above 0 and below the radius');
    this.heightValue = value;
  }
  /** Floor disc and dome radius in metres (above `height`). */
  get radius(): number {
    return this.radiusValue;
  }
  set radius(value: number) {
    if (!(value > this.heightValue && Number.isFinite(value)))
      throw new RangeError('Invalid ground radius; pass a finite number of metres above the height');
    this.radiusValue = value;
  }
  /** Floor point under the photo's camera (a copy). */
  get center(): Vec3 {
    return [...this.centerValue];
  }
  set center(value: Vec3) {
    if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite))
      throw new RangeError('Invalid ground center; pass [x, y, z] in metres');
    this.centerValue[0] = value[0];
    this.centerValue[1] = value[1];
    this.centerValue[2] = value[2];
  }

  protected override shaderCode(): string {
    return backgroundShader(PROJECT);
  }
  protected override writeExtra(f: Float32Array): void {
    f[28] = this.centerValue[0];
    f[29] = this.centerValue[1];
    f[30] = this.centerValue[2];
    f[31] = this.radiusValue;
    f[32] = this.heightValue;
  }
}
