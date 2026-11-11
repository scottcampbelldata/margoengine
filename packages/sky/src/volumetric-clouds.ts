/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';
import { finiteVector } from '@margoengine/math/validate';
import type { Vec3 } from '@margoengine/math';
import { fullscreen } from '../../shared/gpu.js';
import { displayShader } from '../../shared/display.js';
import { applyView } from '../../shared/view-rect.js';
import { sunlight } from './atmosphere.js';
import { depthWGSL, sceneDepth } from './depth.js';
import { linearHdr } from '../../shared/hdr-format.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { STORAGE_BINDING: number; TEXTURE_BINDING: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** Planet radius in metres, the sky's (6,360 km). */
export const PLANET_RADIUS = 6_360_000;
/**
 * What lights the clouds: `Sky` from `@margoengine/sky` (or `/base`) fits. Its sun, the sun's colour through its
 * atmosphere (turbidity), its backdrop exposure, its sky light (the `reflection` feature's 64 x 32 map, when the sky has
 * it) and its moon light all carry over, so the clouds match the sky they sit in.
 */
export interface VolumetricCloudSky {
  readonly sun: ArrayLike<number>;
  readonly options: { readonly turbidity?: number; readonly exposure?: number };
  readonly reflectionTexture?: GPUTexture | undefined;
  readonly lights?: readonly { readonly direction: ArrayLike<number>; readonly radiance: ArrayLike<number> }[];
}
/** {@link VolumetricClouds} settings, read every frame from `clouds.options`. Lengths are metres, speeds metres per second. */
export interface VolumetricCloudOptions {
  /** The sky that lights the clouds (sun, its colour, exposure, sky light, moon). Without one, `sunDirection` and `ambient` light them. */
  sky?: VolumetricCloudSky;
  /** Direction toward the sun when no `sky` is given; normalized. Default [0.3, 0.6, 0.4]. */
  sunDirection?: Vec3;
  /** Fraction of the sky the layer covers, 0 to 1. Default 0.5; 0 draws nothing. */
  coverage?: number;
  /** Cloud base above the ground, 100 to 20,000. Default 1500. */
  bottom?: number;
  /** Cloud tops, above `bottom`, at most 20,000. Default 4000. */
  top?: number;
  /** Extinction per metre inside the densest cloud, above 0 and at most 1. Default 0.04 (cumulus is about 0.02 to 0.1). */
  density?: number;
  /** Width of one repeat of the cloud shapes, 1000 to 200,000. Default 14,000; the fine erosion repeats eight times as often. */
  scale?: number;
  /** Wind along world X and Z; the clouds drift with it. Default [10, 3]. */
  wind?: readonly [number, number];
  /** How fast the shapes change: the noise field rises through itself at this speed, 0 to 50. Default 3. */
  evolution?: number;
  /** Samples along each view ray inside the layer, 8 to 256. Default 64. */
  steps?: number;
  /** Samples toward the sun from each of them, 1 to 16. Default 6. */
  lightSteps?: number;
  /** Farthest cloud drawn, 1000 to 400,000. Default 80,000; clouds also fade into the haze, to half at 28 km. */
  maxDistance?: number;
  /** Sun radiance on the clouds in the sky's units (the sky's own procedural layer uses 1.6). Default 1.6. */
  sunIntensity?: number;
  /** Sky light from above (`[0]`) and from the horizon (`[1]`), linear RGB, when the sky has no reflection map. Default a clear day's. */
  ambient?: readonly [Vec3, Vec3];
  /**
   * The scene's reversed-Z depth each frame (for example `bloom.depthTexture`). With it the clouds stop at scene
   * surfaces, so a camera that flies into the layer sees cloud in front of nearby objects; without it they draw only
   * over the empty sky.
   */
  depth?: () => GPUTexture | undefined;
}
const defaults = {
  coverage: 0.5,
  bottom: 1500,
  top: 4000,
  density: 0.04,
  scale: 14000,
  evolution: 3,
  steps: 64,
  lightSteps: 6,
  maxDistance: 80000,
  sunIntensity: 1.6,
} as const;
const defaultSun: Vec3 = [0.3, 0.6, 0.4];
const defaultAmbient: readonly [Vec3, Vec3] = [
  [0.22, 0.3, 0.45],
  [0.3, 0.34, 0.4],
];
// Integer hash pcg3d (Jarzynski and Olano 2020, "Hash Functions for GPU Rendering", JCGT 9(3)): exact on every GPU.
const hash = /* wgsl */ `
fn cloudHash3(p:vec3u)->vec3f {
 var v=p*1664525u+1013904223u;
 v.x+=v.y*v.z;v.y+=v.z*v.x;v.z+=v.x*v.y;v^=v>>vec3u(16u);
 v.x+=v.y*v.z;v.y+=v.z*v.x;v.z+=v.x*v.y;
 return vec3f(v)*2.3283064e-10;
}
`;
// Tiling noise volumes, made once on the GPU (Schneider 2015, "The Real-Time Volumetric Cloudscapes of Horizon Zero
// Dawn", SIGGRAPH Advances in Real-Time Rendering): the shape volume holds Perlin-Worley in red and Worley fBm at three
// frequencies in green, blue and alpha; the erosion volume Worley fBm at three frequencies. Worley 1996 ("A Cellular
// Texture Basis Function"): one feature point per cell, value 1 minus the distance to the nearest. Perlin 2002
// ("Improving Noise"): gradients at lattice points, quintic fade. Both lattices wrap at the volume edge, so it tiles.
// Perlin-Worley: the Perlin field remapped from the Worley one's floor (Schneider 2015), billowy and connected.
const generate = /* wgsl */ `${hash}
@group(0) @binding(0) var volume:texture_storage_3d<rgba8unorm,write>;
fn wrapCell(c:vec3i,period:i32)->vec3u {return vec3u(((c%period)+period)%period);}
fn worley(p:vec3f,period:i32)->f32 {
 let cell=vec3i(floor(p));let f=fract(p);var best=3.0;
 for(var z=-1;z<=1;z++){for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
  let o=vec3i(x,y,z);let d=vec3f(o)+cloudHash3(wrapCell(cell+o,period))-f;best=min(best,dot(d,d));
 }}}
 return clamp(1.0-sqrt(best),0.0,1.0);
}
fn worleyFbm(p:vec3f,period:i32)->f32 {return worley(p,period)*0.625+worley(p*2.0,period*2)*0.25+worley(p*4.0,period*4)*0.125;}
fn gradientNoise(p:vec3f,period:i32)->f32 {
 let cell=vec3i(floor(p));let f=fract(p);let u=f*f*f*(f*(f*6.0-15.0)+10.0);var v=array<f32,8>();
 for(var i=0;i<8;i++){
  let o=vec3i(i&1,(i>>1)&1,(i>>2)&1);let g=normalize(cloudHash3(wrapCell(cell+o,period))*2.0-1.0+vec3f(0.0001));
  v[i]=dot(g,f-vec3f(o));
 }
 return mix(mix(mix(v[0],v[1],u.x),mix(v[2],v[3],u.x),u.y),mix(mix(v[4],v[5],u.x),mix(v[6],v[7],u.x),u.y),u.z);
}
fn perlinFbm(p:vec3f,period:i32)->f32 {
 var sum=0.0;var weight=0.5;var q=p;var n=period;
 for(var i=0;i<4;i++){sum+=gradientNoise(q,n)*weight;q*=2.0;n*=2;weight*=0.5;}
 return clamp(sum*1.1+0.5,0.0,1.0);
}
@compute @workgroup_size(4,4,4) fn shape(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(volume);if(any(id>=size)){return;}let p=(vec3f(id)+0.5)/vec3f(size);
 let w=worleyFbm(p*4.0,4);
 let perlinWorley=clamp((perlinFbm(p*4.0,4)-(w-1.0))/(2.0-w),0.0,1.0);
 textureStore(volume,vec3i(id),vec4f(perlinWorley,w,worleyFbm(p*8.0,8),worleyFbm(p*16.0,16)));
}
@compute @workgroup_size(4,4,4) fn erosion(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(volume);if(any(id>=size)){return;}let p=(vec3f(id)+0.5)/vec3f(size);
 textureStore(volume,vec3i(id),vec4f(worleyFbm(p*2.0,2),worleyFbm(p*4.0,4),worleyFbm(p*8.0,8),1));
}
`;
// Height above the planet of a world point (metres), written so f32 keeps it to a fraction of a metre at planet scale.
// Density 0 to 1 of the layer at world point p; erode adds the fine erosion (the view rays), without it the light rays
// use the cheaper base shape.
// Wind moves the field, evolution lifts it through itself, so the shapes drift and change.
// A coarse slice of the same volume (one repeat over six of the shapes) says where the clouds gather. Its median is
// 0.48 and 90% of it lies in 0.29 to 0.67, so the local coverage runs from about half to one and a half times the
// option, and is 0 wherever the option is.
// Perlin-Worley over the Worley fBm (Schneider 2015) lies between 0.67 and 0.87 for 90% of the volume (measured from
// this generator on 4,000 points); stretching that span to 0..1 makes the coverage remap read as the share of sky covered.
// Rounded bases and tapering tops, then the coverage remap (Schneider 2015).
// Wispy erosion at the base, billows higher up (Schneider 2015).
// Optical depth (extinction x metres) from p toward the light l through the layer: n samples, spaced quadratically over
// three quarters of the layer's slant depth, of the base shape only.
/** WGSL of the cloud uniform and its density field, shared with `@margoengine/sky/cloud-shadows`. */
export const cloudField = /* wgsl */ `
struct Clouds {inverse:mat4x4f,eye:vec4f,sun:vec4f,sunColor:vec4f,layer:vec4f,shape:vec4f,wind:vec4f,flags:vec4f,moon:vec4f,moonColor:vec4f}
fn cloudRemap(x:f32,a:f32,b:f32)->f32 {return (x-a)/max(b-a,0.00001);}
fn cloudAltitude(c:Clouds,p:vec3f)->f32 {let R=c.eye.w;return (dot(p,p)+2.0*R*p.y)/(length(vec3f(p.x,p.y+R,p.z))+R);}
fn cloudDensityAt(c:Clouds,shape:texture_3d<f32>,detail:texture_3d<f32>,smp:sampler,p:vec3f,erode:bool)->f32 {
 let h=(cloudAltitude(c,p)-c.layer.x)/(c.layer.y-c.layer.x);if(h<=0.0||h>=1.0){return 0.0;}
 let q=(p+vec3f(c.wind.x,c.wind.z,c.wind.y))*c.shape.x;
 let s=textureSampleLevel(shape,smp,q.xzy,0.0);
 let weather=textureSampleLevel(shape,smp,vec3f(q.xz*0.17,0.37),0.0).g;
 let cover=clamp(c.layer.z*(1.0+2.5*(weather-0.48)),0.0,1.0);
 let low=s.g*0.625+s.b*0.25+s.a*0.125;
 let base=clamp((clamp(cloudRemap(s.r,low-1.0,1.0),0.0,1.0)-0.67)/0.21,0.0,1.0);
 let profile=smoothstep(0.0,0.12,h)*smoothstep(1.0,0.45,h);
 let cloud=clamp(cloudRemap(base*profile,1.0-cover,1.0),0.0,1.0)*cover;
 if(cloud<=0.0||!erode){return cloud;}
 let e=textureSampleLevel(detail,smp,((p+vec3f(c.wind.x,c.wind.z*2.0,c.wind.y)*1.5)*c.shape.y).xzy,0.0).rgb;
 let high=e.r*0.625+e.g*0.25+e.b*0.125;
 return clamp(cloudRemap(cloud,mix(high,1.0-high,clamp(h*4.0,0.0,1.0))*0.35,1.0),0.0,1.0);
}
fn cloudLightDepth(c:Clouds,shape:texture_3d<f32>,detail:texture_3d<f32>,smp:sampler,p:vec3f,l:vec3f,n:u32)->f32 {
 let reach=(c.layer.y-c.layer.x)*0.75/max(l.y,0.25);var od=0.0;var previous=0.0;
 for(var i=0u;i<n;i++){let f=(f32(i)+1.0)/f32(n);let t=reach*f*f;od+=cloudDensityAt(c,shape,detail,smp,p+l*(0.5*(t+previous)),false)*(t-previous);previous=t;}
 return od*c.layer.w;
}
`;
// Roots t of |o + t d| = R + h, o the eye from the planet centre, nearer first; (-1, -1) when the ray misses. The
// quadratic's constant is formed without |o|^2 - (R + h)^2 and its roots by the stable form, as f32 loses both at
// planet scale.
// Henyey-Greenstein, scaled so isotropic scattering is 1; two lobes, forward 0.8 and back -0.3 (weight 0.3), times k.
// The stretch of the view ray inside the layer: from below, above or within it.
// Each pixel starts at its own fraction of a step, so the steps do not band.
// Multiple scattering as octaves of weaker extinction and flatter phase (Wrenninge, Kulla and Lundqvist 2013,
// "Oz: The Great and Volumetric", a = b = c = 0.5), with the powder darkening of Schneider 2015 away from the sun.
// Energy-conserving step (Hillaire 2016): the light scattered over the step, with single-scattering albedo 1. Far
// cloud thins into the haze as the sky's own layer does (half at 28 km).
const shader = (depthBinding: string) => /* wgsl */ `${fullscreen}${hash}${cloudField}${displayShader}
@group(0) @binding(0) var<uniform> clouds:Clouds;
@group(0) @binding(1) var shapeNoise:texture_3d<f32>;
@group(0) @binding(2) var erosionNoise:texture_3d<f32>;
@group(0) @binding(3) var noiseSampler:sampler;
@group(0) @binding(4) var skyLight:texture_2d<f32>;
${depthBinding}
fn cloudShell(d:vec3f,h:f32)->vec2f {
 let e=clouds.eye.xyz;let R=clouds.eye.w;let b=dot(e,d)+R*d.y;let k=dot(e,e)+2.0*R*(e.y-h)-h*h;let disc=b*b-k;
 if(disc<0.0){return vec2f(-1.0);}
 let q=-(b+select(-sqrt(disc),sqrt(disc),b>=0.0));if(abs(q)<1e-6){return vec2f(0.0);}
 let roots=vec2f(q,k/q);return vec2f(min(roots.x,roots.y),max(roots.x,roots.y));
}
fn cloudHG(nu:f32,g:f32)->f32 {return (1.0-g*g)/pow(max(1.0+g*g-2.0*g*nu,0.0001),1.5);}
fn cloudPhaseK(nu:f32,k:f32)->f32 {return mix(cloudHG(nu,0.8*k),cloudHG(nu,-0.3*k),0.3);}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let ndc=vec2f(i.uv.x*2.0-1.0,1.0-i.uv.y*2.0);let far=clouds.inverse*vec4f(ndc,0.000001,1);
 let d=normalize(far.xyz/far.w-clouds.eye.xyz);
 let bottom=clouds.layer.x;let top=clouds.layer.y;let altitude=cloudAltitude(clouds,clouds.eye.xyz);
 var start=0.0;var end=-1.0;
 if(altitude<bottom){
  let up=normalize(vec3f(clouds.eye.x,clouds.eye.y+clouds.eye.w,clouds.eye.z));
  if(dot(d,up)>0.0){start=cloudShell(d,bottom).y;end=cloudShell(d,top).y;}
 } else if(altitude<=top){
  let low=cloudShell(d,bottom);end=select(cloudShell(d,top).y,low.x,low.x>0.0);
 } else {
  let high=cloudShell(d,top);
  if(high.x>0.0){start=high.x;let low=cloudShell(d,bottom);end=select(high.y,low.x,low.x>0.0);}
 }
 end=min(end,start+clouds.shape.z);
 ${depthBinding ? `let z=sceneDepthAt(vec2i(i.position.xy));if(z>0.0){let w=clouds.inverse*vec4f(ndc,z,1);end=min(end,length(w.xyz/w.w-clouds.eye.xyz));}` : ''}
 if(end<=start){discard;}
 let n=u32(clouds.shape.w);let dt=(end-start)/f32(n);let s=clouds.sun.xyz;let nu=dot(d,s);
 let lit=max(clouds.sunColor.r,max(clouds.sunColor.g,clouds.sunColor.b))>0.0;
 let above=textureLoad(skyLight,vec2i(0,0),0).rgb;let horizon=textureLoad(skyLight,vec2i(1,0),0).rgb;
 let moon=clouds.moonColor.rgb*clouds.moon.w*cloudPhaseK(dot(d,clouds.moon.xyz),1.0)*0.15;
 var t=start+dt*cloudHash3(vec3u(vec2u(i.position.xy),7u)).x;
 var transmittance=1.0;var light=vec3f(0);var opacity=0.0;
 for(var k=0u;k<n;k++){
  let p=clouds.eye.xyz+d*t;let density=cloudDensityAt(clouds,shapeNoise,erosionNoise,noiseSampler,p,true);
  if(density>0.0){
   let sigma=density*clouds.layer.w;
   var sun=vec3f(0);
   if(lit){
    let od=cloudLightDepth(clouds,shapeNoise,erosionNoise,noiseSampler,p,s,u32(clouds.wind.w));
    var octaves=0.0;var a=1.0;var b=1.0;var g=1.0;
    for(var o=0;o<3;o++){octaves+=a*cloudPhaseK(nu,g)*exp(-b*od);a*=0.5;b*=0.5;g*=0.5;}
    let powder=mix(1.0-exp(-2.0*od-0.3),1.0,0.5+0.5*nu);
    sun=clouds.sunColor.rgb*clouds.sun.w*octaves*powder;
   }
   let h=clamp((cloudAltitude(clouds,p)-bottom)/(top-bottom),0.0,1.0);
   let source=sun+mix(horizon,above,h)+moon;
   let step=exp(-sigma*dt);let haze=exp(-t/40000.0);
   light+=transmittance*(1.0-step)*source*haze;opacity+=transmittance*(1.0-step)*haze;transmittance*=step;
   if(transmittance<0.01){break;}
  }
  t+=dt;
 }
 if(opacity<=0.0){discard;}
 var color=light*clouds.sunColor.w;
 if(clouds.flags.x>0.5){color=toDisplay(color/opacity)*opacity;}
 return vec4f(color,opacity);
}
`;
// The sky light the clouds receive, from the sky's 64 x 32 reflection map: cosine-weighted over the upper half (light
// on a cloud top) and the horizon band (light on its sides and base), with the sky's exposure taken back out.
const skyLightShader = /* wgsl */ `${cloudField}
@group(0) @binding(0) var<uniform> clouds:Clouds;
@group(0) @binding(1) var map:texture_2d<f32>;
@group(0) @binding(2) var lightOut:texture_storage_2d<rgba32float,write>;
var<workgroup> sums:array<vec4f,128>;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) x:u32){
 var above=vec4f(0);var side=vec4f(0);
 for(var y=0u;y<16u;y++){let theta=(f32(y)+0.5)/32.0*3.14159265;let w=cos(theta)*sin(theta);above+=vec4f(textureLoad(map,vec2u(x,y),0).rgb*w,w);}
 for(var y=14u;y<18u;y++){side+=vec4f(textureLoad(map,vec2u(x,y),0).rgb,1);}
 sums[x]=above;sums[64u+x]=side;workgroupBarrier();
 for(var s=32u;s>0u;s=s>>1u){if(x<s){sums[x]+=sums[x+s];sums[64u+x]+=sums[64u+x+s];}workgroupBarrier();}
 if(x==0u){let unexpose=1.0/clouds.sunColor.w;
  textureStore(lightOut,vec2i(0,0),vec4f(sums[0].rgb/sums[0].w*unexpose,1));textureStore(lightOut,vec2i(1,0),vec4f(sums[64].rgb/sums[64].w*unexpose,1));}
}
`;
/**
 * The two tiling noise volumes of the cloud field (64³ shape, 32³ erosion) and their repeating sampler, filled by compute
 * on the first {@link CloudVolumes.fill}. The generator is deterministic, so every copy holds the same clouds: the
 * `@margoengine/sky/cloud-shadows` effect keeps its own copy and needs nothing from the clouds' GPU objects.
 */
