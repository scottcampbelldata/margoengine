/// <reference lib="esnext.disposable" preserve="true" />
// Textured rectangle area lights: an image on each AreaLights rectangle (a TV screen, stained glass, a sign) that colours
// the light it casts. The image goes into a storage buffer, not a texture, as half-float linear RGB with a box-filtered
// level chain: a physical material with shadows, IBL and LocalShadows already binds all 16 sampled textures a shader
// stage may have (docs/shader-contracts.md). No texture binding is added.
//
// Shading: AreaLights integrates each rectangle under two linearly transformed cosines (Heitz, Dupuy, Hill & Neubelt
// 2016), one for GGX specular and one for the Lambert lobe. For a textured light the scalar integral is multiplied by the
// image filtered over the part of the rectangle the lobe sees. In the cosine space the lobe is a clamped cosine around +z
// and the rectangle stays a parallelogram (the transform is linear, so affine coordinates on the light are kept). The
// direction the cosine weights the polygon toward is its vector form factor (Lambert's edge sum; the z component is the
// scalar integral AreaLights already evaluates); the image is read where that direction meets the rectangle's plane (the
// foot of the perpendicular when it does not). The footprint of a clamped cosine on a plane at distance h is
// E(x) proportional to h^2 / (h^2 + x^2)^2, which falls to half at x = h sqrt(sqrt(2) - 1) = 0.6436 h; the level chain is
// read at the level whose texel spans that footprint's diameter over the transformed rectangle's side (the square root
// of its area). Far lights and rough lobes thus read the mean colour, near and sharp ones the texel. The derivation is
// Margo's own from the LTC paper's integral and the cosine footprint; the LTC paper's textured-light section could not
// be read for this job (docs/clean-room.md, docs/work-lists/finish-later.md).
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { f16Bits } from '../../shared/f16.js';
import type { AreaLights, AreaLightTexture } from './area.js';
declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number };

/** RGBA8 pixels, rows top to bottom (an `ImageData`, or a decoded image's pixels). Alpha premultiplies the colour. */
export interface AreaTextureImage {
  readonly width: number;
  readonly height: number;
  /** width x height x 4 bytes: red, green, blue, alpha. */
  readonly data: Uint8Array | Uint8ClampedArray;
}
/** One area light's image in {@link AreaLightTextures.setTextures}. */
export interface AreaTextureEntry {
  image: AreaTextureImage;
  /** `'srgb'` (default): bytes are sRGB-encoded, as in a PNG or JPEG; `'linear'`: linear values. */
  colorSpace?: 'srgb' | 'linear';
}
/** Options of {@link AreaLightTextures}. */
export interface AreaLightTextureOptions {
  /** The rectangle area lights that carry the images. */
  area: AreaLights;
}
/** Distinct images per {@link AreaLightTextures.setTextures} call. */
export const MAX_AREA_TEXTURES = 16;
/** Texels per image side. */
export const MAX_AREA_TEXTURE_SIZE = 1024;
/** Texels in all images together, their level chains included. */
export const MAX_AREA_TEXTURE_TEXELS = 1 << 22;
const MAX_LIGHTS = 64,
  HEADER_WORDS = 4 + MAX_AREA_TEXTURES * 4,
  BINDING = 153,
  // Half-width of the clamped cosine's footprint at half its peak, over the distance: sqrt(sqrt(2) - 1).
  FOOTPRINT = Math.sqrt(Math.SQRT2 - 1);

/** Levels of a width x height chain: each halves (rounded down, at least 1) until both sides are 1. */
export function areaTextureLevels(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}
const decode = (v: number, srgb: boolean) => {
  const c = v / 255;
  // sRGB decode per IEC 61966-2-1.
  return !srgb ? c : c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
};
/**
 * The level chain of an image as linear premultiplied RGB floats, level 0 first: each level halves the last (sides
 * rounded down, at least 1) with an area-weighted box filter, so every level keeps the image's mean exactly.
 */
