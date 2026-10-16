/// <reference lib="esnext.disposable" preserve="true" />
import { resolveMSAA, sceneTarget } from '../../shared/msaa.js';
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { acquireDepth, group } from '../../shared/gpu.js';
import { CoastalFlow, waterFrame, oceanWaves } from './coastal.js';
import { Spray } from './spray.js';
import { MargoError } from '@margoengine/math/errors';
declare const GPUBufferUsage: { VERTEX: number; INDEX: number; UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUTextureUsage: {
  COPY_SRC: number;
  COPY_DST: number;
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
};
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** One swell train: three Gerstner components around this direction and wavelength whose amplitudes sum to `amplitude`. */
export interface Wave {
  /** Travel direction in the XZ plane (any nonzero length). */
  direction: readonly [number, number];
  /** Height in world units. */
  amplitude: number;
  /** Crest spacing in world units, > 0. */
  wavelength: number;
  /** Gerstner crest sharpness; rejected (RangeError) when it would fold the surface. Default 0.5. */
  steepness?: number;
  /** Phase offset in radians. Default 0. */
  phase?: number;
}
/** Terrain coupling: a borrowed heightmap the shallow-water flow, foam and spray run on. */
export interface WaterTerrain {
  /** World-space Y heights in a sampleable `r32float` 2D texture, 2-512 cells per side. */
  heightmap: () => GPUTexture | undefined;
  /** World XZ of the heightmap's first texel corner. */
  origin: readonly [number, number];
  /** World XZ extent the heightmap covers. */
  size: readonly [number, number];
}
/** A directional light record for glints and foam, such as an entry of `sky.lights`. */
export interface WaterLight {
  /** XYZ towards the light (nonzero, normalised here) plus intensity (>= 0) in the fourth element. */
  direction: ArrayLike<number>;
  /** Linear RGB radiance, each >= 0. */
  radiance: ArrayLike<number>;
}
/** Water settings, read at construction unless noted. Invalid values throw RangeError or TypeError. */
export interface WaterOptions {
  /** Grid extent in world units (X, Z), each 0-100,000. Default [100, 100]. */
  size?: readonly [number, number];
  /** Grid cells per side, an integer 1-512. Default 128. */
  segments?: number;
  /** Mean sea level, world Y. Default 0. */
  height?: number;
  /** 1-8 swell trains. Default two trains along [1, 0.3] and [1, 0.6]. */
  waves?: readonly Wave[];
  /** Deep-water colour, linear RGB 0..1. Default [0.01, 0.18, 0.25]. */
  color?: readonly [number, number, number];
  /** Shoreline foam width in world units, 0-100 (exclusive of 0). Default 1. */
  foamDistance?: number;
  /** Scene depth provider; pass `() => effect.depthTexture` when Bloom, SSAO or DOF owns the capture. Default: Water's own. */
  depth?: () => GPUTexture | undefined;
  /** Shallow-water coupling with a terrain heightmap. Omitted: open water only. */
  terrain?: WaterTerrain;
  /** Borrowed sky texture (sampleable `rgba16float`), e.g. `() => sky.reflectionTexture`. Omitted: a sky gradient. */
  reflection?: () => GPUTexture | undefined;
  /** Borrowed viewport-sized `rgba16float` scene colour with COPY_SRC, for refraction. Omitted: an approximate seabed. */
  sceneColor?: () => GPUTexture | undefined;
  /** Up to two directional lights for glints, e.g. `sky.lights`; read every frame. Default: the engine light. */
  lights?: readonly WaterLight[];
  /** A 2,048-droplet GPU spray pool; needs `terrain`. Default false. */
  spray?: boolean;
  /** Stretch the outer grid rows to a 10 km horizon for open ocean. Default false. */
  horizon?: boolean;
}
const shader =
  waterFrame +
  oceanWaves +
  `
const HORIZON=false;
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var history:texture_2d<f32>;
@group(0) @binding(3) var coast:texture_2d<f32>;
@group(0) @binding(4) var environment:texture_2d<f32>;
@group(0) @binding(5) var skySampler:sampler;
@group(0) @binding(6) var opaque:texture_2d<f32>;
@group(0) @binding(7) var<storage,read> connected:array<u32>;
fn inCoast(xz:vec2f)->bool {let uv=(xz-frame.coast.xy)/frame.coast.zw;return frame.flow.w>0.5&&all(uv>=vec2f(0))&&all(uv<=vec2f(1));}
// Match offshore displacement, normals and optics across the finite simulation boundary.
fn coastBlend(xz:vec2f)->vec3f {
 let edges=vec4f(xz-frame.coast.xy,frame.coast.xy+frame.coast.zw-xz);let distance=min(min(edges.x,edges.y),min(edges.z,edges.w));
 let width=min(max(4.0,4.0*max(frame.flow.y,frame.flow.z)),min(frame.coast.z,frame.coast.w)*0.25);let t=clamp(distance/width,0.0,1.0);let slope=6.0*t*(1.0-t)/width;
 var gradient=vec2f(0);if(distance==edges.x){gradient.x=slope;}else if(distance==edges.y){gradient.y=slope;}else if(distance==edges.z){gradient.x=-slope;}else{gradient.y=-slope;}
 return vec3f(gradient,t*t*(3.0-2.0*t));
}
struct CoastalSample {water:vec4f,normal:vec3f,surface:f32,blend:vec3f,ocean:f32}
fn coastal(xz:vec2f)->CoastalSample {
 let size=vec2i(textureDimensions(coast));let uv=(xz-frame.coast.xy)/frame.coast.zw;
 let pixel=clamp(uv*vec2f(size)-0.5,vec2f(0),vec2f(size-1));let lo=vec2i(floor(pixel));let hi=min(lo+1,size-1);let t=fract(pixel);
 let a=textureLoad(coast,lo,0);let b=textureLoad(coast,vec2i(hi.x,lo.y),0);let c=textureLoad(coast,vec2i(lo.x,hi.y),0);let d=textureLoad(coast,hi,0);
 let weights=vec4f((1.0-t.x)*(1.0-t.y),t.x*(1.0-t.y),(1.0-t.x)*t.y,t.x*t.y)*step(vec4f(0.003),vec4f(a.x,b.x,c.x,d.x));
 let total=dot(weights,vec4f(1));let surface=select(frame.settings.y,dot(weights,vec4f(a.x+a.y,b.x+b.y,c.x+c.y,d.x+d.y))/max(0.0001,total),total>0.0001);
 let h=vec4f(select(surface,a.x+a.y,a.x>0.003),select(surface,b.x+b.y,b.x>0.003),select(surface,c.x+c.y,c.x>0.003),select(surface,d.x+d.y,d.x>0.003));
 let dx=mix(h.y-h.x,h.w-h.z,t.y)/max(0.0001,frame.flow.y);let dz=mix(h.z-h.x,h.w-h.y,t.x)/max(0.0001,frame.flow.z);
 let depths=max(vec4f(0),vec4f(frame.settings.y)-vec4f(a.y,b.y,c.y,d.y));
 let indices=vec4u(u32(lo.y*size.x+lo.x),u32(lo.y*size.x+hi.x),u32(hi.y*size.x+lo.x),u32(hi.y*size.x+hi.x))+1u;
 let sea=smoothstep(vec4f(0.65),vec4f(2.4),depths)*vec4f(select(0.0,1.0,connected[indices.x]==0u),select(0.0,1.0,connected[indices.y]==0u),select(0.0,1.0,connected[indices.z]==0u),select(0.0,1.0,connected[indices.w]==0u));
 let ocean=mix(mix(sea.x,sea.y,t.x),mix(sea.z,sea.w,t.x),t.y);let gradient=vec2f(mix(sea.y-sea.x,sea.w-sea.z,t.y)/frame.flow.y,mix(sea.z-sea.x,sea.w-sea.y,t.x)/frame.flow.z);let edge=coastBlend(xz);
 let blend=vec3f(edge.xy*(1.0-ocean)-edge.z*gradient,edge.z*(1.0-ocean));
 return CoastalSample(mix(mix(a,b,t.x),mix(c,d,t.x),t.y),normalize(vec3f(-dx,1,-dz)),surface,blend,ocean);
}
struct Surface {position:vec3f,normal:vec3f,crest:f32}
fn surface(xz:vec2f,sampleWidth:f32)->Surface {
 var p=vec3f(xz.x,frame.settings.y,xz.y);var tangent=vec3f(1,0,0);var binormal=vec3f(0,0,1);var crest=0.0;
 for(var j=0u;j<u32(frame.settings.w);j++){
  let w=frame.waves[j];
  for(var component=0u;component<3u;component++){
   let wave=swell(w,xz,component,sampleWidth);let d=wave.direction;let a=wave.amplitude;
   // The bend's maximum gradient needs this margin to retain the existing nonfolding bound.
   let q=w.shape.x*0.9;let s=sin(wave.phase);let c=cos(wave.phase);
   p+=vec3f(q*a*d.x*c,a*s,q*a*d.y*c);
   let derivative=vec3f(-q*a*d.x*s,a*c,-q*a*d.y*s);
   tangent+=derivative*wave.gradient.x;binormal+=derivative*wave.gradient.y;
   crest=max(crest,smoothstep(0.75,0.98,s)*smoothstep(0.14,0.32,a*length(wave.gradient)));
  }
 }
 if(inCoast(xz)){
  let v=coastal(xz);let blend=v.blend;let shore=vec3f(xz.x,v.surface,xz.y);let delta=shore-p;
  tangent=mix(tangent,vec3f(1,-v.normal.x/max(0.0001,v.normal.y),0),blend.z)+delta*blend.x;
  binormal=mix(binormal,vec3f(0,-v.normal.z/max(0.0001,v.normal.y),1),blend.z)+delta*blend.y;
  p=mix(p,shore,blend.z);
 }
 return Surface(p,normalize(cross(binormal,tangent)),crest);
}
struct Output {@builtin(position) clip:vec4f,@location(0) normal:vec3f,@location(1) world:vec3f,@location(2) crest:f32,@location(3) xz:vec2f}
@vertex fn vertex(@location(0) xz:vec2f,@location(1) sampleWidth:f32)->Output {
 let v=surface(xz,sampleWidth);var clip=frame.camera*vec4f(v.position,1);if(HORIZON){clip.z=max(clip.z,0.000001*clip.w);}return Output(clip,v.normal,v.position,v.crest,xz);
}
fn linear(d:f32)->f32 {return frame.cameraData.x*frame.cameraData.y/(frame.cameraData.x+d*(frame.cameraData.y-frame.cameraData.x));}
fn hash(p:vec2i)->f32 {var x=bitcast<u32>(p.x)*1664525u+bitcast<u32>(p.y)*1013904223u;x=(x^(x>>16u))*2246822519u;return f32(x^(x>>13u))/4294967295.0;}
fn noise(p:vec2f)->vec3f {
 let cell=vec2i(floor(p));let f=fract(p);let t=f*f*(3.0-2.0*f);let slope=6.0*f*(1.0-f);
 let a=hash(cell);let b=hash(cell+vec2i(1,0));let c=hash(cell+vec2i(0,1));let d=hash(cell+vec2i(1));
 return vec3f(mix(mix(a,b,t.x),mix(c,d,t.x),t.y),mix(b-a,d-c,t.y)*slope.x,mix(c-a,d-b,t.x)*slope.y);
}
fn fresnel(cosine:f32)->f32 {return 0.02+0.98*pow(1.0-clamp(cosine,0.0,1.0),5.0);}
fn directionalGlint(light:Light,n:vec3f,v:vec3f,rough:f32)->vec3f {
 if(light.direction.w<=0.0){return vec3f(0);}
 let l=normalize(light.direction.xyz);let nl=clamp(dot(n,l),0.0,1.0);let nv=clamp(dot(n,v),0.001,1.0);
 let h=(v+l)/max(0.0001,length(v+l));let nh=clamp(dot(n,h),0.0,1.0);let vh=clamp(dot(v,h),0.0,1.0);
 let alpha=rough*rough;let a2=alpha*alpha;let denominator=nh*nh*(a2-1.0)+1.0;let d=a2/(3.14159265*denominator*denominator);let k=(rough+1.0)*(rough+1.0)*0.125;
 let g=nv/(nv*(1.0-k)+k)*nl/max(0.001,nl*(1.0-k)+k);
 return light.radiance.rgb*light.direction.w*d*g*fresnel(vh)/max(0.004,4.0*nv);
}
// Open water reflects the horizon when a wave would otherwise sample uncharted ground.
fn reflectionRay(r:vec3f)->vec3f {return normalize(vec3f(r.x,max(0.02,r.y),r.z));}
fn skyColor(direction:vec3f,rough:f32)->vec3f {
 let r=reflectionRay(direction);
 if(frame.color.w>0.5){let uv=vec2f(atan2(r.z,r.x)/6.2831853+0.5,acos(clamp(r.y,0.0,1.0))/3.14159265);let spread=vec2f(rough*0.035,0);return textureSampleLevel(environment,skySampler,uv,0).rgb*0.5+(textureSampleLevel(environment,skySampler,uv-spread,0).rgb+textureSampleLevel(environment,skySampler,uv+spread,0).rgb)*0.25;}
 return mix(vec3f(0.18,0.27,0.32),vec3f(0.035,0.10,0.20),sqrt(max(0.0,r.y)))*frame.radiance.rgb*(0.015+min(1.0,frame.sun.w*0.15));
}
struct Result {@location(0) color:vec4f,@location(1) foam:vec4f}
@fragment fn fragment(i:Output)->Result{
 let pixel=vec2i(i.clip.xy);let waterDistance=linear(i.clip.z);let sceneDepth=textureLoad(depth,pixel,0);
 var gap=50.0;if(sceneDepth>0){gap=max(0.0,linear(sceneDepth)-waterDistance)*abs(frame.eye.y-i.world.y)/max(0.0001,waterDistance);}
 var movement=i.crest;let isCoast=inCoast(i.xz);var refraction=1.0;var dry=false;
 if(frame.flow.w>0.5){
  let sample=coastal(i.xz);let v=sample.water;refraction=coastBlend(i.xz).z;
  // shortcut: uncharted seabed deepens at 0.35 m/m; supply a larger heightmap for distant shoals.
  let outside=max(max(frame.coast.xy-i.xz,i.xz-frame.coast.xy-frame.coast.zw),vec2f(0));let bed=max(0.0,i.world.y-v.y)+length(outside)*0.35;
  gap=mix(gap,min(gap,bed),select(sample.ocean,1.0,isCoast));
  if(isCoast){dry=v.x<0.003;gap=mix(gap,v.x,sample.blend.z);movement=mix(movement,v.z,sample.blend.z);}
 }
 let footprint=max(length(dpdx(i.world.xz)),length(dpdy(i.world.xz)));let edge=max(0.015,fwidth(gap)*1.5);
 let normalWidth=length(fwidth(i.normal));
 // Shoreline quads need their helper lanes until all screen derivatives have been evaluated.
 if(dry){discard;}
 let grainDetail=1.0-smoothstep(0.25,1.0,footprint*2.4);var grain=0.5;
 if(grainDetail>0){grain=mix(0.5,noise(i.world.xz*2.4+vec2f(frame.settings.x*0.22,0)).x,grainDetail);}
 let shore=1.0-smoothstep(0.0,max(frame.settings.z*0.5,edge*2.0),max(0.0,gap+(grain-0.5)*0.08));
 let pattern=mix(0.45,1.0,grain);let fresh=clamp((shore*0.08+movement*0.9)*pattern,0.0,1.0);
 var foam=fresh;if(frame.flow.w<0.5){foam=max(fresh,textureLoad(history,pixel,0).r*exp(-frame.cameraData.z*3.0)*shore);}
 var ripple=vec3f(0);
 if(footprint<6.0){
 let wind=frame.waves[0].wave.xy;let across=vec2f(-wind.y,wind.x);let uv=vec2f(dot(i.world.xz,wind),dot(i.world.xz,across));
 let agitation=noise(uv*vec2f(0.22,0.16)+frame.settings.x*vec2f(-0.09,0.03));
 let chop=noise(uv*vec2f(0.57,0.42)+frame.settings.x*vec2f(-0.17,-0.06)+vec2f(3.17,9.23));
 let a=noise(uv*vec2f(1.8,0.65)+frame.settings.x*vec2f(-0.5,0.12));
 let b=noise(uv*vec2f(3.4,1.9)+frame.settings.x*vec2f(-0.7,0.2)+vec2f(7.13,3.71));
 let gradient=agitation.yz*vec2f(0.22,0.16)*0.30*(1.0-smoothstep(0.25,1.0,footprint*0.22))+chop.yz*vec2f(0.57,0.42)*0.10*(1.0-smoothstep(0.25,1.0,footprint*0.57))+(a.yz*vec2f(1.8,0.65)*0.018+b.yz*vec2f(3.4,1.9)*0.006*(1.0-smoothstep(0.12,0.5,footprint)))*(1.0-smoothstep(0.2,1.0,footprint));
 let slope=wind*gradient.x+across*gradient.y;
 ripple=vec3f(-slope.x,0,-slope.y)*(1.0-foam);
 }
 let n=normalize(i.normal+ripple);let v=normalize(frame.eye.xyz-i.world);let nv=clamp(dot(n,v),0.001,1.0);let reflection=fresnel(nv);
 let optical=min(50.0,gap/max(0.15,abs(v.y)));let transmission=exp(-vec3f(0.38,0.10,0.045)*optical);
 var bottom=vec3f(0.28,0.25,0.17)*(frame.eye.w+frame.radiance.rgb*frame.sun.w*0.12);
 if(frame.radiance.w>0.5){let limit=vec2i(textureDimensions(opaque))-1;var q=clamp(pixel+vec2i(n.xz*min(6.0,gap*2.0)),vec2i(0),limit);let d=textureLoad(depth,q,0);if(d<=0||d>i.clip.z){q=pixel;}if(textureLoad(depth,q,0)>0){bottom=mix(bottom,textureLoad(opaque,q,0).rgb,refraction);}}
 let nl=clamp(dot(n,normalize(frame.sun.xyz)),0.0,1.0);let rough=clamp(0.12+normalWidth*0.6+footprint*0.025,0.12,0.4);
 let glint=directionalGlint(frame.lights[0],n,v,rough)+directionalGlint(frame.lights[1],n,v,rough);
 let body=bottom*transmission+frame.color.rgb*(vec3f(1)-transmission)*(frame.eye.w+frame.radiance.rgb*nl*frame.sun.w*0.12);
 var color=mix(body,skyColor(reflect(-v,n),rough),reflection)+glint;
 color=mix(color,vec3f(0.72,0.77,0.74)*(vec3f(0.05)+frame.radiance.rgb*min(1.0,frame.sun.w)),foam*0.95);
 if(frame.cameraData.w<0.5){color=pow(color/(vec3f(1)+color),vec3f(1.0/2.2));}
 return Result(vec4f(color,1),vec4f(foam,0,0,1));
}`;
const depthCopy = `
@group(0) @binding(0) var sceneDepth:texture_depth_2d;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
@fragment fn fragment(@builtin(position) p:vec4f)->@builtin(frag_depth) f32 {return textureLoad(sceneDepth,vec2i(p.xy),0);}
`;
let instances = 0;
/**
 * An opaque, Y-up water surface: up to eight Gerstner swell trains with analytic normals, Fresnel reflection, glints,
 * absorption and shoreline foam, with optional terrain-coupled shallow-water flow and spray. `Water.attach(engine,
 * options)`; WebGPU only.
 * @throws RangeError / TypeError from the constructor when an option is invalid (including folding wave steepness).
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'state'` during a frame when a
 * borrowed texture (depth, reflection, scene colour, terrain heightmap) does not have the required size or format.
 */
export class Water implements EnginePlugin {
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'load', storeOp: 'store' };
  private readonly foamAttachment: GPURenderPassColorAttachment = {
    view: undefined!,
    loadOp: 'clear',
    storeOp: 'store',
    clearValue: { r: 0, g: 0, b: 0, a: 0 },
  };
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = {
    view: undefined!,
    depthLoadOp: 'load',
    depthStoreOp: 'store',
    stencilReadOnly: true,
  };
  private readonly presentation: GPURenderPassDescriptor = {
    colorAttachments: [this.attachment, this.foamAttachment],
    depthStencilAttachment: this.depthAttachment,
  };
  private readonly copiedDepth: GPURenderPassDepthStencilAttachment = {
    view: undefined!,
    depthClearValue: 0,
    depthLoadOp: 'clear',
    depthStoreOp: 'store',
    stencilReadOnly: true,
  };
  private readonly depthPresentation: GPURenderPassDescriptor = {
    colorAttachments: [],
    depthStencilAttachment: this.copiedDepth,
  };
  private foamMSAA?: GPUTexture;
  private foamMSAAView?: GPUTextureView;
  private surfaceDepth?: GPUTexture;
  private surfaceView?: GPUTextureView;
  private copyPipeline?: GPURenderPipeline;
  private copyGroup?: GPUBindGroup;
  private reflected?: GPUTexture;
  private captured?: GPUTexture;
  private capturedView?: GPUTextureView;
  private skySampler?: GPUSampler;
  private spray?: Spray;
  private readonly colorSource: GPUTexelCopyTextureInfo = { texture: undefined! };
  private readonly colorTarget: GPUTexelCopyTextureInfo = { texture: undefined! };
  private readonly colorSize: GPUExtent3DDict = { width: 1, height: 1, depthOrArrayLayers: 1 };
  private foamViews: GPUTextureView[] = [];
  private groups: GPUBindGroup[] = [];
  private sampledDepth?: GPUTexture;
  private coastal?: CoastalFlow;
  readonly name = 'water:' + ++instances;
  private engine?: Engine;
  private source?: () => GPUTexture | undefined;
  private shared?: ReturnType<typeof acquireDepth>;
  private uniform?: GPUBuffer;
  private vertices?: GPUBuffer;
  private indices?: GPUBuffer;
  private count = 0;
  private pipeline?: GPURenderPipeline;
  private format = '';
  private foam: GPUTexture[] = [];
  private current = 0;
  private time = 0;
  private readonly values = new Float32Array(128);
  private readonly waveHeights = new Float32Array(8);
  private maxWaveHeight = 0;
  private disposed = false;
  private readonly positions: Float32Array;
  private readonly triangles: Uint32Array;
  private readonly horizon: boolean;
  constructor(readonly options: WaterOptions = {}) {
    const {
      size = [100, 100],
      segments = 128,
      height = 0,
      color = [0.01, 0.18, 0.25],
      foamDistance = 1,
      waves = [
        { direction: [1, 0.3], amplitude: 0.3, wavelength: 12.73, phase: 0.43 },
        { direction: [1, 0.6], amplitude: 0.15, wavelength: 7.19, phase: 2.17 },
      ],
    } = options;
    if (
      size.length !== 2 ||
      size.some((v) => !Number.isFinite(Math.fround(v)) || v <= 0 || v > 100000) ||
      !Number.isInteger(segments) ||
      segments < 1 ||
      segments > 512 ||
      !Number.isFinite(Math.fround(height)) ||
      !Number.isFinite(foamDistance) ||
      foamDistance <= 0 ||
      foamDistance > 100 ||
      color.length !== 3 ||
      color.some((v) => !Number.isFinite(v) || v < 0 || v > 1) ||
      waves.length < 1 ||
      waves.length > 8 ||
      (options.depth !== undefined && typeof options.depth !== 'function')
    )
      throw new RangeError('Invalid water options');
    this.values.set([0, height, foamDistance, waves.length], 20);
    this.values.set(color, 24);
    this.values.set([0.6, 0.8, 0, 3, 1, 0.9, 0.75, 0], 104);
    if (
      (options.reflection !== undefined && typeof options.reflection !== 'function') ||
      (options.sceneColor !== undefined && typeof options.sceneColor !== 'function') ||
      (options.spray !== undefined && typeof options.spray !== 'boolean') ||
      (options.spray && !options.terrain) ||
      (options.horizon !== undefined && typeof options.horizon !== 'boolean')
    )
      throw new TypeError('Invalid water optics or spray options');
    this.validateLights();
    this.horizon = options.horizon ?? false;
    this.values[98] = this.values[99] = 1;
    const terrain = options.terrain;
    if (terrain) {
      if (
        typeof terrain.heightmap !== 'function' ||
        terrain.origin.length !== 2 ||
        terrain.origin.some((v) => !Number.isFinite(Math.fround(v))) ||
        terrain.size.length !== 2 ||
        terrain.size.some((v) => !Number.isFinite(Math.fround(v)) || v <= 0 || v > 100000)
      )
        throw new RangeError('Invalid water terrain');
      this.values.set(terrain.origin, 96);
      this.values.set(terrain.size, 98);
      this.values[103] = 1;
    }
    const edge = Math.hypot(size[0] / segments, size[1] / segments);
    for (let i = 0; i < waves.length; i++) {
      const w = waves[i],
        length = Math.hypot(...w.direction),
        q = w.steepness ?? 0.5;
      if (
        w.direction.length !== 2 ||
        w.direction.some((v) => !Number.isFinite(v)) ||
        !length ||
        !Number.isFinite(w.amplitude) ||
        w.amplitude < 0 ||
        w.amplitude > 100 ||
        !Number.isFinite(w.wavelength) ||
        w.wavelength <= 0 ||
        w.wavelength > 100000 ||
        !Number.isFinite(q) ||
        q < 0 ||
        q > 1 ||
        !Number.isFinite(w.phase ?? 0)
      )
        throw new RangeError('Invalid Gerstner wave');
      const k = (2 * Math.PI) / w.wavelength;
      if (q * w.amplitude * k > 1 / waves.length) throw new RangeError('Wave steepness would fold the surface');
      // Fade waves shorter than four triangle edges to prevent mesh sampling artifacts.
      const t = Math.max(0, Math.min(1, (w.wavelength / edge - 2) / 2));
      this.values.set(
        [
          w.direction[0] / length,
          w.direction[1] / length,
          w.amplitude,
          k,
          q,
          Math.sqrt(9.81 * k),
          w.phase ?? 0,
          t * t * (3 - 2 * t),
        ],
        32 + i * 8,
      );
      this.waveHeights[i] = w.amplitude;
      this.maxWaveHeight = Math.max(this.maxWaveHeight, w.amplitude);
    }
    this.positions = new Float32Array((segments + 1) ** 2 * 3);
    this.triangles = new Uint32Array(segments ** 2 * 6);
    // shortcut: a fixed 10 km extension suits local worlds; use camera-centered ocean rings for large travel ranges.
    const coordinate = (i: number, axis: number) => {
      const u = i / segments - 0.5;
      return (
        u * size[axis] + (this.horizon ? Math.sign(u) * 10000 * Math.max(0, (Math.abs(u) - 0.375) / 0.125) ** 3 : 0)
      );
    };
    const step = (i: number, axis: number) =>
      Math.max(
        coordinate(Math.min(segments, i + 1), axis) - coordinate(i, axis),
        coordinate(i, axis) - coordinate(Math.max(0, i - 1), axis),
      );
    for (let z = 0; z <= segments; z++)
      for (let x = 0; x <= segments; x++) {
        const o = (z * (segments + 1) + x) * 3;
        this.positions[o] = coordinate(x, 0);
        this.positions[o + 1] = coordinate(z, 1);
        this.positions[o + 2] = Math.hypot(step(x, 0), step(z, 1));
        if (x < segments && z < segments) {
          const a = o / 3,
            b = a + segments + 1;
          this.triangles.set([a, b, a + 1, a + 1, b, b + 1], (z * segments + x) * 6);
        }
      }
    this.count = this.triangles.length;
  }
  static attach(engine: EngineKernel, options: WaterOptions = {}): Water {
    const effect = new Water(options);
    engineRuntime(engine).use(effect);
    return effect;
  }
  /** Borrowed coastal state; R is water depth in meters. Undefined before simulation or after restoration. */
  get coastalDepthTexture(): GPUTexture | undefined {
    return this.coastal?.states[this.coastal.current];
  }
  /** Borrowed scene depth including the water surface; changes on resize/restoration. */
  get depthTexture(): GPUTexture | undefined {
    return this.surfaceDepth;
  }
  /** Scales the wave spectrum so its largest configured train has this amplitude in meters. */
  setWaveHeight(height: number): this {
    if (this.disposed || !Number.isFinite(height) || height < 0 || height > 100 || (!this.maxWaveHeight && height > 0))
      throw new RangeError('Invalid water wave height');
    for (let i = 0; i < this.values[23]; i++) {
      const o = 32 + i * 8,
        amplitude = this.maxWaveHeight ? (height * this.waveHeights[i]) / this.maxWaveHeight : 0;
      if (this.values[o + 4] * amplitude * this.values[o + 3] > 1 / this.values[23])
        throw new RangeError('Wave steepness would fold the surface');
    }
    for (let i = 0; i < this.values[23]; i++)
      this.values[34 + i * 8] = this.maxWaveHeight ? (height * this.waveHeights[i]) / this.maxWaveHeight : 0;
    return this;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Water requires WebGPU; attach a new Water to a WebGPU engine',
      );
    this.engine = engine;
    this.shared = this.options.depth ? undefined : acquireDepth(engine);
    this.source = this.options.depth ?? this.shared!.texture;
    // The uniform supplies the unused connectivity binding when there is no terrain.
    this.uniform = engine.gpu.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.skySampler = engine.gpu.createSampler({
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
      minFilter: 'linear',
      magFilter: 'linear',
    });
    this.vertices = engine.gpu.createBuffer({
      size: this.positions.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    engine.gpu.queue.writeBuffer(this.vertices, 0, this.positions as Float32Array<ArrayBuffer>);
    this.indices = engine.gpu.createBuffer({
      size: this.triangles.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    engine.gpu.queue.writeBuffer(this.indices, 0, this.triangles as Uint32Array<ArrayBuffer>);
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':draw',
      order: 4,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  private validateLights(): void {
    const lights = this.options.lights;
    if (lights === undefined) return;
    if (!Array.isArray(lights) || lights.length > 2) throw new RangeError('Water accepts up to two directional lights');
    for (const light of lights) {
      if (!light || light.direction?.length !== 4 || light.radiance?.length !== 3)
        throw new RangeError('Invalid water light');
      for (let i = 0; i < 4; i++)
        if (
          !Number.isFinite(Math.fround(light.direction[i])) ||
          (i < 3 && (!Number.isFinite(Math.fround(light.radiance[i])) || light.radiance[i] < 0))
        )
          throw new RangeError('Invalid water light');
      if (
        light.direction[3] < 0 ||
        !Math.hypot(Math.fround(light.direction[0]), Math.fround(light.direction[1]), Math.fround(light.direction[2]))
      )
        throw new RangeError('Invalid water light');
    }
  }
  private draw(c: Context): void {
    resolveMSAA(c);
    const samples = c.descriptor.multisample?.count ?? 1;
    const depth = this.source!();
    if (
      !depth ||
      depth.width !== c.width ||
      depth.height !== c.height ||
      !depth.format.startsWith('depth') ||
      !(depth.usage & GPUTextureUsage.TEXTURE_BINDING)
    )
      throw new MargoError('state', 'Water needs viewport-sized sampleable scene depth; return one from options.depth');
    const reflection = this.options.reflection?.();
    if (
      this.options.reflection &&
      (!reflection ||
        reflection.dimension !== '2d' ||
        reflection.sampleCount !== 1 ||
        reflection.depthOrArrayLayers > 1 ||
        reflection.format !== 'rgba16float' ||
        !(reflection.usage & GPUTextureUsage.TEXTURE_BINDING))
    )
      throw new MargoError(
        'state',
        'Water reflection needs a sampleable rgba16float sky texture; return one from options.reflection',
      );
    if (this.reflected !== reflection) {
      this.reflected = reflection;
      this.groups = [];
    }
    this.values[27] = +!!reflection;
    const scene = this.options.sceneColor?.();
    this.values[111] = +!!scene;
    if (this.options.sceneColor) {
      if (
        !scene ||
        scene.dimension !== '2d' ||
        scene.sampleCount !== 1 ||
        scene.depthOrArrayLayers > 1 ||
        scene.width !== c.width ||
        scene.height !== c.height ||
        scene.format !== 'rgba16float' ||
        scene.format !== c.format ||
        !(scene.usage & GPUTextureUsage.COPY_SRC)
      )
        throw new MargoError(
          'state',
          'Water scene color needs a viewport-sized copyable HDR color texture; return one in the pass format (rgba16float) from options.sceneColor',
        );
      const target = sceneTarget(c);
      // The 1x opaque resolve is separate from our 4x color attachment and stays unchanged during this pass.
      if (
        samples === 4 &&
        target?.samples === 4 &&
        scene === target.resolvedColor &&
        scene.usage & GPUTextureUsage.TEXTURE_BINDING
      ) {
        if (this.colorSource.texture !== scene || !this.capturedView || this.captured) {
          this.captured?.destroy();
          this.captured = undefined;
          this.capturedView = scene.createView();
          this.groups = [];
        }
        this.colorSource.texture = scene;
      } else {
        if (
          this.captured?.width !== c.width ||
          this.captured?.height !== c.height ||
          this.captured?.format !== c.format
        ) {
          this.captured?.destroy();
          this.captured = c.device.createTexture({
            size: [c.width, c.height],
            format: c.format,
            usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
          });
          this.capturedView = this.captured.createView();
          this.colorTarget.texture = this.captured;
          this.colorSize.width = c.width;
          this.colorSize.height = c.height;
          this.groups = [];
        }
        this.colorSource.texture = scene;
        c.encoder.copyTextureToTexture(this.colorSource, this.colorTarget, this.colorSize);
      }
    }
    if (
      this.surfaceDepth?.width !== c.width ||
      this.surfaceDepth?.height !== c.height ||
      this.surfaceDepth?.format !== depth.format ||
      this.surfaceDepth?.sampleCount !== samples
    ) {
      const changed = this.surfaceDepth?.format !== depth.format || this.surfaceDepth?.sampleCount !== samples;
      this.surfaceDepth?.destroy();
      this.surfaceDepth = c.device.createTexture({
        size: [c.width, c.height],
        format: depth.format,
        sampleCount: samples,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.surfaceView = this.surfaceDepth.createView();
      this.copiedDepth.view = this.surfaceView;
      this.groups = [];
      if (changed) {
        const module = c.device.createShaderModule({ code: depthCopy });
        this.copyPipeline = c.device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [] },
          depthStencil: { format: depth.format, depthWriteEnabled: true, depthCompare: 'always' },
          multisample: { count: samples },
        });
        this.format = '';
      }
    }
    if (
      this.foam[0]?.width !== c.width ||
      this.foam[0]?.height !== c.height ||
      (this.foamMSAA?.sampleCount ?? 1) !== samples
    ) {
      this.foamMSAA?.destroy();
      this.foamMSAA = undefined;
      this.foamMSAAView = undefined;
      if (samples === 4) {
        this.foamMSAA = c.device.createTexture({
          size: [c.width, c.height],
          format: 'r8unorm',
          sampleCount: 4,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.foamMSAAView = this.foamMSAA.createView();
      }
      for (const t of this.foam) t.destroy();
      this.foam = [];
      for (let i = 0; i < 2; i++)
        this.foam.push(
          c.device.createTexture({
            size: [c.width, c.height],
            format: 'r8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
          }),
        );
      this.foamViews = this.foam.map((texture) => texture.createView());
      this.groups = [];
      this.current = 0;
    }
    const format = c.format + ':' + samples + ':' + depth.format;
    if (this.format !== format) {
      const module = c.device.createShaderModule({
        code: shader.replace('const HORIZON=false;', `const HORIZON=${this.horizon};`),
      });
      this.pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: 12,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' },
                { shaderLocation: 1, offset: 8, format: 'float32' },
              ],
            },
          ],
        },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }, { format: 'r8unorm' }] },
        primitive: { cullMode: 'none' },
        depthStencil: { format: depth.format, depthCompare: 'greater-equal', depthWriteEnabled: true },
        multisample: { count: samples },
      });
      this.format = format;
      this.groups = [];
    }
    this.time += c.delta;
    this.values.set(c.camera.matrix);
    this.values.set(c.camera.position, 16);
    this.values[20] = this.time;
    this.values[28] = c.camera.near;
    this.values[29] = c.camera.far;
    this.values[30] = c.delta;
    this.values[31] = +(c.format === 'rgba16float');
    const lighting = this.engine!.lighting;
    this.values[19] = lighting?.radiance[3] ?? 0.15;
    if (lighting) {
      this.values.set(lighting.direction, 104);
      this.values[108] = lighting.radiance[0];
      this.values[109] = lighting.radiance[1];
      this.values[110] = lighting.radiance[2];
    }
    this.validateLights();
    this.values.fill(0, 112);
    if (this.options.lights) {
      for (let i = 0; i < this.options.lights.length; i++) {
        const light = this.options.lights[i],
          length = Math.hypot(light.direction[0], light.direction[1], light.direction[2]);
        for (let j = 0; j < 3; j++) this.values[112 + i * 8 + j] = light.direction[j] / length;
        this.values[115 + i * 8] = light.direction[3];
        this.values.set(light.radiance, 116 + i * 8);
      }
    } else {
      this.values.copyWithin(112, 104, 108);
      this.values.copyWithin(116, 108, 111);
    }
    if (this.options.terrain) {
      const terrain = this.options.terrain.heightmap();
      if (
        !terrain ||
        terrain.dimension !== '2d' ||
        terrain.sampleCount !== 1 ||
        terrain.depthOrArrayLayers > 1 ||
        terrain.width < 2 ||
        terrain.height < 2 ||
        terrain.width > 512 ||
        terrain.height > 512 ||
        terrain.format !== 'r32float' ||
        !(terrain.usage & GPUTextureUsage.TEXTURE_BINDING)
      )
        throw new MargoError(
          'state',
          'Water terrain needs a sampleable 2D r32float heightmap, 2..512 cells per side; return one from options.terrain',
        );
      if (this.coastal?.terrain !== terrain) {
        this.spray?.dispose();
        this.spray = undefined;
        this.coastal?.dispose();
        this.coastal = new CoastalFlow(c.device, this.uniform!, terrain);
        if (this.options.spray) this.spray = new Spray(c.device, this.uniform!, this.coastal);
        this.values[101] = this.values[98] / terrain.width;
        this.values[102] = this.values[99] / terrain.height;
        this.groups = [];
      }
      this.values[100] = Math.min(Math.max(c.delta, 0), 1 / 15) / 3;
    }
    c.device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>);
    this.coastal?.step(c.encoder);
    this.spray?.step(c.encoder);
    if (this.sampledDepth !== depth || !this.groups.length) {
      const view = depth.createView({ aspect: 'depth-only' });
      this.copyGroup = group(c.device, this.copyPipeline!, [view]);
      this.groups = [];
      for (let i = 0; i < 2; i++)
        for (let j = 0; j < (this.coastal ? 2 : 1); j++)
          this.groups.push(
            group(c.device, this.pipeline!, [
              { buffer: this.uniform! },
              view,
              this.foamViews[i],
              this.coastal?.views[j] ?? this.foamViews[i],
              reflection?.createView() ?? this.foamViews[i],
              this.skySampler!,
              this.capturedView ?? this.foamViews[i],
              { buffer: this.coastal?.connected ?? this.uniform! },
            ]),
          );
      this.sampledDepth = depth;
    }
    const target = sceneTarget(c);
    if (target && samples === 4) target.copyDepth(c.encoder, this.surfaceView!, 4);
    else {
      const copy = c.encoder.beginRenderPass(this.depthPresentation);
      copy.setPipeline(this.copyPipeline!);
      copy.setBindGroup(0, this.copyGroup!);
      copy.draw(3);
      copy.end();
    }
    const bind = this.groups[this.current * (this.coastal ? 2 : 1) + (this.coastal?.current ?? 0)];
    this.current = 1 - this.current;
    this.attachment.view = c.color;
    this.foamAttachment.view = samples === 4 ? this.foamMSAAView! : this.foamViews[this.current];
    this.foamAttachment.resolveTarget = samples === 4 ? this.foamViews[this.current] : undefined;
    this.foamAttachment.storeOp = samples === 4 ? 'discard' : 'store';
    this.depthAttachment.view = this.surfaceView!;
    const pass = c.encoder.beginRenderPass(this.presentation);
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, bind);
    pass.setVertexBuffer(0, this.vertices!);
    pass.setIndexBuffer(this.indices!, 'uint32');
    pass.drawIndexed(this.count);
    pass.end();
    this.spray?.draw(c, this.surfaceDepth!, this.surfaceView!);
  }
  private release(): void {
    this.foamMSAA?.destroy();
    this.foamMSAA = undefined;
    this.foamMSAAView = undefined;
    this.shared?.release();
    this.shared = undefined;
    this.spray?.dispose();
    this.spray = undefined;
    this.coastal?.dispose();
    this.coastal = undefined;
    this.surfaceDepth?.destroy();
    this.surfaceDepth = undefined;
    this.surfaceView = undefined;
    this.copyPipeline = undefined;
    this.copyGroup = undefined;
    this.captured?.destroy();
    this.captured = undefined;
    this.capturedView = undefined;
    this.reflected = undefined;
    this.skySampler = undefined;
    this.uniform?.destroy();
    this.vertices?.destroy();
    this.indices?.destroy();
    for (const t of this.foam) t.destroy();
    this.foam = [];
    this.foamViews = [];
    this.groups = [];
    this.sampledDepth = undefined;
    this.uniform = this.vertices = this.indices = undefined;
    this.pipeline = undefined;
    this.format = '';
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
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
