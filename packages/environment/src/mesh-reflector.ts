// A planar reflection drawn over a flat mesh's own lit surface (drei's MeshReflectorMaterial): exported from
// @margoengine/environment/reflector-pbr.
import type { EngineKernel } from '@margoengine/core';
import type { Camera, PassContext } from '@margoengine/core/extension';
import { Reflector, type ReflectorOptions } from '@margoengine/environment/reflector';
import { invertMatrix } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';
import { linearColor, type ColorInput } from './color.js';

/** Options of {@link MeshReflector}: {@link ReflectorOptions} (its `roughness` is unused) and the mix below. */
export interface MeshReflectorOptions extends Omit<ReflectorOptions, 'roughness'> {
  /** Reflection weight: multiplies the Fresnel reflectance; the weight is clamped to 1. At least 0. Default 1. */
  mixStrength?: number;
  /** How much of the blurred image replaces the sharp one, 0 to 1 (more is clamped to 1). Default 1. */
  mixBlur?: number;
  /** Contrast of the reflected image about linear 0.5; 1 leaves it, 0 flattens it to grey. At least 0. Default 1. */
  mixContrast?: number;
  /** 0: the reflection weight follows the Fresnel reflectance; 1: every angle reflects as a mirror. 0 to 1. Default 0. */
  mirror?: number;
  /** Box blur of the captured image, [x, y] in capture pixels; [0, 0] draws it sharp. Each 0 to 4096. Default [0, 0]. */
  blur?: readonly [number, number];
  /**
   * World units to depth units: a reflected point at distance d from the mirror plane has depth d x depthScale. Above 0
   * the reflection fades and blurs with that depth, so contacts stay sharp and solid. 0 turns the depth terms off.
   * Default 0.
   */
  depthScale?: number;
  /** Depth where the fade and depth blur start (smoothstep lower edge). Default 0.9. */
  minDepthThreshold?: number;
  /** Depth where the reflection has faded out and the blur is full (smoothstep upper edge). Default 1. */
  maxDepthThreshold?: number;
  /** Blur weight added to the depth's, 0 to 1: the blur a contact keeps. Default 0.25. */
  depthToBlurRatioBias?: number;
  /** Moves the mirror plane along the surface normal, in world units, without moving the drawn surface. Default 0. */
  reflectorOffset?: number;
  /** Reflectance at normal incidence of the surface underneath: `'#rrggbb'`, `0xrrggbb` or linear `[r, g, b]`. Default 0.04 grey (a dielectric of IOR 1.5). */
  f0?: ColorInput;
}

const checked = (value: unknown, name: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`Invalid MeshReflector ${name} ${String(value)}; pass a finite number from ${min} to ${max}`);
  return value;
};
const LIMIT = 3.4e38;

// Blend over the mesh: the shader writes the weighted reflection premultiplied and the mean weight as alpha, so the
// surface underneath keeps (1 - weight) of its own lit colour. The destination alpha is kept.
const BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};

// Weight: Schlick's Fresnel (Schlick 1994) of the surface's F0, raised toward 1 by `mirror`, times `mixStrength`.
// Depth: the captured point's distance from the plane, read back through the capture's inverse view-projection (as
// PBRReflector). Blur: the capture's box-filtered mip chain read at the shorter axis' size, averaged in up to 16 taps
// along the longer axis. Contrast about 0.5, the depth fade and the tap layout are Margo design choices.
const FRAGMENT = `
  let dims=vec2f(textureDimensions(image,0));
  let sharp=textureSampleLevel(image,clampSampler,uv,0.0).rgb;
  let ddim=vec2i(textureDimensions(captureDepth));
  let texel=clamp(vec2i(uv*vec2f(ddim)),vec2i(0),ddim-1);
  let depth=textureLoad(captureDepth,texel,0);
  let world=u.mInv*vec4f(uv*vec2f(2.0,-2.0)+vec2f(-1.0,1.0),depth,1.0);
  let planeDistance=abs(dot(u.mPlane.xyz,world.xyz/max(world.w,1e-8))+u.mPlane.w);
  let x=select(planeDistance*u.mMix.w,1e30,depth==0.0);
  var fade=1.0;
  var blurWeight=1.0;
  if(u.mMix.w>0.0){
    let f=smoothstep(u.mDepth.x,u.mDepth.y,x);
    fade=1.0-f;
    blurWeight=clamp(f+u.mDepth.z,0.0,1.0);
  }
  var c=sharp;
  if(u.mDepth.w>0.5){
    let px=max(u.mBlur.xy,vec2f(1.0));
    let lod=min(log2(min(px.x,px.y)),u.size.z);
    let span=exp2(lod);
    let count=clamp(ceil(max(px.x,px.y)/span),1.0,16.0);
    let axis=select(vec2f(0.0,span),vec2f(span,0.0),px.x>=px.y)/dims;
    var sum=vec3f(0.0);
    let n=i32(count);
    for(var k=0;k<n;k++){
      sum+=textureSampleLevel(image,clampSampler,uv+axis*(f32(k)-(count-1.0)*0.5),lod).rgb;
    }
    c=mix(sharp,sum/count,clamp(u.mMix.y,0.0,1.0)*blurWeight);
  }
  c=max((c-vec3f(0.5))*u.mMix.z+vec3f(0.5),vec3f(0.0))*u.tint.rgb;
  let cosine=clamp(abs(dot(u.mPlane.xyz,normalize(u.mEye.xyz-i.world))),0.0,1.0);
  let fresnel=u.mF0.rgb+(vec3f(1.0)-u.mF0.rgb)*pow(1.0-cosine,5.0);
  let weight=clamp(u.mMix.x*mix(fresnel,vec3f(1.0),u.mF0.w)*fade,vec3f(0.0),vec3f(1.0));
  let alpha=(weight.r+weight.g+weight.b)/3.0;
  if(u.flags.y>0.5){return vec4f(c*weight,alpha);}
  return vec4f(toDisplay(c)*weight,alpha);
}`;

