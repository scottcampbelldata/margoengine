import type { EngineKernel } from '@margoengine/core';
import type { PassContext } from '@margoengine/core/extension';
import { Reflector, type ReflectorOptions } from '@margoengine/environment/reflector';
import { invertMatrix } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';
import { linearColor, type ColorInput } from './color.js';

/** Settings of a Fresnel floor with contact-preserving depth-dependent blur. */
export interface PBRReflectorOptions extends ReflectorOptions {
  /** Linear RGB or sRGB hex floor base color. Default '#808080'. */
  baseColor?: ColorInput;
  /** Metallic weight, 0..1. Default 0. */
  metalness?: number;
  /** Dielectric index of refraction, 1..4. Default 1.5 (F0 = 0.04). */
  ior?: number;
  /** World distance from the plane at which roughness reaches its full blur. Positive normal float32, default 10. */
  blurDistance?: number;
}
const checked = (value: number, name: string, min: number, max: number): number => {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`Invalid reflector ${name}; pass a finite value from ${min} to ${max}`);
  return value;
};

/** Schlick reflectance for cosine nv and scalar F0. Inputs must lie in 0..1. */
export function reflectorFresnel(nv: number, f0 = 0.04): number {
  checked(nv, 'view cosine', 0, 1);
  checked(f0, 'F0', 0, 1);
  return f0 + (1 - f0) * (1 - nv) ** 5;
}

/** Distance-based roughness fraction, clamped at the full-blur distance. Distances are world units. */
export function reflectorBlurFraction(distance: number, blurDistance = 10): number {
  checked(distance, 'distance', 0, Number.MAX_VALUE);
  checked(blurDistance, 'blurDistance', 2 ** -126, 3.4028234663852886e38);
  return Math.min(1, distance / blurDistance);
}

/**
 * Planar floor reflection with Schlick Fresnel and blur growing with the captured geometry's world distance
 * from the plane. Shares Reflector's capture, clipping, normal-map distortion, layers and device lifecycle.
 * The floor base is a uniform linear color; lighting baked into the capture stays HDR until scene output.
 */
export class PBRReflector extends Reflector {
  private base: [number, number, number] = [0, 0, 0];
  private metallic = 0;
  private eta = 1.5;
  private distanceValue = 10;
  private readonly inverse = new Float64Array(16);
  private readonly depthViews = new WeakMap<GPUTexture, GPUTextureView>();
  /** Attach this floor to engine, with the same transform convention as Reflector. */
  static override attach(engine: EngineKernel, options: PBRReflectorOptions = {}): PBRReflector {
    const floor = new PBRReflector(options);
    engine.use(floor);
    return floor;
  }
  constructor(options: PBRReflectorOptions = {}) {
    super(options);
    this.baseColor = options.baseColor ?? '#808080';
    this.metalness = options.metalness ?? 0;
    this.ior = options.ior ?? 1.5;
    this.blurDistance = options.blurDistance ?? 10;
  }
  /** Floor base, linear RGB on read; hex inputs are sRGB. */
  get baseColor(): ColorInput {
    return this.base.slice() as [number, number, number];
  }
  set baseColor(value: ColorInput) {
    const color = linearColor(value);
    for (const channel of color) checked(channel, 'baseColor channel', 0, 1);
    this.base = color;
  }
  /** Metallic weight, 0..1. Live without shader compilation. */
  get metalness(): number {
    return this.metallic;
  }
  set metalness(value: number) {
    this.metallic = checked(value, 'metalness', 0, 1);
  }
  /** Dielectric IOR, 1..4. Live without shader compilation. */
  get ior(): number {
    return this.eta;
  }
  set ior(value: number) {
    this.eta = checked(value, 'ior', 1, 4);
  }
  /** World distance from plane at full mip blur. Must fit a positive normal float32. */
  get blurDistance(): number {
    return this.distanceValue;
  }
  set blurDistance(value: number) {
    this.distanceValue = checked(value, 'blurDistance', 2 ** -126, 3.4028234663852886e38);
  }
  protected override get surfaceUniformLength(): number {
    return 96;
  }
  protected override get surfaceDepth(): GPUTextureView | undefined {
    const texture = this.target.depth;
    if (!texture) return undefined;
    let view = this.depthViews.get(texture);
    if (!view) {
      view = texture.createView({ aspect: 'depth-only' });
      this.depthViews.set(texture, view);
    }
    return view;
  }
  protected override surfaceUniforms(c: Extract<PassContext, { backend: 'webgpu' }>, values: Float32Array): void {
    if (!invertMatrix(this.camera.matrix, this.inverse))
      throw new MargoError('state', 'Reflector capture matrix is singular; use a nonsingular camera projection');
    values.set(c.camera.position, 64);
    values.set(this.base, 68);
    values.set([this.metalness, this.ior, this.blurDistance, 0], 72);
    const n = this.normal,
      o = this.origin;
    values.set([n[0], n[1], n[2], -(n[0] * o[0] + n[1] * o[1] + n[2] * o[2])], 76);
    values.set(this.inverse, 80);
  }
  protected override get surfaceShader(): string {
    return super.surfaceShader
      .replace('flags:vec4f }', 'flags:vec4f, pbrEye:vec4f, pbrBase:vec4f, pbr:vec4f, pbrPlane:vec4f, pbrInv:mat4x4f }')
      .replace(
        '@group(0) @binding(4) var repeatSampler:sampler;',
        '@group(0) @binding(4) var repeatSampler:sampler;\n@group(0) @binding(5) var captureDepth:texture_depth_2d;',
      )
      .replace(
        'let c=textureSampleLevel(image,clampSampler,uv,u.size.z).rgb*u.tint.rgb;',
        `
  let dimensions=vec2i(textureDimensions(captureDepth));
  let texel=clamp(vec2i(uv*vec2f(dimensions)),vec2i(0),dimensions-1);
  let depth=textureLoad(captureDepth,texel,0);
  let world=u.pbrInv*vec4f(uv*vec2f(2.0,-2.0)+vec2f(-1.0,1.0),depth,1.0);
  let planeDistance=select(abs(dot(u.pbrPlane.xyz,world.xyz/max(world.w,1e-8))+u.pbrPlane.w),u.pbr.z,depth==0.0);
  let lod=u.size.z*clamp(planeDistance/u.pbr.z,0.0,1.0);
  let reflected=textureSampleLevel(image,clampSampler,uv,lod).rgb*u.tint.rgb;
  let cosine=clamp(abs(dot(u.pbrPlane.xyz,normalize(u.pbrEye.xyz-i.world))),0.0,1.0);
  let dielectric=pow((u.pbr.y-1.0)/(u.pbr.y+1.0),2.0);
  let f0=mix(vec3f(dielectric),u.pbrBase.rgb,u.pbr.x);
  let fresnel=f0+(vec3f(1.0)-f0)*pow(1.0-cosine,5.0);
  let c=reflected*fresnel+u.pbrBase.rgb*(vec3f(1.0)-fresnel)*(1.0-u.pbr.x);`,
      );
  }
}
