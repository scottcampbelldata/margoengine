// Clean room depth peeling after Everitt (2001) and Bavoil and Myers (2008).
// Reversed-Z: each geometry pass keeps the nearest fragment strictly behind the previous layer.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type PassContext } from '@margoengine/core/extension';
import { applyView } from '../../shared/view-rect.js';
import { currentFrame, retire } from '../../shared/frame-resources.js';
import { alphaBlend, groupCode } from '../../shared/pass.js';
import { TransparentPass, pbrLayer } from './pass.js';

type Context = Extract<PassContext, { backend: 'webgpu' }>;
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };

/** Fixed settings for texture-based exact transparency on WebGPU and full WebGL2 compatibility devices. */
export interface PeelOITOptions {
  /** Maximum nearest distinct depth layers per pixel. Default 10, a positive integer. Farther layers are omitted. */
  layers?: number;
  /** Frame graph order, after opaque drawing and before post processing. Default 8. */
  order?: number;
}

const surface = (group: number) => /* wgsl */ `
struct MargoTransparent {@location(0) color:vec4f, @location(1) depth:f32}
@group(${group}) @binding(120) var margoPrevious:texture_2d<f32>;
fn margoTransparentAt(color:vec4f,clip:vec4f,depth:f32)->MargoTransparent {
  let previous=textureLoad(margoPrevious,vec2i(clip.xy),0).r;
  if(color.a<=0.0 || clip.z>=previous){discard;}
  return MargoTransparent(vec4f(color.rgb,clamp(color.a,0.0,1.0)),clip.z);
}
`;
const resolve = /* wgsl */ `
@group(0) @binding(0) var colorMap:texture_2d<f32>;
@group(0) @binding(1) var depthMap:texture_2d<f32>;
struct Result {@location(0) color:vec4f, @builtin(frag_depth) depth:f32}
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);
}
@fragment fn fragment(@builtin(position) p:vec4f)->Result {
  let q=vec2i(p.xy); let color=textureLoad(colorMap,q,0);
  if(color.a<=0.0){discard;}
  return Result(color,textureLoad(depthMap,q,0).r);
}
`;

/**
 * Exact per-pixel depth order without fragment storage or float blending. Each layer redraws the registered models,
 * then layers composite far to near against opaque scene depth. Single-sample transparent coverage, including in an
 * MSAA scene. Coplanar fragments share one layer; no refraction or custom blending. Use `layers` to cover scene depth.
 * @throws RangeError for a nonpositive/noninteger layer count or invalid order; use positive settings.
 * @throws MargoError on the small preview device; use the full WebGL2 compatibility layer or WebGPU.
 */
export class PeelOIT extends TransparentPass {
  readonly targets: readonly GPUColorTargetState[] = [{ format: 'rgba16float' }, { format: 'r32float' }];
  /** @internal The model hook must write its private nearest-depth buffer. */
  readonly depthWrite = true;
  readonly layout: readonly GPUBindGroupLayoutEntry[] = [
    { binding: 120, visibility: 2, texture: { sampleType: 'unfilterable-float' } },
  ];
  readonly layers: number;
  private readonly code = new Map<number, string>();
  private readonly surfaceCode = new Map<number, string>();
  private textures: GPUTexture[] = [];
  private colors: GPUTextureView[] = [];
  private depths: GPUTextureView[] = [];
  private nearest?: GPUTextureView;
  private first?: GPUTextureView;
  private size = '';
  private layer = 0;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly groups = new Map<GPURenderPipeline, GPUBindGroup[]>();