/**
 * drei's MeshReflectorMaterial for a flat mesh: a {@link Reflector} whose rectangle is drawn over the mesh's own lit
 * surface instead of replacing it. Each pixel keeps (1 - w) of the mesh's colour and adds the mirrored scene times w,
 * where w is the Fresnel reflectance of `f0` (raised toward 1 by `mirror`) times `mixStrength`. The reflection can be
 * box-blurred (`blur`, `mixBlur`), fade and blur with the reflected point's distance from the plane (`depthScale` and
 * the thresholds), take a contrast (`mixContrast`) and be distorted by `normalMap`. Put its `node` (through `parent`)
 * on the mesh's plane, `width` x `height` matching the mesh; the mesh should be left out of the capture (`exclude`).
 * On a display (non-HDR) target the blend happens on display values. WebGPU and the WebGL2 compatibility layer.
 */
export class MeshReflector extends Reflector {
  private strength = 1;
  private blurMix = 1;
  private contrast = 1;
  private mirrorValue = 0;
  private blurPixels: [number, number] = [0, 0];
  private depthScaleValue = 0;
  private minDepth = 0.9;
  private maxDepth = 1;
  private bias = 0.25;
  private offset = 0;
  private reflectance: [number, number, number] = [0.04, 0.04, 0.04];
  private constructed = false;
  private readonly inverse = new Float64Array(16);
  private readonly depthViews = new WeakMap<GPUTexture, GPUTextureView>();

