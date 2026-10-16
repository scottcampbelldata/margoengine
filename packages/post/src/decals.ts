/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
  type Vec3,
} from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { sceneTarget } from '../../shared/msaa.js';
import { MargoError } from '@margoengine/math/errors';
declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** A projected decal: a box projector along `direction` whose footprint is `width` x `height` (three.js DecalGeometry, as a screen-space pass). */
export interface Decal {
  /** World-space centre of the projector box. */
  position: Vec3;
  /** Projection direction, into the surface (world space; need not be unit length). */
  direction: Vec3;
  /** Footprint along the decal's right axis (`direction` x `up`) and up axis (world units). */
  width: number;
  height: number;
  /** Box extent along `direction` (default the smaller of width and height). Surfaces outside it are untouched; the last 10% at each end fades. */
  depth?: number;
  /** Orientation hint (default [0, 1, 0], or [0, 0, 1] when `direction` is vertical); must not be parallel to `direction`. */
  up?: Vec3;
  /** Atlas region [u0, v0, u1, v1] (0..1, v down; default the whole atlas). */
  rect?: readonly [number, number, number, number];
  /** Linear RGB multiplied with the atlas texel (default [1, 1, 1]). With mode 'over' it is emitted radiance and may exceed 1. */
  color?: Vec3;
  /** Multiplies the atlas alpha (0..1, default 1). */
  opacity?: number;
  /** Largest angle (radians) between the surface normal and -direction that still receives the decal; it fades over the last third (default PI / 3). */
  angle?: number;
  /** 'multiply' (default): scales the lit surface by the decal colour, so lighting and shadows stay (grime, paint on light surfaces, cracks).
   * 'over': blends the decal colour as unlit radiance (signs, glows). */
  mode?: 'multiply' | 'over';
}
/** Options of {@link Decals}. */
export interface DecalOptions {
  /** RGBA atlas the decals' `rect`s address (2D, sampled; mipmaps used when present). Default a 1x1 white texel. */
  atlas?: GPUTexture;
}
/** Decals per {@link Decals.setDecals} call. */
export const MAX_DECALS = 4096;
const FLOATS = 24;

