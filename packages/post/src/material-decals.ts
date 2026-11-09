/// <reference lib="esnext.disposable" preserve="true" />
// Material decals, an HDR PostStack stage: box projectors that change a surface's normal, roughness, metalness and base
// colour, and so how it takes light, instead of painting over the lit colour. Each covered pixel's surface comes from a
// SceneTargets capture (albedo, world normal, roughness and metalness); the decals give a new surface; the pixel's
// direct sunlight and ambient light are worked out for both with the shading model of core's lit shader (Lambert plus
// GGX: Walter et al. 2007, Smith-GGX visibility, Schlick Fresnel) and the difference is added to the lit image. Shadow is
// kept: how much sun reached the pixel is read back from the lit image (lit minus ambient, over the unshadowed direct
// light) and the new direct light gets the same share. Tangent-space normals follow the decal's own right and up axes,
// projected onto the surface (Gram-Schmidt), as a normal map follows its UV axes.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext, Vec3 } from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';
import { finiteVector } from '@margoengine/math/validate';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { displayShader } from '../../shared/display.js';
import { fullscreen, group, render } from '../../shared/gpu.js';
import { ggxDFloat, smithGFloat } from '../../shared/light-terms.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { PostStack } from './stack.js';
import { unitLight } from '../../shared/unit-light.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** A projected material decal: a box projector, as `Decal` of `@margoengine/post/decals`, that changes the surface. */
export interface MaterialDecal {
  /** World-space centre of the projector box. */
  position: Vec3;
  /** Projection direction, into the surface (need not be unit length). */
  direction: Vec3;
  /** Footprint along the decal's right axis (`up` x `direction`) and up axis, world units, above 0. */
  width: number;
  height: number;
  /** Box extent along `direction`, above 0. Default the smaller of width and height; the last 10% at each end fades. */
  depth?: number;
  /** Orientation hint (default [0, 1, 0], or [0, 0, 1] when `direction` is vertical); must not be parallel to `direction`. */
  up?: Vec3;
  /** Atlas region [u0, v0, u1, v1], 0..1, v down. Default the whole atlas. */
  rect?: readonly [number, number, number, number];
  /** Multiplies the atlas alpha, 0 to 1. Default 1. */
  opacity?: number;
  /** Largest angle, radians in (0, PI/2], between the surface normal and -direction that still takes the decal; it fades over the last third. Default PI / 3. */
  angle?: number;
  /** Strength of the atlas normal, 0 to 4: 0 keeps the surface normal, 1 is the map as drawn. Default 1. */
  bump?: number;
  /** Roughness the covered surface takes, 0 to 1 (a wet patch: 0.1). Default unchanged. */
  roughness?: number;
  /** Metalness the covered surface takes, 0 to 1 (bare metal in a scratch: 1). Default unchanged. */
  metalness?: number;
  /** Linear RGB multiplied with the base colour, each 0 or more (grime: [0.4, 0.35, 0.3]). Default [1, 1, 1]. */
  color?: Vec3;
}

/** The capture a {@link MaterialDecals} reads: `SceneTargets` outputs of the built-in values of the same names. */
export interface MaterialDecalTargets {
  albedo: GPUTexture;
  normal: GPUTexture;
  material: GPUTexture;
}

/** Options of {@link MaterialDecals}; the object is kept and read every frame. */
export interface MaterialDecalsOptions {
  /**
   * The surface under the decals: a `SceneTargets` with outputs `albedo`, `normal` and `material` (built-in values),
   * as `() => ({albedo: targets.texture('albedo'), normal: targets.texture('normal'), material:
   * targets.texture('material')})`. Nothing changes while it is missing or returns undefined.
   */
  targets?: () => MaterialDecalTargets | undefined;
  /**
   * Tangent-space normal atlas the `rect`s address: RGB a normal map (OpenGL convention, green up), alpha the decal's
   * coverage. Sampled 2D GPUTexture, read at mip level 0. Default a flat normal of full coverage.
   */
  atlas?: GPUTexture;
  /** False passes frames through. Default true. */
  enabled?: boolean;
}

