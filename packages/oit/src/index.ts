/// <reference lib="esnext.disposable" preserve="true" />
// Weighted blended order-independent transparency (McGuire and Bavoil, JCGT 2013) for gltf/pbr BLEND primitives and
// @margoengine/materials transparent meshes, through gltf/pbr's transparency hook (no shader text search).
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type PassContext } from '@margoengine/core/extension';
import { applyView } from '../../shared/view-rect.js';
import { currentFrame, retire, writeUniform } from '../../shared/frame-resources.js';
import { groupCode } from '../../shared/pass.js';
import { TransparentPass, pbrLayer } from './pass.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Weighted blended OIT settings, fixed at construction. */
export interface OITOptions {
  /** Frame graph order of the transparent and composite passes: after the scene and its overlays (edges 6), before SSAO (10), TAA (9) and post composites (30). Default 8. */
  order?: number;
  /** World distance the depth weight is centred on (where a nearer layer starts to dominate). Default: the camera's distance to its target, every frame. */
  depthScale?: number;
  /**
   * Also takes additive and multiply materials and native transmission (a transmission hook keeps its own), so tints and
   * glows blend in any order. Costs one more `rgba16float` target, an `r8unorm` mark for `blendSpace: 'linear'` layers
   * and a second composite draw. Default false.
   */
  blending?: boolean;
}

// Group-2 binding, clear of shadows (1-3), clustered (10-16), IBL/fog (20-25), materials (32-43) and shader nodes.
const BINDING = 120;
// Weight: alpha * clamp(10 / (depth / scale)^6, 0.01, 1000). The power sets how strongly a nearer layer wins (exact for
// two 50% layers 12% apart in depth); the clamp keeps 64 LDR layers inside rgba16float. Unclamped from 0.46 to 3.2 x scale.
// `margoLinear` (KB3148d): a `blendSpace: 'linear'` layer. It clears reveal.g (non-blending) or the `linear` target
// (blending), so the composite knows which pixels to mix in linear light.
const surface = (group: number) => /* wgsl */ `
override margoLinear:bool=false;
struct MargoTransparent {@location(0) accum:vec4f, @location(1) reveal:vec4f}
@group(${group}) @binding(${BINDING}) var<uniform> margoOIT:vec4f;
fn margoTransparentAt(color:vec4f,clip:vec4f,depth:f32)->MargoTransparent {
  let a=clamp(color.a,0.0,1.0); let d=max(depth*margoOIT.x,1e-4);
  let w=a*clamp(10.0/pow(d,6.0),0.01,1000.0); var o:MargoTransparent;
  o.accum=vec4f(color.rgb*w,w); o.reveal=vec4f(a,select(0.0,1.0,margoLinear),0,0); return o;
}
`;
// `blending`: what each kind of surface leaves. Light adds in `added`, the background multiplies by `reveal.rgb`, and
// `reveal.a` keeps the coverage of normal layers alone, which scales their average colour.
const surfaceBlended = (group: number) => /* wgsl */ `
override margoKind:u32=0u;
override margoLinear:bool=false;
struct MargoTransparent {@location(0) accum:vec4f, @location(1) reveal:vec4f, @location(2) added:vec4f, @location(3) linear:vec4f}
@group(${group}) @binding(${BINDING}) var<uniform> margoOIT:vec4f;
fn margoTransparentTint(share:vec4f)->MargoTransparent {
  var o:MargoTransparent; o.reveal=vec4f(share.rgb,1.0); o.linear=vec4f(0); return o;
}
fn margoTransparentAt(color:vec4f,clip:vec4f,depth:f32)->MargoTransparent {
  let a=clamp(color.a,0.0,1.0); var o:MargoTransparent; o.reveal=vec4f(1.0); o.linear=vec4f(select(0.0,1.0,margoLinear));
  if(margoKind==0u){
    let d=max(depth*margoOIT.x,1e-4);
    let w=a*clamp(10.0/pow(d,6.0),0.01,1000.0); o.accum=vec4f(color.rgb*w,w); o.reveal=vec4f(1.0-a);
  } else if(margoKind==1u){o.added=vec4f(color.rgb*a,a);}
  else if(margoKind==2u){o.reveal=vec4f(color.rgb,1.0);}
  else {o.added=vec4f(color.rgb,a);}
  return o;
}
`;
// Over the opaque result: average colour accum.rgb/accum.a at coverage 1 - revealage (premultiplied over, so a
// TransparentCanvas keeps valid alpha). Untouched pixels have revealage 1 and blend nothing.
const composite = /* wgsl */ `
@group(0) @binding(0) var accumMap:texture_2d<f32>;
@group(0) @binding(1) var revealMap:texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
  let q=vec2i(p.xy); let a=textureLoad(accumMap,q,0); return vec4f(a.rgb/max(a.a,1e-5),1-textureLoad(revealMap,q,0).r);
}
`;

