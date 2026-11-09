/// <reference lib="esnext.disposable" preserve="true" />
import { MaskData, maskShader } from './masks.js';
import { checkLight, checkCamera, checkLayer, checkNumber } from './validation.js';
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { hexColor } from '@margoengine/math';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import {
  Light2D,
  type Light2DOptions,
  type LightKind2D,
  type Lighting2DOptions,
  type Occluder2D,
  type Point2D,
  occluderEdges,
  lightAt,
  inLightMask,
} from './index.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** How coordinates outside [0, 1] behave when projecting a light cookie. */
export type CookieWrapMode = 'zero' | 'clamp' | 'repeat' | 'mirror';

/** How the cookie texture combines with the light color. */
export type CookieBlendMode = 'multiply' | 'alpha' | 'color';

/** Size and pixels of a cookie texture: width by height RGBA texels. */
export interface CookieTextureOptions {
  width: number;
  height: number;
  /** RGBA byte data (0..255) or Float32Array (0..1). Length must be width * height * 4. */
  data: ArrayLike<number>;
}

/** A 2D cookie / gobo texture for shaping 2D lights. */
export class CookieTexture2D {
  declare readonly width: number;
  declare readonly height: number;
  declare readonly data: Float32Array;

  constructor(options: CookieTextureOptions) {
    const { width, height, data } = options;
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw rangeError('Invalid cookie texture dimensions', 'pixel-lighting');
    }
    if (!data || data.length !== width * height * 4) {
      throw rangeError('Cookie texture data length must match width * height * 4', 'pixel-lighting');
    }
    this.width = width;
    this.height = height;
    const isFloat = data instanceof Float32Array;
    const buf = new Float32Array(width * height * 4);
    for (let i = 0; i < buf.length; i++) {
      const v = data[i];
      if (!Number.isFinite(v)) throw rangeError('Invalid cookie texture pixel value', 'pixel-lighting');
      buf[i] = isFloat ? Math.max(0, Math.min(1, v)) : Math.max(0, Math.min(255, v)) / 255;
    }
    this.data = buf;
  }
}

/** Creates a CookieTexture2D from raw RGBA data. */
export function createCookieTexture(width: number, height: number, data: ArrayLike<number>): CookieTexture2D {
  return new CookieTexture2D({ width, height, data });
}

/** Creates a window blinds cookie pattern with horizontal or vertical slats. */
export function createWindowCookie(width: number, height: number, slats = 6, vertical = false): CookieTexture2D {
  if (slats < 1 || !Number.isInteger(slats)) throw rangeError('Invalid slats count', 'pixel-lighting');
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const coord = vertical ? x / width : y / height;
      const slatIndex = (coord * slats) % 1;
      const intensity = slatIndex < 0.65 ? 255 : 30;
      const idx = (y * width + x) * 4;
      data[idx] = intensity;
      data[idx + 1] = intensity;
      data[idx + 2] = intensity;
      data[idx + 3] = 255;
    }
  }
  return new CookieTexture2D({ width, height, data });
}

/** Creates a flashlight gobo pattern with a bright center and falloff rings. */
export function createSpotCookie(size: number, innerRatio = 0.5, outerRatio = 0.95): CookieTexture2D {
  if (size < 2 || !Number.isInteger(size)) throw rangeError('Invalid cookie size', 'pixel-lighting');
  const data = new Uint8Array(size * size * 4);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const dist = Math.hypot(dx, dy);
      let val = 0;
      if (dist <= innerRatio) {
        val = 255;
      } else if (dist < outerRatio) {
        const t = (dist - innerRatio) / (outerRatio - innerRatio);
        val = Math.round(255 * (1 - t * t));
      }
      const idx = (y * size + x) * 4;
      data[idx] = val;
      data[idx + 1] = val;
      data[idx + 2] = val;
      data[idx + 3] = 255;
    }
  }
  return new CookieTexture2D({ width: size, height: size, data });
}