/** Decals per {@link MaterialDecals.setDecals} call: every pixel tests each of them. */
export const MAX_MATERIAL_DECALS = 64;
const FLOATS = 24;

const shader = (encode: boolean) => `${fullscreen}${encode ? displayShader : ''}
struct Decal {center:vec4f,right:vec4f,up:vec4f,forward:vec4f,rect:vec4f,color:vec4f}
struct U {inverse:mat4x4f,eye:vec4f,light:vec4f,radiance:vec4f,ambient:vec4f,count:vec4f,decals:array<Decal,${MAX_MATERIAL_DECALS}>}
struct Light {direct:vec3f,ambient:vec3f}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var image:texture_2d<f32>;
@group(0) @binding(2) var depth:texture_depth_2d;
@group(0) @binding(3) var albedo:texture_2d<f32>;
@group(0) @binding(4) var normals:texture_2d<f32>;
@group(0) @binding(5) var material:texture_2d<f32>;
@group(0) @binding(6) var atlas:texture_2d<f32>;
@group(0) @binding(7) var atlasSampler:sampler;
fn out(c:vec3f,a:f32)->vec4f {return vec4f(${encode ? 'toDisplay(c)' : 'c'},a);}
fn read(t:texture_2d<f32>,p:vec2i,size:vec2f)->vec4f {
 let s=vec2f(textureDimensions(t));return textureLoad(t,vec2i((vec2f(p)+0.5)*s/size),0);
}
// Core's lit shader: the sun's direct light (Lambert plus GGX) and the ambient term, in linear light.
fn shade(c:vec3f,r:f32,m:f32,n:vec3f,v:vec3f)->Light {
 let l=u.light.xyz;let h=(v+l)/max(length(v+l),0.0001);
 let nl=clamp(dot(n,l),0.0,1.0);let nv=clamp(dot(n,v),0.0001,1.0);let nh=clamp(dot(n,h),0.0,1.0);let vh=clamp(dot(v,h),0.0,1.0);
 let a=r*r;let a2=a*a;let d=${ggxDFloat};
 let g=${smithGFloat};
 let f0=mix(vec3f(0.04),c,m);let f=f0+(1.0-f0)*pow(1.0-vh,5.0);
 let direct=((1.0-f)*(1.0-m)*c/3.14159265+d*g*f/max(4.0*nl*nv,0.0001))*nl;
 return Light(direct*u.radiance.xyz*u.light.w,c*(1.0-m)*u.radiance.w*u.ambient.rgb);
}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let p=vec2i(at.xy);let size=vec2f(textureDimensions(depth));let lit=textureLoad(image,p,0);let z=textureLoad(depth,p,0);
 let count=u32(u.count.x);
 if(z<=0.0||count==0u){return out(lit.rgb,lit.a);}
 let w=u.inverse*vec4f(at.xy/size*vec2f(2,-2)+vec2f(-1,1),z,1);let pos=w.xyz/w.w;
 let c0=read(albedo,p,size).rgb;let n0=normalize(read(normals,p,size).xyz);let m0=read(material,p,size);
 var c=c0;var n=n0;var r=m0.x;var m=m0.y;var hit=false;
 for(var i=0u;i<count;i++){
  let d=u.decals[i];let rel=pos-d.center.xyz;
  let local=vec3f(dot(rel,d.right.xyz)/dot(d.right.xyz,d.right.xyz),dot(rel,d.up.xyz)/dot(d.up.xyz,d.up.xyz),dot(rel,d.forward.xyz)/dot(d.forward.xyz,d.forward.xyz));
  if(any(abs(local)>vec3f(1.0))){continue;}
  let facing=dot(n0,-normalize(d.forward.xyz));let cosine=d.center.w;
  let fade=smoothstep(cosine,mix(cosine,1.0,0.33),facing)*(1.0-smoothstep(0.8,1.0,abs(local.z)));
  let uv=mix(d.rect.xy,d.rect.zw,vec2f(local.x*0.5+0.5,0.5-local.y*0.5));
  let texel=textureSampleLevel(atlas,atlasSampler,uv,0.0);let a=texel.a*d.right.w*fade;
  if(a<=0.0){continue;}
  // The decal's right and up axes laid on the surface: the tangent frame its normal map is drawn in.
  let t=normalize(d.right.xyz-n*dot(n,d.right.xyz)+vec3f(1e-12));var b=cross(n,t);b=select(-b,b,dot(b,d.up.xyz)>=0.0);
  var tn=texel.xyz*2.0-1.0;tn=vec3f(tn.xy*d.up.w,max(tn.z,0.001));
  n=normalize(mix(n,normalize(t*tn.x+b*tn.y+n*tn.z),a));
  if(d.forward.w>=0.0){r=mix(r,d.forward.w,a);}
  if(d.color.w>=0.0){m=mix(m,d.color.w,a);}
  c=mix(c,c*d.color.rgb,a);hit=true;
 }
 if(!hit){return out(lit.rgb,lit.a);}
 let v=normalize(u.eye.xyz-pos);let before=shade(c0,m0.x,m0.y,n0,v);let after=shade(c,r,m,n,v);
 // The share of the unshadowed sun the pixel got, read back from the lit image; 1 where the sun gives it nothing to read.
 let dd=dot(before.direct,before.direct);
 let sun=select(1.0,clamp(dot(lit.rgb-before.ambient,before.direct)/dd,0.0,1.0),dd>1e-10);
 return out(max(lit.rgb+sun*(after.direct-before.direct)+after.ambient-before.ambient,vec3f(0)),lit.a);
}`;

