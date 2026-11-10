/// <reference lib="esnext.disposable" preserve="true" />
import { TextureRenderTarget } from './texture-target.js';
import type { TextureRenderTargetOptions, TargetSurface } from './texture-target.js';
import { rangeError } from '../../shared/errors.js';
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number; COPY_DST: number };

/** Depth and resolve configuration. Reversed depth defaults to zero, as in the engine. */
export interface DepthTargetOptions extends TextureRenderTargetOptions {
  /** Default: true. */
  readonly depth?: boolean;
  /** Default: depth32float. */
  readonly depthFormat?: 'depth32float' | 'depth24plus' | 'depth24plus-stencil8';
  /** Default: 1. WebGPU supports 1 or 4 samples. */
  readonly samples?: 1 | 4;
}
/** A selected surface with independent depth load and clear controls. */
export interface DepthTargetSurface extends TargetSurface {
  /** Default: clear. */
  readonly depthLoadOp?: 'clear' | 'load';
  /** Default: 0 (reversed Z). */
  readonly clearDepth?: number;
}
type Attachments = { depth?: GPUTexture; msaa?: GPUTexture; resolve?: GPUTexture };
const invalid = (message: string) => rangeError(`Depth target ${message}`, 'creative-target');

function validate(options: DepthTargetOptions): DepthTargetOptions {
  if (![1, 4].includes(options.samples ?? 1)) throw invalid('samples must be 1 or 4; choose a supported count');
  if (options.depth !== undefined && typeof options.depth !== 'boolean') throw invalid('depth must be boolean; use true or false');
  if (!['depth32float', 'depth24plus', 'depth24plus-stencil8'].includes(options.depthFormat ?? 'depth32float'))
    throw invalid('depthFormat is unsupported; choose a depth attachment format');
  // Include retained depth, multisample color and volume resolve scratch in the allocation bar.
  let bytes = 0;
  for (let m = 0; m < (options.mipLevelCount ?? 1) && m < 32; m++) {
    const w = Math.max(1, Math.floor(options.width / 2 ** m));
    const h = Math.max(1, Math.floor((options.height ?? options.width) / 2 ** m));
    const d = options.kind === '3d' ? Math.max(1, Math.floor((options.depthOrLayers ?? 1) / 2 ** m)) : (options.depthOrLayers ?? (options.kind === 'cube' ? 6 : 1));
    const color = options.format === 'rgba16float' ? 8 : 4, samples = options.samples ?? 1;
    bytes += w * h * d * (color + (options.depth === false ? 0 : 4 * samples) + (samples === 4 ? color * (4 + (options.kind === '3d' ? 1 : 0)) : 0));
  }
  if (bytes > 256 * 1024 * 1024) throw invalid('allocation exceeds 256 MiB; reduce dimensions or samples');
  return options;
}

/** Cube/array/volume target with per-surface depth, 4x resolve and area-filtered mip generation. */
export class DepthTextureRenderTarget extends TextureRenderTarget {
  readonly samples: 1 | 4;
  readonly depthFormat: GPUTextureFormat;
  readonly depth: boolean;
  #device: GPUDevice;
  #attachments = new Map<string, Attachments>();
  #mipPipeline?: GPURenderPipeline;

  constructor(device: GPUDevice | null | undefined, options: DepthTargetOptions) {
    super(device, validate(options));
    this.#device = device!;
    this.samples = options.samples ?? 1;
    this.depth = options.depth ?? true;
    this.depthFormat = options.depthFormat ?? 'depth32float';
  }
  protected override textureUsage(): number {
    return super.textureUsage() | GPUTextureUsage.COPY_DST;
  }

  #surface(mip: number, layer: number): Attachments {
    const [w, h, d] = this.mipSize(mip);
    if (!Number.isInteger(layer) || layer < 0 || layer >= d) throw invalid('layer is out of range; choose an existing surface');
    const key = `${mip}:${layer}`;
    let a = this.#attachments.get(key);
    if (!a) {
      a = {};
      this.#attachments.set(key, a);
      const create = (format: GPUTextureFormat, sampleCount: number, usage = GPUTextureUsage.RENDER_ATTACHMENT) =>
        this.#device.createTexture({ size: [w, h], format, sampleCount, usage });
      if (this.depth) a.depth = create(this.depthFormat, this.samples, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING);
      if (this.samples === 4) {
        a.msaa = create(this.options.format, 4);
        if (this.options.kind === '3d') a.resolve = create(this.options.format, 1, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
      }
    }
    return a;
  }

  /** Depth texture for this surface, including multisampled depth when samples is 4. */
  depthTexture(surface: TargetSurface = {}): GPUTexture | undefined {
    return this.#surface(surface.mip ?? 0, surface.layer ?? 0).depth;
  }