/**
 * Texels a coordinate is nudged by before the cookie texel is chosen, on the CPU and in the shader alike. WGSL lets
 * f32 division be off by 2.5 ULP, so a coordinate that lands exactly on a texel edge in exact arithmetic can come out a
 * few ULP under it on one GPU (Metal) and on it on another: without the nudge the two pick neighbouring texels.
 * 1/1024 texel is far above that error and far below anything a picture shows.
 */
const COOKIE_TEXEL_BIAS = 1 / 1024;

/** Samples a cookie texture at normalized coordinate (u, v) with wrapping. */
export function cookieSample(
  cookie: CookieTexture2D,
  u: number,
  v: number,
  wrap: CookieWrapMode = 'zero',
): [number, number, number, number] {
  let su = u;
  let sv = v;

  if (wrap === 'zero') {
    if (su < 0 || su > 1 || sv < 0 || sv > 1) return [0, 0, 0, 0];
  } else if (wrap === 'clamp') {
    su = Math.max(0, Math.min(1, su));
    sv = Math.max(0, Math.min(1, sv));
  } else if (wrap === 'repeat') {
    su = su - Math.floor(su);
    sv = sv - Math.floor(sv);
  } else if (wrap === 'mirror') {
    const mu = Math.abs(su) % 2;
    su = mu > 1 ? 2 - mu : mu;
    const mv = Math.abs(sv) % 2;
    sv = mv > 1 ? 2 - mv : mv;
  }

  const { width, height, data } = cookie;
  const x = Math.max(0, Math.min(width - 1, Math.floor(su * width + COOKIE_TEXEL_BIAS)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(sv * height + COOKIE_TEXEL_BIAS)));
  const idx = (y * width + x) * 4;

  return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
}

/** Options for creating a CookieLight2D. */
export interface CookieLight2DOptions extends Light2DOptions {
  /** Cookie texture to shape the light footprint. */
  cookie?: CookieTexture2D;
  /** Width and height of the cookie footprint in world units. Default is radius * 2 or 64. */
  cookieScale?: number | readonly [number, number];
  /** World offset of the cookie relative to the light position. Default [0, 0]. */
  cookieOffset?: readonly [number, number];
  /** Rotation angle of the cookie in radians. Default 0 (or light angle for spot). */
  cookieRotation?: number;
  /** Wrap mode outside [0, 1]: 'zero' (default), 'clamp', 'repeat', 'mirror'. */
  cookieWrap?: CookieWrapMode;
  /** Blend mode: 'multiply' (default), 'alpha', or 'color'. */
  cookieMode?: CookieBlendMode;
}

/** One 2D light shaped by a cookie texture. */
export class CookieLight2D extends Light2D {
  declare cookie?: CookieTexture2D;
  declare cookieScale: [number, number];
  declare cookieOffset: [number, number];
  declare cookieRotation: number;
  declare cookieWrap: CookieWrapMode;
  declare cookieMode: CookieBlendMode;

  constructor(options: CookieLight2DOptions = {}) {
    super(options);
    this.cookie = options.cookie;
    const defaultScale = this.radius > 0 ? this.radius * 2 : 64;
    this.cookieScale = Array.isArray(options.cookieScale)
      ? [options.cookieScale[0], options.cookieScale[1]]
      : typeof options.cookieScale === 'number'
        ? [options.cookieScale, options.cookieScale]
        : [defaultScale, defaultScale];
    this.cookieOffset = options.cookieOffset ? [options.cookieOffset[0], options.cookieOffset[1]] : [0, 0];
    this.cookieRotation = options.cookieRotation ?? (this.kind === 'spot' ? this.angle : 0);
    this.cookieWrap = options.cookieWrap ?? 'zero';
    this.cookieMode = options.cookieMode ?? 'multiply';
    checkCookieLight(this);
  }
}

function checkCookieLight(l: CookieLight2D): void {
  checkLight(l);
  for (const value of l.cookieScale) checkNumber(value, 'cookieScale', Number.MIN_VALUE);
  for (const value of l.cookieOffset) checkNumber(value, 'cookieOffset');
  checkNumber(l.cookieRotation, 'cookieRotation');
  if (!['zero', 'clamp', 'repeat', 'mirror'].includes(l.cookieWrap))
    throw rangeError('Invalid cookieWrap: use zero, clamp, repeat or mirror', 'pixel-lighting');
  if (!['multiply', 'alpha', 'color'].includes(l.cookieMode))
    throw rangeError('Invalid cookieMode: use multiply, alpha or color', 'pixel-lighting');
}

