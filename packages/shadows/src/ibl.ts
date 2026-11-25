/// <reference lib="esnext.disposable" preserve="true" />
// Shadows from the environment map, an HDR PostStack stage. Each frame a set of directions is drawn from the
// equirect's luminance, importance sampled through its marginal and conditional CDFs (Pharr, Jakob and Humphreys,
// "Physically Based Rendering", 3rd ed. 2016, 13.6.5 and 14.2.4), along a Halton (2, 3) sequence (Halton 1960). Every
// pixel of the frame depth traces its share of them against a BVH of the scene (rays walk the tree in the fragment
// shader, as shadows/rt does), in a 4x4 interleaved pattern so neighbouring pixels take different directions (Keller
// and Heidrich 2001, "Interleaved Sampling", EGWR). Visibility is kept as the ratio estimator of Heitz, Hill and McGuire
// 2018 ("Combining Analytic Direct Illumination and Stochastic Shadows", I3D): sum of cos * V over sum of cos for the
// same samples, which needs no radiance scale and cancels the sampler's weights. The two sums are reprojected into the
// previous frame and kept when the surface found there is the same point (reverse reprojection caching, Nehab, Sander,
// Lawrence, Tatarchuk and Isidoro 2007), decayed so a window of about `history` frames is kept, then summed over a
// small edge-stopped neighbourhood before they divide (edge stopping after Dammertz, Sewtz, Hanika and Lensch 2010,
// "Edge-Avoiding A-Trous Wavelet Transform"; Schied et al. 2017, SVGF, HPG). The frame colour is multiplied by the
// visibility.
// Compared and not chosen: screen-space tracing (Ritschel, Grosch and Seidel 2009, SSDO) misses off-screen and hidden
// casters; voxel cone tracing (Crassin et al. 2011) and voxel-plus-screen tracing blur contact shadows to the voxel size;
// median-cut light extraction with shadow maps (Debevec 2008) gives a fixed number of hard shadows; precomputed SH
// visibility (Sloan, Kautz and Snyder 2002) cannot follow moving casters. Structured importance sampling (Agarwal et al.
// 2003) is replaced by the per-frame sequence plus accumulation.
import type { MeshBVH } from '@margoengine/bvh';
import { GPUMeshBVH, bvhWGSL } from '@margoengine/bvh/gpu';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { displayFor, displayShader, premultipliedCanvas } from '../../shared/display.js';
import { fullscreen, group, render } from '../../shared/gpu.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { invert } from '../../shared/math.js';
import { canTraceShadows } from './rt.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** A linear equirectangular image, row 0 straight up, as `parseHDR` and `parseEXR` of @margoengine/environment give. */
export interface EnvironmentImage {
  readonly width: number;
  readonly height: number;
  /** Linear RGB or RGBA floats, width * height * 3 or * 4. */
  readonly data: Float32Array;
}
/** Piecewise-constant sampling tables over an equirect's luminance * sin(theta), from {@link environmentDistribution}. */
export interface EnvironmentDistribution {
  readonly width: number;
  readonly height: number;
  /** Cumulative row shares, ending at 1. */
  readonly marginal: Float32Array;
  /** Cumulative shares within each row, each row ending at 1. */
  readonly conditional: Float32Array;
  /** Sum of luminance * sin(theta) over all texels; 0 for a black image. */
  readonly total: number;
}
/** Options of {@link IBLShadows}; the object is kept and read every frame. */
export interface IBLShadowsOptions {
  /** Rays per pixel per frame, a whole number from 1 to 32. Default 4. */
  rays?: number;
  /** Share of the frame colour a fully occluded pixel loses, 0 to 1. Default 1. */
  strength?: number;
  /** Environment rotation about +Y in radians, as `Environment` `rotation`. Default 0. */
  rotation?: number;
  /** World units a ray starts off its surface, along the normal, above 0. Default 0.01. */
  bias?: number;
  /** World units a ray reaches, above 0. Default 1e6. */
  far?: number;
  /** Frames of history kept, a whole number from 1 (none) to 256. Default 32. */
  history?: number;
  /** Radius in pixels of the edge-stopped spatial filter, a whole number from 0 to 4. Default 2. */
  blur?: number;
  /** False passes frames through. Default true. */
  enabled?: boolean;
}

