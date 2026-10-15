/// <reference lib="esnext.disposable" preserve="true" />
import type {EngineKernel} from '@margoengine/core';
import {engineRuntime,type Engine,type EnginePlugin,type FrameGraph,type PassContext,type Vec3} from '@margoengine/core/extension';
import {finiteVector} from '@margoengine/math/validate';
import {viewMatrix} from '../../shared/view.js';
import {orthographic} from '../../shared/projection.js';
import {cullingShader,clusteredSampling} from './shader.js';
export {clusteredSampling} from './shader.js';
declare const GPUBufferUsage:{UNIFORM:number;STORAGE:number;COPY_DST:number;COPY_SRC:number};
export interface PointLight {position:Vec3;range:number;color?:Vec3;intensity?:number;/** Casts shadows when \LocalShadows\ (\@margoengine/clustered/shadows\) is attached; the first \maxLights\ such lights get maps. */castShadow?:boolean}
export interface SpotLight extends PointLight {direction:Vec3;outerAngle:number;innerAngle?:number}
export interface ClusteredOptions {grid?:readonly [number,number,number]}
export interface ClusteredReceiver {addLighting(effect:Clustered):()=>void}
/** Per-light shadow term composed into the light loop (\LocalShadows\ from \@margoengine/clustered/shadows\). */
export interface ClusteredShadow {declarations(group:number):string;bindings():GPUBindGroupEntry[]}
/** Extra lights added by the light loop (`AreaLights` from `@margoengine/clustered/area`): `declarations` defines
 * `clusterAreaLighting(position,n,v,nv,base,roughness,metal)->vec3f`, whose result joins the local lights' sum. */
