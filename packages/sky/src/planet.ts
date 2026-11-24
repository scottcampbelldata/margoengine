/// <reference lib="esnext.disposable" preserve="true" />
import { AtmosphereTables, atmosphereCommon, atmosphereLookups, atmosphereParameters, type AtmosphereParameters } from './atmosphere-luts.js';
import { rangeError } from '../../shared/errors.js';
export type { AtmosphereParameters } from './atmosphere-luts.js';
declare const GPUShaderStage: { FRAGMENT: number; VERTEX: number };

/** Hillaire transport in an arbitrary planet frame, kilometres; bind {@link PlanetAtmosphere.group} at group 2. */
export const planetWGSL = `${atmosphereCommon}
@group(2) @binding(0) var<uniform> atmosphere:Atmosphere;
@group(2) @binding(1) var transmittanceTable:texture_2d<f32>;
@group(2) @binding(2) var multipleTable:texture_2d<f32>;
@group(2) @binding(3) var lutSampler:sampler;
${atmosphereLookups}
fn planetPoint(world:vec3f)->vec3f { return (atmosphere.inverse*vec4f(world,1)).xyz; }
fn planetSegment(o:vec3f,d:vec3f,limit:f32)->vec2f {
 let r=atmosphere.radii.y;let b=dot(o,d);let c=dot(o,o)-r*r;let disc=b*b-c;
 if(disc<0.0){return vec2f(0);}
 let h=sqrt(disc);return vec2f(max(0.0,-b-h),min(limit,-b+h));
}
fn planetTransportPoint(p:vec3f,light:vec3f)->vec3f {
 let o=atmosphere.eye.xyz;let delta=p-o;let distance=length(delta);
 if(distance<0.00001){return light*atmosphere.sun.w;}
 let d=delta/distance;let seg=planetSegment(o,d,distance);
 if(seg.y<=seg.x){return light*atmosphere.sun.w;}
 let result=integrateScattering(atmosphere,o+d*seg.x,d,seg.y-seg.x,24u,vec3f(1));
 return (light*result[1]+result[0])*atmosphere.sun.w;
}
fn planetSurface(world:vec3f,albedo:vec3f)->vec3f {
 let raw=planetPoint(world);let r=max(length(raw),atmosphere.radii.x);let p=normalize(raw)*r;let mu=dot(p/r,atmosphere.sun.xyz);
 let delta=p-atmosphere.eye.xyz;let distance=length(delta);let hit=sphereHit(atmosphere.eye.xyz,delta/max(distance,0.00001),atmosphere.radii.x);
 if(hit>=0.0&&hit+0.002<distance){discard;}
 let direct=sunTransmittance(atmosphere,p)*max(mu,0.0);
 let indirect=multipleScattering(atmosphere,max(r,atmosphere.radii.x),mu);
 return planetTransportPoint(p,albedo*(direct+indirect)*atmosphere.radii.z/PI);
}
fn planetAerial(world:vec3f,light:vec3f)->vec3f {
 let o=atmosphere.eye.xyz;let p=planetPoint(world);let delta=p-o;let distance=length(delta);
 let hit=sphereHit(o,delta/max(distance,0.00001),atmosphere.radii.x);
 if(hit>=0.0&&hit+0.001<distance){discard;}
 return planetTransportPoint(p,light);
}
fn planetSky(worldDirection:vec3f)->vec3f {
 let o=atmosphere.eye.xyz;let d=normalize((atmosphere.inverse*vec4f(worldDirection,0)).xyz);
 let seg=planetSegment(o,d,1e9);if(seg.y<=seg.x){return vec3f(0);}
 let ground=sphereHit(o,d,atmosphere.radii.x);let end=select(seg.y,min(seg.y,ground),ground>=0.0);
 if(end<=seg.x){return vec3f(0);}
 let result=integrateScattering(atmosphere,o+d*seg.x,d,end-seg.x,32u,vec3f(1));
 var light=result[0];
 if(ground>=0.0){let p=o+d*ground;let mu=dot(normalize(p),atmosphere.sun.xyz);light+=result[1]*atmosphere.ground.rgb*(sunTransmittance(atmosphere,p)*max(mu,0.0)+multipleScattering(atmosphere,atmosphere.radii.x,mu))*atmosphere.radii.z/PI;}
 return light*atmosphere.sun.w;
}
`.replace(/\bPI\b/g,'PLANET_PI');

