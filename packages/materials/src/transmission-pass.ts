/// <reference lib="esnext.disposable" preserve="true" />
// Scene-copy transmission for gltf-pro's transmission hook: after the opaque draws the resolved scene is copied into a
// box-filtered mip chain, and transmissive surfaces read it where their refracted ray leaves the volume
// (KHR_materials_transmission, KHR_materials_volume, KHR_materials_dispersion), blurred by roughness.
import { margoError } from '../../shared/errors.js';
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
import { applyView } from '../../shared/view-rect.js';
import { currentFrame, retire } from '../../shared/frame-resources.js';
import { groupCode, alphaBlend } from '../../shared/pass.js';
declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Options for `Transmission.attach()`: the frame graph `order` (default 3). */
export interface TransmissionPassOptions {
  /** Frame graph order of the copy and the transmissive draws: after the opaque scene (1) and sky (2), before water (4), fog (5) and OIT (8). Default 3. */
  order?: number;
}
// Group-2 bindings, clear of shadows (1-3), clustered (10-16), IBL/fog (20-25), materials (32-43) and OIT (120).
const BINDING = 124;
// Hook WGSL: margoTransmission is the light arriving through the surface (linear HDR), added under clearcoat and sheen.
// Blur level: the mip whose box width matches the screen footprint of the transmitted GGX lobe.
// - Microfacet tilt: the GGX slope distribution (Walter et al. 2007, eq. 33) has radial CDF r^2/(alpha^2+r^2), so
//   half the facets are tilted less than delta with tan(delta) = alpha (alpha = roughness^2). That median tilt
//   stands for the lobe's half-width.
// - Bend: a ray along the surface normal meets a facet tilted by delta at incidence delta and, by Snell's law
//   (n1 sin i = n2 sin t, with n1 = 1 outside and n2 = ior), leaves at t = asin(sin(delta)/ior) from the facet normal,
//   so it turns away from the straight-through direction by delta - t. For small tilts dt/di = n1 cos i/(n2 cos t)
//   -> n1/n2, giving delta (1 - 1/ior): zero at IOR 1 (a rough IOR-1 slab stays see-through), rising with roughness
//   and IOR without saturating. The shader evaluates the exact normal-incidence angle (no linearisation).
// - Footprint: with a perspective view the background is taken as distant, so the lobe's angular radius tan(delta-t)
//   covers tan(delta-t) * cot(fov/2) of the half-height in NDC; cot(fov/2) is the length of the camera matrix's
//   y row (projection y scale times a unit view axis). An orthographic view has no angular footprint, so the lateral
//   spread over the volume path, path * tan(delta-t), is scaled by the same row instead. The lobe diameter in
//   texels is that NDC radius times the capture height; mip L averages 2^L texels, so level = log2(diameter).
const declarations = (group: number): string => /* wgsl */ `
@group(${group}) @binding(${BINDING}) var margoScene:texture_2d<f32>;
@group(${group}) @binding(${BINDING + 1}) var margoSceneSampler:sampler;
fn margoTransmissionBehind(i:Out,n:vec3f,v:vec3f,ior:f32,path:f32,level:f32)->vec3f {
  let r=refract(-v,faceForward(n,-v,n),1.0/ior);
  let c=f.camera*vec4f(i.position+r*path,1.0);
  let uv=clamp(c.xy/max(c.w,0.000001)*vec2f(0.5,-0.5)+0.5,vec2f(0),vec2f(1));
  return textureSampleLevel(margoScene,margoSceneSampler,uv,level).rgb;
}
// Blur level from the transmitted lobe width (derivation above declarations) at one IOR: dispersed rays each have their own.
fn margoTransmissionLevel(roughness:f32,ior:f32,path:f32)->f32 {
  let size=vec2f(textureDimensions(margoScene,0));
  let alpha=roughness*roughness;
  let sinTilt=alpha*inverseSqrt(1.0+alpha*alpha);
  let sinOut=sinTilt/ior;
  let tanOut=sinOut*inverseSqrt(1.0-sinOut*sinOut);
  let deviation=max((alpha-tanOut)/(1.0+alpha*tanOut),0.0);
  let wRow=vec3f(f.camera[0].w,f.camera[1].w,f.camera[2].w);
  let yRow=vec3f(f.camera[0].y,f.camera[1].y,f.camera[2].y);
  let reach=select(path,1.0,dot(wRow,wRow)>0.0);
  let texels=deviation*reach*length(yRow)*size.y;
  return clamp(log2(max(texels,1.0)),0.0,f32(textureNumLevels(margoScene)-1u));
}
fn margoTransmission(s:Surface,v:vec3f,i:Out)->vec3f {
  let ior=max(f.ext.y,1.0);
  // Node transforms scale the thickness (KHR_materials_volume): the mean of the model axis lengths.
  let scale=(length(f.model[0].xyz)+length(f.model[1].xyz)+length(f.model[2].xyz))/3.0;
  let path=max(margoVolume.x*s.th*scale,0.0);
  var behind=margoTransmissionBehind(i,s.n,v,ior,path,margoTransmissionLevel(s.roughness,ior,path));
  if(f.ext.w>0.0&&path>0.0){
    // KHR_materials_dispersion: IOR spread (IOR-1)*0.025*dispersion; red and blue each read on their own ray.
    let spread=(ior-1.0)*0.025*f.ext.w;
    let red=max(1.0,ior-spread); let blue=ior+spread;
    behind=vec3f(margoTransmissionBehind(i,s.n,v,red,path,margoTransmissionLevel(s.roughness,red,path)).r,behind.g,margoTransmissionBehind(i,s.n,v,blue,path,margoTransmissionLevel(s.roughness,blue,path)).b);
  }
  // Beer-Lambert through the volume: margoVolume.yzw is the transmittance per world unit.
  var transmittance=vec3f(1.0);
  if(path>0.0){
    let t=margoVolume.yzw;
    transmittance=select(select(pow(max(t,vec3f(0.000001)),vec3f(path)),vec3f(0.0),t<=vec3f(0.0)),vec3f(1.0),t>=vec3f(1.0));
  }
  // The dielectric's Fresnel: glTF 2.0 Appendix B mixes the metal part in beside this one, not over it.
  let keep=1.0-margoFresnelPeak(margoDielectricFresnel(s.f0,s.sw,clamp(dot(s.n,v),0.0,1.0)));
  return (1.0-s.metal)*s.tr*keep*s.base.rgb*transmittance*behind;
}
`;
// Mip chain of the scene copy: level0 copies the resolved scene texel for texel; reduce writes each next level as
// the mean of the 2x2 texels above it (an odd last row or column repeats its edge texel).
const copy = /* wgsl */ `
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var sourceSampler:sampler;
@vertex fn vertex(@builtin(vertex_index) k:u32)->@builtin(position) vec4f {
  let corner=vec2f(f32((k<<1u)&2u),f32(k&2u));
  return vec4f(corner*2.0-1.0,0.0,1.0);
}
@fragment fn level0(@builtin(position) p:vec4f)->@location(0) vec4f {
  return textureLoad(source,vec2i(p.xy),0);
}
@fragment fn reduce(@builtin(position) p:vec4f)->@location(0) vec4f {
  _=sourceSampler;
  let last=vec2i(textureDimensions(source,0))-vec2i(1);
  let o=vec2i(p.xy)*2;
  let sum=textureLoad(source,min(o,last),0)+textureLoad(source,min(o+vec2i(1,0),last),0)+
    textureLoad(source,min(o+vec2i(0,1),last),0)+textureLoad(source,min(o+vec2i(1,1),last),0);
  return sum*0.25;
}
`;
const over: GPUBlendState = alphaBlend;
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
  /** Device of the current GPU resources, so a release after device restoration retires them on their own device. */
  private device?: GPUDevice;
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
  /** Reused back-to-front list. Filled from the model map each frame so equal distances stay in insertion order. */
  private readonly ordered: PBRModel[] = [];

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
      throw margoError(
        this.disposed ? 'disposed' : 'state',
        this.disposed
          ? 'Transmission is disposed; create a new Transmission.'
          : 'Transmission.add needs Transmission.attach(engine) first',
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
    if (this.disposed) throw margoError('disposed', 'Transmission is disposed; create a new Transmission.');
    if (!engine.gpu)
      throw margoError('unsupported', 'Transmission requires WebGPU: create the engine with a WebGPU device');
    this.engine = engine;
    this.device = engine.gpu;
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
    return groupCode(this.code, group, declarations);
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
    this.pass = encoder.beginRenderPass({
      label: 'transmission',
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: c.depth, depthReadOnly: true, stencilReadOnly: true },
    });
    applyView(this.pass, c);
    return this.pass;
  }
  private render(c: Context): void {
    // This view draws in the frame: what it releases waits while another view's commands still need it.
    currentFrame(c.device, c.view ?? c);
    if (this.disposed || !this.models.size) return;
    const target = sceneTarget(c),
      device = c.device;
    if (target?.resolvedColor.format !== 'rgba16float')
      throw margoError(
        'state',
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
    const ordered = this.ordered;
    ordered.length = 0;
    for (const model of this.models.keys()) ordered.push(model);
    ordered.sort((a, b) => distance(b) - distance(a));
    try {
      for (let i = 0; i < ordered.length; i++) ordered[i].draw(c, 'transmission', c.color, c.depth);
    } finally {
      this.context = undefined;
      (this.pass as GPURenderPassEncoder | undefined)?.end();
      this.pass = undefined;
      ordered.length = 0;
    }
  }
  private release(): void {
    retire(this.device!, this.texture);
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