export function areaTextureChain(image: AreaTextureImage, srgb = true): Float32Array[] {
  const { width, height, data } = image,
    first = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const alpha = data[i * 4 + 3] / 255;
    for (let k = 0; k < 3; k++) first[i * 3 + k] = decode(data[i * 4 + k], srgb) * alpha;
  }
  const chain = [first];
  let w = width,
    h = height;
  for (let level = 1; level < areaTextureLevels(width, height); level++) {
    const w2 = Math.max(1, w >> 1),
      h2 = Math.max(1, h >> 1),
      src = chain[level - 1],
      dst = new Float32Array(w2 * h2 * 3);
    // Destination texel x covers source [x w / w2, (x + 1) w / w2): weights of the overlapped source texels.
    const spans = (n: number, n2: number, i: number): [number, number][] => {
      const lo = (i * n) / n2,
        hi = ((i + 1) * n) / n2,
        out: [number, number][] = [];
      for (let s = Math.floor(lo); s < Math.ceil(hi); s++)
        out.push([s, (Math.min(hi, s + 1) - Math.max(lo, s)) / (hi - lo)]);
      return out;
    };
    for (let y = 0; y < h2; y++)
      for (let x = 0; x < w2; x++)
        for (const [sy, wy] of spans(h, h2, y))
          for (const [sx, wx] of spans(w, w2, x))
            for (let k = 0; k < 3; k++) dst[(y * w2 + x) * 3 + k] += src[(sy * w + sx) * 3 + k] * wx * wy;
    chain.push(dst);
    w = w2;
    h = h2;
  }
  return chain;
}

// Header: light entries; per image its word offset, width, height and level count; per light its image (index + 1, 0
// for none); then each image's levels, two words (pack2x16float: red green, blue 1) per texel, level 0 first.
const sampling = (group: number) => /* wgsl */ `
struct AreaTextureData {header:vec4u,images:array<vec4u,${MAX_AREA_TEXTURES}>,words:array<u32>}
@group(${group}) @binding(${BINDING}) var<storage,read> areaTextureData:AreaTextureData;
fn areaTextureLevel(image:vec4u,level:u32)->vec3u {var o=image.x;var w=image.y;var h=image.z;
  for(var k=0u;k<level;k++){o+=w*h*2u;w=max(w/2u,1u);h=max(h/2u,1u);}return vec3u(o,w,h);}
fn areaTextureTexel(l:vec3u,x:i32,y:i32)->vec3f {let p=clamp(vec2i(x,y),vec2i(0),vec2i(l.yz)-1);let at=l.x+(u32(p.y)*l.y+u32(p.x))*2u;
  return vec3f(unpack2x16float(areaTextureData.words[at]),unpack2x16float(areaTextureData.words[at+1u]).x);}
fn areaTextureBilinear(image:vec4u,level:u32,uv:vec2f)->vec3f {let l=areaTextureLevel(image,level);
  let t=uv*vec2f(l.yz)-0.5;let i=vec2i(floor(t));let f=t-floor(t);
  return mix(mix(areaTextureTexel(l,i.x,i.y),areaTextureTexel(l,i.x+1,i.y),f.x),mix(areaTextureTexel(l,i.x,i.y+1),areaTextureTexel(l,i.x+1,i.y+1),f.x),f.y);}
// One edge's vector form factor: the unit normal of the edge's plane times the angle it subtends over 2 pi (the z
// component is AreaLights' areaEdge), scaled like areaEdge against float32 underflow.
fn areaTextureEdge(a:vec3f,b:vec3f)->vec3f {let n=cross(a,b);let top=max(max(abs(n.x),abs(n.y)),abs(n.z));if(top<=0.0){return vec3f(0);}
  let k=n/top;let s=length(k);return k/s*atan2(top*s,dot(a,b))*0.15915494;}
// The image of area light j filtered over what the lobe m sees of the rectangle c +- r +- u (receiver to centre, half
// extents); side -1 for the back of a two-sided light. 1 for a light without an image.
fn clusterAreaTexture(j:u32,m:mat3x3f,c:vec3f,r:vec3f,u:vec3f,side:f32)->vec3f {
  if(j>=areaTextureData.header.x){return vec3f(1);}let id=areaTextureData.words[j];if(id==0u){return vec3f(1);}
  let image=areaTextureData.images[id-1u];let top=f32(image.w-1u);
  let C=m*c;let R=m*r;let U=m*u;let N=cross(R,U);let nn=dot(N,N);
  var uv=vec2f(0.5);var lod=top;
  if(nn>1e-30){
    let p0=areaUnit(C-R-U);let p1=areaUnit(C-R+U);let p2=areaUnit(C+R+U);let p3=areaUnit(C+R-U);
    let f=(areaTextureEdge(p0,p1)+areaTextureEdge(p1,p2)+areaTextureEdge(p2,p3)+areaTextureEdge(p3,p0))*side;
    let h=dot(C,N);let fd=dot(f,N);var q=N*(h/nn);if(fd*h>0.0){q=f*(h/fd);}
    let rel=q-C;uv=clamp(vec2f(dot(cross(rel,U),N)/nn*0.5+0.5,0.5-dot(cross(R,rel),N)/nn*0.5),vec2f(0),vec2f(1));
    let nl=sqrt(nn);let span=${(2 * FOOTPRINT).toFixed(7)}*abs(h)/nl/(2.0*sqrt(nl))*f32(max(image.y,image.z));
    lod=clamp(log2(max(span,1.0)),0.0,top);
  }
  let k=u32(floor(lod));let a=areaTextureBilinear(image,k,uv);if(k>=image.w-1u){return a;}
  return mix(a,areaTextureBilinear(image,k+1u,uv),lod-f32(k));
}
`;
/**
 * Images on rectangle area lights: the area light at index i of `AreaLights.setLights` with entry i of
 * {@link setTextures} emits that image (sRGB by default, alpha premultiplied, so transparent texels emit nothing), times
 * its colour and intensity. Each fragment reads the image filtered over the part of the rectangle its specular and
 * diffuse lobes see (sharp reflections show the texels, matte and distant surfaces the mean colour). Lights without an
 * entry are unchanged. Without images it adds nothing to the shaders or the GPU work.
 * @throws TypeError without the AreaLights or for a malformed entry; RangeError for an image of a bad size or too many
 * images or texels.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`.
 */