/** Unit vector pointing toward light source for directional lights. */
const towards = (l: Light2D): [number, number, number] => [
  -Math.cos(l.angle) * Math.cos(l.elevation),
  -Math.sin(l.angle) * Math.cos(l.elevation),
  Math.sin(l.elevation),
];

/**
 * CPU evaluation of CookieLight2D at world coordinate (x, y) with normal.
 * Computes base light attenuation and modulates by the sampled cookie texture.
 */
export function cookieLightAt(
  light: CookieLight2D,
  x: number,
  y: number,
  normal: readonly number[] = [0, 0, 1],
): number[] {
  const base = lightAt(light, x, y, normal);
  if (!light.cookie) return base;
  if (light.mask && !inLightMask(light.mask, x, y)) return [0, 0, 0];

  // Project point (x, y) into cookie coordinate space
  const dx = x - light.x - light.cookieOffset[0];
  const dy = y - light.y - light.cookieOffset[1];
  const cos = Math.cos(light.cookieRotation);
  const sin = Math.sin(light.cookieRotation);
  const rx = dx * cos + dy * sin;
  const ry = -dx * sin + dy * cos;
  const u = rx / light.cookieScale[0] + 0.5;
  const v = ry / light.cookieScale[1] + 0.5;

  const [cr, cg, cb, ca] = cookieSample(light.cookie, u, v, light.cookieWrap);

  if (light.cookieMode === 'alpha') {
    return [base[0] * ca, base[1] * ca, base[2] * ca];
  } else if (light.cookieMode === 'color') {
    const size = Math.hypot(normal[0], normal[1], normal[2]);
    const n = normal.map((val) => val / size);
    let amount = 1;
    let lDir: readonly number[];
    if (light.kind === 'directional') {
      lDir = towards(light);
    } else {
      const ldx = light.x - x;
      const ldy = light.y - y;
      const flat = Math.hypot(ldx, ldy);
      const len = Math.hypot(flat, light.height);
      amount = Math.max(0, 1 - flat / light.radius) ** light.falloff;
      lDir = len ? [ldx / len, ldy / len, light.height / len] : n;
      if (light.kind === 'spot') {
        const along = flat ? -(ldx * Math.cos(light.angle) + ldy * Math.sin(light.angle)) / flat : 1;
        const outer = Math.cos(light.cone);
        const inner = Math.cos(light.cone * (1 - light.softness));
        amount *= inner > outer ? Math.min(1, Math.max(0, (along - outer) / (inner - outer))) : along >= outer ? 1 : 0;
      }
    }
    const shade = amount * Math.max(0, n[0] * lDir[0] + n[1] * lDir[1] + n[2] * lDir[2]) * light.intensity;
    return [cr * ca * shade, cg * ca * shade, cb * ca * shade];
  } else {
    return [base[0] * cr * ca, base[1] * cg * ca, base[2] * cb * ca];
  }
}