// `blending`: dst * reveal, then + light, as two draws: a colour factor per channel and a sum need two blends.
const compositeBlended = /* wgsl */ `
@group(0) @binding(0) var accumMap:texture_2d<f32>;
@group(0) @binding(1) var revealMap:texture_2d<f32>;
@group(0) @binding(2) var addedMap:texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);}
@fragment fn dim(@builtin(position) p:vec4f)->@location(0) vec4f {return textureLoad(revealMap,vec2i(p.xy),0);}
@fragment fn light(@builtin(position) p:vec4f)->@location(0) vec4f {
  let q=vec2i(p.xy); let a=textureLoad(accumMap,q,0); let r=textureLoad(revealMap,q,0).a; let l=textureLoad(addedMap,q,0);
  return vec4f(a.rgb/max(a.a,1e-5)*(1-r)+l.rgb,1-r+l.a);
}
`;
// KB3148d: pixels a linear layer touched, drawn after the composites above with blending off. `scene` is the colour
// before them (the native glass snapshot); `mark` is 1 where no linear layer drew, so a partly covered edge mixes the
// two results. In linear light: encode(decode(average) * coverage + decode(scene) * revealage); the weighted average
// itself stays the one the display composite uses (McGuire and Bavoil 2013), decoded once per pixel.
const linearComposite = (blended: boolean) => /* wgsl */ `
@group(0) @binding(0) var accumMap:texture_2d<f32>;
@group(0) @binding(1) var revealMap:texture_2d<f32>;
@group(0) @binding(2) var sceneMap:texture_2d<f32>;
${blended ? '@group(0) @binding(3) var addedMap:texture_2d<f32>; @group(0) @binding(4) var markMap:texture_2d<f32>;' : ''}
fn decode(c:vec3f)->vec3f {let x=max(c,vec3f(0));return select(x/12.92,pow((x+0.055)/1.055,vec3f(2.4)),x>vec3f(0.04045));}
fn encode(c:vec3f)->vec3f {let x=max(c,vec3f(0));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>vec3f(0.0031308));}
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
  let q=vec2i(p.xy); let v=textureLoad(revealMap,q,0);
  ${blended ? 'let mark=textureLoad(markMap,q,0).r; let r=v.a; let dim=v.rgb; let l=textureLoad(addedMap,q,0);' : 'let mark=v.g; let r=v.r; let dim=vec3f(r); let l=vec4f(0);'}
  if(mark>=1.0){discard;}
  let a=textureLoad(accumMap,q,0); let avg=a.rgb/max(a.a,1e-5); let d=textureLoad(sceneMap,q,0);
  let shown=d.rgb*dim+avg*(1-r)+l.rgb; let light=encode(decode(d.rgb)*dim+decode(avg)*(1-r))+l.rgb;
  return vec4f(mix(light,shown,mark),d.a*r+1-r+l.a);
}
`;
const add: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one' },
  alpha: { srcFactor: 'one', dstFactor: 'one' },
};
const dim: GPUBlendState = {
  color: { srcFactor: 'zero', dstFactor: 'src' },
  alpha: { srcFactor: 'zero', dstFactor: 'src' },
};
const reveal: GPUBlendState = {
  color: { srcFactor: 'zero', dstFactor: 'one-minus-src' },
  alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src' },
};
const over: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
};

/**
 * Order-independent transparency: `oit.add(model)` draws the model's BLEND primitives (gltf/pbr) or a transparent
 * materials mesh into an accumulation (rgba16float, additive) and a revealage (rg16float, multiplicative) target, depth
 * tested against the opaque scene, then composites them over it, so overlapping transparent parts no longer pop as the
 * camera moves. Materials with `blendSpace: 'linear'` go in too: on a display-encoded target the pixels they touch
 * composite in linear light from the native glass snapshot (from the frame after one first draws; README "Linear-light layers"). Models not added keep gltf/pbr's sorted blending. WebGPU only.
 * @throws RangeError from the constructor when `order` is not > 0 or `depthScale` not a positive number.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'state'` from `add` before
 * `attach`.
 */