export class AreaLightTextures implements EnginePlugin, AreaLightTexture {
  readonly name = 'clustered:area-texture';
  readonly area: AreaLights;
  private engine?: Engine;
  private device?: GPUDevice;
  private buffer?: GPUBuffer;
  private entries: GPUBindGroupEntry[] = [];
  private words = new Uint32Array(HEADER_WORDS);
  private listValue: readonly (AreaTextureImage | AreaTextureEntry | null | undefined)[] = Object.freeze([]);
  private active = false;
  private dirty = true;
  private disposed = false;
  constructor(options: AreaLightTextureOptions) {
    if (!options?.area || typeof options.area.setLights !== 'function')
      throw new TypeError('AreaLightTextures needs the AreaLights: new AreaLightTextures({ area })');
    this.area = options.area;
  }
  get owner(): Engine | undefined {
    return this.engine;
  }
  static attach(instance: EngineKernel, options: AreaLightTextureOptions): AreaLightTextures {
    const effect = new AreaLightTextures(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  /** The entries last given to `setTextures` (a frozen copy of the list). */
  get list(): readonly (AreaTextureImage | AreaTextureEntry | null | undefined)[] {
    return this.listValue;
  }
  /**
   * Entry i is the image of the area light at index i of `AreaLights.setLights` (an image, an entry with options, or
   * null for none); lights past the end are plain. At most {@link MAX_AREA_TEXTURES} distinct images (by object and
   * colour space) of up to {@link MAX_AREA_TEXTURE_SIZE} texels a side, {@link MAX_AREA_TEXTURE_TEXELS} in all with
   * their level chains. The pixels are copied and filtered now: call again after changing them. Validates everything
   * before changing anything; no images removes the shader code.
   */
  setTextures(entries: readonly (AreaTextureImage | AreaTextureEntry | null | undefined)[]): this {
    if (this.disposed) throw new MargoError('disposed', 'AreaLightTextures is disposed; create new AreaLightTextures');
    if (!Array.isArray(entries) || entries.length > MAX_LIGHTS)
      throw new RangeError(`Expected an array of at most ${MAX_LIGHTS} area texture entries, one per area light`);
    const images: { image: AreaTextureImage; srgb: boolean; texels: number }[] = [];
    let texels = 0;
    const ids = entries.map((entry) => {
      if (entry === null || entry === undefined) return 0;
      if (typeof entry !== 'object')
        throw new TypeError(
          'An area texture entry must be an image ({width, height, data}), { image, colorSpace } or null',
        );
      const options: AreaTextureEntry = 'image' in entry ? entry : { image: entry },
        { image, colorSpace = 'srgb' } = options;
      if (
        !image ||
        !Number.isInteger(image.width) ||
        !Number.isInteger(image.height) ||
        !(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray)
      )
        throw new TypeError('An area texture image needs integer width and height and RGBA8 data (an ImageData)');
      if (
        image.width < 1 ||
        image.height < 1 ||
        image.width > MAX_AREA_TEXTURE_SIZE ||
        image.height > MAX_AREA_TEXTURE_SIZE ||
        image.data.length !== image.width * image.height * 4
      )
        throw new RangeError(
          `An area texture image must be 1 to ${MAX_AREA_TEXTURE_SIZE} texels a side with width x height x 4 bytes`,
        );
      if (colorSpace !== 'srgb' && colorSpace !== 'linear')
        throw new TypeError("Area texture colorSpace must be 'srgb' or 'linear'");
      const srgb = colorSpace === 'srgb';
      let id = images.findIndex((known) => known.image === image && known.srgb === srgb);
      if (id < 0) {
        let count = 0;
        for (let w = image.width, h = image.height, k = 0; k < areaTextureLevels(image.width, image.height); k++) {
          count += w * h;
          w = Math.max(1, w >> 1);
          h = Math.max(1, h >> 1);
        }
        texels += count;
        id = images.push({ image, srgb, texels: count }) - 1;
      }
      return id + 1;
    });
    if (images.length > MAX_AREA_TEXTURES)
      throw new RangeError(`Expected at most ${MAX_AREA_TEXTURES} distinct area texture images, got ${images.length}`);
    if (texels > MAX_AREA_TEXTURE_TEXELS)
      throw new RangeError(
        `Area texture images and their levels hold ${texels} texels; at most ${MAX_AREA_TEXTURE_TEXELS} in all`,
      );
    const words = new Uint32Array(HEADER_WORDS + ids.length + texels * 2);
    words[0] = ids.length;
    words[1] = images.length;
    words.set(ids, HEADER_WORDS);
    let offset = ids.length;
    images.forEach(({ image, srgb, texels: count }, i) => {
      words.set([offset, image.width, image.height, areaTextureLevels(image.width, image.height)], 4 + i * 4);
      let at = HEADER_WORDS + offset;
      for (const level of areaTextureChain(image, srgb))
        for (let t = 0; t < level.length; t += 3, at += 2) {
          words[at] = f16Bits(level[t]) | (f16Bits(level[t + 1]) << 16);
          words[at + 1] = f16Bits(level[t + 2]) | (f16Bits(1) << 16);
        }
      offset += count * 2;
    });
    this.words = words;
    this.active = images.length > 0;
    this.listValue = Object.freeze([...entries]);
    this.dirty = true;
    this.sync();
    return this;
  }
  /** @internal AreaLightTexture: WGSL defining `clusterAreaTexture`. */
  declarations(group: number): string {
    return sampling(group);
  }
  /** @internal AreaLightTexture: binding 153 of the lit shader's group. */
  bindings(): GPUBindGroupEntry[] {
    if (!this.buffer || this.disposed)
      throw new MargoError(
        'state',
        'Area light textures are not attached; engine.use(textures) and set an image first',
      );
    return this.entries;
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'AreaLightTextures is disposed; create new AreaLightTextures');
    if (!engine.gpu)
      throw new MargoError(
        'unsupported',
        'AreaLightTextures requires the WebGPU backend; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.device = engine.gpu;
    this.dirty = true;
    this.sync();
  }
  // The buffer and the hook exist only while some light has an image, so an empty AreaLightTextures changes no GPU call.
  // The buffer grows (to a power of two) when the images need more room, and is kept when they need less.
  private sync(): void {
    const active = !!this.device && !this.disposed && this.active;
    if (active && (!this.buffer || this.buffer.size < this.words.byteLength)) {
      this.buffer?.destroy();
      const size = Math.max(1024, 2 ** Math.ceil(Math.log2(this.words.byteLength))),
        limits = this.device!.limits;
      if (size > limits.maxStorageBufferBindingSize || size > limits.maxBufferSize)
        throw new RangeError('Area texture images exceed the device storage buffer limit; use fewer or smaller images');
      const buffer = (this.buffer = this.device!.createBuffer({
        size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }));
      this.entries = [{ binding: BINDING, resource: { buffer } }];
      this.dirty = true;
    }
    const hook = active ? this : undefined;
    if (this.area.texture !== hook) this.area.texture = hook;
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
    if (this.area.texture === this) this.area.texture = undefined;
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
