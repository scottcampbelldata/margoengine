/// <reference lib="esnext.disposable" preserve="true" />
// Projector lights: spot lights that project an image. The image goes into a storage buffer as
// packed rgba8 texels, not a texture: a physical material with shadows, IBL and LocalShadows already binds all 16 sampled
// textures a shader stage may have (docs/shader-contracts.md). Its UVs are those of the spot's local shadow map
// (`localShadowMatrix`: a perspective from the light along its direction, a full field of view of twice the outer cone
// angle, up +y or +z when the light points within 8 degrees of vertical), computed in the shader from the light record, so
// they follow `Clustered.setLights` without a CPU copy.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Clustered, ClusteredLightTerm } from './index.js';
declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number };

/** RGBA8 pixels, rows top to bottom (an `ImageData`, or a decoded image's pixels). */
export interface ProjectorImage {
  readonly width: number;
  readonly height: number;
  /** width x height x 4 bytes: red, green, blue, alpha. */
  readonly data: Uint8Array | Uint8ClampedArray;
}
/** One spot's projected image in {@link ProjectorLights.setProjectors}. */
export interface ProjectorEntry {
  image: ProjectorImage;
  /** `'srgb'` (default): bytes are sRGB-encoded, as in a PNG or JPEG; `'linear'`: linear values. */
  colorSpace?: 'srgb' | 'linear';
  /**
   * Half the vertical field of view, radians below pi / 2 (default: the spot's outer cone angle, the frustum of its
   * local shadow map). The cone still bounds the light, so it cuts a square image's corners at the default; the angle
   * `atan(tan(outer) / sqrt(2))` fits the whole square inside the cone.
   */
  angle?: number;
  /** Width over height of the projection (default 1, the local shadow map's square; give `width / height` to keep proportions). */
  aspect?: number;
}
/** Options of {@link ProjectorLights}. */
export interface ProjectorLightOptions {
  /** The clustered lighting whose spot lights project the images. */
  lights: Clustered;
}
/** Distinct images per {@link ProjectorLights.setProjectors} call. */
export const MAX_PROJECTOR_IMAGES = 16;
/** Texels per projector image side. */
export const MAX_PROJECTOR_SIZE = 4096;
/** Texels in all projector images together. */
export const MAX_PROJECTOR_TEXELS = 1 << 24;
const MAX_LIGHTS = 1024,
  HEADER_WORDS = 4 + MAX_PROJECTOR_IMAGES * 4,
  BINDING = 143;

// Header: light entries; per image its word offset, width, height and sRGB flag; per light its image (index + 1, 0 for
// none), the tangent of its vertical half-angle (0: the cone's) and its aspect; then the texels.
// sRGB decode per IEC 61966-2-1.
const sampling = (group: number) => /* wgsl */ `
struct ClusterProjectorData {header:vec4u,images:array<vec4u,${MAX_PROJECTOR_IMAGES}>,words:array<u32>}
@group(${group}) @binding(${BINDING}) var<storage,read> clusterProjectorData:ClusterProjectorData;
fn clusterProjectorTexel(image:vec4u,x:i32,y:i32)->vec4f {
  let p=clamp(vec2i(x,y),vec2i(0),vec2i(image.yz)-1);let c=unpack4x8unorm(clusterProjectorData.words[image.x+u32(p.y)*image.y+u32(p.x)]);
  let rgb=select(c.rgb,select(c.rgb/12.92,pow((c.rgb+0.055)/1.055,vec3f(2.4)),c.rgb>vec3f(0.04045)),image.w==1u);return vec4f(rgb*c.a,c.a);
}
fn clusterProjector(index:u32,light:ClusterLight,position:vec3f)->vec3f {
  if(index>=clusterProjectorData.header.x||light.params.y<0.5){return vec3f(1);}let at=index*4u;let id=clusterProjectorData.words[at];
  if(id==0u){return vec3f(1);}let image=clusterProjectorData.images[id-1u];
  let dir=light.directionOuter.xyz;let up=select(vec3f(0,1,0),vec3f(0,0,1),abs(dir.y)>0.99);
  let x=normalize(cross(up,-dir));let y=cross(-dir,x);let rel=position-light.positionRange.xyz;let w=dot(rel,dir);
  if(w<=0.0){return vec3f(0);}let c=light.directionOuter.w;let stored=bitcast<f32>(clusterProjectorData.words[at+1u]);
  let fy=1.0/select(sqrt(max(1.0-c*c,0.0))/max(c,1e-6),stored,stored>0.0);let fx=fy/bitcast<f32>(clusterProjectorData.words[at+2u]);
  let uv=vec2f(dot(rel,x)*fx,dot(rel,y)*fy)/w*vec2f(0.5,-0.5)+0.5;
  if(any(uv<vec2f(0))||any(uv>vec2f(1))){return vec3f(0);}
  let t=uv*vec2f(image.yz)-0.5;let i=vec2i(floor(t));let f=t-floor(t);
  let a=mix(clusterProjectorTexel(image,i.x,i.y),clusterProjectorTexel(image,i.x+1,i.y),f.x);
  let b=mix(clusterProjectorTexel(image,i.x,i.y+1),clusterProjectorTexel(image,i.x+1,i.y+1),f.x);
  return mix(a,b,f.y).rgb;
}
`;
/**
 * Projector lights for clustered lighting: each spot at index i of `Clustered.setLights` with
 * entry i of {@link setProjectors} projects that image, filtered bilinearly (edges clamped), multiplied into its light
 * (alpha too: transparent texels project nothing); the light stays dark outside the image. Point lights and lights
 * without an entry are unchanged. The UVs are those of the spot's local shadow map, so a shadowed projector's image and
 * shadow line up. Without images it adds nothing to the shaders or the GPU work.
 */
