/// <reference lib="esnext.disposable" preserve="true" />
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { checkCamera, checkNumber } from './validation.js';

type TextureSource = GPUTexture | (() => GPUTexture);
/** Painted world-space geometry consumed by GILighting2D. Textures contain straight, linear RGBA. */
export interface SDFScene2DOptions {
  /** Alpha defines opaque cells; RGB defines diffuse albedo. A pixel layer's target getter is accepted. */
  readonly source: TextureSource;
  /** Emission image, same dimensions as source. Default source (black pixels do not emit). */
  readonly emission?: TextureSource;
  /** Top-left world origin and pixels per world unit. Default {x:0,y:0,zoom:1}. Read each frame. */
  readonly camera?: { x: number; y: number; zoom: number };
  /** Positive alpha at or above this value is opaque. Default .5; range [0,1]. */
  readonly alphaThreshold?: number;
  /** Linear HDR emission multiplier, default 1, nonnegative. */
  readonly emissionIntensity?: number;
}

const transformShader = /* wgsl */ `
struct Settings { camera:vec4f, material:vec4f }
@group(0)@binding(0)var<uniform>u:Settings;
@group(0)@binding(1)var image:texture_2d<f32>;
@group(0)@binding(2)var<storage,read_write>rows:array<vec2f>;
@group(0)@binding(3)var<storage,read_write>hull:array<vec2f>;
@group(0)@binding(4)var<storage,read_write>squared:array<f32>;
@group(0)@binding(5)var field:texture_storage_2d<rgba32float,write>;
const INF:f32=1e20;
@compute @workgroup_size(64)fn horizontal(@builtin(global_invocation_id)id:vec3u){
 let size=textureDimensions(image);let y=id.x;if(y>=size.y){return;}
 var previous=vec2f(-1e10);
 for(var x=0u;x<size.x;x++){
  let a=textureLoad(image,vec2u(x,y),0).a;let solid=a>0&&a>=u.material.x;
  if(solid){previous.x=f32(x);}else{previous.y=f32(x);}
  let delta=vec2f(f32(x))-previous;rows[y*size.x+x]=delta*delta;
 }
 previous=vec2f(1e10);
 for(var x=i32(size.x)-1;x>=0;x--){
  let a=textureLoad(image,vec2i(x,i32(y)),0).a;let solid=a>0&&a>=u.material.x;
  if(solid){previous.x=f32(x);}else{previous.y=f32(x);}
  let delta=previous-vec2f(f32(x));let i=y*size.x+u32(x);rows[i]=min(rows[i],delta*delta);
 }
}
// Lower envelopes of parabolas, one independent column/class per invocation (Felzenszwalb/Huttenlocher).
@compute @workgroup_size(64)fn vertical(@builtin(global_invocation_id)id:vec3u){
 let size=textureDimensions(image);if(id.x>=size.x*2u){return;}
 let x=id.x%size.x;let channel=id.x/size.x;let base=id.x*size.y;var k=-1;
 for(var y=0u;y<size.y;y++){
  let f=rows[y*size.x+x][channel];if(f>=INF){continue;}
  var start=-INF;
  loop {
   if(k<0){break;}
   let q=hull[base+u32(k)].x;let fq=rows[u32(q)*size.x+x][channel];
   start=((f+f32(y)*f32(y))-(fq+q*q))/(2*(f32(y)-q));
   if(start>hull[base+u32(k)].y){break;}k--;
  }
  if(k<0){start=-INF;}k++;hull[base+u32(k)]=vec2f(f32(y),start);
 }
 var cursor=0;
 for(var y=0u;y<size.y;y++){
  var d=INF;
  if(k>=0){
   loop{if(cursor>=k){break;}if(hull[base+u32(cursor+1)].y>=f32(y)){break;}cursor++;}
   let q=hull[base+u32(cursor)].x;d=(f32(y)-q)*(f32(y)-q)+rows[u32(q)*size.x+x][channel];
  }
  squared[channel*size.x*size.y+y*size.x+x]=d;
 }
}
@compute @workgroup_size(8,8)fn finish(@builtin(global_invocation_id)id:vec3u){
 let size=textureDimensions(image);if(any(id.xy>=size)){return;}
 let a=textureLoad(image,id.xy,0).a;let solid=a>0&&a>=u.material.x;let i=id.y*size.x+id.x;
 var d=sqrt(squared[i]);if(solid){d=-sqrt(squared[size.x*size.y+i]);}
 textureStore(field,id.xy,vec4f(d,select(0.0,1.0,solid),0,0));
}
`;