/**
 * Material decals in a PostStack (HDR effect): box projectors that change the normal, roughness, metalness and base
 * colour of what they cover, and relight it, for bullet holes, dents, wet patches and grime with depth. The surface comes
 * from a `SceneTargets` capture; the light is the scene's sun and ambient (`engine.lighting`). Put it first among the
 * HDR effects, before SSR and Bloom.
 * ```ts
 * const targets = SceneTargets.attach(engine, {outputs: {albedo: 'albedo', normal: 'normal', material: 'material'}});
 * const decals = new MaterialDecals({targets: () => ({albedo: targets.texture('albedo')!, normal: targets.texture('normal')!, material: targets.texture('material')!})});
 * PostStack.attach(engine, [decals, new Tonemap()]);
 * decals.setDecals([{position: [0, 0, 0], direction: [0, -1, 0], width: 1, height: 1, roughness: 0.1}]);
 * ```
 * @throws RangeError when an option or decal is out of range; TypeError for a wrong type; MargoError `'state'` outside a
 * PostStack, `'unsupported'` without WebGPU, `'disposed'` after `dispose()`, `'attached'` when joined twice.
 */
export class MaterialDecals implements EnginePlugin {
  readonly name = 'material-decals';
  private engine?: Engine;
  private host?: StackHost;
  private stack?: PostStack;
  private stacked = false;
  private disposed = false;
  private uniform?: GPUBuffer;
  private flat?: GPUTexture;
  private sampler?: GPUSampler;
  private binding?: GPUBindGroup;
  private bound: readonly unknown[] = [];
  private data = new Float32Array(0);
  private readonly values = new Float32Array(36 + MAX_MATERIAL_DECALS * FLOATS);
  private readonly workspace = new Float64Array(52);
  private readonly pipelines = new Map<string, GPURenderPipeline>();

  constructor(readonly options: MaterialDecalsOptions = {}) {
    this.validate();
  }