export class ProjectorLights implements EnginePlugin, ClusteredLightTerm {
  readonly name = 'clustered:projector';
  /** @internal ClusteredLightTerm: the factor in the light loop. */
  readonly term: string = 'clusterProjector(index,light,position)';
  readonly lights: Clustered;
  private engine?: Engine;
  /** @internal Device used by optional projector extensions. */
  protected device?: GPUDevice;
  private buffer?: GPUBuffer;
  private entries: GPUBindGroupEntry[] = [];
  private words = new Uint32Array(HEADER_WORDS);
  private listValue: readonly (ProjectorImage | ProjectorEntry | null | undefined)[] = Object.freeze([]);
  private active = false;
  private dirty = true;
  private disposed = false;
  constructor(options: ProjectorLightOptions) {
    if (!options?.lights || typeof options.lights.setLights !== 'function')
      throw new TypeError('ProjectorLights needs the Clustered lights: new ProjectorLights({ lights })');
    this.lights = options.lights;
  }
  get owner(): Engine | undefined {
    return this.engine;
  }
  static attach(instance: EngineKernel, options: ProjectorLightOptions): ProjectorLights {
    const effect = new ProjectorLights(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  /** The entries last given to `setProjectors` (a frozen copy of the list). */
  get list(): readonly (ProjectorImage | ProjectorEntry | null | undefined)[] {
    return this.listValue;
  }
  /**
   * Entry i is projected by the spot at index i of `Clustered.setLights` (an image, an entry with options, or null for
   * none); lights past the end project nothing. At most {@link MAX_PROJECTOR_IMAGES} distinct images (by object) of up to
   * {@link MAX_PROJECTOR_SIZE} texels a side, {@link MAX_PROJECTOR_TEXELS} in all. The pixels are copied: call again after
   * changing them. Validates everything before changing anything; no images removes the shader code.
   */
  setProjectors(entries: readonly (ProjectorImage | ProjectorEntry | null | undefined)[]): this {
    if (this.disposed) throw new MargoError('disposed', 'ProjectorLights is disposed; create new ProjectorLights');
    if (!Array.isArray(entries) || entries.length > MAX_LIGHTS)
      throw new RangeError(`Expected an array of at most ${MAX_LIGHTS} projector entries, one per clustered light`);
    const images: { image: ProjectorImage; srgb: boolean }[] = [];
    let texels = 0;
    const perLight = entries.map((entry) => {
      if (entry === null || entry === undefined) return [0, 0, 1];
      if (typeof entry !== 'object')
        throw new TypeError('A projector entry must be an image ({width, height, data}), { image, ... } or null');
      const options: ProjectorEntry = 'image' in entry ? entry : { image: entry },
        { image, colorSpace = 'srgb', angle, aspect = 1 } = options;
      if (
        !image ||
        !Number.isInteger(image.width) ||
        !Number.isInteger(image.height) ||
        !(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray)
      )
        throw new TypeError('A projector image needs integer width and height and RGBA8 data (an ImageData)');
      if (
        image.width < 1 ||
        image.height < 1 ||
        image.width > MAX_PROJECTOR_SIZE ||
        image.height > MAX_PROJECTOR_SIZE ||
        image.data.length !== image.width * image.height * 4
      )
        throw new RangeError(
          `A projector image must be 1 to ${MAX_PROJECTOR_SIZE} texels a side with width x height x 4 bytes`,
        );
      if (colorSpace !== 'srgb' && colorSpace !== 'linear')
        throw new TypeError("Projector colorSpace must be 'srgb' or 'linear'");
      if (angle !== undefined && !(angle > 0 && angle < Math.PI / 2))
        throw new RangeError('Projector angle must be in (0, pi/2) radians');
      if (!(aspect > 0 && Number.isFinite(Math.fround(aspect))))
        throw new RangeError('Projector aspect must be a finite number above 0');
      const srgb = colorSpace === 'srgb';
      let id = images.findIndex((known) => known.image === image && known.srgb === srgb);
      if (id < 0) {
        texels += image.width * image.height;
        id = images.push({ image, srgb }) - 1;
      }
      return [id + 1, angle === undefined ? 0 : Math.tan(angle), aspect];
    });
    if (images.length > MAX_PROJECTOR_IMAGES)
      throw new RangeError(`Expected at most ${MAX_PROJECTOR_IMAGES} distinct projector images, got ${images.length}`);
    if (texels > MAX_PROJECTOR_TEXELS)
      throw new RangeError(`Projector images hold ${texels} texels; at most ${MAX_PROJECTOR_TEXELS} in all`);
    const words = new Uint32Array(HEADER_WORDS + perLight.length * 4 + texels),
      floats = new Float32Array(words.buffer);
    words[0] = perLight.length;
    words[1] = images.length;
    let offset = perLight.length * 4;
    images.forEach(({ image, srgb }, i) => {
      words.set([offset, image.width, image.height, +srgb], 4 + i * 4);
      const bytes = image.data;
      // Little-endian rgba8 words, as unpack4x8unorm reads them.
      new Uint8Array(words.buffer, (HEADER_WORDS + offset) * 4, bytes.length).set(bytes);
      offset += image.width * image.height;
    });
    perLight.forEach(([id, tangent, aspect], i) => {
      words[HEADER_WORDS + i * 4] = id;
      floats[HEADER_WORDS + i * 4 + 1] = tangent;
      floats[HEADER_WORDS + i * 4 + 2] = aspect;
    });
    this.words = words;
    this.active = images.length > 0;
    this.listValue = Object.freeze([...entries]);
    this.dirty = true;
    this.sync();
    return this;
  }
  /** @internal ClusteredLightTerm: WGSL defining `clusterProjector`. */
  declarations(group: number): string {
    return sampling(group);
  }
  /** @internal ClusteredLightTerm: binding 143 of the lit shader's group. */
  bindings(): GPUBindGroupEntry[] {
    if (!this.buffer || this.disposed)
      throw new MargoError('state', 'Projector lights are not attached; engine.use(projectors) and set an image first');
    return this.entries;
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'ProjectorLights is disposed; create new ProjectorLights');
    if (!engine.gpu)
      throw new MargoError(
        'unsupported',
        'ProjectorLights requires the WebGPU backend; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.device = engine.gpu;
    this.dirty = true;
    this.sync();
  }
  // The buffer and the hook exist only while some light has an image, so an empty ProjectorLights changes no GPU call.
  // The buffer grows (to a power of two) when the images need more room, and is kept when they need less.
  /** @internal Whether this projector or an optional extension has images. */
  protected get enabled(): boolean { return this.active; }
  /** @internal Synchronize storage and the shared projector hook. */
  protected sync(): void {
    const active = !!this.device && !this.disposed && this.enabled;
    if (active && (!this.buffer || this.buffer.size < this.words.byteLength)) {
      this.buffer?.destroy();
      const size = Math.max(1024, 2 ** Math.ceil(Math.log2(this.words.byteLength))),
        limits = this.device!.limits;
      if (size > limits.maxStorageBufferBindingSize || size > limits.maxBufferSize)
        throw new RangeError(
          'Projector images exceed the device storage buffer limit; use fewer or smaller projector images',
        );
      const buffer = (this.buffer = this.device!.createBuffer({
        size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }));
      this.entries = [{ binding: BINDING, resource: { buffer } }];
      this.dirty = true;
    }
    const hook = active ? this : undefined;
    if (this.lights.projector !== hook) this.lights.projector = hook;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -3.5,
      execute: (c) => {
        if (c.backend !== 'webgpu' || !this.buffer || !this.dirty || !this.active) return;
        c.device.queue.writeBuffer(this.buffer, 0, this.words as Uint32Array<ArrayBuffer>);
        this.dirty = false;
      },
    });
  }
  private release(): void {
    if (this.lights.projector === this) this.lights.projector = undefined;
    this.buffer?.destroy();
    this.buffer = undefined;
    this.entries = [];
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
