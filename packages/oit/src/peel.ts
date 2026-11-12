// Clean room depth peeling after Everitt (2001) and Bavoil and Myers (2008).
// Reversed-Z: each geometry pass keeps the nearest fragment strictly behind the previous layer.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type PassContext } from '@margoengine/core/extension';
import { applyView } from '../../shared/view-rect.js';
import { currentFrame, retire } from '../../shared/frame-resources.js';
import { alphaBlend, groupCode } from '../../shared/pass.js';
import { TransparentPass, linearLight, pbrLayer } from './pass.js';

type Context = Extract<PassContext, { backend: 'webgpu' }>;
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };

/** Fixed settings for texture-based exact transparency on WebGPU and full WebGL2 compatibility devices. */
export interface PeelOITOptions {
  /** Maximum nearest distinct depth layers per pixel. Default 10, a positive integer. Farther layers are omitted. */
  layers?: number;
  /** Frame graph order, after opaque drawing and before post processing. Default 8. */
  order?: number;
}

// A `blendSpace: 'linear'` layer (KB3148e) stores its alpha negated.
const surface = (group: number) => /* wgsl */ `
override margoLinear:bool=false;
struct MargoTransparent {@location(0) color:vec4f, @location(1) depth:f32}
@group(${group}) @binding(120) var margoPrevious:texture_2d<f32>;
fn margoTransparentAt(color:vec4f,clip:vec4f,depth:f32)->MargoTransparent {
  let previous=textureLoad(margoPrevious,vec2i(clip.xy),0).r;
  if(color.a<=0.0 || clip.z>=previous){discard;}
  let a=clamp(color.a,0.0,1.0); return MargoTransparent(vec4f(color.rgb,select(a,-a,margoLinear)),clip.z);
}
`;
// `kind` as ExactOIT's resolve: 0 every layer with the hardware blend, then with a linear layer in the frame 1 the display
// layers of one peel that way and 2 its linear ones with blending off over the snapshot taken right before it (KB3148e).
const resolve = (kind: number) => /* wgsl */ `
@group(0) @binding(0) var colorMap:texture_2d<f32>;
@group(0) @binding(1) var depthMap:texture_2d<f32>;
${kind === 2 ? '@group(0) @binding(2) var sceneMap:texture_2d<f32>;' + linearLight : ''}
struct Result {@location(0) color:vec4f, @builtin(frag_depth) depth:f32}
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);
}
@fragment fn fragment(@builtin(position) p:vec4f)->Result {
  let q=vec2i(p.xy); var color=textureLoad(colorMap,q,0);
  ${['if(color.a==0.0){discard;} color.a=abs(color.a);', 'if(color.a<=0.0){discard;}', 'if(color.a>=0.0){discard;} color=overLinear(vec4f(color.rgb,-color.a),textureLoad(sceneMap,q,0));'][kind]}
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
  /** The snapshot the linear resolve groups read. */
  private groupScene?: GPUTextureView;

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
    // The peels draw in the frame's own context, so what is kept per context (the native glass capture a linear layer
    // reads, KB3148e) is found; only the depth target and the pipeline state they draw with change, and come back after.
    const { depth, descriptor } = c;
    let scene: (() => GPUTextureView) | undefined;
    c.depth = this.nearest!;
    c.descriptor = { ...descriptor, multisample: { count: 1 }, depthStencil: { format: 'depth32float' } };
    try {
      for (this.layer = 0; this.layer < this.layers; this.layer++) {
        if (!this.drawModels(c)) return;
        scene ??= this.scene;
      }
    } finally {
      c.depth = depth;
      c.descriptor = descriptor;
      this.scene = undefined;
    }
    const samples = descriptor.multisample?.count ?? 1,
      format = descriptor.depthStencil!.format,
      pipeline = (kind: number, view?: GPUTextureView): [GPURenderPipeline, GPUBindGroup[]] => {
        const key = c.format + samples + format + kind;
        let made = this.pipelines.get(key);
        if (!made) {
          const module = device.createShaderModule({ code: resolve(kind) });
          const layout = device.createBindGroupLayout({
            entries: (kind === 2 ? [0, 1, 2] : [0, 1]).map((binding) => ({
              binding,
              visibility: 2,
              texture: { sampleType: 'unfilterable-float' as const },
            })),
          });
          this.pipelines.set(
            key,
            (made = device.createRenderPipeline({
              label: 'oit:peel:resolve',
              layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
              vertex: { module, entryPoint: 'vertex' },
              fragment: {
                module,
                entryPoint: 'fragment',
                targets: [{ format: c.format, blend: kind === 2 ? undefined : alphaBlend }],
              },
              depthStencil: { format, depthWriteEnabled: false, depthCompare: 'greater-equal' },
              multisample: { count: samples },
            })),
          );
        }
        let groups = this.groups.get(made);
        if (!groups || (view && this.groupScene !== view)) {
          if (view) this.groupScene = view;
          this.groups.set(
            made,
            (groups = this.colors.map((color, i) =>
              device.createBindGroup({
                layout: made!.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: color },
                  { binding: 1, resource: this.depths[i] },
                  ...(view ? [{ binding: 2, resource: view }] : []),
                ],
              }),
            )),
          );
        }
        return [made, groups];
      },
      open = (): GPURenderPassEncoder => {
        const out = c.encoder.beginRenderPass({
          label: 'oit:peel:resolve',
          colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
          depthStencilAttachment: { view: c.depth, depthReadOnly: true, stencilReadOnly: true },
        });
        applyView(out, c);
        return out;
      };
    if (!scene) {
      const [all, groups] = pipeline(0),
        out = open();
      out.setPipeline(all);
      for (let i = this.layers - 1; i >= 0; i--) {
        out.setBindGroup(0, groups[i]);
        out.draw(3);
      }
      out.end();
      return;
    }
    // KB3148e: peel by peel, far to near, each over a snapshot of the colour the farther peels left.
    const [display, displayGroups] = pipeline(1);
    for (let i = this.layers - 1; i >= 0; i--) {
      const view = scene(),
        [linear, linearGroups] = pipeline(2, view),
        out = open();
      out.setPipeline(display);
      out.setBindGroup(0, displayGroups[i]);
      out.draw(3);
      out.setPipeline(linear);
      out.setBindGroup(0, linearGroups[i]);
      out.draw(3);
      out.end();
    }
  }
  protected release(): void {
    for (const t of this.textures) retire(this.device!, t);
    this.textures = [];
    this.colors = [];
    this.depths = [];
    this.first = this.nearest = undefined;
    this.size = '';
    this.groups.clear();
    this.groupScene = undefined;
  }
  protected freeDevice(): void {
    this.release();
    this.pipelines.clear();
  }
}