  /** Attaches new MaterialDecals to `engine` alone in its own PostStack. */
  static attach(engine: EngineKernel, options: MaterialDecalsOptions = {}): MaterialDecals {
    const effect = new MaterialDecals(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }

  private validate(): void {
    const o = this.options;
    if (o.targets !== undefined && typeof o.targets !== 'function')
      throw new TypeError(
        'MaterialDecals targets must be a function returning {albedo, normal, material} or undefined',
      );
    const atlas = o.atlas;
    if (
      atlas !== undefined &&
      (typeof atlas?.createView !== 'function' ||
        atlas.dimension !== '2d' ||
        !(atlas.usage & GPUTextureUsage.TEXTURE_BINDING))
    )
      throw new TypeError('MaterialDecals atlas must be a sampled 2D GPUTexture');
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw new TypeError('MaterialDecals enabled must be a boolean; pass true or false');
  }

  /**
   * Replaces the decals (at most {@link MAX_MATERIAL_DECALS}), checking every entry before changing anything; later
   * decals apply over earlier ones. `setDecals([])` clears them.
   * @throws RangeError for a missing or invalid entry; TypeError when a value overflows Float32.
   */
  setDecals(list: readonly MaterialDecal[]): this {
    const count = Array.isArray(list) ? list.length : MAX_MATERIAL_DECALS + 1;
    if (this.disposed || count > MAX_MATERIAL_DECALS)
      throw new RangeError(`Expected at most ${MAX_MATERIAL_DECALS} material decals`);
    const vec = (v: readonly number[] | undefined): boolean =>
      Array.isArray(v) && v.length === 3 && [0, 1, 2].every((i) => Number.isFinite(v[i]));
    const unit = (v: number | undefined) => v === undefined || (v >= 0 && v <= 1);
    const packed = Array.from({ length: count }, (_, i) => {
      const d = list[i];
      if (!d || typeof d !== 'object') throw new RangeError('Invalid material decal: expected a decal object');
      const f: readonly number[] = d.direction,
        length = vec(f) ? Math.hypot(...f) : 0,
        size: number[] = [d.width, d.height, d.depth ?? Math.min(d.width, d.height)],
        rect: readonly number[] = d.rect ?? [0, 0, 1, 1],
        color: readonly number[] = d.color ?? [1, 1, 1],
        opacity = d.opacity ?? 1,
        angle = d.angle ?? Math.PI / 3,
        bump = d.bump ?? 1;
      if (
        !vec(d.position) ||
        !length ||
        !size.every((v) => Number.isFinite(v) && v > 0) ||
        !Array.isArray(rect) ||
        rect.length !== 4 ||
        ![0, 1, 2, 3].every((k) => Number.isFinite(rect[k]) && rect[k] >= 0 && rect[k] <= 1) ||
        !vec(color) ||
        color.some((v) => v < 0) ||
        !(opacity >= 0 && opacity <= 1) ||
        !(angle > 0 && angle <= Math.PI / 2) ||
        !(bump >= 0 && bump <= 4) ||
        !unit(d.roughness) ||
        !unit(d.metalness) ||
        (d.up !== undefined && !vec(d.up))
      )
        throw new RangeError(
          'Invalid material decal; position, direction and up need three finite numbers, size above 0, rect 0..1, color >= 0, opacity, roughness and metalness 0..1, bump 0..4, angle in (0, PI/2].',
        );
      const n = f.map((v) => v / length),
        hint: readonly number[] = d.up ?? (Math.abs(n[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0]),
        r = [hint[1] * n[2] - hint[2] * n[1], hint[2] * n[0] - hint[0] * n[2], hint[0] * n[1] - hint[1] * n[0]],
        rl = Math.hypot(...r);
      if (!(rl > 1e-6 * Math.hypot(...hint)))
        throw new RangeError(
          'Material decal up is parallel to its direction; give an up vector that points another way.',
        );
      const right = r.map((v) => v / rl),
        up = [n[1] * right[2] - n[2] * right[1], n[2] * right[0] - n[0] * right[2], n[0] * right[1] - n[1] * right[0]],
        values = [
          ...d.position,
          Math.cos(angle),
          ...right.map((v) => (v * size[0]) / 2),
          opacity,
          ...up.map((v) => (v * size[1]) / 2),
          bump,
          ...n.map((v) => (v * size[2]) / 2),
          d.roughness ?? -1,
          ...rect,
          ...color,
          d.metalness ?? -1,
        ];
      finiteVector(values, FLOATS, 'Material decal position, size and color');
      return values;
    });
    this.data = new Float32Array(packed.flat());
    return this;
  }

  /** Number of decals set. */
  get count(): number {
    return this.data.length / FLOATS;
  }

  private joinStack(host: StackHost): StackStage {
    if (this.engine || this.stacked || this.disposed)
      throw new MargoError('attached', 'MaterialDecals is already attached; create new MaterialDecals');
    this.stacked = true;
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.draw(c, input, output) };
  }

  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'MaterialDecals is disposed; create new MaterialDecals');
    if (!this.stacked)
      throw new MargoError(
        'state',
        'MaterialDecals runs inside a PostStack; use MaterialDecals.attach(engine) or add it to a PostStack',
      );
    if (!engine.gpu)
      throw new MargoError('unsupported', 'MaterialDecals requires WebGPU; it does not run on the WebGL2 fallback');
    this.engine = engine;
    const device = engine.gpu;
    this.uniform = device.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.flat = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: this.flat }, new Uint8Array([128, 128, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }

  /** Removes the effect, releases its GPU resources and disposes the stack `attach` created. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.stack?.dispose();
    this.stack = undefined;
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private draw(c: Context, input: GPUTextureView, output: StageOutput): GPUTextureView | void {
    this.validate();
    const o = this.options,
      surface = (o.enabled ?? true) && this.count ? o.targets?.() : undefined;
    if (!surface && output.hdr) return input;
    const device = c.device,
      depth = this.host!.depthTexture!,
      v = this.values,
      { direction, radiance, ambient } = this.engine!.lighting;
    if (!invertMatrixStable(c.camera.matrix, v.subarray(0, 16), this.workspace))
      throw new MargoError('state', 'Invalid MaterialDecals camera; give the camera a finite, invertible projection');
    v.set(c.camera.position, 16);
    unitLight(v, 20, direction);
    v.set(radiance, 24);
    v.set(ambient ?? [1, 1, 1], 28);
    v[32] = surface ? this.count : 0;
    v.set(this.data, 36);
    device.queue.writeBuffer(this.uniform!, 0, v, 0, 36 + this.data.length);
    const key = `${output.format}:${output.multisample?.count ?? 1}:${+!output.hdr}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = render(device, shader(!output.hdr), output.format, { multisample: output.multisample });
      this.pipelines.set(key, pipeline);
    }
    // Without a surface the stage only encodes the frame for display (count 0), so any bound texture will do.
    const albedo = surface?.albedo ?? this.flat!,
      parts = [pipeline, input, depth, albedo, surface?.normal, surface?.material, o.atlas];
    if (parts.some((part, i) => part !== this.bound[i])) {
      this.bound = parts;
      this.binding = group(device, pipeline, [
        { buffer: this.uniform! },
        input,
        depth.createView({ aspect: 'depth-only' }),
        albedo.createView(),
        (surface?.normal ?? this.flat!).createView(),
        (surface?.material ?? this.flat!).createView(),
        (o.atlas ?? this.flat!).createView(),
        this.sampler!,
      ]);
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: output.view, loadOp: viewLoadOp(c, 'clear'), storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.binding!);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }

  private release(): void {
    this.uniform?.destroy();
    this.flat?.destroy();
    this.uniform = this.flat = this.sampler = this.binding = undefined;
    this.bound = [];
    this.pipelines.clear();
  }
}