const TILE = 16;
const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Sampling tables for `image`: each texel's share is its luminance (Rec. 709) times sin(theta), the solid angle a row
 * covers, so directions follow the light the image sends.
 * @throws TypeError for a malformed image, RangeError for a negative or non-finite texel.
 */
export function environmentDistribution(image: EnvironmentImage): EnvironmentDistribution {
  const { width, height, data } = image ?? ({} as EnvironmentImage);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 1 << 24)
    throw new TypeError('Invalid environment size; pass whole texels, at most 16M in all');
  if (!(data instanceof Float32Array))
    throw new TypeError('Invalid environment data; pass a Float32Array of linear RGB(A)');
  const channels = data.length === width * height * 4 ? 4 : data.length === width * height * 3 ? 3 : 0;
  if (!channels) throw new TypeError('Invalid environment data length; pass width * height * 3 or * 4 floats');
  const marginal = new Float32Array(height),
    conditional = new Float32Array(width * height);
  let total = 0;
  for (let y = 0; y < height; y++) {
    const sin = Math.sin((Math.PI * (y + 0.5)) / height);
    let row = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels,
        r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      if (!(r >= 0 && g >= 0 && b >= 0 && r < Infinity && g < Infinity && b < Infinity))
        throw new RangeError(`Invalid environment texel ${x},${y}; pass finite linear radiance of 0 or more`);
      row += luminance(r, g, b) * sin;
      conditional[y * width + x] = row;
    }
    for (let x = 0; x < width; x++)
      conditional[y * width + x] = row > 0 ? conditional[y * width + x] / row : (x + 1) / width;
    total += row;
    marginal[y] = total;
  }
  for (let y = 0; y < height; y++) marginal[y] = total > 0 ? marginal[y] / total : (y + 1) / height;
  return { width, height, marginal, conditional, total };
}

// First index in [from, from + count) whose value exceeds u (the last one when none does).
const find = (cdf: Float32Array, from: number, count: number, u: number): number => {
  let lo = 0,
    hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[from + mid] > u) hi = mid;
    else lo = mid + 1;
  }
  return lo;
};
const radical = (i: number, base: number): number => {
  let f = 1,
    r = 0;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
};

/**
 * `count` world directions from `distribution`, as xyz and a weight in each four floats, starting at sequence index
 * `offset`. The weight is sin(theta) of the texel centre over sin(theta) of the sample: radiance over pdf divided by
 * a constant, all a ratio estimator needs. `rotation` turns them as `Environment` `rotation` does. A black image gives
 * weight 0.
 */
export function environmentDirections(
  distribution: EnvironmentDistribution,
  count: number,
  { rotation = 0, offset = 0 }: { rotation?: number; offset?: number } = {},
  out = new Float32Array(count * 4),
): Float32Array {
  const { width, height, marginal, conditional, total } = distribution,
    c = Math.cos(rotation),
    s = Math.sin(rotation);
  for (let k = 0; k < count; k++) {
    const i = (offset + k) % 0x1000000,
      u = radical(i + 1, 2),
      v = radical(i + 1, 3),
      y = find(marginal, 0, height, v),
      below = y ? marginal[y - 1] : 0,
      fy = (v - below) / Math.max(marginal[y] - below, 1e-30),
      x = find(conditional, y * width, width, u),
      left = x ? conditional[y * width + x - 1] : 0,
      fx = (u - left) / Math.max(conditional[y * width + x] - left, 1e-30),
      theta = (Math.PI * (y + Math.min(Math.max(fy, 0), 1))) / height,
      phi = 2 * Math.PI * ((x + Math.min(Math.max(fx, 0), 1)) / width - 0.5),
      sinT = Math.sin(theta),
      ex = sinT * Math.sin(phi),
      ez = -sinT * Math.cos(phi);
    // Environment space to world: the inverse of the lookup's (c x - s z, y, s x + c z).
    out[k * 4] = c * ex + s * ez;
    out[k * 4 + 1] = Math.cos(theta);
    out[k * 4 + 2] = -s * ex + c * ez;
    out[k * 4 + 3] = total > 0 && sinT > 0 ? Math.sin((Math.PI * (y + 0.5)) / height) / sinT : 0;
  }
  return out;
}