export interface ClusteredArea {declarations(group:number):string;bindings():GPUBindGroupEntry[]}
export class Clustered implements EnginePlugin {
  readonly name='clustered';readonly grid:readonly [number,number,number];
  /** Multiplies all local lights; a callback is sampled each render. */
  intensityScale:number|(()=>number)=1;
  private engine?:Engine;private device?:GPUDevice;private uniform?:GPUBuffer;private lights?:GPUBuffer;private pipeline?:GPUComputePipeline;private group?:GPUBindGroup;
  private counts?:GPUBuffer;private indices?:GPUBuffer;private entries:GPUBindGroupEntry[]=[];private receivers=new Map<ClusteredReceiver,()=>void>();
  private readonly values=new Float32Array(32);private readonly ints=new Uint32Array(this.values.buffer);private readonly data=new Float32Array(1024*16);private lightCount=0;private dirty=true;private disposed=false;
  private readonly view=this.values.subarray(0,16);
  private readonly shaders=new Map<number,Map<string,string>>();private readonly hooks=new Map<number,{declarations:string;light:string}>();
  private shadowHook?:ClusteredShadow;private areaHook?:ClusteredArea;private joined?:[GPUBindGroupEntry[]|undefined,GPUBindGroupEntry[]|undefined,GPUBindGroupEntry[],GPUBindGroupEntry[]];
  /** Set by \LocalShadows\; changing it recomposes the shaders. */
  get shadow():ClusteredShadow|undefined {return this.shadowHook;}
  set shadow(hook:ClusteredShadow|undefined) {this.shadowHook=hook;this.shaders.clear();this.hooks.clear();}
  /** Set by `AreaLights` while it has lights; changing it recomposes the shaders. */
  get area():ClusteredArea|undefined {return this.areaHook;}
  set area(hook:ClusteredArea|undefined) {this.areaHook=hook;this.shaders.clear();this.hooks.clear();}
  constructor(options:ClusteredOptions={}) {const grid=options.grid??[16,9,24];if(grid.length!==3||grid.some(v=>!Number.isInteger(v)||v<1||v>128)||grid.reduce((a,b)=>a*b,1)>32768)throw new RangeError('Invalid cluster grid');this.grid=[...grid] as [number,number,number];}
  get owner():Engine|undefined {return this.engine;}
  static attach(instance:EngineKernel,options:ClusteredOptions={}):Clustered {const effect=new Clustered(options);engineRuntime(instance).use(effect);return effect;}
  setLights(lights:readonly (PointLight|SpotLight)[]):this {
    if(this.disposed||!Array.isArray(lights)||lights.length>1024)throw new RangeError('Expected at most 1,024 lights');
    for(const light of lights){finiteVector(light.position,3,'Light position');finiteVector(light.color??[1,1,1],3,'Light color');
      if(!Number.isFinite(Math.fround(light.range))||light.range<=0||!Number.isFinite(Math.fround(light.intensity??1))||(light.intensity??1)<0||(light.color??[]).some((v:number)=>v<0))throw new RangeError('Invalid light range/color/intensity');
      if('direction' in light){finiteVector(light.direction,3,'Spot direction');if(!Math.hypot(...light.direction)||!Number.isFinite(light.outerAngle)||light.outerAngle<=0||light.outerAngle>=Math.PI/2||!Number.isFinite(light.innerAngle??0)||(light.innerAngle??0)<0||(light.innerAngle??0)>light.outerAngle)throw new RangeError('Invalid spot cone');}
    }
    let shadows=0;lights.forEach((light,i)=>{const offset=i*16,slot=light.castShadow?++shadows:0;this.data.set([...light.position,light.range,...light.color??[1,1,1],light.intensity??1],offset);
      if('direction' in light){const length=Math.hypot(...light.direction);this.data.set([...light.direction.map((v:number)=>v/length),Math.cos(light.outerAngle),Math.cos(light.innerAngle??0),1,slot,0],offset+8);}else{this.data.fill(0,offset+8,offset+16);this.data[offset+14]=slot;}
    });this.lightCount=lights.length;this.dirty=true;return this;
  }
  add(receiver:ClusteredReceiver):()=>void {if(this.disposed||!receiver||typeof receiver.addLighting!=='function'||this.receivers.has(receiver))throw new TypeError('Invalid or duplicate clustered receiver');const remove=receiver.addLighting(this);this.receivers.set(receiver,remove);return()=>{if(this.receivers.delete(receiver))remove();};}
  bindings():GPUBindGroupEntry[] {if(!this.uniform||this.disposed)throw new Error('Clustered lighting is not attached');const shadow=this.shadowHook?.bindings(),area=this.areaHook?.bindings();if(!shadow&&!area)return this.entries;
    let j=this.joined;if(!j||j[0]!==shadow||j[1]!==area||j[2]!==this.entries)this.joined=j=[shadow,area,this.entries,[...this.entries,...shadow??[],...area??[]]];return j[3];}
  shader(source:string,group=0):string {
    let cache=this.shaders.get(group);const cached=cache?.get(source);if(cached)return cached;
    const base=source.includes('let base=terrainColor')?'base':'i.color';
    const code=source.replace(/let linear=([^;]+);/,`let linear=$1+clusterLighting(i.clip.xy,i.position,n,frame.eye.xyz,${base},i.material.x,i.material.y);`);
    if(code===source)throw new Error('Clustered lighting requires the standard PBR shader');const output=clusteredSampling(group,this.shadowHook,this.areaHook)+code;if(!cache){cache=new Map();this.shaders.set(group,cache);}cache.set(source,output);return output;
  }
  /** gltf-pro lighting hooks: local lights add to the surface's light. */
  pbr(group:number):{declarations:string;light:string} {let hooks=this.hooks.get(group);if(!hooks)this.hooks.set(group,hooks={declarations:clusteredSampling(group,this.shadowHook,this.areaHook),light:'clusterLighting(i.clip.xy,i.position,s.n,f.eye.xyz,s.base.rgb,s.roughness,s.metal)'});return hooks;}
  setup(engine:Engine):void {
    if(this.disposed||!engine.gpu)throw new Error('Clustered lighting requires WebGPU and a live effect');this.engine=engine;this.device=engine.gpu;
    const count=this.grid[0]*this.grid[1]*this.grid[2],bytes=count*1024*4;
    if(bytes>this.device.limits.maxStorageBufferBindingSize||bytes>this.device.limits.maxBufferSize)throw new RangeError('Cluster index list exceeds device limit');
    const buffer=(size:number,usage:number)=>this.device!.createBuffer({size,usage:usage|GPUBufferUsage.COPY_DST});
    this.uniform=buffer(128,GPUBufferUsage.UNIFORM);this.lights=buffer(this.data.byteLength,GPUBufferUsage.STORAGE);this.counts=buffer(count*4,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);this.indices=buffer(bytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
    this.pipeline=this.device.createComputePipeline({layout:'auto',compute:{module:this.device.createShaderModule({code:cullingShader}),entryPoint:'main'}});
    this.entries=[this.uniform,this.lights,this.counts,this.indices].map((buffer,i)=>({binding:i+4,resource:{buffer}}));this.group=this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:this.entries});this.dirty=true;
  }
  registerPasses(graph:FrameGraph):void {graph.add({name:this.name,order:-3,execute:c=>{if(c.backend!=='webgpu')return;
    const intensity=typeof this.intensityScale==='function'?this.intensityScale():this.intensityScale;
    if(typeof intensity!=='number'||!Number.isFinite(Math.fround(intensity))||intensity<0)throw new RangeError('Invalid clustered intensity scale');
    for(const [receiver,remove] of this.receivers)if('disposed' in receiver&&receiver.disposed){remove();this.receivers.delete(receiver);}
    if(this.dirty){if(this.lightCount)c.device.queue.writeBuffer(this.lights!,0,this.data as Float32Array<ArrayBuffer>,0,this.lightCount*16);this.dirty=false;}
    viewMatrix(this.view,c.camera);for(let i=0;i<3;i++)this.ints[16+i]=this.grid[i];this.ints[19]=intensity===0?0:this.lightCount;
    const values=this.values;values[20]=c.width;values[21]=c.height;values[22]=Math.tan(c.camera.fov*Math.PI/360);values[23]=c.width/c.height;values[24]=c.camera.near;values[25]=c.camera.far;values[26]=values[27]=0;values[28]=intensity;values[29]=values[30]=values[31]=0;
    // Orthographic clip matrix (e.g. @margoengine/cameras): view-space half extents per NDC unit, signed near/far, NDC offset.
    const o=orthographic(c.camera.matrix,c.camera.position);if(o){values[22]=1/o.sy;values[23]=o.sy/o.sx;values[24]=o.near;values[25]=o.far;values[29]=o.ox;values[30]=o.oy;values[31]=1;}
    // Map jittered fragments back to the unjittered culling grid using the projection's screen offset.
    const m=c.camera.matrix,v=this.values;v[26]=-0.5*(m[0]*v[2]+m[4]*v[6]+m[8]*v[10]);v[27]=0.5*(m[1]*v[2]+m[5]*v[6]+m[9]*v[10]);c.device.queue.writeBuffer(this.uniform!,0,v as Float32Array<ArrayBuffer>);
    const pass=c.encoder.beginComputePass();pass.setPipeline(this.pipeline!);pass.setBindGroup(0,this.group!);pass.dispatchWorkgroups(Math.ceil(this.grid[0]*this.grid[1]*this.grid[2]/64));pass.end();c.shader=this.shader(c.shader);c.bindings.push(...this.bindings());
  }});}
  /** GPU buffers for diagnostics and custom forward materials; no production readback. */
  get lightLists():{counts:GPUBuffer;indices:GPUBuffer} {if(!this.counts||!this.indices)throw new Error('Clustered lighting is not attached');return {counts:this.counts,indices:this.indices};}
  private release():void {for(const buffer of [this.uniform,this.lights,this.counts,this.indices])buffer?.destroy();this.uniform=this.lights=this.counts=this.indices=undefined;this.pipeline=undefined;this.group=undefined;this.entries=[];this.shaders.clear();}
  onDeviceRestored(engine:Engine):void {this.release();this.setup(engine);}
  dispose():void {if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);for(const remove of this.receivers.values())remove();this.receivers.clear();this.release();this.engine=this.device=undefined;}
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
  /** @deprecated Use dispose(); kept as an alias until 1.0. */
  destroy():void {this.dispose();}
}
