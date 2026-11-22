/// <reference lib="esnext.disposable" preserve="true" />
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { checkCamera, checkNumber } from './validation.js';
import { BindGroups, TextureOption, viewOf } from './resources.js';

type TextureSource = GPUTexture | (() => GPUTexture);
/** What reports a lost texture and gives the device a new one belongs to: the engine of the pass that encodes. */
interface SDFOwner {
  readonly gpu?: GPUDevice | null;
  onError(error: unknown): void;
}
/** Painted world-space geometry consumed by GILighting2D. Textures contain straight, linear RGBA. */
export interface SDFScene2DOptions {
  /**
   * Alpha defines opaque cells; RGB defines diffuse albedo. A function is read each frame (a pixel layer's target
   * getter). A plain texture lost at a device restore leaves the painted scene out of the light, reported once,
   * until a new one is assigned to {@link SDFScene2D.source}.
   */
  readonly source: TextureSource;
  /**
   * Emission image, same dimensions as source; a function is read each frame. Default source (black pixels do not emit).
   * A plain texture lost at a device restore uses the default, reported once, until a new one is assigned.
   */
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
@group(0)@binding(6)var emission:texture_2d<f32>;
@group(0)@binding(7)var<storage,read_write>history:array<vec4f>;
@group(0)@binding(8)var<storage,read_write>changed:atomic<u32>;
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
 let color=textureLoad(image,id.xy,0);let light=textureLoad(emission,id.xy,0);
 if(any(color!=history[i*2u])||any(light!=history[i*2u+1u])){atomicOr(&changed,1u);}
 history[i*2u]=color;history[i*2u+1u]=light;
 var d=sqrt(squared[i]);if(solid){d=-sqrt(squared[size.x*size.y+i]);}
 textureStore(field,id.xy,vec4f(d,select(0.0,1.0,solid),0,0));
}
`;

/** Exact pixel-centre signed distance transform, rebuilt on the GPU before every GI frame. */
export class SDFScene2D implements Disposable {
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
  #historyKey?: string;
  #lastEncoder?: GPUCommandEncoder;
  #owner?: SDFOwner;
  readonly #sourceOption: TextureOption;
  readonly #emissionOption: TextureOption;
  readonly #groups = new BindGroups();
  readonly #changed = new Uint32Array(1);
  readonly #settings = new Float32Array(8);

  constructor(options: SDFScene2DOptions) {
    if (!options?.source) throw typeError('SDFScene2D source is required', 'pixel-lighting');
    this.#sourceOption = new TextureOption(options.source, 'SDFScene2D source', 'assign a new source');
    this.#emissionOption = new TextureOption(options.emission, 'SDFScene2D emission', 'assign a new emission');
    this.camera = options.camera ?? { x: 0, y: 0, zoom: 1 };
    this.alphaThreshold = options.alphaThreshold ?? 0.5;
    this.emissionIntensity = options.emissionIntensity ?? 1;
    this.#validate();
  }
  #validate(): void {
    checkCamera(this.camera);
    checkNumber(this.alphaThreshold, 'alphaThreshold', 0);
    if (this.alphaThreshold > 1) throw rangeError('alphaThreshold must be in [0,1]', 'pixel-lighting');
    checkNumber(this.emissionIntensity, 'emissionIntensity', 0);
  }
  /** Borrowed alpha/albedo texture or getter, read on every encode. Never destroyed by this object. */
  get source(): TextureSource {
    return this.#sourceOption.value!;
  }
  set source(value: TextureSource) {
    if (!value) throw typeError('SDFScene2D source is required', 'pixel-lighting');
    this.#sourceOption.set(value, this.#owner?.gpu);
  }
  /** Borrowed emission texture or getter; undefined uses source. Never destroyed by this object. */
  get emission(): TextureSource | undefined {
    return this.#emissionOption.value;
  }
  set emission(value: TextureSource | undefined) {
    this.#emissionOption.set(value, this.#owner?.gpu);
  }
  /** Current rgba32float field: R signed distance in source pixels, G occupancy. Replaced on resize/restore. */
  get distanceTexture(): GPUTexture | undefined {
    return this.#field;
  }
  /** GPU flag for exact source/emission/configuration changes in the current encoded snapshot. */
  get changeBuffer(): GPUBuffer | undefined {
    return this.#buffers[5];
  }

  /**
   * Encode the three exact transform passes into the caller's frame; GILighting2D calls this automatically and passes
   * its engine as `owner`, which reports a lost texture once. Returns false, encoding nothing, while a plain source is
   * lost with its device.
   */
  encode(device: GPUDevice, encoder: GPUCommandEncoder, owner?: SDFOwner): boolean {
    if (this.#disposed) throw fault('disposed', 'SDFScene2D disposed; create a new one', 'pixel-lighting');
    this.#validate();
    if (owner) this.#owner = owner;
    if (this.#lastEncoder === encoder && this.#device === device) return true;
    if (this.#device !== device) {
      this.#release();
      this.#device = device;
    }
    const source = this.#sourceOption.get(device, this.#owner);
    if (!source) return false;
    // No emission image, or a plain one lost with its device: the source, as when emission is left out.
    const emission = this.#emissionOption.get(device, this.#owner) ?? source;
    for (const image of [source, emission]) {
      if (
        image.dimension !== '2d' ||
        image.depthOrArrayLayers !== 1 ||
        image.sampleCount !== 1 ||
        !(image.usage & 4) ||
        !/^(rgba8unorm(-srgb)?|bgra8unorm(-srgb)?|rgba16float|rgba32float)$/.test(image.format)
      )
        throw rangeError(
          'SDF images must be single-sample 2D normalized or float RGBA textures with TEXTURE_BINDING',
          'pixel-lighting',
        );
    }
    if (source.width !== emission.width || source.height !== emission.height)
      throw rangeError('SDF emission dimensions must match source', 'pixel-lighting');
    const count = source.width * source.height;
    if (count * 32 > device.limits.maxStorageBufferBindingSize || count * 32 > device.limits.maxBufferSize)
      throw rangeError('SDF scratch exceeds device buffer limit', 'pixel-lighting');
    if (
      Math.ceil(Math.max(source.width * 2, source.height) / 64) > device.limits.maxComputeWorkgroupsPerDimension ||
      Math.ceil(Math.max(source.width, source.height) / 8) > device.limits.maxComputeWorkgroupsPerDimension
    )
      throw rangeError('SDF dispatch exceeds device limit', 'pixel-lighting');
    if (!this.#layout) {
      const visibility = 4;
      this.#layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility, buffer: { type: 'uniform' } },
          { binding: 1, visibility, texture: { sampleType: 'unfilterable-float' } },
          ...[2, 3, 4].map((binding) => ({ binding, visibility, buffer: { type: 'storage' as const } })),
          { binding: 5, visibility, storageTexture: { access: 'write-only', format: 'rgba32float' } },
          { binding: 6, visibility, texture: { sampleType: 'unfilterable-float' } },
          ...[7, 8].map((binding) => ({ binding, visibility, buffer: { type: 'storage' as const } })),
        ],
      });
      const module = device.createShaderModule({ label: 'exact painted distance transform', code: transformShader });
      const layout = device.createPipelineLayout({ bindGroupLayouts: [this.#layout] });
      this.#pipelines = ['horizontal', 'vertical', 'finish'].map((entryPoint) =>
        device.createComputePipeline({
          layout,
          compute: { module, entryPoint },
        }),
      );
    }
    if (!this.#field || this.#field.width !== source.width || this.#field.height !== source.height) {
      this.#field?.destroy();
      for (const buffer of this.#buffers) buffer.destroy();
      this.#historyKey = undefined;
      this.#buffers = [32, count * 8, count * 16, count * 8, count * 32, 16].map((size, i) =>
        device.createBuffer({
          size,
          usage: (i ? 128 : 64) | 8,
        }),
      );
      this.#field = device.createTexture({
        label: 'painted signed distance',
        size: [source.width, source.height],
        format: 'rgba32float',
        usage: 4 | 8 | 1,
      });
    }
    this.#source = source;
    this.#emission = emission;
    const key = JSON.stringify([this.camera, this.alphaThreshold, this.emissionIntensity]);
    this.#changed[0] = this.#historyKey === key ? 0 : 1;
    device.queue.writeBuffer(this.#buffers[5], 0, this.#changed);
    this.#settings.set([
      this.camera.x,
      this.camera.y,
      this.camera.zoom,
      0,
      this.alphaThreshold,
      this.emissionIntensity,
    ]);
    device.queue.writeBuffer(this.#buffers[0], 0, this.#settings);
    // Kept while the images, the field and the scratch are the same objects: a steady frame makes none.
    const b = this.#buffers,
      group = this.#groups.get(device, 'encode', this.#layout, [
        { binding: 0, resource: { buffer: b[0] } },
        { binding: 1, resource: viewOf(source) },
        { binding: 2, resource: { buffer: b[1] } },
        { binding: 3, resource: { buffer: b[2] } },
        { binding: 4, resource: { buffer: b[3] } },
        { binding: 5, resource: viewOf(this.#field) },
        { binding: 6, resource: viewOf(emission) },
        { binding: 7, resource: { buffer: b[4] } },
        { binding: 8, resource: { buffer: b[5] } },
      ]);
    this.#pipelines.forEach((pipeline, i) => {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      if (i === 2) pass.dispatchWorkgroups(Math.ceil(source.width / 8), Math.ceil(source.height / 8));
      else pass.dispatchWorkgroups(Math.ceil((i ? source.width * 2 : source.height) / 64));
      pass.end();
    });
    this.#historyKey = key;
    this.#lastEncoder = encoder;
    return true;
  }
  /** Bind the encoded field, source and emission for an owning lighting pass; the same group while nothing changed. */
  bindGroup(device: GPUDevice, layout: GPUBindGroupLayout): GPUBindGroup {
    if (device !== this.#device || !this.#field)
      throw fault('state', 'Encode the SDF scene before binding it', 'pixel-lighting');
    return this.#groups.get(device, 'bind', layout, [
      { binding: 0, resource: { buffer: this.#buffers[0] } },
      { binding: 1, resource: viewOf(this.#source!) },
      { binding: 2, resource: viewOf(this.#emission!) },
      { binding: 3, resource: viewOf(this.#field) },
      { binding: 4, resource: { buffer: this.#buffers[5] } },
    ]);
  }
  #release(): void {
    this.#field?.destroy();
    this.#field = undefined;
    for (const buffer of this.#buffers) buffer.destroy();
    this.#buffers = [];
    this.#pipelines = [];
    this.#layout = undefined;
    this.#device = undefined;
    this.#source = this.#emission = undefined;
    this.#historyKey = undefined;
    this.#lastEncoder = undefined;
    this.#groups.clear();
  }
  /** Release owned scratch and field textures; source textures remain borrowed. */
  dispose(): void {
    if (!this.#disposed) {
      this.#disposed = true;
      this.#release();
    }
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
