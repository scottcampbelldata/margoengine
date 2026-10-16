/// <reference lib="esnext.disposable" preserve="true" />
// Weighted blended order-independent transparency (McGuire and Bavoil, JCGT 2013) for gltf-pro BLEND primitives and
// @margoengine/materials transparent meshes, through gltf-pro's transparency hook (no shader text search).
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import type { PBRModel, PBRTransparency } from '@margoengine/gltf-pro';
import { MargoError } from '@margoengine/math/errors';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Weighted blended OIT settings, fixed at construction. */
export interface OITOptions {
  /** Frame graph order of the transparent and composite passes: after the scene and its overlays (edges 6), before SSAO (10), TAA (9) and post composites (30). Default 8. */
  order?: number;
  /** World distance the depth weight is centred on (where a nearer layer starts to dominate). Default: the camera's distance to its target, every frame. */
  depthScale?: number;
}

// Group-2 binding, clear of shadows (1-3), clustered (10-16), IBL/fog (20-25), materials (32-43) and shader nodes.
const BINDING = 120;
// Weight: alpha * clamp(10 / (depth / scale)^6, 0.01, 1000). The power sets how strongly a nearer layer wins (exact for
// two 50% layers 12% apart in depth); the clamp keeps 64 LDR layers inside rgba16float. Unclamped from 0.46 to 3.2 x scale.
const declarations = (group: number) => /* wgsl */ `
struct MargoTransparent {@location(0) accum:vec4f, @location(1) reveal:vec4f}
@group(${group}) @binding(${BINDING}) var<uniform> margoOIT:vec4f;
fn margoTransparent(color:vec4f,i:Out)->MargoTransparent {
  let a=clamp(color.a,0.0,1.0); let d=max(-(f.view*vec4f(i.position,1)).z*margoOIT.x,1e-4);
  let w=a*clamp(10.0/pow(d,6.0),0.01,1000.0); var o:MargoTransparent;
  o.accum=vec4f(color.rgb*w,w); o.reveal=vec4f(a); return o;
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
const over: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
};
let serial = 0;

/**
 * Order-independent transparency: `oit.add(model)` draws the model's BLEND primitives (gltf-pro) or a transparent
 * materials mesh into an accumulation (rgba16float, additive) and a revealage (r16float, multiplicative) target, depth
 * tested against the opaque scene, then composites them over it, so overlapping transparent parts no longer pop as the
 * camera moves. Models not added keep gltf-pro's sorted blending. WebGPU only.
 */
export class OIT implements EnginePlugin, PBRTransparency {
  readonly name = 'oit:' + serial++;
  readonly order: number;
  readonly targets: readonly GPUColorTargetState[] = [
    {
      format: 'rgba16float',
      blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } },
    },
    {
      format: 'r16float',
      blend: {
        color: { srcFactor: 'zero', dstFactor: 'one-minus-src' },
        alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src' },
      },
    },
  ];
  private readonly depthScale?: number;
  private engine?: Engine;
  private disposed = false;
  private readonly models = new Map<PBRModel, () => void>();
  private readonly code = new Map<number, string>();
  private readonly values = new Float32Array(4);
  private uniform?: GPUBuffer;
  private textures: GPUTexture[] = [];
  private views: GPUTextureView[] = [];
  private size = '';
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly groups = new Map<GPURenderPipeline, GPUBindGroup>();
  private context?: Context;
  private pass?: GPURenderPassEncoder;

  static attach(engine: EngineKernel, options?: OITOptions): OIT {
    const value = new OIT(options);
    engineRuntime(engine).use(value);
    return value;
  }
  constructor({ order = 8, depthScale }: OITOptions = {}) {
    if (
      !Number.isFinite(order) ||
      order <= 0 ||
      (depthScale !== undefined && !(depthScale > 0 && Number.isFinite(depthScale)))
    )
      throw new RangeError('OIT order must be > 0 and depthScale a positive number');
    this.order = order;
    this.depthScale = depthScale;
  }
  /** Draws a gltf-pro model's BLEND primitives (or a transparent materials mesh) order-independently. Returns a remover. */
  add(model: PBRModel): () => void {
    if (this.disposed || !this.engine)
      throw new MargoError(
        this.disposed ? 'disposed' : 'state',
        this.disposed ? 'OIT is disposed; create a new OIT' : 'OIT.add needs OIT.attach(engine) first',
      );
    let release = this.models.get(model);
    if (!release) {
      const restore = model.setTransparency(this),
        forget = model.onDispose(() => this.models.delete(model));
      release = () => {
        if (this.models.get(model) === release) {
          this.models.delete(model);
          forget();
          restore();
        }
      };
      this.models.set(model, release);
    }
    return release;
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'OIT is disposed; create a new OIT');
    if (!engine.gpu) throw new MargoError('unsupported', 'OIT requires WebGPU; use a WebGPU engine');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: this.order,
      execute: (c) => {
        if (c.backend === 'webgpu') this.render(c);
      },
    });
  }
  /** @internal gltf-pro transparency hook. */
  declarations(group: number): string {
    let code = this.code.get(group);
    if (!code) this.code.set(group, (code = declarations(group)));
    return code;
  }
  /** @internal gltf-pro transparency hook. */
  bindings(): GPUBindGroupEntry[] {
    return [{ binding: BINDING, resource: { buffer: this.uniform! } }];
  }
  /** @internal gltf-pro transparency hook: the accumulation pass, begun on the first transparent draw of the frame. */
  begin(): GPURenderPassEncoder {
    if (this.pass) return this.pass;
    const c = this.context!,
      msaa = this.views.length > 2,
      v = this.views;
    return (this.pass = c.encoder.beginRenderPass({
      label: 'oit:accumulate',
      colorAttachments: [
        {
          view: msaa ? v[2] : v[0],
          resolveTarget: msaa ? v[0] : undefined,
          clearValue: [0, 0, 0, 0],
          loadOp: 'clear',
          storeOp: msaa ? 'discard' : 'store',
        },
        {
          view: msaa ? v[3] : v[1],
          resolveTarget: msaa ? v[1] : undefined,
          clearValue: [1, 0, 0, 0],
          loadOp: 'clear',
          storeOp: msaa ? 'discard' : 'store',
        },
      ],
      depthStencilAttachment: { view: c.depth, depthReadOnly: true, stencilReadOnly: true },
    }));
  }
  private render(c: Context): void {
    if (this.disposed || !this.models.size) return;
    const samples = c.descriptor.multisample?.count ?? 1,
      size = c.width + 'x' + c.height + 'x' + samples,
      device = c.device;
    if (size !== this.size) {
      this.release();
      this.size = size;
      // Resolved (sampled by the composite) targets first, then their multisampled draw targets.
      for (const count of samples > 1 ? [1, 1, samples, samples] : [1, 1]) {
        const format = this.targets[this.textures.length % 2].format;
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
    device.queue.writeBuffer(this.uniform!, 0, this.values);
    this.context = c;
    this.pass = undefined;
    try {
      for (const model of this.models.keys()) model.draw(c, 'transparent', c.color, c.depth);
    } finally {
      this.context = undefined;
    }
    const pass = this.pass as GPURenderPassEncoder | undefined;
    if (!pass) return;
    pass.end();
    this.pass = undefined;
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
    out.setPipeline(pipeline);
    out.setBindGroup(0, group);
    out.draw(3);
    out.end();
  }
  private release(): void {
    for (const t of this.textures) t.destroy();
    this.textures = [];
    this.views = [];
    this.size = '';
    this.groups.clear();
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.pipelines.clear();
    this.uniform?.destroy();
    this.setup(engine);
  }
  /** Restores sorted blending on every added model and frees the targets. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const release of [...this.models.values()]) release();
    this.release();
    this.pipelines.clear();
    this.uniform?.destroy();
    this.uniform = undefined;
    this.engine?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
