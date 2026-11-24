// A light probe given as nine RGB spherical-harmonic coefficients (L2 SH of the incoming radiance), a ShaderEffect in
// the ambient slot like HemisphereLight. The coefficients are radiance; the shader evaluates the Lambert-convolved
// irradiance over pi (Ramamoorthi and Hanrahan 2001, "An Efficient Representation for Irradiance Environment Maps",
// SIGGRAPH, https://graphics.stanford.edu/papers/envmap/; band factors 1, 2/3, 1/4), so a surface of albedo `a`
// reflects `a x E(n) / pi x intensity`. Basis order and constants: Sloan 2008, "Stupid Spherical Harmonics (SH)
// Tricks", GDC, https://www.ppsloan.org/publications/StupidSH36.pdf (the same order as three.js SphericalHarmonics3,
// so its nine coefficients carry over unchanged).
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { ShaderEffect, type PBRHooks } from './lighting.js';
import { HEMISPHERE_BINDING, HEMISPHERE_TERM, patchAmbient } from './hemisphere.js';
import { SH_BASIS, SH_IRRADIANCE_BANDS, evaluateSH, radianceToIrradianceSH } from './sh.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** Nine RGB coefficients: `[[r, g, b] x 9]`, or 27 numbers coefficient-major (`k * 3 + channel`). */
export type SHCoefficients = readonly (readonly [number, number, number])[] | ArrayLike<number>;

/** Options of {@link SHLight}. */
export interface SHLightOptions {
  /**
   * L2 SH radiance coefficients, linear, in the order (l,m) = (0,0), (1,-1) y, (1,0) z, (1,1) x, (2,-2) xy, (2,-1) yz,
   * (2,0) 3z^2-1, (2,1) xz, (2,2) x^2-y^2 (three.js SphericalHarmonics3 and `projectEquirectSH` order). Default: all
   * zero (no light).
   */
  coefficients?: SHCoefficients;
  /** Multiplies the light (default 1). */
  intensity?: number;
  /** Plugin and pass name. Default 'environment:sh'. */
  name?: string;
}

// Irradiance over pi: the CPU folds basis constant x band factor x intensity into each coefficient, so the shader is
// the nine polynomial terms.
const wgsl = (group: number) => `struct MargoSkyLight {c:array<vec4f,9>}
@group(${group}) @binding(${HEMISPHERE_BINDING}) var<uniform> margoSkyLightData:MargoSkyLight;
fn margoSkyLight(n:vec3f)->vec3f {let d=normalize(n);let c=margoSkyLightData.c;
let e=c[0].rgb+c[1].rgb*d.y+c[2].rgb*d.z+c[3].rgb*d.x+c[4].rgb*(d.x*d.y)+c[5].rgb*(d.y*d.z)+c[6].rgb*(3.0*d.z*d.z-1.0)+c[7].rgb*(d.x*d.z)+c[8].rgb*(d.x*d.x-d.y*d.y);
return max(e,vec3f(0.0));}
`;

function flatten(value: SHCoefficients): Float32Array<ArrayBuffer> {
  const out = new Float32Array(27),
    rows = Array.isArray(value) && value.length === 9 && Array.isArray(value[0]);
  if (!rows && (value as ArrayLike<number>).length !== 27)
    throw new RangeError('SH coefficients must be 9 [r, g, b] triples or 27 numbers');
  for (let k = 0; k < 9; k++)
    for (let c = 0; c < 3; c++) {
      const v = rows ? (value as readonly (readonly number[])[])[k][c] : (value as ArrayLike<number>)[k * 3 + c];
      if (typeof v !== 'number' || !Number.isFinite(Math.fround(v)))
        throw new RangeError(`SH coefficient ${k} channel ${c} must be a finite number`);
      out[k * 3 + c] = v;
    }
  return out;
}

