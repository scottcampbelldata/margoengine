/// <reference lib="esnext.disposable" preserve="true" />
import type {EngineKernel} from '@margoengine/core';
import {engineRuntime,type Engine,type EnginePlugin,type FrameGraph,type Vec3} from '@margoengine/core/extension';
import {finiteVector} from '@margoengine/math/validate';
import type {Clustered,ClusteredArea} from './index.js';
import {ltcSize,ltcTable} from './ltc.js';
declare const GPUBufferUsage:{STORAGE:number;COPY_DST:number};
/** A rectangular area light (three.js `RectAreaLight`). It emits from one face, toward `direction`, unless `twoSided`. */
export interface RectAreaLight {
  /** World-space centre. */
  position:Vec3;
  /** The side the light faces (its normal), world space; need not be unit length. */
  direction:Vec3;
  /** Size along the light's right axis, `direction Ã— up` (world units). */
  width:number;
  /** Size along the light's up axis, `up` made perpendicular to `direction` (world units). */
  height:number;
  /** Orientation hint (default [0, 1, 0], or [0, 0, 1] when `direction` is vertical); must not be parallel to `direction`. */
  up?:Vec3;
  /** Linear RGB, multiplied by `intensity` (default [1, 1, 1]). */
  color?:Vec3;
  /** Emitted radiance (luminance, as three.js `RectAreaLight`; default 1). A light of area A matches a clustered point light of intensity `intensity Ã— A` facing the surface. */
  intensity?:number;
  /** Emit from both faces (default false). */
  twoSided?:boolean;
}
/** Options of {@link AreaLights}. */
export interface AreaLightOptions {
  /** The clustered lighting whose light loop also evaluates the area lights (core meshes and every `lights.add()` receiver). */
  lights:Clustered;
}
/** Area lights per {@link AreaLights.setLights} call. */
export const MAX_AREA_LIGHTS=64;
const LIGHT_FLOATS=16,HEADER=4,LUT_OFFSET=(HEADER+MAX_AREA_LIGHTS*LIGHT_FLOATS)*4;
// One storage buffer, no textures: a count, the lights (centre + twoSided, half-width and half-height vectors, radiance) and the
// LTC table as pack2x16float pairs, three u32 per cell, filtered bilinearly by hand (environment's BRDF LUT does the same).
// Each light integrates the quad, clipped to the horizon, under the GGX LTC (specular) and the cosine (diffuse).
const sampling=(group:number)=>/* wgsl */`
struct AreaLight {center:vec4f,right:vec4f,up:vec4f,color:vec4f}
struct AreaLightData {count:vec4u,lights:array<AreaLight,${MAX_AREA_LIGHTS}>,lut:array<u32>}
@group(${group}) @binding(17) var<storage,read> areaLights:AreaLightData;
fn areaLutCell(x:u32,y:u32,k:u32)->vec2f {return unpack2x16float(areaLights.lut[(y*${ltcSize}u+x)*3u+k]);}
fn areaLut(st:vec2f,k:u32)->vec2f {let i=vec2u(st);let j=min(i+1u,vec2u(${ltcSize-1}u));let f=st-vec2f(i);
  return mix(mix(areaLutCell(i.x,i.y,k),areaLutCell(j.x,i.y,k),f.x),mix(areaLutCell(i.x,j.y,k),areaLutCell(j.x,j.y,k),f.x),f.y);}
fn areaUnit(p:vec3f)->vec3f {return p*inverseSqrt(max(dot(p,p),1e-20));}
// z of the edge's vector form factor: cross(a,b).z * theta/sin(theta)/2pi (rational fit, Hill and Heitz 2016).
fn areaEdge(a:vec3f,b:vec3f)->f32 {let x=dot(a,b);let y=abs(x);let v=(0.8543985+(0.4965155+0.0145206*y)*y)/(3.417594+(4.1616724+y)*y);
  return (a.x*b.y-a.y*b.x)*select(0.5*inverseSqrt(max(1-x*x,1e-7))-v,v,x>0);}
// Cosine-weighted integral (form factor) of the quad seen through m, clipped to z>=0: its edges plus the horizon chord.
fn areaIntegral(m:mat3x3f,a:vec3f,b:vec3f,c:vec3f,d:vec3f)->f32 {
  var p=array(m*a,m*b,m*c,m*d);var sum=0.0;var leave=vec3f(0);var enter=vec3f(0);var clipped=false;
  for(var i=0;i<4;i++){var s=p[i];var e=p[(i+1)%4];if(s.z<0&&e.z<0){continue;}
    if(s.z<0){s=mix(s,e,s.z/(s.z-e.z));enter=s;}else if(e.z<0){e=mix(s,e,s.z/(s.z-e.z));leave=e;clipped=true;}
    sum+=areaEdge(areaUnit(s),areaUnit(e));}
  if(clipped){sum+=areaEdge(areaUnit(leave),areaUnit(enter));}
  return sum;
}
fn clusterAreaLighting(position:vec3f,n:vec3f,v:vec3f,nv:f32,base:vec3f,roughness:f32,metal:f32)->vec3f {
  let st=vec2f(clamp(roughness,0.045,1.0),sqrt(1-nv))*${ltcSize-1}.0;let t1=vec4f(areaLut(st,0u),areaLut(st,1u));let t2=areaLut(st,2u);
  var t=v-n*dot(n,v);if(dot(t,t)<1e-8){t=cross(n,select(vec3f(1,0,0),vec3f(0,0,1),abs(n.x)>0.5));}
  let x=normalize(t);let local=transpose(mat3x3f(x,cross(n,x),n));
  let lobe=mat3x3f(vec3f(t1.x,0,t1.y),vec3f(0,1,0),vec3f(t1.z,0,t1.w))*local;
  var specular=vec3f(0);var diffuse=vec3f(0);
  for(var j=0u;j<areaLights.count.x;j++){
    let light=areaLights.lights[j];let c=light.center.xyz-position;let r=light.right.xyz;let u=light.up.xyz;
    var side=1.0;if(dot(cross(r,u),c)>0){if(light.center.w<0.5){continue;}side=-1.0;}
    let a=c-r-u;let b=c-r+u;let e=c+r+u;let d=c+r-u;
    specular+=light.color.rgb*max(side*areaIntegral(lobe,a,b,e,d),0.0);diffuse+=light.color.rgb*max(side*areaIntegral(local,a,b,e,d),0.0);
  }
  let f0=mix(vec3f(0.04),base,metal);
  return (f0*t2.x+(1-f0)*t2.y)*specular+(1-metal)*base*diffuse;
}
`;
/**
 * Rectangular area lights for clustered lighting (three.js `RectAreaLight`), shaded with Linearly Transformed Cosines (Heitz
 * et al. 2016): GGX specular and Lambert diffuse, the quad clipped exactly to each surface's horizon. Core meshes and every
 * receiver of the `lights` (gltf-pro models, materials meshes, terrain) are lit. Every fragment evaluates every area light
 * (no cluster culling: the lights have no range). Without lights it adds nothing to the shaders or the GPU work.
 */