/** Exact pixel-centre signed distance transform, rebuilt on the GPU before every GI frame. */
export class SDFScene2D implements Disposable {
  /** Borrowed alpha/albedo texture or getter. Never destroyed by this object. */
  source: TextureSource;
  /** Borrowed emission texture or getter; undefined uses source. */
  emission?: TextureSource;
  /** Top-left world origin and pixel scale, read on every encode. */
  camera: { x: number; y: number; zoom: number };
  /** Opaque alpha cutoff, default .5. */
  alphaThreshold: number;
  /** HDR emission multiplier, default 1. */
  emissionIntensity: number;
  #device?: GPUDevice;
  #field?: GPUTexture;
  #buffers: GPUBuffer[] = [];
  #pipelines: GPUComputePipeline[] = [];
  #layout?: GPUBindGroupLayout;
  #source?: GPUTexture;
  #emission?: GPUTexture;
  #disposed = false;

  constructor(options: SDFScene2DOptions) {
    if (!options?.source) throw typeError('SDFScene2D source is required', 'pixel-lighting');
    this.source = options.source;
    this.emission = options.emission;
    this.camera = options.camera ?? { x: 0, y: 0, zoom: 1 };
    this.alphaThreshold = options.alphaThreshold ?? .5;
    this.emissionIntensity = options.emissionIntensity ?? 1;
    this.#validate();
  }
  #validate(): void {
    checkCamera(this.camera);
    checkNumber(this.alphaThreshold, 'alphaThreshold', 0);
    if (this.alphaThreshold > 1) throw rangeError('alphaThreshold must be in [0,1]', 'pixel-lighting');
    checkNumber(this.emissionIntensity, 'emissionIntensity', 0);
  }
  /** Current rgba32float field: R signed distance in source pixels, G occupancy. Replaced on resize/restore. */
  get distanceTexture(): GPUTexture | undefined { return this.#field; }

  /** Encode the three exact transform passes into the caller's frame. GILighting2D calls this automatically. */
  encode(device: GPUDevice, encoder: GPUCommandEncoder): void {
    if (this.#disposed) throw fault('disposed', 'SDFScene2D disposed; create a new one', 'pixel-lighting');
    this.#validate();
    const pick = (source: TextureSource) => typeof source === 'function' ? source() : source;
    const source = pick(this.source), emission = pick(this.emission ?? this.source);
    for (const image of [source, emission]) {
      if (image.dimension !== '2d' || image.depthOrArrayLayers !== 1 || image.sampleCount !== 1 ||
          !(image.usage & 4) || !/^(rgba8unorm(-srgb)?|bgra8unorm(-srgb)?|rgba16float|rgba32float)$/.test(image.format))
        throw rangeError('SDF images must be single-sample 2D normalized or float RGBA textures with TEXTURE_BINDING', 'pixel-lighting');
    }
    if (source.width !== emission.width || source.height !== emission.height)
      throw rangeError('SDF emission dimensions must match source', 'pixel-lighting');
    const count = source.width * source.height;
    if (count * 16 > device.limits.maxStorageBufferBindingSize || count * 16 > device.limits.maxBufferSize)
      throw rangeError('SDF scratch exceeds device buffer limit', 'pixel-lighting');
    if (Math.ceil(Math.max(source.width * 2, source.height) / 64) > device.limits.maxComputeWorkgroupsPerDimension ||
        Math.ceil(Math.max(source.width, source.height) / 8) > device.limits.maxComputeWorkgroupsPerDimension)
      throw rangeError('SDF dispatch exceeds device limit', 'pixel-lighting');
    if (this.#device !== device) { this.#release(); this.#device = device; }
    if (!this.#layout) {
      const visibility = 4;
      this.#layout = device.createBindGroupLayout({ entries: [
        { binding: 0, visibility, buffer: { type: 'uniform' } },
        { binding: 1, visibility, texture: { sampleType: 'unfilterable-float' } },
        ...[2, 3, 4].map(binding => ({ binding, visibility, buffer: { type: 'storage' as const } })),
        { binding: 5, visibility, storageTexture: { access: 'write-only', format: 'rgba32float' } },
      ] });
      const module = device.createShaderModule({ label: 'exact painted distance transform', code: transformShader });
      const layout = device.createPipelineLayout({ bindGroupLayouts: [this.#layout] });
      this.#pipelines = ['horizontal', 'vertical', 'finish'].map(entryPoint => device.createComputePipeline({
        layout, compute: { module, entryPoint },
      }));
    }
    if (!this.#field || this.#field.width !== source.width || this.#field.height !== source.height) {
      this.#field?.destroy();
      for (const buffer of this.#buffers) buffer.destroy();
      this.#buffers = [32, count * 8, count * 16, count * 8].map((size, i) => device.createBuffer({
        size, usage: (i ? 128 : 64) | 8,
      }));
      this.#field = device.createTexture({ label: 'painted signed distance', size: [source.width, source.height],
        format: 'rgba32float', usage: 4 | 8 | 1 });
    }
    this.#source = source; this.#emission = emission;
    device.queue.writeBuffer(this.#buffers[0], 0, new Float32Array([
      this.camera.x, this.camera.y, this.camera.zoom, 0, this.alphaThreshold, this.emissionIntensity, 0, 0,
    ]));
    const group = device.createBindGroup({ layout: this.#layout, entries: [
      { binding: 0, resource: { buffer: this.#buffers[0] } }, { binding: 1, resource: source.createView() },
      ...this.#buffers.slice(1).map((buffer, i) => ({ binding: i + 2, resource: { buffer } })),
      { binding: 5, resource: this.#field.createView() },
    ] });
    this.#pipelines.forEach((pipeline, i) => {
      const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group);
      if (i === 2) pass.dispatchWorkgroups(Math.ceil(source.width / 8), Math.ceil(source.height / 8));
      else pass.dispatchWorkgroups(Math.ceil((i ? source.width * 2 : source.height) / 64));
      pass.end();
    });
  }
  /** Bind the encoded field, source and emission for an owning lighting pass. */
  bindGroup(device: GPUDevice, layout: GPUBindGroupLayout): GPUBindGroup {
    if (device !== this.#device || !this.#field) throw fault('state', 'Encode the SDF scene before binding it', 'pixel-lighting');
    return device.createBindGroup({ layout, entries: [
      { binding: 0, resource: { buffer: this.#buffers[0] } },
      { binding: 1, resource: this.#source!.createView() }, { binding: 2, resource: this.#emission!.createView() },
      { binding: 3, resource: this.#field.createView() },
    ] });
  }
  #release(): void {
    this.#field?.destroy(); this.#field = undefined;
    for (const buffer of this.#buffers) buffer.destroy();
    this.#buffers = []; this.#pipelines = []; this.#layout = undefined; this.#device = undefined;
    this.#source = this.#emission = undefined;
  }
  /** Release owned scratch and field textures; source textures remain borrowed. */
  dispose(): void { if (!this.#disposed) { this.#disposed = true; this.#release(); } }
  [Symbol.dispose](): void { this.dispose(); }
}
