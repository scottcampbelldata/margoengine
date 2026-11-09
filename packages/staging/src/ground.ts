/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine } from '@margoengine/core/extension';
import { ContactShadows, type ContactPrimitive, type ContactShadowOptions } from './index.js';
import { fault, rangeError } from '../../shared/errors.js';

/** The public Environment data needed by a dominant-light receiver; no environment code is imported. */
export interface GroundShadowEnvironment {
  /** Unrotated, coefficient-major RGB radiance SH, in Margo's real L2 basis. */
  readonly sh: { readonly radiance: Float32Array };
  /** Environment rotation about +Y, radians. */
  readonly rotation: number;
  /** Environment radiance multiplier. Zero disables the shadow. */
  readonly intensity: number;
}
/** A directional ground shadow inferred from the HDR's first radiance moment. */
export interface GroundShadowOptions extends ContactShadowOptions {
  /** Lighting environment. Default: the `environment` plugin in the receiver's owning scene. Read live. */
  environment?: GroundShadowEnvironment;
}

/**
 * Projects casters opposite the HDR's dominant light direction onto a receiver. The luminance-weighted
 * first SH band gives the radiance moment (Sloan 2008); homogeneous ray-plane geometry gives the shadow.
 * This is one directional-light approximation, not a full environment visibility integral.
 */
export class GroundShadows extends ContactShadows {
  override readonly name = 'ground-shadows';
  declare readonly options: GroundShadowOptions;
  private environment?: GroundShadowEnvironment;
  private lightKey = '';
  private readonly direction = [0, 0, 0];
  private readonly matrix = new Float32Array(16);
  private lit = false;

  /** Copies receiver options. Other receiver defaults, including blur and height, are unchanged. */
  constructor(options: GroundShadowOptions = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw rangeError('Invalid ground shadow options; pass an options object', 'arguments');
    super({ ...options });
  }
  /** Attaches to the default scene; use `scene.use(new GroundShadows(options))` for another scene. */
  static override attach(engine: EngineKernel, options: GroundShadowOptions = {}): GroundShadows {
    const shadow = new GroundShadows(options);
    engineRuntime(engine).use(shadow);
    return shadow;
  }
  override setup(engine: Engine): void {
    if (!engine.gpu)
      throw fault('unsupported', 'GroundShadows needs WebGPU or WebGL2 compatibility; select one of those backends');
    this.environment =
      this.options.environment ?? (engine.plugins.get('environment') as GroundShadowEnvironment | undefined);
    if (!this.environment)
      throw fault('state', 'GroundShadows needs an Environment; attach one first or pass environment');
    super.setup(engine);
  }
  protected override changed(draws: readonly ContactPrimitive[], s: ReturnType<GroundShadows['settings']>): boolean {
    const env = this.options.environment ?? this.environment!,
      coefficients = env.sh?.radiance;
    if (
      !(coefficients instanceof Float32Array) ||
      coefficients.length !== 27 ||
      !coefficients.every(Number.isFinite) ||
      !Number.isFinite(env.rotation) ||
      !Number.isFinite(env.intensity) ||
      env.intensity < 0
    )
      throw rangeError(
        'Invalid ground shadow environment; use finite L2 radiance SH, rotation and nonnegative intensity',
        'arguments',
      );
    // Y_1 = 0.488602512 * (y,z,x). RGB luminance and the identical band scale commute with integration.
    const luminance = (k: number) =>
      coefficients[k * 3] * 0.2126 + coefficients[k * 3 + 1] * 0.7152 + coefficients[k * 3 + 2] * 0.0722;
    const x = luminance(3),
      y = luminance(1),
      z = luminance(2),
      length = Math.hypot(x, y, z);
    const c = Math.cos(env.rotation),
      t = Math.sin(env.rotation),
      d = this.direction;
    // IBL samples R(+rotation)*world, so the source light rotates by the inverse transform.
    if (length > 0) {
      d[0] = (c * x + t * z) / length;
      d[1] = y / length;
      d[2] = (-t * x + c * z) / length;
    } else d.fill(0);
    // An isotropic HDR or a light on/below the receiver cannot cast a finite directional ground shadow.
    this.lit =
      env.intensity > 0 &&
      length > Math.abs(luminance(0)) * 1e-6 &&
      s.normal.reduce((sum, v, i) => sum + v * d[i], 0) > 1e-6;
    const key = [...d, +this.lit].join('|'),
      changed = super.changed(draws, s);
    const result = changed || key !== this.lightKey;
    this.lightKey = key;
    return result;
  }
  protected override coverage(_depth: string): string {
    return '1';
  }
  protected override coverageScale(): number {
    return this.lit ? 1 : 0;
  }
  protected override projection(s: ReturnType<GroundShadows['settings']>): Float32Array {
    const m = this.matrix,
      d = this.direction,
      center = [s.x, s.ground, s.z];
    const dot = (axis: readonly number[]) => axis.reduce((sum, v, i) => sum + v * d[i], 0);
    const n = dot(s.normal),
      u = this.lit ? dot(s.u) / n : 0,
      v = this.lit ? dot(s.v) / n : 0;
    m.fill(0);
    for (let i = 0; i < 3; i++) {
      m[4 * i] = (2 * (s.u[i] - u * s.normal[i])) / s.width;
      m[4 * i + 1] = (2 * (s.v[i] - v * s.normal[i])) / s.depth;
      m[4 * i + 2] = s.normal[i] / s.height;
    }
    for (let row = 0; row < 3; row++) m[12 + row] = -center.reduce((sum, p, i) => sum + p * m[4 * i + row], 0);
    m[15] = 1;
    return m;
  }
}