/**
 * Light probe from nine RGB L2 spherical-harmonic coefficients (three.js `LightProbe`): the diffuse ambient light of a
 * whole environment in 27 numbers, the same at every point. `engine.use(light)` (or `SHLight.attach`) lights core
 * meshes and terrain; `light.add(model)` adds gltf/pbr models, materials meshes and VAT crowds. It takes the ambient
 * slot exactly as {@link HemisphereLight} does (in place of the built-in ambient, added to IBL, the fallback outside
 * LightProbes volumes without an environment, occluded by SSAO); one ambient light per engine. Coefficients and
 * intensity are live (a uniform write, no recompile).
 */
export class SHLight extends ShaderEffect {
  private buffer?: GPUBuffer;
  private gpu?: GPUDevice;
  private entry?: GPUBindGroupEntry[];
  private radiance: Float32Array<ArrayBuffer> = new Float32Array(27);
  private strength = 1;
  private dirty = true;
  /** Nine vec4: basis constant x band factor x intensity x coefficient. */
  private readonly values = new Float32Array(36);
  /** Same as `engine.use(new SHLight(...))`; returns the light. */
  static attach(engine: EngineKernel, options?: SHLightOptions): SHLight {
    const value = new SHLight(options);
    engine.use(value);
    return value;
  }
  constructor(options: SHLightOptions = {}) {
    super(options.name ?? 'environment:sh');
    if (options.coefficients !== undefined) this.radiance = flatten(options.coefficients);
    this.intensity = options.intensity ?? 1;
  }
  /** The radiance coefficients (27 numbers, coefficient-major); a copy. */
  get coefficients(): Float32Array {
    return this.radiance.slice();
  }
  set coefficients(value: SHCoefficients) {
    this.radiance = flatten(value);
    this.update();
  }
  /** Multiplies the light. */
  get intensity(): number {
    return this.strength;
  }
  set intensity(value: number) {
    if (typeof value !== 'number' || !Number.isFinite(Math.fround(value)) || value < 0)
      throw new RangeError('SH light intensity must be a finite number of 0 or more');
    this.strength = value;
    this.update();
  }
  /**
   * The light a surface facing `normal` receives, as the shader computes it: irradiance over pi x intensity (an albedo
   * `a` reflects `a` times this), clamped at zero.
   */
  irradiance(normal: readonly [number, number, number]): [number, number, number] {
    const e = evaluateSH(radianceToIrradianceSH(this.radiance), normal);
    return e.map((v) => Math.max(0, v * this.strength)) as [number, number, number];
  }
  private update(): void {
    for (let k = 0; k < 9; k++)
      for (let c = 0; c < 3; c++)
        this.values[k * 4 + c] = this.radiance[k * 3 + c] * SH_BASIS[k] * SH_IRRADIANCE_BANDS[k] * this.strength;
    this.dirty = true;
  }
  protected get device(): GPUDevice | undefined {
    return this.gpu;
  }
  protected entries(): GPUBindGroupEntry[] {
    if (this.dirty) {
      this.gpu!.queue.writeBuffer(this.buffer!, 0, this.values);
      this.dirty = false;
    }
    return this.entry!;
  }
  protected patch(source: string, group: number): string {
    return patchAmbient(this.name, source, wgsl(group));
  }
  protected hooks(group: number): PBRHooks {
    return { declarations: wgsl(group), sky: HEMISPHERE_TERM };
  }
  override setup(engine: EngineKernel): void {
    super.setup(engine);
    const device = engineRuntime(engine).gpu;
    if (!device) throw new MargoError('unsupported', 'SHLight requires the WebGPU backend');
    this.release();
    this.allocate(device);
  }
  onDeviceRestored(engine: EngineKernel): void {
    const device = engineRuntime(engine).gpu;
    this.release();
    if (device && !this.disposed) this.allocate(device);
  }
  private allocate(device: GPUDevice): void {
    this.buffer = device.createBuffer({
      label: 'SH light',
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.entry = [{ binding: HEMISPHERE_BINDING, resource: { buffer: this.buffer } }];
    this.gpu = device;
    this.dirty = true;
  }
  private release(): void {
    this.buffer?.destroy();
    this.buffer = this.gpu = this.entry = undefined;
  }
  override dispose(): void {
    super.dispose();
    this.release();
  }
}