// The trace pass. axisStep takes the nearer of a pixel's two neighbours on each axis, so a depth edge does not bend
// the rebuilt normal. A 1x depth texel holds one sample of the pixel (the nearest on WebGPU, sample 0 on the WebGL2
// layer), not its centre, so the point can sit up to half a pixel step off the surface: the start adds that to `bias`,
// the slope-scaled offset of shadow mapping (Dou et al. 2014, "Adaptive Depth Bias for Shadow Maps").
const traceShader = (tree: string) => `${fullscreen}
struct U {view:mat4x4f,inverse:mat4x4f,previous:mat4x4f,trace:vec4f,blend:vec4f}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var<uniform> rays:array<vec4f,${TILE * 32}>;
@group(0) @binding(2) var depth:texture_depth_2d;
@group(0) @binding(3) var lastSurface:texture_2d<f32>;
@group(0) @binding(4) var lastWeight:texture_2d<f32>;
${tree}
struct Out {@location(0) surface:vec4f,@location(1) weight:f32}
fn surfaceAt(p:vec2i,size:vec2f)->vec4f {
 let d=textureLoad(depth,p,0);let h=u.inverse*vec4f((vec2f(p)+0.5)/size*vec2f(2,-2)+vec2f(-1,1),d,1);
 return vec4f(h.xyz/h.w,select(0.0,1.0,d>0));
}
fn axisStep(at:vec3f,ahead:vec4f,behind:vec4f)->vec3f {
 let f=ahead.xyz-at;let b=at-behind.xyz;
 let fl=select(3.4e38,dot(f,f),ahead.w>0&&dot(f,f)>0);let bl=select(3.4e38,dot(b,b),behind.w>0&&dot(b,b)>0);
 return select(b,f,fl<=bl);
}
@fragment fn fragment(@builtin(position) at:vec4f)->Out {
 let p=vec2i(at.xy);let size=vec2f(textureDimensions(depth));let last=vec2i(size)-1;
 let here=surfaceAt(p,size);
 if(here.w==0){return Out(vec4f(0),0);}
 let pos=here.xyz;
 let dx=axisStep(pos,surfaceAt(min(p+vec2i(1,0),last),size),surfaceAt(max(p-vec2i(1,0),vec2i(0)),size));
 let dy=axisStep(pos,surfaceAt(min(p+vec2i(0,1),last),size),surfaceAt(max(p-vec2i(0,1),vec2i(0)),size));
 let near=u.inverse*vec4f((vec2f(p)+0.5)/size*vec2f(2,-2)+vec2f(-1,1),1,1);
 let toEye=normalize(near.xyz/near.w-pos);
 var n=cross(dx,dy);
 n=select(toEye,normalize(n),dot(n,n)>0);
 n=select(n,-n,dot(n,toEye)<0);
 let footprint=sqrt(max(dot(dx,dx),dot(dy,dy)));
 let count=u32(u.trace.x);let tile=u32(p.x&3)+4u*u32(p.y&3);
 let start=pos+n*(u.trace.y+0.5*footprint);
 var lit=0.0;var sum=0.0;
 if(u.trace.w>0){
  for(var j=0u;j<count;j++){
   let s=rays[tile*count+j];let c=dot(n,s.xyz)*s.w;
   if(c>0){sum+=c;if(bvhAny(start,s.xyz,0.0,u.trace.z,0u).face==BVH_MISS){lit+=c;}}
  }
 }
 var keep=vec2f(0);
 let back=u.previous*vec4f(pos,1);
 if(u.blend.w==0&&back.w>0){
  let q=back.xy/back.w*vec2f(0.5,-0.5)+0.5;
  if(all(q>=vec2f(0))&&all(q<vec2f(1))){
   let o=vec2i(q*size);let old=textureLoad(lastSurface,o,0);
   if(distance(old.xyz,pos)<=3*footprint+1e-6*length(pos)){keep=vec2f(old.w,textureLoad(lastWeight,o,0).x);}
  }
 }
 let sums=keep*u.blend.x+vec2f(lit,sum);
 return Out(vec4f(pos,sums.x),sums.y);
}`;

