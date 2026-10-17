/// <reference lib="esnext.disposable" preserve="true" />
// Refraction for KHR_materials_transmission + KHR_materials_volume (gltf-pro models and @margoengine/materials meshes)
// through gltf-pro's transmission hook: the opaque scene is copied into a mip chain once per frame, then each transmissive
// surface reads it along its refracted ray (Khronos glTF PBR, Appendix B "specular_btdf"; the screen-space approximation
// of the Khronos glTF sample renderer).
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import type { PBRModel, PBRTransmission } from '@margoengine/gltf-pro';
import { sceneTarget } from '../../shared/msaa.js';
declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

export interface TransmissionPassOptions {
  /** Frame graph order of the copy and the transmissive draws: after the opaque scene (1) and sky (2), before water (4), fog (5) and OIT (8). Default 3. */
  order?: number;
}
// Group-2 bindings, clear of shadows (1-3), clustered (10-16), IBL/fog (20-25), materials (32-43) and OIT (120).
const BINDING = 124;
// Light through the surface (base layer, before clearcoat and sheen): the scene behind along the refracted ray, blurred by
// roughness, attenuated by the volume (Beer-Lambert) and weighted by the dielectric's transmitted share (1 - Fresnel).
// - Exit point: position + refract(-v, n, 1/ior) normalized x thickness (mesh units, scaled to world); thickness 0 is thin-walled.
// - Blur: mip level log2(width) x roughness x clamp(2 ior - 2, 0, 1): no blur when the IOR does not bend light.
// - Volume: transmittance per world unit margoVolume.yzw = attenuationColor^(1/attenuationDistance), raised to the path length.
const declarations = (group: number) => /* wgsl */ `
@group(${group}) @binding(${BINDING}) var margoScene:texture_2d<f32>;
@group(${group}) @binding(${BINDING + 1}) var margoSceneSampler:sampler;
fn margoTransmission(s:Surface,v:vec3f,i:Out)->vec3f {
  let ior=max(f.ext.y,1.0); let r=refract(-v,s.n,1/ior);
  let path=margoVolume.x*s.th*(length(f.model[0].xyz)+length(f.model[1].xyz)+length(f.model[2].xyz))/3;
  let clip=f.camera*vec4f(i.position+r*(path/max(length(r),1e-4)),1); let uv=clip.xy/clip.w*vec2f(0.5,-0.5)+0.5;
  let lod=log2(f32(textureDimensions(margoScene).x))*s.roughness*clamp(ior*2-2,0.0,1.0);
  let behind=textureSampleLevel(margoScene,margoSceneSampler,uv,lod).rgb;
  let volume=select(pow(margoVolume.yzw,vec3f(path)),vec3f(1),path<=0);
  let f0=mix(s.f0,s.base.rgb,s.metal); let fresnel=f0+(1-f0)*pow(1-clamp(dot(s.n,v),0.0,1.0),5.0);
  return (1-s.metal)*s.tr*(1-fresnel)*s.base.rgb*volume*behind;
}
`;
// Level 0 copies the resolved scene texel for texel; each further level averages 2x2 texels of the one above (bilinear at its centre).
const copy = /* wgsl */ `
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);}
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var bilinear:sampler;
@fragment fn level0(@builtin(position) p:vec4f)->@location(0) vec4f {return textureLoad(source,vec2i(p.xy),0);}
@fragment fn reduce(@builtin(position) p:vec4f)->@location(0) vec4f {return textureSampleLevel(source,bilinear,p.xy/vec2f(max(textureDimensions(source)/2u,vec2u(1))),0);}
`;
const over: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
};
let serial = 0;

/**
 * Real transmission: `transmission.add(model)` makes a gltf-pro model's or materials mesh's transmissive surfaces refract
 * the opaque scene behind them, blurred by roughness and attenuated through `thickness` of the volume, instead of tinting
 * the background. Needs an HDR scene capture (a PostStack with an HDR or display effect, such as Tonemap or Bloom). The scene is
 * copied (a mip chain) only on frames where a transmissive surface draws. WebGPU only.
 */
export class Transmission implements EnginePlugin, PBRTransmission {
  readonly name = 'transmission:' + serial++;
  readonly order: number;
  targets: readonly GPUColorTargetState[] = [];
  private engine?: Engine;
  private disposed = false;
  private readonly models = new Map<PBRModel, () => void>();
  private readonly code = new Map<number, string>();
  private readonly formats = new Map<string, GPUColorTargetState[]>();
  private texture?: GPUTexture;
  private view?: GPUTextureView;
  private levels: GPUTextureView[] = [];
  private reduceGroups: GPUBindGroup[] = [];
  private source?: GPUTexture;
  private sourceGroup?: GPUBindGroup;
  private sampler?: GPUSampler;
  private pipelines?: { level0: GPURenderPipeline; reduce: GPURenderPipeline };
  private context?: Context;
  private pass?: GPURenderPassEncoder;