  /** Same as `engine.use(new MeshReflector(options))`; returns it. */
  static override attach(engine: EngineKernel, options: MeshReflectorOptions = {}): MeshReflector {
    const value = new MeshReflector(options);
    engine.use(value);
    return value;
  }
  constructor(options: MeshReflectorOptions = {}) {
    if ((options as ReflectorOptions).roughness !== undefined)
      throw new TypeError('MeshReflector takes blur and mixBlur, not roughness; remove roughness');
    super(options);
    this.mixStrength = options.mixStrength ?? 1;
    this.mixBlur = options.mixBlur ?? 1;
    this.mixContrast = options.mixContrast ?? 1;
    this.mirror = options.mirror ?? 0;
    this.blurSize = options.blur ?? [0, 0];
    this.depthScale = options.depthScale ?? 0;
    this.minDepthThreshold = options.minDepthThreshold ?? 0.9;
    this.maxDepthThreshold = options.maxDepthThreshold ?? 1;
    this.depthToBlurRatioBias = options.depthToBlurRatioBias ?? 0.25;
    this.reflectorOffset = options.reflectorOffset ?? 0;
    if (options.f0 !== undefined) this.f0 = options.f0;
    this.constructed = true;
  }
  /** Reflection weight, 0 or more. Live. */
  get mixStrength(): number {
    return this.strength;
  }
  set mixStrength(value: number) {
    this.strength = checked(value, 'mixStrength', 0, LIMIT);
  }
  /** Share of the blurred image, 0 or more (clamped to 1 in the shader). Live. */
  get mixBlur(): number {
    return this.blurMix;
  }
  set mixBlur(value: number) {
    this.blurMix = checked(value, 'mixBlur', 0, LIMIT);
  }
  /** Contrast about linear 0.5, 0 or more. Live. */
  get mixContrast(): number {
    return this.contrast;
  }
  set mixContrast(value: number) {
    this.contrast = checked(value, 'mixContrast', 0, LIMIT);
  }
  /** 0 (Fresnel weight) to 1 (mirror at every angle). Live. */
  get mirror(): number {
    return this.mirrorValue;
  }
  set mirror(value: number) {
    this.mirrorValue = checked(value, 'mirror', 0, 1);
  }
  /** The `blur` option: box blur [x, y] in capture pixels, each 0 to 4096; non-zero builds the capture's mip chain. Live. */
  get blurSize(): readonly [number, number] {
    return [this.blurPixels[0], this.blurPixels[1]];
  }
  set blurSize(value: readonly [number, number]) {
    if (!Array.isArray(value) || value.length !== 2)
      throw new TypeError('Invalid MeshReflector blur; pass [x, y] in capture pixels');
    this.blurPixels = [checked(value[0], 'blur x', 0, 4096), checked(value[1], 'blur y', 0, 4096)];
    super.roughness = this.blurPixels[0] > 0 || this.blurPixels[1] > 0 ? 1 : 0;
  }
  /** Depth units per world unit; 0 turns the depth fade and blur off. Live. */
  get depthScale(): number {
    return this.depthScaleValue;
  }
  set depthScale(value: number) {
    this.depthScaleValue = checked(value, 'depthScale', 0, LIMIT);
  }
  /** Lower smoothstep edge of the depth terms. Live. */
  get minDepthThreshold(): number {
    return this.minDepth;
  }
  set minDepthThreshold(value: number) {
    this.minDepth = checked(value, 'minDepthThreshold', -LIMIT, LIMIT);
  }
  /** Upper smoothstep edge of the depth terms. Live. */
  get maxDepthThreshold(): number {
    return this.maxDepth;
  }
  set maxDepthThreshold(value: number) {
    this.maxDepth = checked(value, 'maxDepthThreshold', -LIMIT, LIMIT);
  }
  /** Blur weight added to the depth's, 0 to 1. Live. */
  get depthToBlurRatioBias(): number {
    return this.bias;
  }
  set depthToBlurRatioBias(value: number) {
    this.bias = checked(value, 'depthToBlurRatioBias', 0, 1);
  }
  /** Mirror plane offset along the normal, world units. Live. */
  get reflectorOffset(): number {
    return this.offset;
  }
  set reflectorOffset(value: number) {
    this.offset = checked(value, 'reflectorOffset', -LIMIT, LIMIT);
  }
  /** F0 of the surface underneath, linear RGB on read. Live. */
  get f0(): ColorInput {
    return this.reflectance.slice() as [number, number, number];
  }
  set f0(value: ColorInput) {
    const color = linearColor(value);
    for (const channel of color) checked(channel, 'f0 channel', 0, 1);
    this.reflectance = color;
  }
  /** Not used by MeshReflector: its blur is `blur` and `mixBlur`. Reads 0 or 1 (whether the mip chain is built). */
  override get roughness(): number {
    return super.roughness;
  }
  override set roughness(value: number) {
    // The base constructor sets its default; after construction only `blur` drives the mip chain.
    if (this.constructed) throw new TypeError('MeshReflector takes blur and mixBlur, not roughness; set blurSize and mixBlur instead');
    super.roughness = value;
  }
  protected override aim(main: Camera): boolean {
    if (this.minDepth >= this.maxDepth && this.depthScaleValue > 0)
      throw new RangeError('MeshReflector minDepthThreshold must be below maxDepthThreshold while depthScale is above 0; lower minDepthThreshold or raise maxDepthThreshold');
    const o = this.origin,
      n = this.normal,
      k = this.offset;
    o[0] += n[0] * k;
    o[1] += n[1] * k;
    o[2] += n[2] * k;
    return super.aim(main);
  }
  protected override get surfaceBlend(): GPUBlendState {
    return BLEND;
  }
  protected override get surfaceUniformLength(): number {
    return 104;
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
      throw new MargoError('state', 'MeshReflector capture matrix is singular; use a nonsingular camera projection');
    values.set(c.camera.position, 64);
    values[67] = 0;
    values.set(this.reflectance, 68);
    values[71] = this.mirrorValue;
    values.set([this.strength, this.blurMix, this.contrast, this.depthScaleValue], 72);
    const n = this.normal,
      o = this.origin;
    values.set([n[0], n[1], n[2], -(n[0] * o[0] + n[1] * o[1] + n[2] * o[2])], 76);
    const blurred = this.blurPixels[0] > 0 || this.blurPixels[1] > 0;
    values.set([this.minDepth, this.maxDepth, this.bias, blurred ? 1 : 0], 80);
    values.set([this.blurPixels[0], this.blurPixels[1], 0, 0], 84);
    values.set(this.inverse, 88);
  }
  protected override get surfaceShader(): string {
    const base = super.surfaceShader,
      start = base.indexOf('  let c=textureSampleLevel(image,clampSampler,uv,u.size.z).rgb*u.tint.rgb;');
    if (start < 0) throw new MargoError('state', 'MeshReflector found no planar surface colour line to replace; rebuild @margoengine/environment so reflector and reflector-pbr match');
    return (
      base
        .slice(0, start)
        .replace(
          'flags:vec4f }',
          'flags:vec4f, mEye:vec4f, mF0:vec4f, mMix:vec4f, mPlane:vec4f, mDepth:vec4f, mBlur:vec4f, mInv:mat4x4f }',
        )
        .replace(
          '@group(0) @binding(4) var repeatSampler:sampler;',
          '@group(0) @binding(4) var repeatSampler:sampler;\n@group(0) @binding(5) var captureDepth:texture_depth_2d;',
        ) + FRAGMENT
    );
  }
}