  override begin(encoder: GPUCommandEncoder, surface: DepthTargetSurface = {}): GPURenderPassEncoder {
    const depthLoadOp = surface.depthLoadOp ?? 'clear', clearDepth = surface.clearDepth ?? 0;
    if (!['clear', 'load'].includes(depthLoadOp) || !Number.isFinite(clearDepth) || clearDepth < 0 || clearDepth > 1)
      throw invalid('depth clear/load is invalid; use clear or load and a depth in 0..1');
    let desc!: GPURenderPassDescriptor;
    super.begin({ beginRenderPass: (d: GPURenderPassDescriptor) => { desc = d; return {} as GPURenderPassEncoder; } } as GPUCommandEncoder, surface);
    const mip = surface.mip ?? 0, layer = surface.layer ?? 0;
    const a = this.#surface(mip, layer);
    const color = Array.from(desc.colorAttachments)[0]!;
    if (a.msaa) {
      color.resolveTarget = a.resolve?.createView() ?? color.view;
      color.view = a.msaa.createView();
      delete color.depthSlice;
    }
    if (a.depth) desc.depthStencilAttachment = {
      view: a.depth.createView(), depthLoadOp, depthStoreOp: 'store', depthClearValue: clearDepth,
      ...(this.depthFormat === 'depth24plus-stencil8' ? { stencilLoadOp: depthLoadOp, stencilStoreOp: 'store', stencilClearValue: 0 } : {}),
    };
    const pass = encoder.beginRenderPass(desc);
    if (!a.resolve) return pass;
    const target = this.texture, size = this.mipSize(mip), resolve = a.resolve;
    return new Proxy(pass, { get(object, key) {
      if (key === 'end') return () => {
        object.end();
        encoder.copyTextureToTexture({ texture: resolve }, { texture: target, mipLevel: mip, origin: [0, 0, layer] }, [size[0], size[1], 1]);
      };
      const value = Reflect.get(object, key, object);
      return typeof value === 'function' ? value.bind(object) : value;
    } });
  }

  /** Record all lower mips after rendering mip zero. Exact box footprints include odd-sized edge texels. */
  generateMipmaps(encoder: GPUCommandEncoder): void {
    this.mipSize();
    const volume = this.options.kind === '3d';
    if (!this.#mipPipeline) {
      const module = this.#device.createShaderModule({ code: `
@group(0) @binding(0) var source: texture_${volume ? '3d' : '2d_array'}<f32>;
struct Out { @builtin(position) p: vec4f, @location(0) @interpolate(flat) layer: u32 }
@vertex fn vs(@builtin(vertex_index) i:u32, @builtin(instance_index) layer:u32)->Out {
  let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  return Out(vec4f(p[i],0,1),layer);
}
@fragment fn fs(input:Out)->@location(0) vec4f {
  let size = vec3f(vec2f(textureDimensions(source,0).xy), ${volume ? 'f32(textureDimensions(source,0).z)' : '1.0'});
  let output = max(floor(size/2.0),vec3f(1));
  let pixel = vec3f(floor(input.p.xy),${volume ? 'f32(input.layer)' : '0.0'});
  let lo = pixel*size/output; let hi = (pixel+1.0)*size/output;
  var sum = vec4f(0); var weight = 0.0;
  for(var z=i32(floor(lo.z)); z<i32(ceil(hi.z)); z++) {
    for(var y=i32(floor(lo.y)); y<i32(ceil(hi.y)); y++) {
      for(var x=i32(floor(lo.x)); x<i32(ceil(hi.x)); x++) {
        let delta = max(vec3f(0), min(hi,vec3f(f32(x+1),f32(y+1),f32(z+1)))-max(lo,vec3f(f32(x),f32(y),f32(z))));
        let w = delta.x*delta.y*delta.z;
        sum += textureLoad(source, ${volume ? 'vec3i(x,y,z),0' : 'vec2i(x,y),i32(input.layer),0'})*w; weight += w;
      }
    }
  }
  return sum/weight;
}` });
      this.#mipPipeline = this.#device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: this.options.format }] } });
    }
    for (let mip = 1; mip < this.options.mipLevelCount; mip++) {
      const group = this.#device.createBindGroup({ layout: this.#mipPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: this.texture.createView({ dimension: volume ? '3d' : '2d-array', baseMipLevel: mip - 1, mipLevelCount: 1 }) }] });
      for (let layer = 0; layer < this.mipSize(mip)[2]; layer++) {
        const pass = super.begin(encoder, { mip, layer });
        pass.setPipeline(this.#mipPipeline); pass.setBindGroup(0, group); pass.draw(3, 1, 0, layer); pass.end();
      }
    }
  }
  #release(): void {
    for (const a of this.#attachments.values()) { a.depth?.destroy(); a.msaa?.destroy(); a.resolve?.destroy(); }
    this.#attachments.clear(); this.#mipPipeline = undefined;
  }
  override restore(device: GPUDevice | null | undefined): void {
    super.restore(device); this.#release(); this.#device = device!;
  }
  override dispose(): void { this.#release(); super.dispose(); }
}