// The compose pass sums the two ratio terms over the blur window and divides once.
// ponytail: the edge stop is a distance test, not a plane test; it keeps a few pixels of a nearby surface at a contact.
const composeShader = (encode: boolean) => `${fullscreen}${encode ? displayShader : ''}
struct U {view:mat4x4f,inverse:mat4x4f,previous:mat4x4f,trace:vec4f,blend:vec4f}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var surface:texture_2d<f32>;
@group(0) @binding(3) var weight:texture_2d<f32>;
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let p=vec2i(at.xy);let now=textureLoad(scene,p,0);let last=vec2i(textureDimensions(surface))-1;
 let centre=textureLoad(surface,p,0);var shade=1.0;
 if(u.blend.z>0&&textureLoad(weight,p,0).x>0){
  var reach=0.0;
  for(var k=0;k<4;k++){
   let o=clamp(p+array<vec2i,4>(vec2i(1,0),vec2i(-1,0),vec2i(0,1),vec2i(0,-1))[k],vec2i(0),last);
   if(textureLoad(weight,o,0).x>0){reach=max(reach,distance(textureLoad(surface,o,0).xyz,centre.xyz));}
  }
  let r=i32(u.blend.y);var sums=vec2f(0);
  for(var j=-r;j<=r;j++){
   for(var i=-r;i<=r;i++){
    let o=clamp(p+vec2i(i,j),vec2i(0),last);let s=textureLoad(surface,o,0);let w=textureLoad(weight,o,0).x;
    if(w>0&&distance(s.xyz,centre.xyz)<=2*f32(max(abs(i),abs(j))+1)*reach+1e-6*length(centre.xyz)){sums+=vec2f(s.w,w);}
   }
  }
  shade=mix(1.0,clamp(sums.x/sums.y,0.0,1.0),u.blend.z);
 }
 let rgb=now.rgb*shade;
 return vec4f(${encode ? 'toDisplay(rgb)' : 'rgb'},now.a);
}`;

/**
 * Soft shadows and occlusion from the environment map, in a PostStack (HDR effect): every pixel's share of light from
 * the environment that the scene in `bvh` lets through, traced each frame toward the image's bright regions and kept
 * over frames. Place it first among the HDR effects. It scales the whole frame colour, so other lights in the pixel
 * dim as well; use it where the environment is the main light.
 * ```ts
 * PostStack.attach(engine, [new IBLShadows(bvh, image, {rays: 4}), new Tonemap()]);
 * ```
 * After moving what the tree holds, call `bvh.refit()`; the effect sends it again on the next frame.
 * @throws TypeError or RangeError for a bad image or option (options are checked now and every frame); MargoError
 * `'state'` outside a PostStack, `'unsupported'` where the device cannot read storage buffers in a fragment shader,
 * `'disposed'` after `dispose()`, `'attached'` when joined twice.
 */
export class IBLShadows implements EnginePlugin {
  readonly name = 'ibl-shadows';
  /** The sampling tables of the image, built once. */
  readonly distribution: EnvironmentDistribution;
  private engine?: Engine;
  private host?: StackHost;
  private stacked = false;
  private disposed = false;
  private fresh = true;
  private frame = 0;
  private revision = -1;
  private tree?: GPUMeshBVH;
  private uniform?: GPUBuffer;
  private directions?: GPUBuffer;
  private surfaces: GPUTexture[] = [];
  private weights: GPUTexture[] = [];
  private last = 0;
  private tracer?: GPURenderPipeline;
  private readonly composers = new Map<string, GPURenderPipeline>();
  private traces: (GPUBindGroup | undefined)[] = [];
  private composes = new Map<GPURenderPipeline, readonly [GPUTextureView, GPUBindGroup][]>();
  private depth?: GPUTexture;
  private readonly values = new Float32Array(56);
  private readonly previous = new Float32Array(16);
  private readonly workspace = new Float64Array(52);
  private readonly rays = new Float32Array(TILE * 32 * 4);