export class OIT extends TransparentPass {
  readonly targets: readonly GPUColorTargetState[];
  readonly blends: boolean;
  private readonly depthScale?: number;
  readonly layout: readonly GPUBindGroupLayoutEntry[] = [{ binding: BINDING, visibility: 2, buffer: {} }];
  private readonly code = new Map<number, string>();
  private readonly surfaceCode = new Map<number, string>();
  private readonly values = new Float32Array(4);
  private uniform?: GPUBuffer;
  /** This view's uniform binding while its models draw (a frame-arena slice for a second view). */
  private binding?: GPUBufferBinding;
  private textures: GPUTexture[] = [];
  private views: GPUTextureView[] = [];
  private size = '';
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly blendedPipelines = new Map<string, GPURenderPipeline[]>();
  private readonly groups = new Map<GPURenderPipeline, GPUBindGroup>();
  private readonly linearPipelines = new Map<string, GPURenderPipeline>();
  private linearGroup?: { view: GPUTextureView; pipeline: GPURenderPipeline; group: GPUBindGroup };

  static attach(engine: EngineKernel, options?: OITOptions): OIT {
    const value = new OIT(options);
    engineRuntime(engine).use(value);
    return value;
  }
  constructor({ order = 8, depthScale, blending = false }: OITOptions = {}) {
    if (depthScale !== undefined && !(depthScale > 0 && Number.isFinite(depthScale)))
      throw new RangeError('OIT order must be > 0 and depthScale a positive number');
    super(order);
    this.depthScale = depthScale;
    this.blends = !!blending;
    this.targets = blending
      ? [
          { format: 'rgba16float', blend: add },
          { format: 'rgba16float', blend: dim },
          { format: 'rgba16float', blend: add },
          { format: 'r8unorm', blend: reveal },
        ]
      : [
          { format: 'rgba16float', blend: add },
          { format: 'rg16float', blend: reveal },
        ];
  }
  override setup(engine: Engine): void {
    super.setup(engine);
    this.uniform = engine.gpu!.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  /** @internal gltf\/pbr transparency hook. */
  declarations(group: number): string {
    return groupCode(this.code, group, (g) => this.surface(g) + pbrLayer);
  }
  /** @internal Effect hook. */
  surface(group: number): string {
    return groupCode(this.surfaceCode, group, this.blends ? surfaceBlended : surface);
  }
  /** @internal gltf\/pbr transparency hook. */
  bindings(): GPUBindGroupEntry[] {
    return [{ binding: BINDING, resource: this.binding ?? { buffer: this.uniform! } }];
  }
  /** @internal gltf\/pbr transparency hook: the accumulation pass, begun on the first transparent draw of the frame. */
  begin(): GPURenderPassEncoder {
    if (this.pass) return this.pass;
    const c = this.context!,
      count = this.targets.length,
      msaa = this.views.length > count,
      v = this.views;
    const pass = (this.pass = c.encoder.beginRenderPass({
      label: 'oit:accumulate',
      colorAttachments: this.targets.map((_, k) => ({
        view: msaa ? v[k + count] : v[k],
        resolveTarget: msaa ? v[k] : undefined,
        clearValue: k === 1 || k === 3 ? [1, 1, 1, 1] : [0, 0, 0, 0],
        loadOp: 'clear',
        storeOp: msaa ? 'discard' : 'store',
      })),
      depthStencilAttachment: { view: c.depth, depthReadOnly: true, stencilReadOnly: true },
    }));
    applyView(pass, c);
    return pass;
  }
  protected render(c: Context): void {
    // This view draws in the frame: what it releases waits while another view's commands still need it.
    currentFrame(c.device, c.view ?? c);
    if (this.disposed || this.empty) return;
    const samples = c.descriptor.multisample?.count ?? 1,
      size = c.width + 'x' + c.height + 'x' + samples,
      device = c.device;
    if (size !== this.size) {
      this.release();
      this.size = size;
      // Resolved (sampled by the composite) targets first, then their multisampled draw targets.
      const kept = this.targets.length;
      for (let k = 0; k < (samples > 1 ? kept * 2 : kept); k++) {
        const format = this.targets[k % kept].format,
          count = k < kept ? 1 : samples;
        const texture = device.createTexture({
          label: 'oit:' + format,
          size: [c.width, c.height],
          format,
          sampleCount: count,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | (count === 1 ? GPUTextureUsage.TEXTURE_BINDING : 0),
        });
        this.textures.push(texture);
        this.views.push(texture.createView());
      }
    }
    const scale = this.depthScale ?? Math.hypot(...c.camera.position.map((p, i) => p - c.camera.target[i]));
    this.values[0] = 1 / (scale || 1);
    // A second view in the same frame gets its own copy of the uniform.
    this.binding = writeUniform(device, this.uniform!, this.values, c.view ?? c);
    this.scene = undefined;
    let scene: GPUTextureView | undefined;
    try {
      if (!this.drawModels(c)) return;
      // The colour before the composite, for the pixels a linear layer touched (copied only when one drew).
      scene = (this.scene as (() => GPUTextureView) | undefined)?.();
    } finally {
      this.binding = undefined;
      this.scene = undefined;
    }
    if (this.blends) return this.compositeBlended(c, samples, scene);
    const key = c.format + samples;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = device.createShaderModule({ code: composite });
      this.pipelines.set(
        key,
        (pipeline = device.createRenderPipeline({
          label: 'oit:composite',
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format, blend: over }] },
          multisample: { count: samples },
        })),
      );
    }
    let group = this.groups.get(pipeline);
    if (!group)
      this.groups.set(
        pipeline,
        (group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.views[0] },
            { binding: 1, resource: this.views[1] },
          ],
        })),
      );
    const out = c.encoder.beginRenderPass({
      label: 'oit:composite',
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
    });
    applyView(out, c);
    out.setPipeline(pipeline);
    out.setBindGroup(0, group);
    out.draw(3);
    if (scene) this.drawLinear(out, c, samples, scene);
    out.end();
  }
  /** KB3148d: the linear-light composite of the pixels a `blendSpace: 'linear'` layer touched, blending off. */
  private drawLinear(out: GPURenderPassEncoder, c: Context, samples: number, scene: GPUTextureView): void {
    const device = c.device,
      key = c.format + samples;
    let pipeline = this.linearPipelines.get(key);
    if (!pipeline) {
      const module = device.createShaderModule({ code: linearComposite(this.blends) });
      this.linearPipelines.set(
        key,
        (pipeline = device.createRenderPipeline({
          label: 'oit:composite-linear',
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
          multisample: { count: samples },
        })),
      );
    }
    let linear = this.linearGroup;
    if (linear?.view !== scene || linear.pipeline !== pipeline) {
      const v = this.views,
        resources = this.blends ? [v[0], v[1], scene, v[2], v[3]] : [v[0], v[1], scene];
      this.linearGroup = linear = {
        view: scene,
        pipeline,
        group: device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: resources.map((resource, binding) => ({ binding, resource })),
        }),
      };
    }
    out.setPipeline(pipeline);
    out.setBindGroup(0, linear.group);
    out.draw(3);
  }
  private compositeBlended(c: Context, samples: number, scene?: GPUTextureView): void {
    const device = c.device,
      key = c.format + samples;
    let pair = this.blendedPipelines.get(key);
    if (!pair) {
      const module = device.createShaderModule({ code: compositeBlended }),
        layout = device.createPipelineLayout({
          bindGroupLayouts: [
            device.createBindGroupLayout({
              entries: [0, 1, 2].map((binding) => ({
                binding,
                visibility: 2,
                texture: { sampleType: 'unfilterable-float' },
              })),
            }),
          ],
        });
      const make = (entryPoint: string, blend: GPUBlendState) =>
        device.createRenderPipeline({
          label: 'oit:composite',
          layout,
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint, targets: [{ format: c.format, blend }] },
          multisample: { count: samples },
        });
      this.blendedPipelines.set(key, (pair = [make('dim', dim), make('light', add)]));
    }
    let group = this.groups.get(pair[0]);
    if (!group)
      this.groups.set(
        pair[0],
        (group = device.createBindGroup({
          layout: pair[0].getBindGroupLayout(0),
          entries: [0, 1, 2].map((binding) => ({ binding, resource: this.views[binding] })),
        })),
      );
    const out = c.encoder.beginRenderPass({
      label: 'oit:composite',
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
    });
    applyView(out, c);
    out.setBindGroup(0, group);
    for (const pipeline of pair) {
      out.setPipeline(pipeline);
      out.draw(3);
    }
    if (scene) this.drawLinear(out, c, samples, scene);
    out.end();
  }
  protected release(): void {
    for (const t of this.textures) retire(this.device!, t);
    this.textures = [];
    this.views = [];
    this.size = '';
    this.groups.clear();
    this.linearGroup = undefined;
  }
  protected freeDevice(): void {
    this.release();
    this.pipelines.clear();
    this.blendedPipelines.clear();
    this.linearPipelines.clear();
    retire(this.device!, this.uniform);
    this.uniform = undefined;
  }
}