// Box vertices from the vertex index: 36 corners of 12 triangles, each corner a sign in {-1, 1}^3 along right, up, forward.
// Back faces only (cullMode 'front'), no depth test: every covered pixel runs once, also with the camera inside the box.
// Fragment: world position from scene depth, local box coordinates, normal from the nearer neighbour depths per axis
// (no smearing across silhouettes), angle and depth fades, atlas sample with derivatives taken before any discard.
const shader = (multisampled: boolean) => /* wgsl */ `
struct View {matrix:mat4x4f,inverse:mat4x4f,eye:vec4f,screen:vec4f}
struct Decal {center:vec4f,right:vec4f,up:vec4f,forward:vec4f,rect:vec4f,color:vec4f}
@group(0) @binding(0) var<uniform> view:View;
@group(0) @binding(1) var<storage,read> decals:array<Decal>;
@group(0) @binding(2) var depth:${multisampled ? 'texture_depth_multisampled_2d' : 'texture_depth_2d'};
@group(0) @binding(3) var atlas:texture_2d<f32>;
@group(0) @binding(4) var atlasSampler:sampler;
struct Out {@builtin(position) clip:vec4f,@location(0) @interpolate(flat) id:u32}
@vertex fn vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) id:u32)->Out {
  let faces=array<u32,36>(0,2,1,1,2,3, 4,5,6,5,7,6, 0,1,4,1,5,4, 2,6,3,3,6,7, 0,4,2,2,4,6, 1,3,5,3,7,5);
  let c=faces[v];let s=vec3f(f32(c&1u),f32((c>>1u)&1u),f32((c>>2u)&1u))*2.0-1.0;let d=decals[id];
  var o:Out;o.clip=view.matrix*vec4f(d.center.xyz+s.x*d.right.xyz+s.y*d.up.xyz+s.z*d.forward.xyz,1.0);o.id=id;return o;
}
fn world(q:vec2i)->vec3f {
  let size=vec2i(view.screen.xy);let p=clamp(q,vec2i(0),size-1);let z=textureLoad(depth,p,0);
  let w=view.inverse*vec4f((f32(p.x)+0.5)/view.screen.x*2.0-1.0,1.0-(f32(p.y)+0.5)/view.screen.y*2.0,z,1.0);return w.xyz/w.w;
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
  let d=decals[i.id];let q=vec2i(i.clip.xy);let p=world(q);let r=p-d.center.xyz;
  let local=vec3f(dot(r,d.right.xyz)/dot(d.right.xyz,d.right.xyz),dot(r,d.up.xyz)/dot(d.up.xyz,d.up.xyz),dot(r,d.forward.xyz)/dot(d.forward.xyz,d.forward.xyz));
  let uv=mix(d.rect.xy,d.rect.zw,vec2f(local.x*0.5+0.5,0.5-local.y*0.5));let dx=dpdx(uv);let dy=dpdy(uv);
  let l=p-world(q-vec2i(1,0));let rr=world(q+vec2i(1,0))-p;let b=p-world(q-vec2i(0,1));let t=world(q+vec2i(0,1))-p;
  let ex=select(rr,l,dot(l,l)<dot(rr,rr));let ey=select(t,b,dot(b,b)<dot(t,t));var n=normalize(cross(ex,ey));n=select(-n,n,dot(n,view.eye.xyz-p)>0.0);
  let facing=dot(n,-normalize(d.forward.xyz));let cosine=d.right.w;
  let fade=smoothstep(cosine,mix(cosine,1.0,0.33),facing)*(1.0-smoothstep(0.8,1.0,abs(local.z)));
  let texel=textureSampleGrad(atlas,atlasSampler,uv,dx,dy);let a=texel.a*d.up.w*fade;
  if(any(abs(local)>vec3f(1.0))||a<=0.0){discard;}
  let color=texel.rgb*d.color.rgb;
  return select(vec4f(color,a),vec4f(mix(vec3f(1.0),color,a),1.0),d.center.w<0.5);
}
`;
const multiply: GPUBlendState = {
  color: { srcFactor: 'dst', dstFactor: 'zero' },
  alpha: { srcFactor: 'zero', dstFactor: 'one' },
};
const over: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'zero', dstFactor: 'one' },
};

/**
 * Projected decals as a screen-space pass (box projector, world position reconstructed from scene depth, normal-angle fade,
 * texture atlas): they land on everything that writes depth before order 1.9 (core meshes, gltf-pro and materials models,
 * terrain), after the opaque scene and before sky, water and transparent effects. Needs scene depth: attach a post
 * capture (Tonemap, Bloom, PostStack, SSAO, TAA) first. With no decals it records nothing.
 */