  constructor(
    readonly bvh: MeshBVH,
    environment: EnvironmentImage | EnvironmentDistribution,
    readonly options: IBLShadowsOptions = {},
  ) {
    if (!bvh || typeof (bvh as { refit?: unknown }).refit !== 'function')
      throw new TypeError(
        'IBLShadows needs a MeshBVH of the casters; pass MeshBVH.build(worldTriangles(engine, meshes))',
      );
    this.distribution =
      'marginal' in (environment ?? {})
        ? (environment as EnvironmentDistribution)
        : environmentDistribution(environment as EnvironmentImage);
    this.validate();
  }

  private validate(): void {
    const o = this.options,
      whole = (v: number | undefined, lo: number, hi: number) =>
        v === undefined || (Number.isInteger(v) && v >= lo && v <= hi),
      above = (v: number | undefined) => v === undefined || (Number.isFinite(v) && v > 0);
    if (!whole(o.rays, 1, 32)) throw new RangeError('IBLShadows rays must be a whole number from 1 to 32');
    if (!whole(o.history, 1, 256))
      throw new RangeError('IBLShadows history must be a whole number of frames from 1 to 256');
    if (!whole(o.blur, 0, 4)) throw new RangeError('IBLShadows blur must be a whole number of pixels from 0 to 4');
    if (o.strength !== undefined && !(o.strength >= 0 && o.strength <= 1))
      throw new RangeError('IBLShadows strength must be in 0..1; pass a share of the light');
    if (!above(o.bias) || !above(o.far))
      throw new RangeError('IBLShadows bias and far must be finite and above 0; pass world units');
    if (o.rotation !== undefined && !Number.isFinite(o.rotation))
      throw new RangeError('IBLShadows rotation must be a finite number of radians');
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw new TypeError('IBLShadows enabled must be a boolean; pass true or false');
  }

  /** Drops the history, as after a camera cut; the next frame starts again from its own rays. */
  reset(): void {
    this.fresh = true;
  }