const cookieShader = /* wgsl */ `
struct Uniforms{
view:vec4f,size:vec4f,at:vec4f,way:vec4f,color:vec4f,cookie_scale:vec4f,cookie_rot:vec4f,cookie_info:vec4f,cookie_origin:vec4f,mask_bounds:vec4f,mask_info:vec4f,}
@group(0)@binding(0)var<uniform>u:Uniforms;
@group(0)@binding(1)var bumps:texture_2d<f32>;
@group(0)@binding(2)var<storage,read>edges:array<vec4f>;
@group(1)@binding(0)var cookie_tex:texture_2d<f32>;
@group(1)@binding(1)var cookie_samp:sampler;
@group(0)@binding(3)var sum:texture_2d_array<f32>;
@vertex fn wide(@builtin(vertex_index)i:u32)->@builtin(position)vec4f{
return vec4f(f32(i&1u)*4.0 - 1.0,f32(i>>1u)*4.0 - 1.0,0.0,1.0);
}
fn clip(d:vec2f)->vec2f{
return d*u.view.z/u.size.xy*vec2f(2.0,-2.0);
}
@vertex fn edge(@builtin(vertex_index)i:u32,@location(0)e:vec4f)->@builtin(position)vec4f{
var p=e.xy;
if((i&1u)==1u){
p=e.zw;
}
if(i<2u){
return vec4f(clip(p - u.view.xy)+vec2f(-1.0,1.0),0.0,1.0);
}
return vec4f(clip(p*u.at.w - u.at.xy),0.0,0.0);
}
@fragment fn none()->@location(0)vec4f{
return vec4f(0.0);
}
@fragment fn show(@builtin(position)f:vec4f)->@location(0)vec4f{
let p=vec2i(f.xy);
return vec4f(textureLoad(sum,p,0,0).rgb+textureLoad(sum,p,1,0).rgb+textureLoad(sum,p,2,0).rgb+textureLoad(sum,p,3,0).rgb,1.0);
}
@fragment fn lit(@builtin(position)f:vec4f)->@location(0)vec4f{
let world=u.view.xy+f.xy/u.view.z;
if(!maskVisible(world,u.mask_bounds,u.mask_info)){
return vec4f(0.0);
}
var n=vec3f(0.0,0.0,1.0);
if(u.size.z>0.0){
let s=textureLoad(bumps,vec2i(f.xy),0);
if(s.a>0.0){
n=normalize(s.xyz*2.0 - 1.0);
}
}
var l=u.at.xyz;
var a=1.0;
let isPoint=u.at.w>0.0;
var dL=0.0;
if(isPoint){
let d=u.at.xy - world;
dL=length(d);
a=pow(max(0.0,1.0 - dL/u.color.w),u.way.w);
let v=vec3f(d,u.at.z);
l=n;
if(dot(v,v)>0.0){
l=normalize(v);
}
if(u.size.w>0.0){
var c=1.0;
if(dL>0.0){
c=-dot(d,u.way.xy)/dL;
}
if(u.way.z>u.view.w){
a*=clamp((c - u.view.w)/(u.way.z - u.view.w),0.0,1.0);
}
else if(c<u.view.w){
a=0.0;
}
}
}
var vis=1.0;
let hasShadows=u.cookie_info.z>0.5;
let edgeCount=u32(u.cookie_info.y);
if(hasShadows&&edgeCount>0u&&a>0.0){
let thetaL=select(atan2(u.at.y,u.at.x),atan2(u.at.y - world.y,u.at.x - world.x),isPoint);
let rx=cos(thetaL);
let ry=sin(thetaL);
for(var e=0u;
e<edgeCount;
e++){
let seg=edges[e];
let ax=seg.x - world.x;
let ay=seg.y - world.y;
let ex=seg.z - seg.x;
let ey=seg.w - seg.y;
let across=rx*ey - ry*ex;
if(abs(across)>1e-6){
let t=(ax*ey - ay*ex)/across;
let s=(ax*ry - ay*rx)/across;
if(t>=0.0&&(!isPoint||t<=dL)&&s>=0.0&&s<=1.0){
vis=0.0;
break;
}
}
}
}
if(vis<=0.0||a<=0.0){
return vec4f(0.0);
}
var cookieMod=vec4f(1.0);
if(u.cookie_info.x>0.5){
let delta=world - u.cookie_origin.xy - u.cookie_scale.zw;
let rx=delta.x*u.cookie_rot.x - delta.y*u.cookie_rot.y;
let ry=delta.x*u.cookie_rot.y+delta.y*u.cookie_rot.x;
var uv=vec2f(rx/u.cookie_scale.x+0.5,ry/u.cookie_scale.y+0.5);
let wrapMode=u32(u.cookie_rot.z);
var oob=false;
if(wrapMode==0u){
if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0){
oob=true;
}
}
else if(wrapMode==1u){
uv=clamp(uv,vec2f(0.0),vec2f(1.0));
}
else if(wrapMode==2u){
uv=fract(uv);
}
else if(wrapMode==3u){
let m=abs(uv)% vec2f(2.0);
uv=select(m,vec2f(2.0)- m,m>vec2f(1.0));
}
if(oob){
cookieMod=vec4f(0.0);
}
else{
let dims=vec2i(textureDimensions(cookie_tex));
let texel=clamp(vec2i(floor(uv*vec2f(dims)+vec2f(${COOKIE_TEXEL_BIAS}
))),vec2i(0),dims - vec2i(1));
cookieMod=textureLoad(cookie_tex,texel,0);
}
}
let diffuse=max(0.0,dot(n,l));
let blendMode=u32(u.cookie_rot.w);
var outCol=vec3f(0.0);
if(blendMode==1u&&u.cookie_info.x>0.5){
outCol=u.color.rgb*a*diffuse*vis*cookieMod.a;
}
else if(blendMode==2u&&u.cookie_info.x>0.5){
outCol=cookieMod.rgb*cookieMod.a*a*diffuse*vis*u.cookie_info.w;
}
else{
outCol=u.color.rgb*a*diffuse*vis*cookieMod.rgb*cookieMod.a;
}
return vec4f(outCol,0.0);
}
`;

