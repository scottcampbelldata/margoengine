/// <reference lib="esnext.disposable" preserve="true" />
// Light probes baked from the scene on the GPU: an irradiance volume (a grid of L1 or L2 spherical-harmonic probes,
// trilinear between probes) and local reflection probes (box-projected, prefiltered octahedral radiance, blended by their
// influence boxes). Both replace the ambient term (`margoAmbient`, like EnvironmentLighting, so SSAO occludes them) on core
// meshes (`engine.use`) and on every `add(model)` receiver (gltf-pro and materials models, terrain). Everything lives in one
// storage buffer, so the probes add no sampled texture: with an Environment fallback the binding count matches
// EnvironmentLighting's (gltf-pro's physical material with every light still fits WebGPU's 16).
import type { EngineKernel } from '@margoengine/core';
import { Camera, engineRuntime, type FrameGraph, type PassContext, type Vec3 } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Environment } from './environment.js';
import { IBL_WGSL, iblBindGroupEntries } from './ibl.js';
import { IBL_BINDING, ShaderEffect, type LightingTarget, type PBRHooks } from './lighting.js';
import { evaluateSH } from './sh.js';
import { halfToFloat } from './half.js';
import { common } from './shaders.js';
import { captureDevice } from './capture-device.js';

declare const GPUBufferUsage: {
  UNIFORM: number;
  STORAGE: number;
  COPY_DST: number;
  COPY_SRC: number;
  MAP_READ: number;
};
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
declare const GPUMapMode: { READ: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
type BakePipelines = Record<'sh' | 'resample' | 'prefilter', GPUComputePipeline>;
type CaptureTarget = {
  color: GPUTexture;
  depth: GPUTexture;
  array: GPUTextureView;
  colors: GPUTextureView[];
  depthView: GPUTextureView;
  passes: GPURenderPassDescriptor[];
  groups: Map<GPUComputePipeline, GPUBindGroup[]>;
};
type CaptureResources = {
  device: GPUDevice;
  owned: Array<GPUTexture | GPUBuffer>;
  frame: GPUBuffer;
  params: GPUBuffer;
  read?: GPUBuffer;
  sampler: GPUSampler;
  targets: Map<number, CaptureTarget>;
  values: Float32Array;
  slots: Uint32Array;
  floats: Float32Array;
  commands: GPUCommandBuffer[];
  cameras: Camera[];
  positions: [number, number, number][];
  aims: [number, number, number][];
  bindings: GPUBindGroupEntry[];
  frameBinding: GPUBindGroupEntry;
  descriptor: GPURenderPipelineDescriptor;
  depthStencil: GPUDepthStencilState;
  multisample: GPUMultisampleState;
  draw: { pipeline: GPURenderPipeline; bindings: GPUBindGroupEntry[]; clear: false };
  view?: Context;
  environmentView?: GPUTextureView;
  environmentParams?: GPUBuffer;
};
type Waiter = { resolve: () => void; reject: (error: unknown) => void };

/** A box filled with a grid of irradiance probes, one at the centre of each cell. */
export interface IrradianceVolume {
  /** World-space corners of the box. */
  min: Vec3;
  max: Vec3;
  /** Probes along x, y and z (1-64 each, at most 4,096 in total). */
  counts: readonly [number, number, number];
  /** Spherical-harmonic order per probe: 1 (4 coefficients) or 2 (9, default). */
  sh?: 1 | 2;
  /** Cube face edge each probe captures (power of two, 8-64, default 16). */
  resolution?: number;
  /** World distance outside the box over which the volume fades to the fallback (default 0: a hard edge 1 mm out; the box faces are inside). */
  blend?: number;
}
/** A local reflection probe: captured at `position`, box-projected onto `min`..`max`, which is also its influence. */
export interface ReflectionProbe {
  /** Capture point; must lie inside the box. */
  position: Vec3;
  min: Vec3;
  max: Vec3;
  /** World distance outside the box over which the probe fades out (default 10% of the box's smallest side; the box faces are inside). */
  blend?: number;
  /** Re-captured by live capture under `priority: 'dynamic'` ({@link LiveReflectionOptions}); default false. */
  dynamic?: boolean;
}
/**
 * Live reflection capture ({@link LightProbes.setLive}): reflection probes re-captured while the scene changes, a few cube
 * faces per frame. One probe is refreshed at a time: its six faces, then its prefilter with the sixth face, after which
 * shading uses the new radiance. With a still camera, a change shows in a probe within (eligible probes + 1) refreshes
 * of `6 / facesPerFrame` frames each.
 */
export interface LiveReflectionOptions {
  /** Cube faces captured per frame, across probes (1-96, default 1). */
  facesPerFrame?: number;
  /**
   * Which probes refresh: 'nearest' (default) every reflection probe, 'dynamic' only those marked `dynamic`. Each round
   * refreshes every eligible probe once, the one whose box is nearest the camera first.
   */
  priority?: 'nearest' | 'dynamic';
  /**
   * GGX importance samples per rough texel of the live prefilter (power of two, 64-4096, default 256): a fixed cost per
   * refresh, so the prefilter never spikes a frame. `bake()` keeps its full-source convolution unless given `samples`.
   */
  samples?: number;
}
/** Options of {@link LightProbes}. */
export interface LightProbeOptions {
  /** Ambient light outside the probes (and the sky the captures see). Without it, receivers keep their own ambient there. */
  environment?: Environment;
  volume?: IrradianceVolume;
  /** At most {@link MAX_REFLECTION_PROBES}; earlier probes win where boxes overlap (list nested boxes first). */
  reflections?: readonly ReflectionProbe[];
  /** Reflection probe edge: capture faces and the sharpest octahedral level (power of two, 16-256, default 128). */
  resolution?: number;
  /** Capture camera near and far planes (defaults 0.05 and 1000). */
  near?: number;
  far?: number;
  /** Plugin and pass name. Default 'light-probes'. */
  name?: string;
  /** Starts live reflection capture ({@link LightProbes.setLive}); default off. */
  live?: LiveReflectionOptions;
}
/** Options of {@link LightProbes.bake}. */
export interface ProbeBakeOptions {
  /** Captures in a row; each one sees the previous one's probe light (an extra bounce). Default 1. */
  bounces?: number;
  /** Optional GGX importance samples per rough reflection texel (power of two, 64-4096). Omit for full-source convolution. Sharp level 0 and volume SH are unchanged. */
  samples?: number;
}

/** Reflection probes per LightProbes. */
export const MAX_REFLECTION_PROBES = 16;
/** Binding of the probe storage buffer, in core's group 0 and gltf-pro's group 2 (the IBL fallback keeps 20-24). */
export const PROBE_BINDING = 26;
const CAPTURE_BINDING = 27,
  HEADER_BYTES = 64 + MAX_REFLECTION_PROBES * 64,
  MAX_VOLUME_PROBES = 4096,
  LIVE_SAMPLES = 256;
// Capture cameras per cube face: forward and up (right = forward x up); the WGSL below uses the same table.
const FACES: readonly (readonly [Vec3, Vec3])[] = [
  [
    [1, 0, 0],
    [0, 1, 0],
  ],
  [
    [-1, 0, 0],
    [0, 1, 0],
  ],
  [
    [0, 1, 0],
    [0, 0, -1],
  ],
  [
    [0, -1, 0],
    [0, 0, 1],
  ],
  [
    [0, 0, 1],
    [0, 1, 0],
  ],
  [
    [0, 0, -1],
    [0, 1, 0],
  ],
];

const dataWgsl = (access: string, group: number, binding: number) => /* wgsl */ `
struct ProbeBox {position:vec4f,min:vec4f,max:vec4f,data:vec4u}
struct ProbeData {volumeMin:vec4f,volumeMax:vec4f,volumeCounts:vec4u,reflections:vec4u,boxes:array<ProbeBox,${MAX_REFLECTION_PROBES}>,texels:array<vec4u>}
@group(${group}) @binding(${binding}) var<storage,${access}> probeData:ProbeData;
// Texel i: float16 r, g, b in the 8-byte half i & 1 of vec4u i / 2 (octahedral radiance). Volume probes pack their SH in whole vec4u.
fn probeTexel(i:u32)->vec3f {let t=probeData.texels[i>>1u];let u=select(t.xy,t.zw,(i&1u)==1u);return vec3f(unpack2x16float(u.x),unpack2x16float(u.y).x);}
fn probeOct(d:vec3f)->vec2f {
  let a=d/max(abs(d.x)+abs(d.y)+abs(d.z),1e-20);var q=a.xz;
  if(a.y<0.0){q=(1.0-abs(a.zx))*select(vec2f(-1.0),vec2f(1.0),a.xz>=vec2f(0.0));}
  return q*0.5+0.5;
}
`;
// Shading: volume irradiance (trilinear over the eight nearest probes, evaluated like environment's iblIrradiance) and
// reflection radiance (box projection, trilinear over the prefiltered octahedral levels), mixed with the fallback by weight.
const shadingWgsl = (group: number, environment: boolean) =>
  dataWgsl('read', group, PROBE_BINDING) +
  /* wgsl */ `
// 1 inside the box and on its faces (surfaces lying on a room box are lit by it), fading to 0 over blend outside it.
fn probeFade(p:vec3f,lo:vec3f,hi:vec3f,blend:f32)->f32 {let o=max(lo-p,p-hi);return clamp(1.0-max(o.x,max(o.y,o.z))/max(blend,1e-3),0.0,1.0);}
fn probeIrradiance(p:vec3f,n:vec3f)->vec4f {
  let k=probeData.volumeCounts.w;if(k==0u){return vec4f(0);}
  let lo=probeData.volumeMin.xyz;let hi=probeData.volumeMax.xyz;let w=probeFade(p,lo,hi,probeData.volumeMin.w);if(w<=0.0){return vec4f(0);}
  let counts=probeData.volumeCounts.xyz;let last=vec3f(counts-1u);let g=clamp((p-lo)/(hi-lo)*vec3f(counts)-0.5,vec3f(0),last);
  let i0=vec3u(g);let f=g-vec3f(i0);
  // Each probe's coefficients are float16 rgb triples packed back to back in k vec4u (2 for L1, 4 for L2): the eight
  // corners are blended as raw halves (s0..s6 hold halves 0..27), then evaluated once.
  var s0=vec4f(0);var s1=vec4f(0);var s2=vec4f(0);var s3=vec4f(0);var s4=vec4f(0);var s5=vec4f(0);var s6=vec4f(0);
  for(var c=0u;c<8u;c++){
    let corner=min(i0+vec3u(c&1u,(c>>1u)&1u,c>>2u),counts-1u);let t=select(1.0-f,f,vec3<bool>((c&1u)!=0u,(c&2u)!=0u,(c&4u)!=0u));
    let o=(corner.x+counts.x*(corner.y+counts.y*corner.z))*k;let wt=t.x*t.y*t.z;let a=probeData.texels[o];let b=probeData.texels[o+1u];
    s0+=wt*vec4f(unpack2x16float(a.x),unpack2x16float(a.y));s1+=wt*vec4f(unpack2x16float(a.z),unpack2x16float(a.w));
    s2+=wt*vec4f(unpack2x16float(b.x),unpack2x16float(b.y));s3+=wt*vec4f(unpack2x16float(b.z),unpack2x16float(b.w));
    if(k>2u){let c4=probeData.texels[o+2u];let d=probeData.texels[o+3u];
      s4+=wt*vec4f(unpack2x16float(c4.x),unpack2x16float(c4.y));s5+=wt*vec4f(unpack2x16float(c4.z),unpack2x16float(c4.w));s6+=wt*vec4f(unpack2x16float(d.x),unpack2x16float(d.y));}
  }
  let b1=0.488602512*n;
  var e=s0.xyz*0.282094792+vec3f(s0.w,s1.xy)*b1.y+vec3f(s1.zw,s2.x)*b1.z+s2.yzw*b1.x;
  if(k>2u){e+=s3.xyz*(1.092548431*n.x*n.y)+vec3f(s3.w,s4.xy)*(1.092548431*n.y*n.z)+vec3f(s4.zw,s5.x)*(0.315391565*(3.0*n.z*n.z-1.0))+s5.yzw*(1.092548431*n.x*n.z)+s6.xyz*(0.546274215*(n.x*n.x-n.y*n.y));}
  return vec4f(max(e,vec3f(0)),w);
}
fn probeLevel(o:u32,s:u32,uv:vec2f)->vec3f {
  let st=clamp(uv*f32(s)-0.5,vec2f(0),vec2f(f32(s-1u)));let i=vec2u(st);let j=min(i+1u,vec2u(s-1u));let f=st-vec2f(i);
  return mix(mix(probeTexel(o+i.y*s+i.x),probeTexel(o+i.y*s+j.x),f.x),mix(probeTexel(o+j.y*s+i.x),probeTexel(o+j.y*s+j.x),f.x),f.y);
}
fn probeRadiance(b:ProbeBox,d:vec3f,rough:f32)->vec3f {
  let levels=b.data.z;let lod=clamp(rough,0.0,1.0)*f32(levels-1u);let k0=u32(lod);let k1=min(k0+1u,levels-1u);let uv=probeOct(d);
  var o0=b.data.x;for(var j=0u;j<k0;j++){let s=b.data.y>>j;o0+=s*s;}let s0=b.data.y>>k0;
  return mix(probeLevel(o0,s0,uv),probeLevel(select(o0+s0*s0,o0,k1==k0),b.data.y>>k1,uv),lod-f32(k0));
}
fn probeReflection(p:vec3f,r:vec3f,rough:f32)->vec4f {
  var sum=vec3f(0);var left=1.0;let q=r+select(vec3f(0),vec3f(1e-6),abs(r)<vec3f(1e-6));
  for(var j=0u;j<probeData.reflections.x;j++){
    let b=probeData.boxes[j];if(b.data.w==0u){continue;}
    let w=probeFade(p,b.min.xyz,b.max.xyz,b.position.w)*left;if(w<=0.0){continue;}
    let t3=(select(b.min.xyz,b.max.xyz,q>vec3f(0))-p)/q;let d=p+r*max(min(t3.x,min(t3.y,t3.z)),0.0)-b.position.xyz;
    sum+=w*probeRadiance(b,select(r,d,dot(d,d)>1e-12),rough);left-=w;
  }
  return vec4f(sum,1.0-left);
}
${
  environment
    ? `@group(${group}) @binding(${IBL_BINDING}) var iblSpecular:texture_cube<f32>;
@group(${group}) @binding(${IBL_BINDING + 1}) var iblSampler:sampler;
@group(${group}) @binding(${IBL_BINDING + 2}) var<storage,read> iblBrdf:array<u32>;
@group(${group}) @binding(${IBL_BINDING + 3}) var<uniform> iblSh:array<vec4f,9>;
@group(${group}) @binding(${IBL_BINDING + 4}) var<uniform> iblParams:vec4f;
${IBL_WGSL}`
    : ''
}
// Specular radiance the probes put on a surface (before the split-sum weight): reflection probes, then the environment's
// prefiltered sky (or nothing). Post's SSR calls it to remove exactly the light its reflections replace.
fn probeSpecular(p:vec3f,n:vec3f,v:vec3f,rough:f32)->vec3f {
  let r=reflect(-v,n);let s=probeReflection(p,r,rough);
  return s.rgb+(1.0-s.a)*${environment ? 'iblPrefiltered(iblSpecular,iblSampler,iblParams,r,rough)*iblParams.w' : 'vec3f(0)'};
}
// The receiver's ambient term with the probes: diffuse from the volume, specular from the reflection probes, the rest from
// the environment (or \`ambient\`, the receiver's own ambient, without one). Split-sum weights as EnvironmentLighting.
fn probeShade(p:vec3f,n:vec3f,v:vec3f,base:vec3f,metal:f32,rough:f32,ambient:vec3f)->vec3f {
  let nv=clamp(dot(n,v),1e-4,1.0);let f0=mix(vec3f(0.04),base,metal);
  ${
    environment
      ? 'let ab=iblBrdfTerms(nv,rough);let sw=f0*ab.x+ab.y;'
      : 'let c=rough*vec4f(-1,-0.0275,-0.572,0.022)+vec4f(1,0.0425,1.04,-0.04);let a=min(c.x*c.x,exp2(-9.28*nv))*c.x+c.y;let sw=f0*(c.z-1.04*a)+(c.w+1.04*a);'
  }
  let diffuse=(1.0-sw)*(1.0-metal)*base;let e=probeIrradiance(p,n);
  ${environment ? 'let fallback=diffuse*iblIrradiance(iblSh,iblRotate(n,iblParams))*iblParams.w;' : 'let fallback=ambient;'}
  return mix(fallback,diffuse*e.rgb,e.a)+probeSpecular(p,n,v,rough)*sw;
}
`;

// Bake: radiance = capture (premultiplied over the environment where nothing was drawn, alpha < 1), projected to SH
// (normalised cube texel solid angles), resampled to octahedral level 0 and GGX-convolved (n = v = r) into the rougher levels.
// The sampled prefilter runs one workgroup per output texel: its 64 threads split the GGX samples (i, i + 64, ...) and
// add their sums in workgroup memory, so no thread runs a long chain of dependent texture reads (one thread per texel
// looping over every sample was latency-bound: a 2.0 ms median for a 128 px probe at 256 samples on an RTX A6000).
// Same samples, same estimate.
const bakeWgsl = (environment: boolean, sampled: boolean) =>
  dataWgsl('read_write', 0, 0) +
  (sampled ? common : '') +
  /* wgsl */ `
struct Bake {offset:u32,size:u32,source:u32,sourceSize:u32,roughness:f32,count:u32,pad0:u32,pad1:u32}
@group(0) @binding(1) var<uniform> bake:Bake;
@group(0) @binding(2) var faces:texture_2d_array<f32>;
@group(0) @binding(3) var linear:sampler;
${
  environment
    ? `@group(0) @binding(4) var sky:texture_cube<f32>;
@group(0) @binding(5) var<uniform> skyParams:vec4f;
fn envRadiance(d:vec3f)->vec3f {return textureSampleLevel(sky,linear,vec3f(skyParams.x*d.x-skyParams.y*d.z,d.y,skyParams.y*d.x+skyParams.x*d.z),0.0).rgb*skyParams.w;}`
    : 'fn envRadiance(d:vec3f)->vec3f {return vec3f(0);}'
}
// Columns: right, up, forward (FACES in probes.ts).
fn face(f:u32)->mat3x3f {return array<mat3x3f,6>(
  mat3x3f(0,0,1, 0,1,0, 1,0,0),mat3x3f(0,0,-1, 0,1,0, -1,0,0),mat3x3f(-1,0,0, 0,0,-1, 0,1,0),
  mat3x3f(-1,0,0, 0,0,1, 0,-1,0),mat3x3f(-1,0,0, 0,1,0, 0,0,1),mat3x3f(1,0,0, 0,1,0, 0,0,-1))[f];}
fn store(i:u32,c:vec3f) {let u=vec2u(pack2x16float(c.rg),pack2x16float(vec2f(c.b,0.0)));let q=i>>1u;if((i&1u)==0u){probeData.texels[q].x=u.x;probeData.texels[q].y=u.y;}else{probeData.texels[q].z=u.x;probeData.texels[q].w=u.y;}}
fn octDecode(uv:vec2f)->vec3f {let f=uv*2.0-1.0;var n=vec3f(f.x,1.0-abs(f.x)-abs(f.y),f.y);let t=max(-n.y,0.0);n.x+=select(t,-t,n.x>=0.0);n.z+=select(t,-t,n.z>=0.0);return n;}
fn sampleFaces(d:vec3f)->vec3f {
  let m=abs(d);var f=select(1u,0u,d.x>0.0);if(m.y>=m.x&&m.y>=m.z){f=select(3u,2u,d.y>0.0);}else if(m.z>m.x&&m.z>m.y){f=select(5u,4u,d.z>0.0);}
  let b=face(f);let ndc=vec2f(dot(d,b[0]),dot(d,b[1]))/dot(d,b[2]);
  let c=textureSampleLevel(faces,linear,vec2f(ndc.x*0.5+0.5,0.5-ndc.y*0.5),f,0.0);
  return c.rgb+(1.0-c.a)*envRadiance(normalize(d));
}
var<workgroup> partial:array<vec4f,256>;
@compute @workgroup_size(256) fn sh(@builtin(local_invocation_index) t:u32) {
  let s=textureDimensions(faces).x;let total=6u*s*s;var acc:array<vec3f,9>;var weight=0.0;
  for(var i=t;i<total;i+=256u){
    let f=i/(s*s);let xy=vec2u(i%s,(i/s)%s);let ndc=vec2f((f32(xy.x)+0.5)/f32(s)*2.0-1.0,1.0-(f32(xy.y)+0.5)/f32(s)*2.0);
    let b=face(f);let d=normalize(b[2]+ndc.x*b[0]+ndc.y*b[1]);let w=pow(1.0+dot(ndc,ndc),-1.5);
    let c=textureLoad(faces,xy,f,0);let l=(c.rgb+(1.0-c.a)*envRadiance(d))*w;weight+=w;
    acc[0]+=l*0.282094792;acc[1]+=l*(0.488602512*d.y);acc[2]+=l*(0.488602512*d.z);acc[3]+=l*(0.488602512*d.x);
    acc[4]+=l*(1.092548431*d.x*d.y);acc[5]+=l*(1.092548431*d.y*d.z);acc[6]+=l*(0.315391565*(3.0*d.z*d.z-1.0));acc[7]+=l*(1.092548431*d.x*d.z);acc[8]+=l*(0.546274215*(d.x*d.x-d.y*d.y));
  }
  for(var k=0u;k<bake.count;k++){
    partial[t]=vec4f(acc[k],weight);workgroupBarrier();
    for(var stride=128u;stride>0u;stride>>=1u){if(t<stride){partial[t]+=partial[t+stride];}workgroupBarrier();}
    if(t==0u){let band=select(select(0.25,0.6666667,k>0u&&k<4u),1.0,k==0u);coefficients[k]=partial[0].xyz*(12.566370614/partial[0].w)*band;}
    workgroupBarrier();
  }
  // Pack the count * 3 halves into bake.size vec4u at vec4 index bake.offset (zero padded).
  if(t<bake.size){var v=vec4u(0);for(var e=0u;e<4u;e++){let h=(t*4u+e)*2u;v[e]=pack2x16float(vec2f(coefficientHalf(h),coefficientHalf(h+1u)));}probeData.texels[bake.offset+t]=v;}
}
var<workgroup> coefficients:array<vec3f,9>;
fn coefficientHalf(h:u32)->f32 {if(h>=bake.count*3u){return 0.0;}return coefficients[h/3u][h%3u];}
@compute @workgroup_size(8,8) fn resample(@builtin(global_invocation_id) id:vec3u) {
  let s=bake.size;if(id.x>=s||id.y>=s){return;}
  store(bake.offset+id.y*s+id.x,sampleFaces(octDecode((vec2f(id.xy)+0.5)/f32(s))));
}
${
  sampled
    ? `
var<workgroup> texelSum:array<vec4f,64>;
@compute @workgroup_size(64) fn prefilter(@builtin(workgroup_id) g:vec3u,@builtin(local_invocation_index) k:u32) {
  let s=bake.size;
  let n=normalize(octDecode((vec2f(g.xy)+0.5)/f32(s)));
  let up=select(vec3f(1,0,0),vec3f(0,0,1),abs(n.z)<0.999);
  let t=normalize(cross(up,n));let b=cross(n,t);let alpha=bake.roughness*bake.roughness;
  var sum=vec4f(0);
  for(var i=k;i<bake.count;i+=64u){
    let hl=importanceGGX(hammersley(i,bake.count),alpha);
    let h=t*hl.x+b*hl.y+n*hl.z;let l=2.0*hl.z*h-n;let nl=dot(n,l);
    if(nl>0.0){sum+=vec4f(sampleFaces(l)*nl,nl);}
  }
  texelSum[k]=sum;workgroupBarrier();
  for(var stride=32u;stride>0u;stride>>=1u){if(k<stride){texelSum[k]+=texelSum[k+stride];}workgroupBarrier();}
  if(k==0u){let total=texelSum[0];store(bake.offset+g.y*s+g.x,total.rgb/max(total.a,1e-20));}
}
`
    : `
@compute @workgroup_size(8,8) fn prefilter(@builtin(global_invocation_id) id:vec3u) {
  let s=bake.size;if(id.x>=s||id.y>=s){return;}
  let n=normalize(octDecode((vec2f(id.xy)+0.5)/f32(s)));let a=bake.roughness*bake.roughness;let a2=a*a;let m=bake.sourceSize;
  var sum=vec4f(0);
  for(var j=0u;j<m*m;j++){
    let p=octDecode((vec2f(f32(j%m),f32(j/m))+0.5)/f32(m));let r=length(p);let l=p/r;let nl=dot(n,l);if(nl<=0.0){continue;}
    let nh=dot(n,normalize(n+l));let q=nh*nh*(a2-1.0)+1.0;let w=a2/(q*q)*nl/(r*r*r);
    sum+=vec4f(probeTexel(bake.source+j)*w,w);
  }
  store(bake.offset+id.y*s+id.x,sum.rgb/max(sum.a,1e-20));
}
`
}`;

// The capture shader: core's lit shader with every patch, drawn from the probe camera (its own Frame at CAPTURE_BINDING;
// core's binding 0 kept statically used), output as linear radiance, without fog (receivers fog themselves) and with
// clustered lights looped in full (the light lists are culled for the main camera).
const captureCore = (shader: string): string => {
  const code = shader
    .replace(
      '@group(0) @binding(0) var<uniform> frame:Frame;',
      `@group(0) @binding(0) var<uniform> margoMainFrame:Frame;\n@group(0) @binding(${CAPTURE_BINDING}) var<uniform> frame:Frame;`,
    )
    .replace('@vertex fn vertex(i:Input)->Output {', '@vertex fn vertex(i:Input)->Output {_=margoMainFrame.eye;')
    .replace(/let mapped=[\s\S]*?return vec4f\([^\n]+\);/, 'if(false){$&}return vec4f(linear,1);');
  if (
    !code.includes('margoMainFrame:Frame') ||
    !code.includes('_=margoMainFrame') ||
    !code.includes('return vec4f(linear,1);')
  )
    throw new Error('Light probe capture requires the standard core lighting shader');
  return captureLights(code);
};
const captureLights = (code: string): string => {
  let out = code.replace(/(?<!fn )fogAmount\(/g, '0.0*fogAmount(');
  if (out.includes('fn clusterLighting(')) {
    const before = out;
    out = out
      .replace('if(depth<clusterFrame.depth.x||depth>clusterFrame.depth.y){return vec3f(0);}', '')
      .replace(
        'let count=clusterCounts[cell];',
        'let count=clusterFrame.grid.w;if(false){_=clusterCounts[cell];_=clusterIndices[0];}',
      )
      .replace('clusterLights[clusterIndices[cell*1024u+j]]', 'clusterLights[j]');
    if (
      (
        before.match(
          /clusterIndices\[cell\*1024u\+j\]|let count=clusterCounts\[cell\];|depth>clusterFrame\.depth\.y/g,
        ) ?? []
      ).length !== 3 ||
      out.includes('clusterLights[clusterIndices')
    )
      throw new Error('Light probe capture does not recognise the clustered lighting shader');
  }
  return out;
};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const vector = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(finite);
const powerOfTwo = (v: number | undefined, fallback: number, min: number, max: number, label: string): number => {
  const n = v ?? fallback;
  if (!Number.isInteger(n) || n < min || n > max || n & (n - 1))
    throw new RangeError(`Light probe ${label} must be a power of two from ${min} to ${max}`);
  return n;
};
const boxValid = (min: unknown, max: unknown): boolean => vector(min) && vector(max) && min.every((v, i) => v < max[i]);
/** Octahedral levels of a reflection probe of edge `size`: down to 4 x 4. */
const levelCount = (size: number) => Math.log2(size) - 1;
const levelTexels = (size: number) => {
  let n = 0;
  for (let k = 0; k < levelCount(size); k++) n += (size >> k) ** 2;
  return n;
};

/**
 * Light probes baked from the scene on the GPU: an irradiance volume (L1/L2 SH probes on a grid, trilinear between them)
 * and up to 16 box-projected reflection probes. `engine.use(probes)` lights core meshes, `probes.add(model)` gltf-pro and
 * materials models and terrain; added models are also captured. They replace the ambient term (and EnvironmentLighting:
 * pass the environment as the fallback instead of attaching both). `await probes.bake()` captures at load or on demand;
 * {@link setLive} keeps reflection probes current while the scene changes, and {@link refresh} re-captures one from code.
 */
export class LightProbes extends ShaderEffect {
  readonly environment?: Environment;
  readonly volume?: Readonly<IrradianceVolume>;
  readonly reflections: readonly Readonly<ReflectionProbe>[];
  readonly resolution: number;
  private readonly near: number;
  private readonly far: number;
  private gpu?: GPUDevice;
  private buffer?: GPUBuffer;
  private entry: GPUBindGroupEntry[] = [];
  private cached?: GPUBindGroupEntry[];
  private version = -1;
  private readonly header = new ArrayBuffer(HEADER_BYTES);
  private readonly headerView = new DataView(this.header);
  private headerBaked = false;
  private readonly texelCount: number;
  private readonly offsets: number[] = [];
  private readonly captured = new Set<CaptureModel>();
  private snapshot?: Uint32Array;
  private snapshotExposed = false;
  private pending = false;
  private baking = false;
  private bakeSamples = 0;
  private capture?: { source: string; buffers: number | undefined; pipeline: GPURenderPipeline };
  private captureProxy?: { device: GPUDevice; proxy: GPUDevice };
  private bakeDevice?: GPUDevice;
  private readonly bakeCache = new Map<boolean, BakePipelines>();
  private captureResources?: CaptureResources;
  private readonly volumePosition: [number, number, number] = [0.1, 0.1, 0.1];
  // Live and on-demand reflection capture: the probe being refreshed (-1: none), its next face and capture point, the
  // probes refreshed this round, the probes whose radiance is on the GPU, requested refreshes and their promises.
  private liveOptions: Readonly<Required<LiveReflectionOptions>> | null = null;
  private job = -1;
  private jobFace = 0;
  private readonly jobPosition: [number, number, number] = [0, 0, 0];
  private jobWaiters: Waiter[] = [];
  private readonly refreshQueue: number[] = [];
  private readonly refreshWaiters: Waiter[][];
  private readonly roundDone: Uint8Array;
  private readonly active: Uint8Array;
  private refreshCount = 0;

  /** Same as `engine.use(new LightProbes(options))`; returns the LightProbes. */
  static attach(engine: EngineKernel, options: LightProbeOptions): LightProbes {
    const value = new LightProbes(options);
    engine.use(value);
    return value;
  }
  constructor(options: LightProbeOptions) {
    super(options?.name ?? 'light-probes');
    const { volume, reflections = [], environment }: LightProbeOptions = options ?? {};
    if (!volume && !reflections.length) throw new TypeError('LightProbes needs a volume or reflection probes');
    if (environment !== undefined && (typeof environment !== 'object' || !('specularView' in environment)))
      throw new TypeError('LightProbes environment must be an Environment');
    this.near = options.near ?? 0.05;
    this.far = options.far ?? 1000;
    if (!finite(this.near) || !finite(this.far) || this.near <= 0 || this.far <= this.near)
      throw new RangeError('Invalid light probe near/far');
    this.resolution = powerOfTwo(options.resolution, 128, 16, 256, 'resolution');
    const view = new DataView(this.header);
    let texels = 0;
    if (volume) {
      const counts = volume.counts,
        sh = volume.sh ?? 2,
        blend = volume.blend ?? 0;
      if (
        !boxValid(volume.min, volume.max) ||
        !Array.isArray(counts) ||
        counts.length !== 3 ||
        counts.some((n) => !Number.isInteger(n) || n < 1 || n > 64) ||
        counts[0] * counts[1] * counts[2] > MAX_VOLUME_PROBES ||
        (sh !== 1 && sh !== 2) ||
        !finite(blend) ||
        blend < 0
      )
        throw new RangeError(
          'Invalid irradiance volume: min < max, 1-64 probes per axis (4,096 in total), sh 1 or 2, blend >= 0',
        );
      powerOfTwo(volume.resolution, 16, 8, 64, 'volume resolution');
      this.volume = {
        ...volume,
        min: [...volume.min],
        max: [...volume.max],
        counts: [counts[0], counts[1], counts[2]],
        sh,
        blend,
      };
      volume.min.forEach((v, i) => {
        view.setFloat32(i * 4, v, true);
        view.setFloat32(16 + i * 4, volume.max[i], true);
        view.setUint32(32 + i * 4, counts[i], true);
      });
      view.setFloat32(12, blend, true);
      texels = counts[0] * counts[1] * counts[2] * (sh === 2 ? 8 : 4); // 27 or 12 float16 values in 4 or 2 vec4u (8-byte texel units)
    }
    if (!Array.isArray(reflections as unknown) || reflections.length > MAX_REFLECTION_PROBES)
      throw new RangeError(`Expected at most ${MAX_REFLECTION_PROBES} reflection probes`);
    this.reflections = reflections.map((probe, j) => {
      if (
        !boxValid(probe?.min, probe?.max) ||
        !vector(probe.position) ||
        probe.position.some((v, i) => v < probe.min[i] || v > probe.max[i]) ||
        (probe.blend !== undefined && (!finite(probe.blend) || probe.blend < 0))
      )
        throw new RangeError('Invalid reflection probe: min < max, position inside the box, blend >= 0');
      if (probe.dynamic !== undefined && typeof probe.dynamic !== 'boolean')
        throw new TypeError('Reflection probe dynamic must be a boolean; pass true, false or omit it');
      const blend = probe.blend ?? 0.1 * Math.min(...probe.max.map((v, i) => v - probe.min[i])),
        o = 64 + j * 64;
      [probe.position, probe.min, probe.max].forEach((v, k) =>
        v.forEach((x, i) => view.setFloat32(o + k * 16 + i * 4, x, true)),
      );
      view.setFloat32(o + 12, blend, true);
      view.setUint32(o + 48, texels, true);
      view.setUint32(o + 52, this.resolution, true);
      view.setUint32(o + 56, levelCount(this.resolution), true);
      this.offsets.push(texels);
      texels += levelTexels(this.resolution);
      return { ...probe, position: [...probe.position], min: [...probe.min], max: [...probe.max], blend };
    });
    view.setUint32(48, this.reflections.length, true);
    this.environment = environment;
    this.texelCount = texels;
    this.roundDone = new Uint8Array(this.reflections.length);
    this.active = new Uint8Array(this.reflections.length);
    this.refreshWaiters = this.reflections.map(() => []);
    if (options.live !== undefined) this.setLive(options.live);
  }

  /** GPU bytes of the probe buffer: a 1,088-byte header, 64 B per L2 volume probe (32 B per L1), 8 B per reflection texel. */
  get byteLength(): number {
    return HEADER_BYTES + this.texelCount * 8;
  }
  /** True once a bake has finished (the probes then light receivers). */
  get baked(): boolean {
    return !!this.snapshot;
  }
  /** The live capture settings ({@link setLive}), or null while live capture is off. */
  get live(): Readonly<Required<LiveReflectionOptions>> | null {
    return this.liveOptions;
  }
  /** Reflection probe refreshes completed by live and on-demand capture (each: six faces and a prefilter). */
  get refreshes(): number {
    return this.refreshCount;
  }
  /**
   * Starts live reflection capture with these settings, or stops it with null. While it runs, every frame captures up
   * to `facesPerFrame` cube faces of one reflection probe at a time (refreshed whole before the next starts, chosen by
   * `priority`) and prefilters a probe with its sixth face, so shading switches to complete new radiance at once.
   * Captures draw what the frame draws: core meshes the frame culls (outside the main camera) are missing from them, so
   * render with `culling: false` (`engine.start({culling: false})`) when probes must see the whole scene. The irradiance
   * volume is bake-only. A probe captured live lights receivers from its first refresh, baked or not.
   */
  setLive(options: LiveReflectionOptions | null): void {
    if (options === null) {
      this.liveOptions = null;
      // A live refresh in progress stops too; one that a refresh() call waits for finishes.
      if (!this.jobWaiters.length) this.job = -1;
      return;
    }
    if (typeof options !== 'object') throw new TypeError('LightProbes live options must be an object or null');
    if (!this.reflections.length)
      throw new TypeError('LightProbes live capture needs reflection probes; add some to `reflections`');
    const facesPerFrame = options.facesPerFrame ?? 1,
      priority = options.priority ?? 'nearest',
      samples = powerOfTwo(options.samples, LIVE_SAMPLES, 64, 4096, 'live samples');
    if (!Number.isInteger(facesPerFrame) || facesPerFrame < 1 || facesPerFrame > 6 * MAX_REFLECTION_PROBES)
      throw new RangeError('LightProbes live facesPerFrame must be an integer from 1 to 96');
    if (priority !== 'nearest' && priority !== 'dynamic')
      throw new TypeError("LightProbes live priority must be 'nearest' or 'dynamic'");
    this.liveOptions = Object.freeze({ facesPerFrame, priority, samples });
    this.roundDone.fill(0);
  }
  /**
   * Re-captures reflection probe `index` (every reflection probe when omitted) over the next frames, ahead of the live
   * order and sliced like it (live `facesPerFrame` and `samples`, or one face per frame and 256 samples without live
   * capture, which this does not need). Resolves when the GPU has finished the probe's prefilter; the engine must keep
   * rendering. Rejects if the probes are disposed first.
   */
  async refresh(index?: number): Promise<void> {
    if (this.disposed) throw new MargoError('disposed', `${this.name} is disposed; create new LightProbes`);
    if (!this.engine || !this.gpu)
      throw new MargoError('state', `${this.name} is not attached; engine.use(probes) first`);
    if (index !== undefined && (!Number.isInteger(index) || index < 0 || index >= this.reflections.length))
      throw new RangeError(`Reflection probe index must be an integer from 0 to ${this.reflections.length - 1}`);
    const indices = index === undefined ? this.reflections.map((_, j) => j) : [index];
    await Promise.all(
      indices.map(
        (j) =>
          new Promise<void>((resolve, reject) => {
            this.refreshWaiters[j].push({ resolve, reject });
            if (!this.refreshQueue.includes(j)) this.refreshQueue.push(j);
          }),
      ),
    );
  }
  /** Moves a reflection probe's capture point inside its box. Call `bake()` again to capture the scene there. */
  setReflectionPosition(index: number, position: Vec3): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.reflections.length)
      throw new RangeError('Invalid reflection probe index');
    const probe = this.reflections[index];
    if (!vector(position) || position.some((v, i) => v < probe.min[i] || v > probe.max[i]))
      throw new RangeError('Reflection probe position must be finite and inside the box');
    (probe as ReflectionProbe).position = [...position];
    const view = this.headerView,
      offset = 64 + index * 64;
    for (let i = 0; i < 3; i++) view.setFloat32(offset + i * 4, position[i], true);
    if (this.gpu) this.writeHeader(this.headerBaked);
  }
  protected get device(): GPUDevice | null | undefined {
    if (!this.gpu || this.disposed) return null;
    return this.environment && (this.environment.disposed || this.environment.device !== this.gpu) ? null : this.gpu;
  }
  protected entries(): GPUBindGroupEntry[] {
    if (!this.environment) return this.entry;
    if (!this.cached || this.version !== this.environment.version) {
      this.cached = [...iblBindGroupEntries(this.environment, IBL_BINDING), ...this.entry];
      this.version = this.environment.version;
    }
    return this.cached;
  }
  protected patch(source: string, group: number): string {
    if (source.includes('let margoAmbient='))
      throw new Error(
        `${this.name} replaces EnvironmentLighting: pass {environment} to LightProbes instead of attaching both`,
      );
    const base = source.includes('let base=terrainColor') ? 'base' : 'i.color',
      env = !!this.environment,
      color = source.includes('frame.ambient.rgb') ? '*frame.ambient.rgb' : '';
    const code = source.replace(
      /let linear=([^;]+);/,
      (_, terms: string) =>
        `let margoAmbient=probeShade(i.position,n,v,${base},i.material.y,i.material.x,${env ? 'vec3f(0)' : `${base}*(1.0-i.material.y)*frame.radiance.w${color}`});let linear=${terms.replace('frame.radiance.w', '0.0')}+margoAmbient;`,
    );
    return code === source ? source : shadingWgsl(group, env) + code;
  }
  protected hooks(group: number): PBRHooks {
    // Without an environment the fallback is gltf-pro's own hemisphere ambient (its `ambient(s)`, which the hook replaces).
    const ambient = this.environment
      ? 'vec3f(0)'
      : '(s.base.rgb*(1.0-s.metal)+mix(vec3f(0.04),s.base.rgb,s.metal)*0.5)*mix(vec3f(0.35,0.3,0.25),vec3f(1),clamp(s.n.y*0.5+0.5,0.0,1.0))*f.radiance.w';
    return {
      declarations: shadingWgsl(group, !!this.environment),
      ambient: `probeShade(i.position,s.n,v,s.base.rgb,s.metal,s.roughness,${ambient})*s.occlusion`,
    };
  }
  /** Adds the probe lighting to a model (gltf-pro, materials, terrain); models with a `draw` method are also captured by `bake`. */
  override add(model: LightingTarget): () => void {
    const release = super.add(model),
      drawable = model as unknown as Partial<CaptureModel>;
    if (typeof drawable.draw !== 'function') return release;
    this.captured.add(drawable as CaptureModel);
    return () => {
      this.captured.delete(drawable as CaptureModel);
      release();
    };
  }
  override setup(engine: EngineKernel): void {
    super.setup(engine);
    const device = engineRuntime(engine).gpu;
    if (!device) throw new Error('LightProbes require the WebGPU backend');
    this.allocate(device);
  }
  onDeviceRestored(engine: EngineKernel): void {
    const device = engineRuntime(engine).gpu;
    this.release();
    this.capture = undefined;
    if (device && !this.disposed) {
      this.allocate(device);
      if (this.environment && this.environment.device !== device)
        this.environment.restore(device).catch((error) => engine.onError(error));
    }
  }
  private allocate(device: GPUDevice): void {
    if (this.byteLength > device.limits.maxStorageBufferBindingSize || this.byteLength > device.limits.maxBufferSize)
      throw new RangeError('Light probe buffer exceeds device limit');
    this.buffer = device.createBuffer({
      label: 'light probes',
      size: this.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.gpu = device;
    this.entry = [{ binding: PROBE_BINDING, resource: { buffer: this.buffer } }];
    this.cached = undefined;
    // A restored device gets the last bake back (kept on the CPU), so the lighting survives device loss.
    if (this.snapshot) device.queue.writeBuffer(this.buffer, HEADER_BYTES, this.snapshot as Uint32Array<ArrayBuffer>);
    this.writeHeader(!!this.snapshot);
  }
  private writeHeader(baked: boolean): void {
    this.headerBaked = baked;
    const view = this.headerView;
    if (this.volume) view.setUint32(44, baked ? (this.volume.sh === 2 ? 4 : 2) : 0, true); // vec4u per probe; 0 = unbaked
    for (let j = 0; j < this.reflections.length; j++)
      view.setUint32(64 + j * 64 + 60, +(baked || !!this.active[j]), true);
    this.gpu!.queue.writeBuffer(this.buffer!, 0, view.buffer);
  }
  private release(): void {
    // The GPU radiance is gone: live-captured probes are dark until captured again, and a refresh in progress restarts.
    this.active.fill(0);
    if (this.job !== -1 && this.jobWaiters.length) {
      this.refreshWaiters[this.job].unshift(...this.jobWaiters);
      if (!this.refreshQueue.includes(this.job)) this.refreshQueue.unshift(this.job);
    }
    this.jobWaiters = [];
    this.job = -1;
    const resources = this.captureResources;
    this.captureResources = undefined;
    if (resources) for (const resource of resources.owned) resource.destroy();
    this.buffer?.destroy();
    this.buffer = this.gpu = undefined;
    this.entry = [];
    this.cached = undefined;
    this.capture = undefined;
    this.bakeDevice = undefined;
    this.captureProxy = undefined;
    this.bakeCache.clear();
  }

  override registerPasses(graph: FrameGraph): void {
    super.registerPasses(graph);
    // After every shader patch (order -1), before the main draw (0) and the models' passes, whose per-draw uniform writes must
    // land after the capture's submits.
    graph.add({
      name: this.name + ':capture',
      order: -0.5,
      execute: (c) => {
        if (c.backend !== 'webgpu' || c.device !== this.gpu) return;
        if (this.pending) {
          this.pending = false;
          // The bake re-captures every face into the shared targets: a live refresh in progress starts over.
          this.jobFace = 0;
          this.captureAll(c);
        } else if (this.job !== -1 || this.refreshQueue.length || this.liveOptions) this.captureSlice(c);
      },
    });
  }

  /**
   * Captures the scene from every probe and rebuilds the probe data on the GPU: core meshes plus the added models, lit as
   * the frame lights them, with the environment (or black) where nothing was drawn. Renders `1 + bounces` frames with
   * culling off. Resolves when the GPU has finished; the result is also kept on the CPU (device-loss restore).
   */
  async bake(options: ProbeBakeOptions = {}): Promise<void> {
    const bounces = options.bounces ?? 1;
    if (!Number.isInteger(bounces) || bounces < 1 || bounces > 8)
      throw new RangeError('Light probe bounces must be an integer from 1 to 8');
    const samples = options.samples === undefined ? 0 : powerOfTwo(options.samples, 0, 64, 4096, 'bake samples');
    if (this.disposed || !this.engine || !this.gpu)
      throw new Error(`${this.name} is not attached: engine.use(probes) first`);
    if (this.baking) throw new Error('Light probe bake pending');
    if (this.environment?.device === null) throw new Error('Light probe environment is not ready');
    this.baking = true;
    this.bakeSamples = samples;
    try {
      const engine = this.engine,
        device = this.gpu;
      // One ordinary frame first: shadow maps and other per-frame inputs the capture samples come from the previous frame.
      engine.render({ culling: false });
      if (this.disposed || this.gpu !== device) throw new Error('Light probe bake interrupted');
      for (let b = 0; b < bounces; b++) {
        this.pending = true;
        device.pushErrorScope('validation');
        try {
          engine.render({ culling: false });
        } catch (error) {
          // A synchronous receiver failure must not leave the device's error-scope stack open.
          try {
            await device.popErrorScope();
          } catch {
            /* Keep the original rendering failure. */
          }
          throw error;
        }
        const error = await device.popErrorScope();
        if (error) throw new Error(`Light probe bake failed: ${error.message}`);
        if (this.pending) throw new Error('Light probe capture did not run (the engine did not render)');
        if (this.disposed || this.gpu !== device) throw new Error('Light probe bake interrupted');
        this.writeHeader(true);
      }
      const resources = this.captureResources!;
      let read = resources.read;
      if (!read) {
        read = device.createBuffer({
          size: this.texelCount * 8,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        resources.owned.push(read);
        resources.read = read;
      }
      let mapped = false;
      try {
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(this.buffer!, HEADER_BYTES, read, 0, this.texelCount * 8);
        resources.commands[0] = encoder.finish();
        device.queue.submit(resources.commands);
        await read.mapAsync(GPUMapMode.READ);
        mapped = true;
        if (this.disposed || this.gpu !== device) throw new Error('Light probe bake interrupted');
        const words = new Uint32Array(read.getMappedRange());
        // Public texels have snapshot lifetime. An unobserved private result can
        // reuse its large backing store until the getter actually publishes it.
        if (this.snapshot && !this.snapshotExposed && this.snapshot.length === words.length) this.snapshot.set(words);
        else this.snapshot = words.slice();
        this.snapshotExposed = false;
      } finally {
        if (mapped) read.unmap();
      }
    } finally {
      this.pending = false;
      this.baking = false;
      this.bakeSamples = 0;
    }
  }

  /**
   * Volume irradiance / PI at a world position for a unit normal (multiply by albedo), as the shaders compute it from the
   * last bake: trilinear between the eight nearest probes, float16 values. Null outside the volume or before a bake.
   */
  irradianceAt(position: Vec3, normal: Vec3): [number, number, number] | null {
    const v = this.volume,
      data = this.snapshot;
    if (!v || !data || !vector(position) || !vector(normal)) return null;
    if (position.some((p, i) => p < v.min[i] || p > v.max[i])) return null;
    const k = v.sh === 2 ? 9 : 4,
      n = v.counts,
      out: [number, number, number] = [0, 0, 0],
      coefficients = new Float32Array(27);
    const g = position.map((p, i) =>
        Math.min(n[i] - 1, Math.max(0, ((p - v.min[i]) / (v.max[i] - v.min[i])) * n[i] - 0.5)),
      ),
      i0 = g.map(Math.floor);
    for (let c = 0; c < 8; c++) {
      const corner = [0, 1, 2].map((a) => Math.min(i0[a] + ((c >> a) & 1), n[a] - 1)),
        w = [0, 1, 2].reduce((t, a) => t * ((c >> a) & 1 ? g[a] - i0[a] : 1 - g[a] + i0[a]), 1);
      // The probe's halves start at word (index * vec4u per probe * 4); coefficient j, channel ch is half 3j + ch.
      const o = (corner[0] + n[0] * (corner[1] + n[1] * corner[2])) * (k === 9 ? 16 : 8);
      coefficients.fill(0);
      for (let h = 0; h < k * 3; h++) coefficients[h] = halfPair(data[o + (h >> 1)])[h & 1];
      evaluateSH(coefficients, normal).forEach((x, ch) => {
        out[ch] += x * w;
      });
    }
    return out.map((x) => Math.max(0, x)) as [number, number, number];
  }
  /** @internal The last bake's 32-bit words: volume probes first (each its SH as float16 rgb triples in 16 words for L2, 8 for
   * L1), then each reflection probe's octahedral levels (two words per texel: float16 r, g, b, 0). */
  get texels(): Uint32Array | undefined {
    if (this.snapshot) this.snapshotExposed = true;
    return this.snapshot;
  }
  /** @internal First texel of reflection probe `index`. */
  reflectionOffset(index: number): number {
    return this.offsets[index];
  }

  private resources(device: GPUDevice): CaptureResources {
    if (this.captureResources?.device === device) return this.captureResources;
    const owned: Array<GPUBuffer | GPUTexture> = [];
    const track = <T extends GPUBuffer | GPUTexture>(resource: T): T => {
      owned.push(resource);
      return resource;
    };
    try {
      const frame = track(device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })),
        params = track(device.createBuffer({ size: 256 * 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })),
        sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
        targets = new Map<number, CaptureTarget>();
      const makeTarget = (size: number) => {
        if (targets.has(size)) return;
        const color = track(
            device.createTexture({
              size: [size, size, 6],
              format: 'rgba16float',
              usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            }),
          ),
          depth = track(
            device.createTexture({
              size: [size, size],
              format: 'depth24plus',
              usage: GPUTextureUsage.RENDER_ATTACHMENT,
            }),
          ),
          depthView = depth.createView(),
          colors: GPUTextureView[] = [],
          passes: GPURenderPassDescriptor[] = [];
        for (let face = 0; face < 6; face++) {
          const view = color.createView({ dimension: '2d', baseArrayLayer: face, arrayLayerCount: 1 });
          colors.push(view);
          passes.push({
            colorAttachments: [{ view, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
            depthStencilAttachment: {
              view: depthView,
              depthClearValue: 0,
              depthLoadOp: 'clear',
              depthStoreOp: 'store',
            },
          });
        }
        targets.set(size, {
          color,
          depth,
          array: color.createView({ dimension: '2d-array' }),
          colors,
          depthView,
          passes,
          groups: new Map(),
        });
      };
      if (this.volume) makeTarget(this.volume.resolution ?? 16);
      if (this.reflections.length) makeTarget(this.resolution);
      const cameras: Camera[] = [],
        positions: [number, number, number][] = [],
        aims: [number, number, number][] = [];
      for (let face = 0; face < 6; face++) {
        const position: [number, number, number] = [0.1, 0.1, 0.1],
          target: [number, number, number] = [0.1, 0.1, 0.1],
          camera = new Camera({ fov: 90, position, target, near: this.near, far: this.far });
        camera.up = FACES[face][1];
        cameras.push(camera);
        positions.push(position);
        aims.push(target);
      }
      const bindings: GPUBindGroupEntry[] = [],
        slots = new Uint32Array(64 * 8),
        resources: CaptureResources = {
          device,
          owned,
          frame,
          params,
          sampler,
          targets,
          cameras,
          positions,
          aims,
          bindings,
          frameBinding: { binding: CAPTURE_BINDING, resource: { buffer: frame } },
          values: new Float32Array(32),
          slots,
          floats: new Float32Array(slots.buffer),
          commands: [],
          descriptor: {} as GPURenderPipelineDescriptor,
          depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'greater-equal' },
          multisample: { count: 1 },
          draw: { pipeline: this.capture!.pipeline, bindings, clear: false },
        };
      this.captureResources = resources;
      return resources;
    } catch (error) {
      for (const resource of owned) resource.destroy();
      throw error;
    }
  }
  // This frame's capture setup: the capture pipeline for the frame's shader, the bake pipelines for the filter mode and
  // the pooled resources with this frame's descriptor and bindings. Returns the bake pipelines.
  private prepare(c: Context, samples: number): BakePipelines {
    const device = c.device,
      buffers = c.descriptor.vertex.buffers?.length;
    if (this.capture?.source !== c.shader || this.capture.buffers !== buffers) {
      const shader = captureCore(c.shader),
        module = device.createShaderModule({ code: shader });
      this.capture = {
        source: c.shader,
        buffers,
        pipeline: device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex', buffers: c.descriptor.vertex.buffers },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] },
          depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'greater-equal' },
          primitive: { cullMode: 'none' },
        }),
      };
    }
    const bake = this.bakePipelines(device, samples > 0),
      resources = this.resources(device),
      descriptor = resources.descriptor;
    // Copy this frame's optional descriptor keys, without retaining keys removed by a host between bakes.
    for (const key in descriptor)
      if (!Object.prototype.hasOwnProperty.call(c.descriptor, key))
        delete (descriptor as unknown as Record<string, unknown>)[key];
    Object.assign(descriptor, c.descriptor);
    descriptor.multisample = resources.multisample;
    descriptor.depthStencil = resources.depthStencil;
    resources.bindings.length = c.bindings.length + 1;
    for (let i = 0; i < c.bindings.length; i++) resources.bindings[i] = c.bindings[i];
    resources.bindings[c.bindings.length] = resources.frameBinding;
    resources.draw.pipeline = this.capture!.pipeline;
    const environmentView = this.environment?.specularView,
      environmentParams = this.environment?.paramsBuffer;
    if (resources.environmentView !== environmentView || resources.environmentParams !== environmentParams) {
      for (const target of resources.targets.values()) target.groups.clear();
      resources.environmentView = environmentView;
      resources.environmentParams = environmentParams;
    }
    // The adapter binds native methods once, preserving native receivers and runtime method overrides.
    if (this.captureProxy?.device !== device)
      this.captureProxy = { device, proxy: captureDevice(device, captureLights) };
    if (!resources.view) resources.view = { ...c };
    return bake;
  }
  private captureAll(c: Context): void {
    const samples = this.bakeSamples,
      bake = this.prepare(c, samples),
      resources = this.captureResources!;
    if (this.volume) {
      const volume = this.volume,
        size = volume.resolution ?? 16,
        position = this.volumePosition;
      for (let z = 0; z < volume.counts[2]; z++)
        for (let y = 0; y < volume.counts[1]; y++)
          for (let x = 0; x < volume.counts[0]; x++) {
            position[0] = volume.min[0] + ((x + 0.5) * (volume.max[0] - volume.min[0])) / volume.counts[0];
            position[1] = volume.min[1] + ((y + 0.5) * (volume.max[1] - volume.min[1])) / volume.counts[1];
            position[2] = volume.min[2] + ((z + 0.5) * (volume.max[2] - volume.min[2])) / volume.counts[2];
            for (let face = 0; face < 6; face++)
              this.captureFace(
                c,
                resources,
                bake,
                position,
                size,
                face,
                x + volume.counts[0] * (y + volume.counts[1] * z),
                -1,
                samples,
              );
          }
    }
    for (let index = 0; index < this.reflections.length; index++)
      for (let face = 0; face < 6; face++)
        this.captureFace(
          c,
          resources,
          bake,
          this.reflections[index].position,
          this.resolution,
          face,
          -1,
          index,
          samples,
        );
  }
  // Live and on-demand capture for this frame: up to facesPerFrame cube faces of one reflection probe at a time (they
  // share the capture target), the probe's prefilter with its sixth face. A capture that throws (an unrecognised
  // shader, say) turns live capture off and rejects the waiting refreshes before the error stops the engine, so a
  // restarted engine does not hit it again.
  private captureSlice(c: Context): void {
    const live = this.liveOptions,
      samples = live ? live.samples : LIVE_SAMPLES;
    let bake: BakePipelines | undefined;
    try {
      for (let budget = live ? live.facesPerFrame : 1; budget > 0; budget--) {
        if (this.job === -1 && !this.nextJob(c.camera)) return;
        bake ??= this.prepare(c, samples);
        const face = this.jobFace++;
        this.captureFace(
          c,
          this.captureResources!,
          bake,
          this.jobPosition,
          this.resolution,
          face,
          -1,
          this.job,
          samples,
        );
        if (face === 5) this.finishJob();
      }
    } catch (error) {
      this.liveOptions = null;
      this.job = -1;
      this.rejectRefreshes(error);
      throw error;
    }
  }
  private rejectRefreshes(error: unknown): void {
    const waiting = this.jobWaiters;
    this.jobWaiters = [];
    this.refreshQueue.length = 0;
    for (const waiter of waiting) waiter.reject(error);
    for (let j = 0; j < this.refreshWaiters.length; j++) {
      const list = this.refreshWaiters[j];
      this.refreshWaiters[j] = [];
      for (const waiter of list) waiter.reject(error);
    }
  }
  // Picks the next probe to refresh: a requested one first, then (live) the eligible probe nearest the camera that this
  // round has not refreshed yet, starting a new round when all have been. False when there is nothing to capture.
  private nextJob(camera: Camera): boolean {
    let next = this.refreshQueue.length ? this.refreshQueue.shift()! : -1;
    const live = this.liveOptions;
    if (next === -1 && live) {
      const eye = camera.position,
        dynamicOnly = live.priority === 'dynamic';
      for (let round = 0; round < 2 && next === -1; round++) {
        if (round) this.roundDone.fill(0);
        let best = Infinity;
        for (let j = 0; j < this.reflections.length; j++) {
          const probe = this.reflections[j];
          if (this.roundDone[j] || (dynamicOnly && !probe.dynamic)) continue;
          // Squared distance from the camera to the probe's influence box (0 inside it).
          let d = 0;
          for (let k = 0; k < 3; k++) {
            const below = probe.min[k] - eye[k],
              above = eye[k] - probe.max[k],
              out = below > above ? below : above;
            if (out > 0) d += out * out;
          }
          if (d < best) {
            best = d;
            next = j;
          }
        }
      }
    }
    if (next === -1) return false;
    this.job = next;
    this.jobFace = 0;
    const position = this.reflections[next].position;
    this.jobPosition[0] = position[0];
    this.jobPosition[1] = position[1];
    this.jobPosition[2] = position[2];
    // Promises of refreshes requested before this capture began resolve when it ends.
    if (this.refreshWaiters[next].length) {
      const waiting = this.refreshWaiters[next];
      this.refreshWaiters[next] = this.jobWaiters;
      this.jobWaiters = waiting;
    }
    return true;
  }
  private finishJob(): void {
    const j = this.job,
      device = this.gpu!;
    this.job = -1;
    this.roundDone[j] = 1;
    this.refreshCount++;
    if (!this.active[j]) {
      // Lit from now on: the flag lands after the prefilter's submit, before this frame's shading.
      this.active[j] = 1;
      const at = 64 + j * 64 + 60;
      this.headerView.setUint32(at, 1, true);
      device.queue.writeBuffer(this.buffer!, at, this.header, at, 4);
    }
    if (this.jobWaiters.length) {
      const waiters = this.jobWaiters;
      this.jobWaiters = [];
      device.queue.onSubmittedWorkDone().then(
        () => {
          for (const waiter of waiters) waiter.resolve();
        },
        (error: unknown) => {
          for (const waiter of waiters) waiter.reject(error);
        },
      );
    }
  }
  private captureFace(
    c: Context,
    resources: CaptureResources,
    bake: BakePipelines,
    position: Vec3,
    size: number,
    face: number,
    volumeIndex: number,
    reflectionIndex: number,
    samples: number,
  ): void {
    const device = c.device,
      target = resources.targets.get(size)!,
      lighting = engineRuntime(this.engine!).lighting,
      values = resources.values,
      view = resources.view!;
    const camera = resources.cameras[face],
      eye = resources.positions[face],
      aim = resources.aims[face],
      forward = FACES[face][0];
    for (let axis = 0; axis < 3; axis++) {
      eye[axis] = position[axis];
      aim[axis] = position[axis] + forward[axis];
    }
    // Draw receivers borrow this camera; restore its capture settings before reusing it.
    camera.fov = 90;
    camera.near = this.near;
    camera.far = this.far;
    camera.position = eye;
    camera.target = aim;
    camera.up = FACES[face][1];
    camera.project = undefined;
    camera.cancelFit();
    camera.update(1, true);
    values.set(camera.matrix);
    values.set(position, 16);
    values[19] = 0;
    values.set(lighting.direction, 20);
    values.set(lighting.radiance, 24);
    values.fill(1, 28, 31);
    if (lighting.ambient) values.set(lighting.ambient, 28);
    device.queue.writeBuffer(resources.frame, 0, values);
    const encoder = device.createCommandEncoder(),
      color = target.colors[face],
      depth = target.depthView,
      savedEncoder = c.encoder,
      savedColor = c.color,
      savedDepth = c.depth,
      savedDescriptor = c.descriptor;
    encoder.beginRenderPass(target.passes[face]).end();
    c.encoder = encoder;
    c.color = color;
    c.depth = depth;
    c.descriptor = resources.descriptor;
    resources.draw.pipeline = this.capture!.pipeline;
    resources.draw.bindings = resources.bindings;
    resources.draw.clear = false;
    try {
      c.draw(resources.draw);
    } finally {
      c.encoder = savedEncoder;
      c.color = savedColor;
      c.depth = savedDepth;
      c.descriptor = savedDescriptor;
    }
    if (this.disposed || this.gpu !== device) throw new Error('Light probe bake interrupted');
    for (const key in view)
      if (!Object.prototype.hasOwnProperty.call(c, key)) delete (view as unknown as Record<string, unknown>)[key];
    Object.assign(view, c);
    view.device = this.captureProxy!.proxy;
    view.encoder = encoder;
    view.camera = camera;
    view.color = color;
    view.depth = depth;
    view.descriptor = resources.descriptor;
    view.format = 'rgba16float';
    view.width = view.height = size;
    for (const model of this.captured) {
      model.draw(view, 'beauty', color, depth);
      if (this.disposed || this.gpu !== device) throw new Error('Light probe bake interrupted');
    }
    if (face === 5) this.filterProbe(resources, target, bake, encoder, volumeIndex, reflectionIndex, samples);
    resources.commands[0] = encoder.finish();
    device.queue.submit(resources.commands);
  }
  private captureGroup(
    resources: CaptureResources,
    target: CaptureTarget,
    pipeline: GPUComputePipeline,
    entry: keyof BakePipelines,
    slot: number,
    samples: number,
  ): GPUBindGroup {
    let groups = target.groups.get(pipeline);
    if (!groups) target.groups.set(pipeline, (groups = []));
    let group = groups[slot];
    if (!group) {
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: this.buffer! } },
        { binding: 1, resource: { buffer: resources.params, offset: slot * 256, size: 32 } },
      ];
      if (entry !== 'prefilter' || samples > 0) {
        entries.push({ binding: 2, resource: target.array });
        // Without an environment SH reads textureLoad and the sampler is absent from its static layout.
        if (entry !== 'sh' || this.environment) entries.push({ binding: 3, resource: resources.sampler });
        if (this.environment)
          entries.push(
            { binding: 4, resource: resources.environmentView! },
            { binding: 5, resource: { buffer: resources.environmentParams!, offset: 0, size: 16 } },
          );
      }
      group = resources.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
      groups[slot] = group;
    }
    return group;
  }
  private filterProbe(
    resources: CaptureResources,
    target: CaptureTarget,
    bake: BakePipelines,
    encoder: GPUCommandEncoder,
    volumeIndex: number,
    reflectionIndex: number,
    samples: number,
  ): void {
    const slots = resources.slots,
      floats = resources.floats,
      volume = reflectionIndex === -1,
      count = volume ? 1 : levelCount(this.resolution),
      base = this.offsets[reflectionIndex];
    let offset = volume ? volumeIndex * (this.volume!.sh === 1 ? 2 : 4) : base;
    for (let slot = 0; slot < count; slot++) {
      const at = slot * 64,
        size = volume ? (this.volume!.sh === 1 ? 2 : 4) : this.resolution >> slot;
      slots[at] = offset;
      slots[at + 1] = size;
      slots[at + 2] = !volume && slot > 0 ? base : 0;
      slots[at + 3] = this.resolution;
      floats[at + 4] = !volume && slot > 0 ? slot / (count - 1) : 0;
      slots[at + 5] = volume ? (this.volume!.sh === 1 ? 4 : 9) : slot > 0 ? samples : 0;
      slots[at + 6] = slots[at + 7] = 0;
      if (!volume) offset += size ** 2;
    }
    resources.device.queue.writeBuffer(resources.params, 0, slots, 0, count * 64);
    const pass = encoder.beginComputePass();
    for (let slot = 0; slot < count; slot++) {
      const entry = volume ? 'sh' : slot === 0 ? 'resample' : 'prefilter',
        size = slots[slot * 64 + 1],
        // Sampled prefilter: one 64-thread workgroup per texel; otherwise 8 x 8 texels per workgroup.
        x = volume ? 1 : entry === 'prefilter' && samples > 0 ? size : Math.ceil(size / 8),
        pipeline = bake[entry];
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.captureGroup(resources, target, pipeline, entry, slot, samples));
      pass.dispatchWorkgroups(x, x);
    }
    pass.end();
  }
  private bakePipelines(device: GPUDevice, sampled: boolean): BakePipelines {
    if (this.bakeDevice !== device) {
      this.bakeCache.clear();
      this.bakeDevice = device;
    }
    const cached = this.bakeCache.get(sampled);
    if (cached) return cached;
    const module = device.createShaderModule({ code: bakeWgsl(!!this.environment, sampled) });
    const make = (entryPoint: string) =>
      device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
    const pipelines = { sh: make('sh'), resample: make('resample'), prefilter: make('prefilter') };
    this.bakeCache.set(sampled, pipelines);
    return pipelines;
  }
  override dispose(): void {
    super.dispose();
    this.release();
    this.captured.clear();
    this.liveOptions = null;
    this.rejectRefreshes(new MargoError('disposed', `${this.name} was disposed before the refresh finished`));
  }
}

/** What `bake` captures besides core meshes: anything drawn like a gltf-pro `PBRModel` (materials meshes too). */
interface CaptureModel {
  draw(context: Context, mode: 'beauty', color: GPUTextureView, depth: GPUTextureView): void;
}
const halfPair = (word: number): [number, number] => [halfToFloat(word & 0xffff), halfToFloat(word >>> 16)];