export class CloudVolumes {
  readonly shape: GPUTexture;
  readonly erosion: GPUTexture;
  readonly sampler: GPUSampler;
  private filled = false;
  constructor(device: GPUDevice) {
    const volume = (size: number) =>
      device.createTexture({
        size: [size, size, size],
        dimension: '3d',
        format: 'rgba8unorm',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
    this.shape = volume(64);
    this.erosion = volume(32);
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
    });
  }
  /** Encodes the generation once; later calls do nothing. */
  fill(device: GPUDevice, encoder: GPUCommandEncoder): void {
    if (this.filled) return;
    const code = device.createShaderModule({ code: generate });
    for (const [texture, entryPoint, groups] of [
      [this.shape, 'shape', 16],
      [this.erosion, 'erosion', 8],
    ] as const) {
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: code, entryPoint } }),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: texture.createView() }],
        }),
      );
      pass.dispatchWorkgroups(groups, groups, groups);
      pass.end();
    }
    this.filled = true;
  }
  /** Frees both volumes. */
  dispose(): void {
    this.shape.destroy();
    this.erosion.destroy();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
/**
 * Writes the layer's fields of the `Clouds` uniform ({@link cloudField}) into `v`: the planet radius, base and tops,
 * coverage, density, the noise scales and the drift. Shared by the clouds and their shadows, so both read one field.
 */
export function writeLayer(v: Float32Array, options: VolumetricCloudOptions, drift: ArrayLike<number>): void {
  const scale = options.scale ?? defaults.scale;
  v[19] = PLANET_RADIUS;
  v[28] = options.bottom ?? defaults.bottom;
  v[29] = options.top ?? defaults.top;
  v[30] = options.coverage ?? defaults.coverage;
  v[31] = options.density ?? defaults.density;
  v[32] = 1 / scale;
  v[33] = 8 / scale;
  v[36] = drift[0];
  v[37] = drift[1];
  v[38] = drift[2];
}
const inRange = (value: number, low: number, high: number) => Number.isFinite(value) && value >= low && value <= high;
/**
 * Volumetric clouds: a layer of real 3D cloud between `bottom` and `top`, ray marched through tiling noise volumes,
 * lit by the sun with self-shadowing and multiple scattering, so light breaks through gaps in shafts and the shapes
 * drift and change with the wind. A camera can fly into, through and above the layer.
 * `VolumetricClouds.attach(engine, {sky})`; leave the sky's own `clouds` option off with it.
 * @throws TypeError / RangeError on invalid options; MargoError `'unsupported'` on a WebGL engine, `'disposed'` after
 * `dispose()`, `'state'` when the camera matrix is not invertible.
 */
export class VolumetricClouds implements EnginePlugin {
  readonly name: string = 'sky:volumetric-clouds';
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private volumes?: CloudVolumes;
  private light?: GPUTexture;
  private pipeline?: GPURenderPipeline;
  private bind?: GPUBindGroup;
  private key = '';
  private bound?: GPUTexture | GPUTextureView;
  private lightPipeline?: GPUComputePipeline;
  private lightGroup?: GPUBindGroup;
  private lightSource?: GPUTexture;
  private disposed = false;
  private readonly values = new Float32Array(64);
  private readonly scratch = new Float64Array(52);
  private readonly color = new Float32Array(3);
  private readonly ambientValues = new Float32Array(8);
  /** Metres the shapes have moved along X and Z with the wind, and risen through themselves. */
  readonly drift = new Float64Array(3);
  constructor(readonly options: VolumetricCloudOptions = {}) {
    this.validate();
  }
  static attach(engine: EngineKernel, options: VolumetricCloudOptions = {}): VolumetricClouds {
    const clouds = new VolumetricClouds(options);
    engineRuntime(engine).use(clouds);
    return clouds;
  }
  private validate(): void {
    const o = this.options;
    if (typeof o !== 'object' || o === null) throw new TypeError('VolumetricClouds options must be an object');
    if (o.sky !== undefined && (typeof o.sky !== 'object' || o.sky === null || !(o.sky.sun?.length >= 3)))
      throw new TypeError(
        'VolumetricClouds sky must be a Sky (with a sun direction); pass the sky that lights the clouds',
      );
    if (o.depth !== undefined && typeof o.depth !== 'function')
      throw new TypeError('VolumetricClouds depth must be a function returning the scene depth texture');
    if (o.sunDirection) finiteVector(o.sunDirection, 3, 'VolumetricClouds sunDirection');
    if (o.sunDirection && !(Math.hypot(...o.sunDirection) > 0))
      throw new RangeError('VolumetricClouds sunDirection needs a nonzero length');
    if (o.wind) finiteVector(o.wind, 2, 'VolumetricClouds wind');
    if (o.ambient) for (const c of o.ambient) finiteVector(c, 3, 'VolumetricClouds ambient');
    const bottom = o.bottom ?? defaults.bottom,
      top = o.top ?? defaults.top;
    if (
      !inRange(o.coverage ?? defaults.coverage, 0, 1) ||
      !inRange(bottom, 100, 20000) ||
      !inRange(top, bottom + 1, 20000) ||
      !inRange(o.density ?? defaults.density, 1e-6, 1) ||
      !inRange(o.scale ?? defaults.scale, 1000, 200000) ||
      !inRange(o.evolution ?? defaults.evolution, 0, 50) ||
      !Number.isInteger(o.steps ?? defaults.steps) ||
      !inRange(o.steps ?? defaults.steps, 8, 256) ||
      !Number.isInteger(o.lightSteps ?? defaults.lightSteps) ||
      !inRange(o.lightSteps ?? defaults.lightSteps, 1, 16) ||
      !inRange(o.maxDistance ?? defaults.maxDistance, 1000, 400000) ||
      !inRange(o.sunIntensity ?? defaults.sunIntensity, 0, 1000)
    )
      throw new RangeError(
        'Invalid VolumetricClouds options; keep coverage 0 to 1, bottom 100 to 20000 below top (at most 20000), density above 0 to 1, scale 1000 to 200000, evolution 0 to 50, integer steps 8 to 256 and lightSteps 1 to 16, maxDistance 1000 to 400000 and sunIntensity 0 or more.',
      );
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'VolumetricClouds requires WebGPU; attach new VolumetricClouds to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    const d = engine.gpu;
    this.uniform = d.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.volumes = new CloudVolumes(d);
    this.light = d.createTexture({
      size: [2, 1],
      format: 'rgba32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  }
  registerPasses(graph: FrameGraph): void {
    // After the sky (2) and before its fog (5): the clouds composite over the sky backdrop, and fog over them.
    graph.add({
      name: 'sky:volumetric-clouds',
      order: 3,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  onPreUpdate(delta: number): void {
    this.validate();
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid VolumetricClouds delta; pass a finite delta of 0 or more seconds.');
    const wind = this.options.wind ?? [10, 3],
      scale = this.options.scale ?? defaults.scale;
    // The field repeats every `scale` metres, so the drift wraps there in double precision and stays exact in f32.
    this.drift[0] = (this.drift[0] + wind[0] * delta) % scale;
    this.drift[1] = (this.drift[1] + wind[1] * delta) % scale;
    this.drift[2] = (this.drift[2] + (this.options.evolution ?? defaults.evolution) * delta) % scale;
  }
  private write(c: Context): boolean {
    const o = this.options,
      v = this.values,
      sky = o.sky;
    if (!invertMatrixStable(c.camera.matrix, v.subarray(0, 16), this.scratch))
      throw new MargoError('state', 'Invalid VolumetricClouds camera; give the camera a finite, invertible projection');
    const bottom = o.bottom ?? defaults.bottom,
      top = o.top ?? defaults.top,
      sun = sky?.sun ?? o.sunDirection ?? defaultSun,
      length = Math.hypot(sun[0], sun[1], sun[2]) || 1;
    v.set(c.camera.position, 16);
    writeLayer(v, o, this.drift);
    for (let i = 0; i < 3; i++) v[20 + i] = sun[i] / length;
    v[23] = o.sunIntensity ?? defaults.sunIntensity;
    // The sun's colour through the sky's atmosphere at the middle of the layer: warm and dim low down, 0 once it has set.
    sunlight(v[21], (bottom + top) / 2000, sky?.options.turbidity ?? 2, this.color);
    v.set(this.color, 24);
    v[27] = 2 ** (sky?.options.exposure ?? 0);
    v[34] = o.maxDistance ?? defaults.maxDistance;
    v[35] = o.steps ?? defaults.steps;
    v[39] = o.lightSteps ?? defaults.lightSteps;
    v[40] = +!linearHdr(c.format);
    const moon = sky?.lights?.[1];
    for (let i = 0; i < 4; i++) v[44 + i] = moon ? moon.direction[i] : 0;
    for (let i = 0; i < 3; i++) v[48 + i] = moon ? moon.radiance[i] : 0;
    c.device.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
    return v[30] > 0;
  }
  // The sky light: from the sky's reflection map on the GPU when it has one, else the `ambient` option.
  private skyLight(c: Context): void {
    const map = this.options.sky?.reflectionTexture;
    if (map) {
      if (this.lightSource !== map) {
        this.lightPipeline ??= c.device.createComputePipeline({
          layout: 'auto',
          compute: { module: c.device.createShaderModule({ code: skyLightShader }), entryPoint: 'main' },
        });
        this.lightGroup = c.device.createBindGroup({
          layout: this.lightPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.uniform! } },
            { binding: 1, resource: map.createView() },
            { binding: 2, resource: this.light!.createView() },
          ],
        });
        this.lightSource = map;
      }
      const pass = c.encoder.beginComputePass();
      pass.setPipeline(this.lightPipeline!);
      pass.setBindGroup(0, this.lightGroup!);
      pass.dispatchWorkgroups(1);
      pass.end();
      return;
    }
    const [above, horizon] = this.options.ambient ?? defaultAmbient,
      a = this.ambientValues;
    a.set(above, 0);
    a.set(horizon, 4);
    a[3] = a[7] = 1;
    c.device.queue.writeTexture({ texture: this.light! }, a as Float32Array<ArrayBuffer>, { bytesPerRow: 32 }, [2, 1]);
  }
  private draw(c: Context): void {
    if (!this.uniform) return;
    if (!this.write(c)) return;
    this.volumes!.fill(c.device, c.encoder);
    this.skyLight(c);
    const depth = this.options.depth ? sceneDepth(c, this.options.depth, 'VolumetricClouds') : undefined,
      samples = c.descriptor.multisample?.count ?? 1,
      key = `${c.format}:${samples}:${depth?.samples ?? 0}:${c.descriptor.depthStencil?.format}`;
    if (this.key !== key) {
      const module = c.device.createShaderModule({ code: shader(depth ? depthWGSL(5, depth.samples) : '') });
      this.pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: c.format,
              // Premultiplied: the cloud's light over what is behind it times its transmittance; the alpha stays.
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
              },
            },
          ],
        },
        multisample: c.descriptor.multisample,
        // Without a depth texture the clouds draw only where the scene left the sky (reversed-Z depth still 0).
        ...(depth
          ? {}
          : {
              depthStencil: {
                format: c.descriptor.depthStencil!.format,
                depthCompare: 'greater-equal' as const,
                depthWriteEnabled: false,
              },
            }),
      });
      this.key = key;
      this.bound = undefined;
    }
    if (this.bound !== (depth?.texture ?? this.light)) {
      this.bind = c.device.createBindGroup({
        layout: this.pipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: this.volumes!.shape.createView() },
          { binding: 2, resource: this.volumes!.erosion.createView() },
          { binding: 3, resource: this.volumes!.sampler },
          { binding: 4, resource: this.light!.createView() },
          ...(depth ? [{ binding: 5, resource: depth.resource }] : []),
        ],
      });
      this.bound = depth?.texture ?? this.light;
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      ...(depth ? {} : { depthStencilAttachment: { view: c.depth, depthReadOnly: true, stencilReadOnly: true } }),
    });
    applyView(pass, c);
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.bind!);
    pass.draw(3);
    pass.end();
  }
  private release(): void {
    this.uniform?.destroy();
    this.volumes?.dispose();
    this.light?.destroy();
    this.uniform = this.volumes = this.light = undefined;
    this.pipeline = this.bind = this.lightPipeline = this.lightGroup = undefined;
    this.bound = this.lightSource = undefined;
    this.key = '';
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