const STRIDE = 256;
const SUM_FORMAT = 'rgba16float';
const SUM_LAYERS = 4;
const FLOATS = STRIDE / 4;

/** Options for CookieLighting2D: the plain lighting options plus the default cookie scale, wrap and blend for its lights. */
export interface CookieLighting2DOptions extends Lighting2DOptions {
  /** Default cookie scale in world units if not set per light. Default 64. */
  cookieScale?: number | readonly [number, number];
  /** Default cookie wrap mode if not set per light. Default 'zero'. */
  cookieWrap?: CookieWrapMode;
  /** Default cookie blend mode if not set per light. Default 'multiply'. */
  cookieMode?: CookieBlendMode;
}

let count = 0;

/**
 * 2D Lighting plugin with cookie / gobo texture support.
 * WebGPU only.
 */
export class CookieLighting2D implements EnginePlugin {
  declare readonly name: string;
  declare ambient: string;
  declare camera: { readonly x: number; readonly y: number; readonly zoom: number };
  declare cookieScale: [number, number];
  declare cookieWrap: CookieWrapMode;
  declare cookieMode: CookieBlendMode;
  readonly lights: CookieLight2D[] = [];
  readonly #target: GPUTexture | (() => GPUTexture);
  readonly #normals?: GPUTexture | (() => GPUTexture);
  readonly #order: number;
  #edges: Float32Array = new Float32Array();
  #edgesWritten = false;
  #engine?: Engine;
  #device?: GPUDevice;
  #module?: GPUShaderModule;
  #layout?: GPUBindGroupLayout;
  #cookieLayout?: GPUBindGroupLayout;
  #pipelines?: GPUPipelineLayout;
  #format?: GPUTextureFormat;
  #light?: GPURenderPipeline;
  #show?: GPURenderPipeline;
  #showGroup?: GPUBindGroup;
  #sum?: GPUTexture;
  #sumView?: GPUTextureView;
  #sumLayers: GPUTextureView[] = [];
  #uniform?: GPUBuffer;
  #values: Float32Array<ArrayBuffer> = new Float32Array(0);
  #edgeBuffer?: GPUBuffer;
  #flat?: GPUTexture;
  #group?: GPUBindGroup;
  #flatCookie?: GPUTexture;
  #cookieSampler?: GPUSampler;
  #defaultCookieGroup?: GPUBindGroup;
  #cookieGpuMap = new Map<CookieTexture2D, GPUTexture>();
  #cookieGroupMap = new WeakMap<CookieTexture2D, GPUBindGroup>();
  declare layer: number;
  #masks = new MaskData();
  #disposed = false;