  private joinStack(host: StackHost): StackStage {
    if (this.engine || this.stacked || this.disposed)
      throw new MargoError('attached', 'IBLShadows is already attached; create a new IBLShadows');
    this.stacked = true;
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.draw(c, input, output) };
  }

  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'IBLShadows is disposed; create a new IBLShadows');
    if (!this.stacked)
      throw new MargoError('state', 'IBLShadows runs inside a PostStack; add it to PostStack.attach(engine, [...])');
    if (!engine.gpu || !canTraceShadows(engine))
      throw new MargoError(
        'unsupported',
        'IBLShadows needs four storage buffers in a fragment shader; this device has fewer, use ContactShadows or SSAO',
      );
    const device = engine.gpu;
    this.engine = engine;
    try {
      this.tree = GPUMeshBVH.forShader(device, this.bvh);
      this.revision = this.bvh.revision;
      this.uniform = device.createBuffer({ size: 224, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.directions = device.createBuffer({
        size: this.rays.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    } catch (error) {
      this.release();
      throw error;
    }
    this.fresh = true;
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }

  /** Removes the effect and releases its GPU resources. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private targets(device: GPUDevice, width: number, height: number): void {
    if (this.surfaces[0]?.width === width && this.surfaces[0].height === height) return;
    this.releaseTargets();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    for (let i = 0; i < 2; i++) {
      this.surfaces[i] = device.createTexture({
        label: 'ibl shadows surface',
        size: [width, height],
        format: 'rgba32float',
        usage,
      });
      this.weights[i] = device.createTexture({
        label: 'ibl shadows weight',
        size: [width, height],
        format: 'r32float',
        usage,
      });
    }
    this.fresh = true;
  }

  private draw(c: Context, input: GPUTextureView, output: StageOutput): GPUTextureView | void {
    this.validate();
    const o = this.options,
      enabled = o.enabled ?? true;
    if (!enabled) {
      this.fresh = true;
      if (output.hdr) return input;
    }
    const device = c.device,
      depth = this.host!.depthTexture!,
      v = this.values;
    this.targets(device, depth.width, depth.height);
    if (this.depth !== depth) {
      this.depth = depth;
      this.traces = [];
    }
    v.set(c.camera.matrix);
    if (!invert(v.subarray(16, 32), c.camera.matrix, 0, this.workspace))
      throw new MargoError('state', 'Invalid IBLShadows camera; give the camera a finite, invertible projection');
    v.set(this.fresh ? c.camera.matrix : this.previous, 32);
    const rays = o.rays ?? 4,
      history = o.history ?? 32;
    v.set([rays, o.bias ?? 0.01, o.far ?? 1e6, this.distribution.total > 0 ? 1 : 0], 48);
    v.set([1 - 1 / history, o.blur ?? 2, enabled ? (o.strength ?? 1) : 0, +this.fresh], 52);
    device.queue.writeBuffer(this.uniform!, 0, v);
    const next = this.last ^ 1;
    if (enabled) {
      if (this.bvh.revision !== this.revision) {
        this.tree!.update();
        this.revision = this.bvh.revision;
      }
      environmentDirections(
        this.distribution,
        TILE * rays,
        { rotation: o.rotation ?? 0, offset: this.frame * TILE * rays },
        this.rays,
      );
      this.frame = (this.frame + 1) % 0x10000;
      device.queue.writeBuffer(this.directions!, 0, this.rays, 0, TILE * rays * 4);
      if (!this.tracer) {
        const module = device.createShaderModule({ code: traceShader(bvhWGSL({ group: 0, binding: 5 })) });
        this.tracer = device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba32float' }, { format: 'r32float' }] },
        });
      }
      const t = this.tree!;
      const bindings = (this.traces[next] ??= group(device, this.tracer, [
        { buffer: this.uniform! },
        { buffer: this.directions! },
        depth.createView({ aspect: 'depth-only' }),
        this.surfaces[this.last].createView(),
        this.weights[this.last].createView(),
        ...[t.nodes, t.index, t.faces, t.positions, t.params].map((buffer) => ({ buffer })),
      ]));
      const pass = c.encoder.beginRenderPass({
        colorAttachments: [
          { view: this.surfaces[next].createView(), loadOp: 'clear', storeOp: 'store' },
          { view: this.weights[next].createView(), loadOp: 'clear', storeOp: 'store' },
        ],
      });
      pass.setPipeline(this.tracer);
      pass.setBindGroup(0, bindings);
      pass.draw(3);
      pass.end();
      this.last = next;
      this.fresh = false;
      // The next frame reprojects into this one. Kept here: a second writeBuffer would land before this frame's pass.
      this.previous.set(c.camera.matrix);
    }
    const key = `${output.format}:${output.multisample?.count ?? 1}:${+output.hdr}:${premultipliedCanvas(this.engine)}`;
    let composer = this.composers.get(key);
    if (!composer) {
      composer = render(device, displayFor(this.engine, composeShader(!output.hdr)), output.format, {
        multisample: output.multisample,
      });
      this.composers.set(key, composer);
    }
    let cached = this.composes.get(composer);
    const at = this.last;
    if (!cached || cached[at]?.[0] !== input) {
      const made = [...(cached ?? [])] as [GPUTextureView, GPUBindGroup][];
      made[at] = [
        input,
        group(device, composer, [
          { buffer: this.uniform! },
          input,
          this.surfaces[at].createView(),
          this.weights[at].createView(),
        ]),
      ];
      this.composes.set(composer, (cached = made));
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: output.view, loadOp: viewLoadOp(c, 'clear'), storeOp: 'store' }],
    });
    pass.setPipeline(composer);
    pass.setBindGroup(0, cached[at][1]);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }

  private releaseTargets(): void {
    for (const t of [...this.surfaces, ...this.weights]) t.destroy();
    this.surfaces = [];
    this.weights = [];
    this.traces = [];
    this.composes.clear();
  }

  private release(): void {
    this.releaseTargets();
    this.tree?.dispose();
    this.uniform?.destroy();
    this.directions?.destroy();
    this.tree = this.uniform = this.directions = this.tracer = this.depth = undefined;
    this.composers.clear();
  }
}
