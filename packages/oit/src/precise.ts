// Weighted blended OIT with f32 sums, from McGuire and Bavoil (2013) and the WebGPU format capability tables.
// Four scalar targets retain scene MSAA: RGBA32F is not multisampleable, while R32F is.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type PassContext } from '@margoengine/core/extension';
import { fault } from '../../shared/errors.js';
import { compatTier, requireCompatTier } from '../../shared/compat.js';
import { currentFrame, retire, writeUniform } from '../../shared/frame-resources.js';
import { alphaBlend, groupCode } from '../../shared/pass.js';
import { applyView } from '../../shared/view-rect.js';
import { TransparentPass, pbrLayer } from './pass.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Fixed settings for float32 weighted accumulation. Transmission and custom blending retain their sorted paths. */
export interface PreciseOITOptions {
  /** Frame graph order, after opaque drawing and before post processing. Default 8. */
  order?: number;
  /** Depth-weight distance in world units. Default the camera's distance to its target, recomputed each frame. */
  depthScale?: number;
}

const add: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one' },
  alpha: { srcFactor: 'one', dstFactor: 'one' },
};
const surface = (group: number) => /* wgsl */ `
struct MargoTransparent {
  @location(0) r:f32, @location(1) g:f32, @location(2) b:f32, @location(3) weight:f32, @location(4) reveal:f32
}
@group(${group}) @binding(120) var<uniform> margoOIT:vec4f;
fn margoTransparentAt(color:vec4f,clip:vec4f,depth:f32)->MargoTransparent {
  let a=clamp(color.a,0.0,1.0); let d=max(depth*margoOIT.x,1e-4);
  let w=a*clamp(10.0/pow(d,6.0),0.01,1000.0);
  return MargoTransparent(color.r*w,color.g*w,color.b*w,w,a);
}
`;
const composite = (samples: number) => /* wgsl */ `
${[0, 1, 2, 3, 4].map((i) => `@group(0) @binding(${i}) var map${i}:${samples > 1 ? 'texture_multisampled_2d' : 'texture_2d'}<f32>;`).join('\n')}
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);
}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
  let q=vec2i(p.xy); var sum=vec4f(0.0); var reveal=0.0;
  for(var s=0;s<${samples};s+=1){
    sum+=vec4f(${[0, 1, 2, 3].map((i) => `textureLoad(map${i},q,${samples > 1 ? 's' : '0'}).r`).join(',')});
    reveal+=textureLoad(map4,q,${samples > 1 ? 's' : '0'}).r;
  }
  return vec4f(sum.rgb/max(sum.a,${samples}.0*1e-5),1.0-reveal/${samples}.0);
}
`;

/**
 * Weighted transparency with four R32F accumulation channels instead of half-float sums. The weighting and coverage
 * match OIT; bright stacked layers no longer overflow at 65504. Five render targets and float32 blending are required.
 * On WebGPU request `features: ['float32-blendable']` when creating the engine; WebGL2 needs EXT_float_blend.
 * Scene MSAA is preserved by reading and averaging the scalar samples in the composite, without a hardware resolve.
 * @throws RangeError for invalid order/depthScale; use positive finite settings.
 * @throws MargoError 'unsupported' without float32 blending or five targets; request the feature or use OIT.
 */
export class PreciseOIT extends TransparentPass {
  readonly targets: readonly GPUColorTargetState[] = [
    ...[0, 1, 2, 3].map(() => ({ format: 'r32float' as const, blend: add })),
    {
      format: 'r16float',
      blend: {
        color: { srcFactor: 'zero', dstFactor: 'one-minus-src' },
        alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src' },
      },
    },
  ];
  readonly layout: readonly GPUBindGroupLayoutEntry[] = [{ binding: 120, visibility: 2, buffer: {} }];
  private readonly depthScale?: number;
  private readonly code = new Map<number, string>();
  private readonly surfaceCode = new Map<number, string>();
  private readonly values = new Float32Array(4);
  private uniform?: GPUBuffer;
  private binding?: GPUBufferBinding;
  private textures: GPUTexture[] = [];
  private views: GPUTextureView[] = [];
  private size = '';
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly groups = new Map<GPURenderPipeline, GPUBindGroup>();