  constructor(options: CookieLighting2DOptions) {
    if (!options?.target) throw typeError('Lighting2D needs a target', 'pixel-lighting');
    const order = options.order ?? 20;
    checkNumber(order, 'order');
    this.#target = options.target;
    this.#normals = options.normals;
    this.#order = order;
    this.camera = options.camera ?? { x: 0, y: 0, zoom: 1 };
    this.ambient = options.ambient ?? '#000000';
    this.layer = options.layer ?? 0xffffffff;
    const cs = options.cookieScale ?? 64;
    this.cookieScale = Array.isArray(cs) ? [cs[0], cs[1]] : [cs, cs];
    this.cookieWrap = options.cookieWrap ?? 'zero';
    this.cookieMode = options.cookieMode ?? 'multiply';
    this.name = options.name ?? `cookie-lighting2d-${++count}`;
    if (options.occluders) this.setOccluders(options.occluders);
  }

  static attach(instance: EngineKernel, options: CookieLighting2DOptions): CookieLighting2D {
    const lighting = new CookieLighting2D(options);
    engineRuntime(instance).use(lighting);
    return lighting;
  }

  addLight(options: CookieLight2DOptions = {}): CookieLight2D {
    if (this.#disposed) throw fault('disposed', 'CookieLighting2D has been disposed', 'pixel-lighting');
    const light = new CookieLight2D({
      cookieScale: this.cookieScale,
      cookieWrap: this.cookieWrap,
      cookieMode: this.cookieMode,
      ...options,
    });
    this.lights.push(light);
    return light;
  }

  removeLight(light: CookieLight2D): void {
    const at = this.lights.indexOf(light);
    if (at >= 0) this.lights.splice(at, 1);
  }

  setOccluders(occluders: readonly Occluder2D[]): void {
    this.#edges = occluderEdges(occluders);
    this.#edgesWritten = false;
  }

  setup(engine: Engine): void {
    if (this.#disposed) throw fault('disposed', 'CookieLighting2D disposed; create a new one');
    if (engine.backend !== 'webgpu') throw fault('unsupported', 'CookieLighting2D needs WebGPU', 'webgpu');
    this.#engine = engine;
    engine.frameGraph.add({
      name: this.name,
      order: this.#order,
      execute: (c) => {
        if (c.backend === 'webgpu' && !c.view?.index) this.#run(c);
      },
    });
  }

  onDeviceRestored(): void {
    this.#release();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#engine?.removePlugin(this.name);
    this.#engine = undefined;
    this.#release();
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  #release(): void {
    this.#masks.dispose();
    for (const texture of this.#cookieGpuMap.values()) texture.destroy();
    this.#cookieGpuMap.clear();
    this.#cookieGroupMap = new WeakMap();
    this.#uniform?.destroy();
    this.#edgeBuffer?.destroy();
    this.#flat?.destroy();
    this.#flatCookie?.destroy();
    this.#sum?.destroy();
    this.#uniform = this.#edgeBuffer = this.#flat = this.#flatCookie = undefined;
    this.#cookieSampler = undefined;
    this.#defaultCookieGroup = undefined;
    this.#module = this.#layout = this.#cookieLayout = this.#pipelines = this.#format = this.#light = undefined;
    this.#show = this.#showGroup = this.#sum = this.#sumView = undefined;
    this.#sumLayers = [];
    this.#group = this.#device = undefined;
    this.#edgesWritten = false;
  }

  #getOrCreateCookieGpu(device: GPUDevice, cookie: CookieTexture2D): GPUTexture {
    let tex = this.#cookieGpuMap.get(cookie);
    if (!tex) {
      tex = device.createTexture({
        label: 'lighting2d cookie upload',
        size: [cookie.width, cookie.height, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      const bytes = new Uint8Array(cookie.data.length);
      for (let i = 0; i < cookie.data.length; i++) {
        bytes[i] = Math.round(cookie.data[i] * 255);
      }
      device.queue.writeTexture(
        { texture: tex },
        bytes,
        { bytesPerRow: cookie.width * 4 },
        { width: cookie.width, height: cookie.height },
      );
      this.#cookieGpuMap.set(cookie, tex);
    }
    return tex;
  }

  #prepare(device: GPUDevice, target: GPUTextureFormat): void {
    if (this.#device !== device) {
      if (this.#device) this.#release();
      this.#device = device;
    }
    if (!this.#module) {
      this.#module = device.createShaderModule({ label: 'cookie-lighting2d', code: maskShader(4) + cookieShader });
      this.#layout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 176 },
          },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
          { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        ],
      });
      this.#cookieLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ],
      });
      this.#pipelines = device.createPipelineLayout({
        bindGroupLayouts: [this.#layout, this.#cookieLayout],
      });
      this.#flat = device.createTexture({
        size: [1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.#flatCookie = device.createTexture({
        size: [1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture(
        { texture: this.#flatCookie },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4 },
        { width: 1, height: 1 },
      );
      this.#cookieSampler = device.createSampler({
        magFilter: 'nearest',
        minFilter: 'nearest',
      });
      this.#defaultCookieGroup = device.createBindGroup({
        layout: this.#cookieLayout,
        entries: [
          { binding: 0, resource: this.#flatCookie.createView() },
          { binding: 1, resource: this.#cookieSampler },
        ],
      });
    }
    if (!this.#light) {
      const module = this.#module!,
        layout = this.#pipelines!,
        format = SUM_FORMAT;
      this.#light = device.createRenderPipeline({
        label: 'cookie-lighting2d light',
        layout,
        vertex: { module, entryPoint: 'wide' },
        fragment: {
          module,
          entryPoint: 'lit',
          targets: [
            {
              format,
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one' },
                alpha: { srcFactor: 'zero', dstFactor: 'one' },
              },
            },
          ],
        },
      });
    }
    if (target !== this.#format) {
      this.#format = target;
      this.#show = device.createRenderPipeline({
        label: 'cookie-lighting2d show',
        layout: 'auto',
        vertex: { module: this.#module!, entryPoint: 'wide' },
        fragment: { module: this.#module!, entryPoint: 'show', targets: [{ format: target }] },
      });
      this.#showGroup = undefined;
    }
  }

  #run(c: Extract<PassContext, { backend: 'webgpu' }>): void {
    const device = c.device,
      pick = (texture: GPUTexture | (() => GPUTexture)) => (typeof texture === 'function' ? texture() : texture),
      target = pick(this.#target),
      bump = this.#normals && pick(this.#normals),
      camera = this.camera,
      ambient = hexColor(this.ambient),
      lights = this.lights.filter((light) => (light.layers & this.layer) !== 0);
    if (!ambient) throw rangeError('Invalid ambient color: use a hex color such as #rrggbb', 'pixel-lighting');
    if (bump && (bump.width !== target.width || bump.height !== target.height))
      throw fault('state', 'Lighting2D normals differ in size from the target', 'pixel-lighting');
    checkCamera(camera);
    checkLayer(this.layer);
    this.lights.forEach(checkCookieLight);
    this.#prepare(device, target.format);
    this.#masks.upload(device, lights);
    this.#group = undefined;

    const wanted = Math.max(1, lights.length) * FLOATS;
    if (!this.#uniform || this.#values.length < wanted) {
      this.#uniform?.destroy();
      this.#values = new Float32Array(wanted * 2);
      this.#uniform = device.createBuffer({
        label: 'cookie-lighting2d',
        size: this.#values.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    const edges = this.#edges;
    const edgeCount = edges.length / 4;
    const edgeBytes = Math.max(16, edges.byteLength);
    if (!this.#edgeBuffer || this.#edgeBuffer.size < edgeBytes) {
      this.#edgeBuffer?.destroy();
      this.#edgeBuffer = device.createBuffer({
        label: 'cookie-lighting2d edges',
        size: edgeBytes * 2,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.#edgesWritten = false;
    }
    if (!this.#edgesWritten) {
      if (edges.length) {
        device.queue.writeBuffer(this.#edgeBuffer!, 0, edges as Float32Array<ArrayBuffer>);
      } else {
        device.queue.writeBuffer(this.#edgeBuffer!, 0, new Float32Array(4));
      }
      this.#edgesWritten = true;
    }

    const shown = bump ?? this.#flat!;
    this.#group = device.createBindGroup({
      layout: this.#layout!,
      entries: [
        { binding: 0, resource: { buffer: this.#uniform, size: 176 } },
        { binding: 1, resource: shown.createView() },
        { binding: 4, resource: { buffer: this.#masks.buffer! } },
        { binding: 2, resource: { buffer: this.#edgeBuffer! } },
      ],
    });

    if (!this.#sum || this.#sum.width !== target.width || this.#sum.height !== target.height) {
      this.#sum?.destroy();
      const size = [target.width, target.height];
      this.#sum = device.createTexture({
        label: 'cookie-lighting2d sum',
        size: [size[0], size[1], SUM_LAYERS],
        format: SUM_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.#sumView = this.#sum.createView({ dimension: '2d-array' });
      this.#sumLayers = Array.from({ length: SUM_LAYERS }, (_, baseArrayLayer) =>
        this.#sum!.createView({ dimension: '2d', baseArrayLayer, arrayLayerCount: 1 }),
      );
      this.#showGroup = undefined;
    }

    this.#showGroup ??= device.createBindGroup({
      layout: this.#show!.getBindGroupLayout(0),
      entries: [{ binding: 3, resource: this.#sumView! }],
    });

    const values = this.#values;
    lights.forEach((l, i) => {
      const rgb = hexColor(l.color)!,
        far = l.kind === 'directional',
        from = far ? towards(l) : [l.x, l.y, l.height],
        wrapIndex = ['zero', 'clamp', 'repeat', 'mirror'].indexOf(l.cookieWrap),
        blendIndex = ['multiply', 'alpha', 'color'].indexOf(l.cookieMode);
      values.set(
        [
          camera.x,
          camera.y,
          camera.zoom,
          Math.cos(l.cone),
          target.width,
          target.height,
          bump ? 1 : 0,
          l.kind === 'spot' ? 1 : 0,
          from[0],
          from[1],
          from[2],
          far ? 0 : 1,
          Math.cos(l.angle),
          Math.sin(l.angle),
          Math.cos(l.cone * (1 - l.softness)),
          l.falloff,
          rgb[0] * l.intensity,
          rgb[1] * l.intensity,
          rgb[2] * l.intensity,
          l.radius,
          l.cookieScale[0],
          l.cookieScale[1],
          l.cookieOffset[0],
          l.cookieOffset[1],
          Math.cos(l.cookieRotation),
          -Math.sin(l.cookieRotation),
          wrapIndex >= 0 ? wrapIndex : 0,
          blendIndex >= 0 ? blendIndex : 0,
          l.cookie ? 1 : 0,
          edgeCount,
          l.shadows ? 1 : 0,
          l.intensity,
          l.x,
          l.y,
          0,
          0,
          ...this.#masks.fields[i],
        ],
        i * FLOATS,
      );
    });
    device.queue.writeBuffer(this.#uniform, 0, values);

    this.#sumLayers.forEach((view, layer) =>
      c.encoder
        .beginRenderPass({
          colorAttachments: [
            {
              view,
              loadOp: 'clear',
              clearValue: layer ? [0, 0, 0, 1] : [ambient[0], ambient[1], ambient[2], 1],
              storeOp: 'store',
            },
          ],
        })
        .end(),
    );

    lights.forEach((l, i) => {
      let cookieGroup = this.#defaultCookieGroup!;
      if (l.cookie) {
        let group = this.#cookieGroupMap.get(l.cookie);
        if (!group) {
          const cookieTex = this.#getOrCreateCookieGpu(device, l.cookie);
          group = device.createBindGroup({
            layout: this.#cookieLayout!,
            entries: [
              { binding: 0, resource: cookieTex.createView() },
              { binding: 1, resource: this.#cookieSampler! },
            ],
          });
          this.#cookieGroupMap.set(l.cookie, group);
        }
        cookieGroup = group;
      }

      const pass = c.encoder.beginRenderPass({
        colorAttachments: [{ view: this.#sumLayers[i % SUM_LAYERS]!, loadOp: 'load', storeOp: 'store' }],
      });
      pass.setBindGroup(0, this.#group!, [i * STRIDE]);
      pass.setBindGroup(1, cookieGroup);
      pass.setPipeline(this.#light!);
      pass.draw(3);
      pass.end();
    });

    const show = c.encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    show.setBindGroup(0, this.#showGroup!);
    show.setPipeline(this.#show!);
    show.draw(3);
    show.end();
  }
}