export class Decals implements EnginePlugin {
  readonly name = 'post:decals';
  readonly atlas?: GPUTexture;
  private engine?: Engine;
  private device?: GPUDevice;
  private uniform?: GPUBuffer;
  private storage?: GPUBuffer;
  private white?: GPUTexture;
  private sampler?: GPUSampler;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly layouts = new Map<boolean, GPUBindGroupLayout>();
  private group?: { key: unknown[]; group: GPUBindGroup };
  private depthViews = new WeakMap<GPUTexture, GPUTextureView>();
  private data = new Float32Array(0);
  private counts: [number, number] = [0, 0];
  private dirty = false;
  private disposed = false;
  private readonly values = new Float32Array(40);
  private readonly workspace = new Float64Array(52);
  private readonly pass: GPURenderPassDescriptor = {
    colorAttachments: [{ view: undefined as unknown as GPUTextureView, loadOp: 'load', storeOp: 'store' }],
  };
  constructor(options: DecalOptions = {}) {
    const atlas = options.atlas;
    if (
      atlas !== undefined &&
      (typeof atlas?.createView !== 'function' ||
        atlas.dimension !== '2d' ||
        !(atlas.usage & GPUTextureUsage.TEXTURE_BINDING))
    )
      throw new TypeError('Decal atlas must be a sampled 2D GPUTexture');
    this.atlas = atlas;
  }
  get owner(): Engine | undefined {
    return this.engine;
  }
  static attach(instance: EngineKernel, options?: DecalOptions): Decals {
    const decals = new Decals(options);
    engineRuntime(instance).use(decals);
    return decals;
  }
  /** Replaces the decals (at most {@link MAX_DECALS}); validates every entry before changing anything. Drawn in list order within each mode, 'multiply' first. */
  setDecals(list: readonly Decal[]): this {
    if (this.disposed || !Array.isArray(list) || list.length > MAX_DECALS)
      throw new RangeError(`Expected at most ${MAX_DECALS} decals`);
    const packed = list.map((d) => {
      const vec = (v: readonly number[] | undefined): boolean =>
        Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
      const f: readonly number[] = d?.direction,
        length = vec(f) ? Math.hypot(...f) : 0,
        size: number[] = [d?.width, d?.height, d?.depth ?? Math.min(d?.width, d?.height)],
        rect: readonly number[] = d?.rect ?? [0, 0, 1, 1],
        color: readonly number[] = d?.color ?? [1, 1, 1],
        opacity = d?.opacity ?? 1,
        angle = d?.angle ?? Math.PI / 3,
        mode = d?.mode ?? 'multiply';
      if (
        !vec(d?.position) ||
        !length ||
        !size.every((v) => Number.isFinite(v) && v > 0) ||
        !Array.isArray(rect) ||
        rect.length !== 4 ||
        !rect.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ||
        !vec(color) ||
        color.some((v) => v < 0) ||
        !(opacity >= 0 && opacity <= 1) ||
        !(angle > 0 && angle <= Math.PI / 2) ||
        (mode !== 'multiply' && mode !== 'over') ||
        (d.up !== undefined && !vec(d.up))
      )
        throw new RangeError(
          'Invalid decal: position, direction, positive size, rect in 0..1, color >= 0, opacity 0..1, angle in (0, PI/2], mode',
        );
      const n = f.map((v) => v / length),
        hint: readonly number[] = d.up ?? (Math.abs(n[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0]),
        r = [hint[1] * n[2] - hint[2] * n[1], hint[2] * n[0] - hint[0] * n[2], hint[0] * n[1] - hint[1] * n[0]],
        rl = Math.hypot(...r);
      if (!(rl > 1e-6 * Math.hypot(...hint))) throw new RangeError('Decal up is parallel to its direction');
      const right = r.map((v) => v / rl),
        up = [n[1] * right[2] - n[2] * right[1], n[2] * right[0] - n[0] * right[2], n[0] * right[1] - n[1] * right[0]];
      return {
        mode,
        values: [
          ...d.position,
          +(mode === 'over'),
          ...right.map((v) => (v * size[0]) / 2),
          Math.cos(angle),
          ...up.map((v) => (v * size[1]) / 2),
          opacity,
          ...n.map((v) => (v * size[2]) / 2),
          0,
          ...rect,
          ...color,
          0,
        ],
      };
    });
    const order = [...packed.filter((p) => p.mode === 'multiply'), ...packed.filter((p) => p.mode === 'over')];
    this.data = new Float32Array(order.length * FLOATS);
    order.forEach((p, i) => this.data.set(p.values, i * FLOATS));
    this.counts = [
      order.length - packed.filter((p) => p.mode === 'over').length,
      packed.filter((p) => p.mode === 'over').length,
    ];
    this.dirty = true;
    return this;
  }
  /** Number of decals set. */
  get count(): number {
    return this.counts[0] + this.counts[1];
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Decals require WebGPU and a live effect; attach a new Decals to a WebGPU engine',
      );
    this.engine = engine;
    this.device = engine.gpu;
    this.uniform = this.device.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    if (!this.atlas) {
      this.white = this.device.createTexture({
        size: [1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.device.queue.writeTexture(
        { texture: this.white },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4 },
        [1, 1],
      );
    }
    this.storage = undefined;
    this.dirty = true;
  }
  // After opaque meshes (0), gltf-pro models (1) and LOD (1.5); before sky (2), water (4) and volumetric fog (5).
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: 1.9,
      execute: (c) => {
        if (c.backend === 'webgpu' && this.count && c.device === this.device) this.render(c);
      },
    });
  }
  private render(c: Context): void {
    const device = c.device,
      target = sceneTarget(c);
    if (!target)
      throw new MargoError(
        'state',
        'Decals need scene depth: attach a post capture (Tonemap, Bloom, PostStack, SSAO, TAA) first',
      );
    const multisampled = target.samples > 1,
      depth = multisampled ? target.depthSource : this.depthView(target.resolvedDepth);
    if (this.dirty || !this.storage) {
      if (!this.storage || this.storage.size < this.data.byteLength) {
        this.storage?.destroy();
        this.storage = device.createBuffer({
          size: Math.max(FLOATS * 4, this.data.byteLength),
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.group = undefined;
      }
      device.queue.writeBuffer(this.storage, 0, this.data as Float32Array<ArrayBuffer>);
      this.dirty = false;
    }
    const v = this.values;
    v.set(c.camera.matrix);
    if (!invertMatrixStable(c.camera.matrix, v.subarray(16, 32), this.workspace)) return;
    v.set(c.camera.position, 32);
    v[36] = c.width;
    v[37] = c.height;
    device.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
    // One explicit layout per depth kind, so both blend pipelines share a bind group.
    let layout = this.layouts.get(multisampled);
    if (!layout) {
      const both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
      this.layouts.set(
        multisampled,
        (layout = device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: both, buffer: { type: 'uniform' } },
            { binding: 1, visibility: both, buffer: { type: 'read-only-storage' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', multisampled } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          ],
        })),
      );
    }
    const samples = c.descriptor.multisample?.count ?? 1,
      pipeline = (mode: 'multiply' | 'over') => {
        const key = mode + c.format + samples + multisampled;
        let p = this.pipelines.get(key);
        if (!p) {
          const module = device.createShaderModule({ code: shader(multisampled) });
          p = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [layout!] }),
            vertex: { module, entryPoint: 'vertex' },
            fragment: {
              module,
              entryPoint: 'fragment',
              targets: [{ format: c.format, blend: mode === 'multiply' ? multiply : over }],
            },
            primitive: { cullMode: 'front' },
            multisample: { count: samples },
          });
          this.pipelines.set(key, p);
        }
        return p;
      };
    const atlas = this.atlas ?? this.white!,
      key = [layout, this.storage, depth, atlas];
    if (!this.group || this.group.key.some((k, i) => k !== key[i]))
      this.group = {
        key,
        group: device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { buffer: this.uniform! } },
            { binding: 1, resource: { buffer: this.storage! } },
            { binding: 2, resource: depth! },
            { binding: 3, resource: atlas.createView() },
            { binding: 4, resource: this.sampler! },
          ],
        }),
      };
    (this.pass.colorAttachments as GPURenderPassColorAttachment[])[0].view = c.color;
    const pass = c.encoder.beginRenderPass(this.pass);
    if (this.counts[0]) {
      pass.setPipeline(pipeline('multiply'));
      pass.setBindGroup(0, this.group.group);
      pass.draw(36, this.counts[0]);
    }
    if (this.counts[1]) {
      pass.setPipeline(pipeline('over'));
      pass.setBindGroup(0, this.group.group);
      pass.draw(36, this.counts[1], 0, this.counts[0]);
    }
    pass.end();
  }
  private depthView(texture: GPUTexture): GPUTextureView {
    let view = this.depthViews.get(texture);
    if (!view) this.depthViews.set(texture, (view = texture.createView({ aspect: 'depth-only' })));
    return view;
  }
  private release(): void {
    this.uniform?.destroy();
    this.storage?.destroy();
    this.white?.destroy();
    this.uniform = this.storage = this.white = this.sampler = undefined;
    this.pipelines.clear();
    this.layouts.clear();
    this.group = undefined;
    this.depthViews = new WeakMap();
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