export class AreaLights implements EnginePlugin,ClusteredArea {
  readonly name='clustered:area';readonly lights:Clustered;
  private engine?:Engine;private device?:GPUDevice;private buffer?:GPUBuffer;private entries:GPUBindGroupEntry[]=[];
  private readonly data=new Float32Array(HEADER+MAX_AREA_LIGHTS*LIGHT_FLOATS);private readonly count=new Uint32Array(this.data.buffer,0,1);private dirty=true;private disposed=false;
  constructor(options:AreaLightOptions) {if(!options?.lights||typeof options.lights.setLights!=='function')throw new TypeError('AreaLights needs the Clustered lights');this.lights=options.lights;}
  get owner():Engine|undefined {return this.engine;}
  static attach(instance:EngineKernel,options:AreaLightOptions):AreaLights {const effect=new AreaLights(options);engineRuntime(instance).use(effect);return effect;}
  /** Replaces the area lights (at most {@link MAX_AREA_LIGHTS}); validates every entry before changing anything. An empty list removes the shader code. */
  setLights(lights:readonly RectAreaLight[]):this {
    if(this.disposed||!Array.isArray(lights)||lights.length>MAX_AREA_LIGHTS)throw new RangeError(`Expected at most ${MAX_AREA_LIGHTS} area lights`);
    const packed=lights.map(light=>{
      finiteVector(light.position,3,'Area light position');finiteVector(light.direction,3,'Area light direction');finiteVector(light.color??[1,1,1],3,'Area light color');
      const intensity=light.intensity??1,f=light.direction,length=Math.hypot(...f);
      if(!length||![light.width,light.height,intensity].every(v=>Number.isFinite(Math.fround(v))&&v>=0)||!light.width||!light.height||(light.color??[]).some((v:number)=>v<0)||typeof(light.twoSided??false)!=='boolean')throw new RangeError('Invalid area light size/color/intensity/direction');
      const n=f.map((v:number)=>v/length),hint=light.up??(Math.abs(n[1])>0.999?[0,0,1]:[0,1,0]);if(light.up)finiteVector(light.up,3,'Area light up');
      const r=[hint[1]*n[2]-hint[2]*n[1],hint[2]*n[0]-hint[0]*n[2],hint[0]*n[1]-hint[1]*n[0]],rl=Math.hypot(...r);
      if(!(rl>1e-6*Math.hypot(...hint)))throw new RangeError('Area light up is parallel to its direction');
      const right=r.map((v:number)=>v/rl),up=[n[1]*right[2]-n[2]*right[1],n[2]*right[0]-n[0]*right[2],n[0]*right[1]-n[1]*right[0]],color:ArrayLike<number>=light.color??[1,1,1];
      return [...light.position,light.twoSided?1:0,...right.map(v=>v*light.width/2),0,...up.map(v=>v*light.height/2),0,...Array.from(color,(v:number)=>v*intensity),0];
    });
    packed.forEach((values,i)=>this.data.set(values,HEADER+i*LIGHT_FLOATS));this.count[0]=lights.length;this.dirty=true;this.sync();return this;
  }
  /** @internal ClusteredArea: WGSL defining `clusterAreaLighting`. */
  declarations(group:number):string {return sampling(group);}
  /** @internal ClusteredArea: binding 17 of the lit shader's group. */
  bindings():GPUBindGroupEntry[] {if(!this.buffer||this.disposed)throw new Error('Area lights are not attached');return this.entries;}
  setup(engine:Engine):void {if(this.disposed||!engine.gpu)throw new Error('Area lights require WebGPU and a live effect');this.engine=engine;this.device=engine.gpu;this.dirty=true;this.sync();}
  // The buffer (with the table) and the hook exist only while there are lights, so an empty AreaLights changes no GPU call.
  private sync():void {
    const active=!!this.device&&!this.disposed&&this.count[0]>0;
    if(active&&!this.buffer){const table=ltcTable(),buffer=this.buffer=this.device!.createBuffer({size:LUT_OFFSET+table.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
      this.device!.queue.writeBuffer(buffer,LUT_OFFSET,table as Uint16Array<ArrayBuffer>);this.entries=[{binding:17,resource:{buffer}}];this.dirty=true;}
    const hook=active?this:undefined;if(this.lights.area!==hook)this.lights.area=hook;
  }
  registerPasses(graph:FrameGraph):void {graph.add({name:this.name,order:-3.5,execute:c=>{
    if(c.backend!=='webgpu'||!this.buffer||!this.dirty)return;c.device.queue.writeBuffer(this.buffer,0,this.data as Float32Array<ArrayBuffer>,0,HEADER+this.count[0]*LIGHT_FLOATS);this.dirty=false;
  }});}
  private release():void {if(this.lights.area===this)this.lights.area=undefined;this.buffer?.destroy();this.buffer=undefined;this.entries=[];}
  onDeviceRestored(engine:Engine):void {this.release();this.setup(engine);}
  dispose():void {if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);this.release();this.engine=this.device=undefined;}
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
}