  static attach(engine: EngineKernel, options?: TransmissionPassOptions): Transmission {
    const value = new Transmission(options);
    engineRuntime(engine).use(value);
    return value;
  }
  constructor({ order = 3 }: TransmissionPassOptions = {}) {
    if (!Number.isFinite(order) || order <= 0) throw new RangeError('Transmission order must be a number > 0');
    this.order = order;
  }
  /** Refracts the scene through the model's transmissive primitives (gltf-pro model or materials mesh). Returns a remover. */
  add(model: PBRModel): () => void {
    if (this.disposed || !this.engine)
      throw new Error(
        this.disposed ? 'Transmission is disposed' : 'Transmission.add needs Transmission.attach(engine) first',
      );
    let release = this.models.get(model);
    if (!release) {
      const restore = model.setTransmission(this),
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
    if (this.disposed) throw new Error('Transmission is disposed');
    if (!engine.gpu) throw new Error('Transmission requires WebGPU');
    this.engine = engine;
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
  /** @internal gltf-pro transmission hook. */
  declarations(group: number): string {
    let code = this.code.get(group);
    if (!code) this.code.set(group, (code = declarations(group)));
    return code;
  }
  /** @internal gltf-pro transmission hook. */
  bindings(): GPUBindGroupEntry[] {
    return [
      { binding: BINDING, resource: this.view! },
      { binding: BINDING + 1, resource: this.sampler! },
    ];
  }
  /** @internal gltf-pro transmission hook: copies the scene, then begins the pass the transmissive surfaces draw in. */
  begin(): GPURenderPassEncoder {
    if (this.pass) return this.pass;
    const c = this.context!,
      target = sceneTarget(c)!,
      encoder = c.encoder,
      p = this.pipelines!;
    target.resolve(encoder);
    if (this.source !== target.resolvedColor) {
      this.source = target.resolvedColor;
      this.sourceGroup = c.device.createBindGroup({
        layout: p.level0.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: this.source.createView() }],
      });
    }
    for (let level = 0; level < this.levels.length; level++) {
      const pass = encoder.beginRenderPass({
        label: 'transmission:copy',
        colorAttachments: [{ view: this.levels[level], loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
      });
      pass.setPipeline(level ? p.reduce : p.level0);
      pass.setBindGroup(0, level ? this.reduceGroups[level - 1] : this.sourceGroup!);
      pass.draw(3);
      pass.end();
    }
    return (this.pass = encoder.beginRenderPass({
      label: 'transmission',
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: c.depth, depthReadOnly: true, stencilReadOnly: true },
    }));
  }
  private render(c: Context): void {
    if (this.disposed || !this.models.size) return;
    const target = sceneTarget(c),
      device = c.device;
    if (target?.resolvedColor.format !== 'rgba16float')
      throw new Error(
        'Transmission needs an HDR scene capture: attach a PostStack with an HDR or display effect (such as Tonemap or Bloom) first',
      );
    if (!this.pipelines) {
      const module = device.createShaderModule({ code: copy }),
        pipeline = (entryPoint: string) =>
          device.createRenderPipeline({
            label: 'transmission:copy',
            layout: 'auto',
            vertex: { module, entryPoint: 'vertex' },
            fragment: { module, entryPoint, targets: [{ format: 'rgba16float' }] },
          });
      this.pipelines = { level0: pipeline('level0'), reduce: pipeline('reduce') };
      this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    }
    if (this.texture?.width !== c.width || this.texture.height !== c.height) {
      this.release();
      const count = Math.floor(Math.log2(Math.max(c.width, c.height))) + 1;
      const texture = (this.texture = device.createTexture({
        label: 'transmission:scene',
        size: [c.width, c.height],
        format: 'rgba16float',
        mipLevelCount: count,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      }));
      this.view = texture.createView();
      this.levels = Array.from({ length: count }, (_, level) =>
        texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
      );
      this.reduceGroups = this.levels.slice(0, -1).map((source) =>
        device.createBindGroup({
          layout: this.pipelines!.reduce.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: source },
            { binding: 1, resource: this.sampler! },
          ],
        }),
      );
    }
    let targets = this.formats.get(c.format);
    if (!targets) this.formats.set(c.format, (targets = [{ format: c.format, blend: over }]));
    this.targets = targets;
    // Back to front, so blended transmissive surfaces composite in order.
    const eye = c.camera.position,
      distance = (m: PBRModel) => {
        const t = m.root.matrix;
        return Math.hypot(eye[0] - t[12], eye[1] - t[13], eye[2] - t[14]);
      };
    this.context = c;
    this.pass = undefined;
    try {
      for (const model of [...this.models.keys()].sort((a, b) => distance(b) - distance(a)))
        model.draw(c, 'transmission', c.color, c.depth);
    } finally {
      this.context = undefined;
      (this.pass as GPURenderPassEncoder | undefined)?.end();
      this.pass = undefined;
    }
  }
  private release(): void {
    this.texture?.destroy();
    this.texture = this.view = this.source = this.sourceGroup = undefined;
    this.levels = [];
    this.reduceGroups = [];
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.pipelines = undefined;
    this.setup(engine);
  }
  /** Restores the tinted blend on every added model and frees the scene copy. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const release of [...this.models.values()]) release();
    this.release();
    this.pipelines = undefined;
    this.engine?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