  static attach(engine: EngineKernel, options?: PeelOITOptions): PeelOIT {
    const value = new PeelOIT(options);
    engineRuntime(engine).use(value);
    return value;
  }
  constructor({ order = 8, layers = 10 }: PeelOITOptions = {}) {
    super(order);
    if (!Number.isSafeInteger(layers) || layers < 1)
      throw new RangeError('Invalid PeelOIT layers; use a positive safe integer');
    this.layers = layers;
  }
  declarations(group: number): string {
    return groupCode(this.code, group, (g) => this.surface(g) + pbrLayer);
  }
  surface(group: number): string {
    return groupCode(this.surfaceCode, group, surface);
  }
  bindings(): GPUBindGroupEntry[] {
    return [{ binding: 120, resource: this.layer ? this.depths[this.layer - 1] : this.first! }];
  }
  begin(): GPURenderPassEncoder {
    if (this.pass) return this.pass;
    const c = this.context!;
    this.pass = c.encoder.beginRenderPass({
      label: 'oit:peel',
      colorAttachments: [this.colors[this.layer], this.depths[this.layer]].map((view) => ({
        view,
        clearValue: [0, 0, 0, 0],
        loadOp: 'clear',
        storeOp: 'store',
      })),
      depthStencilAttachment: {
        view: this.nearest!,
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    applyView(this.pass, c);
    return this.pass;
  }
  protected render(c: Context): void {
    currentFrame(c.device, c.view ?? c);
    if (this.disposed || this.empty) return;
    const device = c.device,
      size = c.width + 'x' + c.height;
    if (size !== this.size) {
      this.release();
      this.size = size;
      const make = (format: GPUTextureFormat) => {
        const t = device.createTexture({
          label: 'oit:peel:' + format,
          size: [c.width, c.height],
          format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.textures.push(t);
        return t.createView();
      };
      this.nearest = make('depth32float');
      this.first = make('r32float');
      for (let i = 0; i < this.layers; i++) {
        this.colors.push(make('rgba16float'));
        this.depths.push(make('r32float'));
      }
    }
    // A value outside the clip volume admits every visible fragment on the first peel.
    const clear = c.encoder.beginRenderPass({
      label: 'oit:peel:reset',
      colorAttachments: [{ view: this.first!, clearValue: [2, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
    });
    clear.end();
    const peel: Context = {
      ...c,
      depth: this.nearest!,
      descriptor: { ...c.descriptor, multisample: { count: 1 }, depthStencil: { format: 'depth32float' } },
    };
    for (this.layer = 0; this.layer < this.layers; this.layer++) {
      if (!this.drawModels(peel)) return;
    }
    const samples = c.descriptor.multisample?.count ?? 1,
      format = c.descriptor.depthStencil!.format,
      key = c.format + samples + format;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = device.createShaderModule({ code: resolve });
      const layout = device.createBindGroupLayout({
        entries: [0, 1].map((binding) => ({ binding, visibility: 2, texture: { sampleType: 'unfilterable-float' } })),
      });
      this.pipelines.set(
        key,
        (pipeline = device.createRenderPipeline({
          label: 'oit:peel:resolve',
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format, blend: alphaBlend }] },
          depthStencil: { format, depthWriteEnabled: false, depthCompare: 'greater-equal' },
          multisample: { count: samples },
        })),
      );
    }
    let groups = this.groups.get(pipeline);
    if (!groups)
      this.groups.set(
        pipeline,
        (groups = this.colors.map((view, i) =>
          device.createBindGroup({
            layout: pipeline!.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: view },
              { binding: 1, resource: this.depths[i] },
            ],
          }),
        )),
      );
    const out = c.encoder.beginRenderPass({
      label: 'oit:peel:resolve',
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: c.depth, depthReadOnly: true, stencilReadOnly: true },
    });
    applyView(out, c);
    out.setPipeline(pipeline);
    for (let i = this.layers - 1; i >= 0; i--) {
      out.setBindGroup(0, groups[i]);
      out.draw(3);
    }
    out.end();
  }
  protected release(): void {
    for (const t of this.textures) retire(this.device!, t);
    this.textures = [];
    this.colors = [];
    this.depths = [];
    this.first = this.nearest = undefined;
    this.size = '';
    this.groups.clear();
  }
  protected freeDevice(): void {
    this.release();
    this.pipelines.clear();
  }
}