/** GPU-owned Hillaire tables and a world-to-planet transform, independent of camera orientation. */
export class PlanetAtmosphere {
  /** Bind-group layout for the shader's group 2. */
  readonly layout: GPUBindGroupLayout;
  /** Bind at group 2 before drawing. */
  readonly group: GPUBindGroup;
  readonly #tables: AtmosphereTables;
  #disposed = false;
  /** Allocates tables; use WebGPU or the WebGL2 compatibility GPUDevice. */
  constructor(device: GPUDevice) {
    if(!device||typeof device.createComputePipeline!=='function')throw rangeError('Planet atmosphere needs a GPUDevice; use WebGPU or webgl2-compat','sky');
    this.#tables = new AtmosphereTables(device);
    this.layout = device.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}},
      {binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{}},
      {binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{}},
      {binding:3,visibility:GPUShaderStage.FRAGMENT,sampler:{}},
    ]});
    this.group = device.createBindGroup({layout:this.layout,entries:[
      {binding:0,resource:{buffer:this.#tables.uniform}},
      {binding:1,resource:this.#tables.transmittance.createView()},
      {binding:2,resource:this.#tables.multiple.createView()},
      {binding:3,resource:this.#tables.sampler},
    ]});
  }
  /** Updates the physical frame and encodes table refresh only when the medium changes. */
  prepare(encoder: GPUCommandEncoder, worldToPlanet: ArrayLike<number>, eye: ArrayLike<number>, sun: ArrayLike<number>, options: { atmosphere?: AtmosphereParameters; illuminance?: number; exposure?: number } = {}): void {
    if(this.#disposed) throw rangeError('Planet atmosphere is disposed; create a new instance','sky');
    const illuminance=options.illuminance??20, exposure=options.exposure??0;
    const a=atmosphereParameters(options.atmosphere);
    if(Math.hypot(...Array.from(eye))<a.bottomRadius)throw rangeError('Planet camera lies below ground; keep the observer outside the planet','sky');
    const shell=a.topRadius-a.bottomRadius;
    const rayleighColumn=-a.rayleighHeight*Math.expm1(-shell/a.rayleighHeight);
    const mieColumn=-a.mieHeight*Math.expm1(-shell/a.mieHeight);
    if(a.topRadius>100000||a.rayleigh.some((value,c)=>value*rayleighColumn+(typeof a.mie==='number'?a.mie:a.mie[c])*mieColumn>6))
      throw rangeError('Planet atmosphere needs radii at most 100000 km and vertical scattering depth at most 6; reduce the medium','sky');
    if(worldToPlanet.length!==16||eye.length!==3||sun.length!==3||
      [...Array.from(worldToPlanet),...Array.from(eye),...Array.from(sun)].some(x=>!Number.isFinite(x)||!Number.isFinite(Math.fround(x)))||
      !(illuminance>=0&&illuminance<=1000000)||!Number.isFinite(exposure)||Math.abs(exposure)>20||!(Math.hypot(...Array.from(sun))>0))
      throw rangeError('Planet frame needs finite transforms, nonzero sun, illuminance 0..1000000 and exposure -20..20','sky');
    const v=this.#tables.values;
    this.#tables.medium(a,1);v.set(Array.from(worldToPlanet),0);v[34]=illuminance;
    const length=Math.hypot(...Array.from(sun));v.set(Array.from(sun,x=>x/length),36);v[39]=2**exposure;v.set(Array.from(eye),40);
    this.#tables.upload(encoder);
  }
  /** Frees tables and uniforms; idempotent. */
  dispose(): void {if(this.#disposed)return;this.#disposed=true;this.#tables.dispose();}
  [Symbol.dispose](): void {this.dispose();}
}