  static attach(engine: EngineKernel, options?: PreciseOITOptions): PreciseOIT {
    const value = new PreciseOIT(options);
    engineRuntime(engine).use(value);
    return value;
  }
  constructor({ order = 8, depthScale }: PreciseOITOptions = {}) {
    super(order);
    if (depthScale !== undefined && !(depthScale > 0 && Number.isFinite(depthScale)))
      throw new RangeError('Invalid PreciseOIT depthScale; use a positive finite number');
    this.depthScale = depthScale;
  }
  override setup(engine: Engine): void {
    super.setup(engine);
    const device = engine.gpu!;
    requireCompatTier(device, 'PreciseOIT');
    const extensions = (
      device as GPUDevice & { adapter?: { capabilities?: { extensions?: { EXT_float_blend?: boolean } } } }
    ).adapter?.capabilities?.extensions;
    const blendable =
      compatTier(device) === 'webgl2' ? extensions?.EXT_float_blend : device.features.has('float32-blendable');
    if (!blendable || device.limits.maxColorAttachments < 5)
      throw fault(
        'unsupported',
        "PreciseOIT needs five targets and float32 blending; request features: ['float32-blendable'] on WebGPU or EXT_float_blend on WebGL2, or use OIT",
        'compatibility-layer',
      );
    this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  declarations(group: number): string {
    return groupCode(this.code, group, (g) => this.surface(g) + pbrLayer);
  }
  surface(group: number): string {
    return groupCode(this.surfaceCode, group, surface);
  }
  bindings(): GPUBindGroupEntry[] {
    return [{ binding: 120, resource: this.binding ?? { buffer: this.uniform! } }];
  }
  begin(): GPURenderPassEncoder {
    if (this.pass) return this.pass;
    const c = this.context!;
    this.pass = c.encoder.beginRenderPass({
      label: 'oit:precise:accumulate',
      colorAttachments: this.views.map((view, i) => ({
        view,
        clearValue: i === 4 ? [1, 0, 0, 0] : [0, 0, 0, 0],
        loadOp: 'clear',
        storeOp: 'store',
      })),
      depthStencilAttachment: { view: c.depth, depthReadOnly: true, stencilReadOnly: true },
    });
    applyView(this.pass, c);
    return this.pass;
  }
  protected render(c: Context): void {
    currentFrame(c.device, c.view ?? c);
    if (this.disposed || this.empty) return;
    const device = c.device,
      samples = c.descriptor.multisample?.count ?? 1,
      size = c.width + 'x' + c.height + 'x' + samples;
    if (size !== this.size) {
      this.release();
      this.size = size;
      for (const target of this.targets) {
        const t = device.createTexture({
          label: 'oit:precise:' + target.format,
          size: [c.width, c.height],
          format: target.format,
          sampleCount: samples,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.textures.push(t);
        this.views.push(t.createView());
      }
    }
    const scale = this.depthScale ?? Math.hypot(...c.camera.position.map((p, i) => p - c.camera.target[i]));
    this.values[0] = 1 / (scale || 1);
    this.binding = writeUniform(device, this.uniform!, this.values, c.view ?? c);
    try {
      if (!this.drawModels(c)) return;
    } finally {
      this.binding = undefined;
    }
    const key = c.format + samples;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = device.createShaderModule({ code: composite(samples) });
      const layout = device.createBindGroupLayout({
        entries: this.views.map((_, binding) => ({
          binding,
          visibility: 2,
          texture: { sampleType: 'unfilterable-float', multisampled: samples > 1 },
        })),
      });
      this.pipelines.set(
        key,
        (pipeline = device.createRenderPipeline({
          label: 'oit:precise:composite',
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format, blend: alphaBlend }] },
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
          entries: this.views.map((resource, binding) => ({ binding, resource })),
        })),
      );
    const out = c.encoder.beginRenderPass({
      label: 'oit:precise:composite',
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
    });
    applyView(out, c);
    out.setPipeline(pipeline);
    out.setBindGroup(0, group);
    out.draw(3);
    out.end();
  }
  protected release(): void {
    for (const t of this.textures) retire(this.device!, t);
    this.textures = [];
    this.views = [];
    this.size = '';
    this.groups.clear();
  }
  protected freeDevice(): void {
    this.release();
    this.pipelines.clear();
    retire(this.device!, this.uniform);
    this.uniform = undefined;
  }
}
