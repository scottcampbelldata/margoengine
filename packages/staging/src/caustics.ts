/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph, type PassContext, type Vec3 } from '@margoengine/core/extension';
import type { GPUMeshBVH } from '@margoengine/bvh/gpu';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { applyView } from '../../shared/view-rect.js';
import { unitLight } from '../../shared/unit-light.js';
import { causticPhotons, causticFloor } from './caustics-shader.js';
declare const GPUBufferUsage: {STORAGE:number;UNIFORM:number;COPY_DST:number;COPY_SRC:number;MAP_READ:number};
declare const GPUMapMode: {READ:number};

/** World-space indexed triangles of one optical medium, outward wound for closed products. */
export interface CausticGeometry {
  /** Finite xyz positions. Copied before attachment/replacement awaits. */
  positions: Float32Array;
  /** Three vertex indices per triangle. */
  indices: Uint32Array;
  /** Optional xyz shading normals, one per vertex; zero selects the geometric normal. */
  normals?: Float32Array;
}
/** A photon map and additive horizontal floor catcher; colours/intensity apply at presentation. */
export interface ProductCausticsOptions {
  /** Static world-space snapshot; call setGeometry after motion/deformation. */
  geometry: CausticGeometry;
  /** Floor centre. Default [0,0,0]. */
  position?: Vec3;
  /** Floor/emission footprint width and depth, each 0.01..1e4. Default 4. */
  size?: number | readonly [number,number];
  /** Emission plane height above the floor, 0.01..1e4; above the whole product. Default 3. */
  height?: number;
  /** Direction toward a distant source; must have positive Y. Default [0,1,0]. */
  lightDirection?: Vec3;
  /** Optional point source above the emission plane by at least half its largest side. Overrides direction. */
  lightPosition?: Vec3;
  /** Air-to-medium index, 1..3. Default 1.5 (glass); water uses 1.333. */
  ior?: number;
  /** Exit medium-to-air index, 1..3. Default ior. */
  backsideIOR?: number;
  /** Trace exit boundaries and internal total reflections. False is one open water interface. Default true. */
  backside?: boolean;
  /** Boundary event budget, integer 1..32. Default 8. Truncated paths deposit nothing. */
  maxEvents?: number;
  /** Photon grid side, integer 16..512. Default 128; squared is paths per update. */
  photonSide?: number;
  /** Floor map side, integer 16..512. Default 128. */
  resolution?: number;
  /** Updates to render, integer 1..1024 or Infinity. Default 1; invalidate restarts. */
  frames?: number;
  /** Reconstruction radius in world units, 0..largest footprint side. Default largest side / resolution. */
  worldRadius?: number;
  /** Nonnegative display multiplier, at most 1000. Default 1. */
  intensity?: number;
  /** Linear tint in 0..1. Default white. */
  color?: Vec3;
  /** Cancels preparation. Not retained in the live options. */
  signal?: AbortSignal;
}
type Context=Extract<PassContext,{backend:'webgpu'}>;
type Resources={device:GPUDevice;tree:GPUMeshBVH;indices:GPUBuffer;normals:GPUBuffer;uniform:GPUBuffer;energy:GPUBuffer;pipeline:GPUComputePipeline;group:GPUBindGroup;mapSide:number;maxY:number;code:string};
const vector=(v:unknown):v is Vec3=>Array.isArray(v)&&v.length===3&&[0,1,2].every(i=>Number.isFinite(v[i])&&Math.abs(v[i])<=1e6);
function snapshot(g:CausticGeometry):CausticGeometry{
  if(!g||!(g.positions instanceof Float32Array)||!(g.indices instanceof Uint32Array)||g.positions.length%3||!g.positions.length||g.indices.length%3||!g.indices.length||
    !g.positions.every(v=>Number.isFinite(v)&&Math.abs(v)<=1e6)||g.indices.some(i=>i>=g.positions.length/3)||g.positions.length/3>1e6||g.indices.length/3>1e6||
    (g.normals!==undefined&&(!(g.normals instanceof Float32Array)||g.normals.length!==g.positions.length||!g.normals.every(Number.isFinite))))
    throw typeError('Invalid caustic geometry; pass finite indexed xyz triangles and optional matching normals, up to one million vertices/triangles','arguments');
  return {positions:g.positions.slice(),indices:g.indices.slice(),normals:g.normals?.slice()};
}
function release(r:Resources|undefined):void{
  if(!r)return;r.tree.dispose();for(const b of [r.indices,r.normals,r.uniform,r.energy])b.destroy();
}
async function wait<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T>{
  signal?.throwIfAborted();if(!signal)return promise;
  let abort:()=>void=()=>{};
  const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([promise,cancelled]);}finally{signal.removeEventListener('abort',abort);}
}

/** GPU BVH photon refraction for glass/water products and an additive floor, independent of camera visibility. */
export class ProductCaustics implements EnginePlugin {
  readonly name='product-caustics';
  /** Live settings; source geometry is an owned snapshot. */
  readonly options: Omit<ProductCausticsOptions,'signal'>;
  private engine?:Engine;
  private source:CausticGeometry;
  private resources?:Resources;
  private pending:Promise<void>=Promise.resolve();
  private disposed=false;
  private count=0;
  private key='';
  private floor?:GPURenderPipeline;
  private floorGroup?:GPUBindGroup;
  private floorKey='';
  private values=new Float32Array(40);
  private constructor(options:ProductCausticsOptions){
    if(!options||typeof options!=='object')throw typeError('ProductCaustics needs geometry; pass an options object','arguments');
    const {signal:_signal,geometry,...rest}=options;this.source=snapshot(geometry);this.options={...structuredClone(rest),geometry:this.source};this.settings();
  }
  /** Snapshot, attach and prepare the lazy GPU BVH transport. Native preview refuses explicitly. */
  static async attach(engine:EngineKernel,options:ProductCausticsOptions):Promise<ProductCaustics>{
    options?.signal?.throwIfAborted();const value=new ProductCaustics(options);
    try{engineRuntime(engine).use(value);await wait(value.ready,options.signal);return value;}catch(error){value.dispose();throw error;}
  }
  /** Current GPU preparation, including device restoration. */
  get ready():Promise<void>{return this.pending;}
  /** Deterministic work count and cached map state. */
  get stats():{updates:number;photonsPerUpdate:number;resolution:number}{const s=this.settings();return {updates:this.count,photonsPerUpdate:s.side*s.side,resolution:s.resolution};}
  setup(engine:Engine):void{
    if(!engine.gpu)throw fault('unsupported','ProductCaustics requires WebGPU or the full WebGL2 compatibility layer; select one of those backends');
    this.engine=engine;this.pending=this.prepare(this.source);
  }
  registerPasses(graph:FrameGraph):void{graph.add({name:this.name,order:1.5,execute:c=>{if(c.backend==='webgpu')this.draw(c);}});}
  /** Rebuild an owned geometry snapshot atomically; caller updates may be queued in order. */
  setGeometry(geometry:CausticGeometry,options:{signal?:AbortSignal}={}):Promise<void>{
    if(this.disposed)return Promise.reject(fault('disposed','ProductCaustics is disposed; attach a new catcher'));
    let source:CausticGeometry;try{options.signal?.throwIfAborted();source=snapshot(geometry);}catch(error){return Promise.reject(error);}
    const update=this.pending.catch(()=>{}).then(()=>this.prepare(source,options.signal));this.pending=update;return update;
  }
  /** Recompute a cached map after changes; camera motion does not reset it. */
  invalidate():void{if(this.disposed)throw fault('disposed','ProductCaustics is disposed; attach a new catcher');this.count=0;this.key='';}
  onDeviceRestored(_engine:Engine):void{release(this.resources);this.resources=undefined;this.floor=this.floorGroup=undefined;this.floorKey='';this.invalidate();this.pending=this.prepare(this.source);}
  /** Read normalized irradiance from the current photon map. Render a frame after ready first. */
  async readMap(options:{signal?:AbortSignal}={}):Promise<{resolution:number;irradiance:Float32Array}>{
    await wait(this.pending,options.signal);if(this.disposed||!this.resources)throw fault('disposed','ProductCaustics is disposed; attach a new catcher');
    const r=this.resources,n=r.mapSide,buffer=r.device.createBuffer({size:n*n*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    try{const encoder=r.device.createCommandEncoder();encoder.copyBufferToBuffer(r.energy,0,buffer,0,n*n*4);r.device.queue.submit([encoder.finish()]);
      await wait(buffer.mapAsync(GPUMapMode.READ),options.signal);const words=new Uint32Array(buffer.getMappedRange()),result=Float32Array.from(words,v=>v/1073741824*n*n*(this.options.lightPosition?1/this.values[36]:1));
      return {resolution:n,irradiance:result};
    }finally{buffer.destroy();}
  }
  /** Detach and free the BVH/map/receiver; pending preparations cannot resurrect the effect. */
  dispose():void{if(this.disposed)return;this.disposed=true;release(this.resources);this.resources=undefined;this.floor=this.floorGroup=undefined;this.engine?.sceneOf(this)?.removePlugin(this.name);}
  [Symbol.dispose]():void{this.dispose();}
  private settings(){
    const o=this.options,p=o.position??[0,0,0],size=typeof o.size==='number'?[o.size,o.size]:o.size??[4,4],height=o.height??3,
      d=o.lightDirection??[0,1,0],side=o.photonSide??128,resolution=o.resolution??128,ior=o.ior??1.5,exit=o.backsideIOR??ior,frames=o.frames??1,radius=o.worldRadius??Math.max(...size)/resolution;
    if(!vector(p)||!Array.isArray(size)||size.length!==2||![0,1].every(i=>Number.isFinite(size[i])&&size[i]>=.01&&size[i]<=1e4)||
      !Number.isFinite(height)||height<.01||height>1e4||!vector(d)||!(d[1]>0)||
      ![side,resolution].every(v=>Number.isInteger(v)&&v>=16&&v<=512)||![ior,exit].every(v=>Number.isFinite(v)&&v>=1&&v<=3)||
      !(frames===Infinity||(Number.isInteger(frames)&&frames>=1&&frames<=1024))||!Number.isInteger(o.maxEvents??8)||(o.maxEvents??8)<1||(o.maxEvents??8)>32||
      !Number.isFinite(radius)||radius<0||radius>Math.max(...size)||!Number.isFinite(o.intensity??1)||(o.intensity??1)<0||(o.intensity??1)>1000||
      !vector(o.color??[1,1,1])||(o.color??[1,1,1]).some(v=>v<0||v>1)||
      (o.lightPosition!==undefined&&(!vector(o.lightPosition)||o.lightPosition[1]-p[1]-height<Math.max(...size)/2)))
      throw rangeError('Invalid product caustics settings; use bounded finite floor/light/IOR values, map sides 16..512 and a point source sufficiently above the emission plane','arguments');
    const scale=Math.max(...d.map(Math.abs)),unit=d.map(v=>v/scale),length=Math.hypot(...unit);
    return {p,size,height,d:unit.map(v=>v/length),side,resolution,ior,exit,frames,radius};
  }
  private async prepare(source:CausticGeometry,signal?:AbortSignal):Promise<void>{
    const device=this.engine!.gpu!,s=this.settings();signal?.throwIfAborted();
    if(source.positions.some((v,i)=>i%3===1&&v>=Math.fround(Math.fround(s.p[1])+Math.fround(s.height))))throw rangeError('Emission plane intersects the product; increase height above every source vertex','arguments');
    const [{MeshBVH},{GPUMeshBVH,bvhWGSL}]=await Promise.all([import('@margoengine/bvh/tree'),import('@margoengine/bvh/gpu')]);
    signal?.throwIfAborted();const tree=await GPUMeshBVH.create(device,MeshBVH.build(source));
    const buffers:GPUBuffer[]=[];let installed=false;
    try{
      const upload=(data:Uint32Array|Float32Array)=>{const b=device.createBuffer({size:Math.max(4,data.byteLength),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});buffers.push(b);device.queue.writeBuffer(b,0,data as BufferSource);return b;};
      const indices=upload(source.indices),normals=upload(source.normals??new Float32Array(source.positions.length)),
        uniform=device.createBuffer({size:160,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),energy=device.createBuffer({size:s.resolution*s.resolution*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});buffers.push(uniform,energy);
      const code=causticPhotons(bvhWGSL()),pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:'main'}});
      signal?.throwIfAborted();if(this.disposed)throw fault('disposed','ProductCaustics was disposed during preparation; attach a new catcher');
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[...tree.bindings(),{binding:5,resource:{buffer:indices}},{binding:6,resource:{buffer:normals}},{binding:7,resource:{buffer:uniform}},{binding:8,resource:{buffer:energy}}]});
      release(this.resources);this.resources={device,tree,indices,normals,uniform,energy,pipeline,group,mapSide:s.resolution,maxY:tree.bvh!.nodeBounds[4],code};this.source=source;this.options.geometry=source;this.floor=this.floorGroup=undefined;this.floorKey='';this.invalidate();installed=true;
    }finally{if(!installed){tree.dispose();for(const buffer of buffers)buffer.destroy();}}
  }
  private draw(c:Context):void{
    const r=this.resources;if(this.disposed||!r||r.device!==c.device)return;
    const s=this.settings(),o=this.options;
    if(Math.fround(Math.fround(s.p[1])+Math.fround(s.height))<=r.maxY)throw rangeError('Emission plane intersects the product; increase height above every source vertex','arguments');
    if(s.resolution!==r.mapSide)throw rangeError('Caustic resolution is fixed per geometry preparation; use setGeometry after changing it','arguments');
    const v=this.values;v.set(c.camera.matrix);v.set([...s.p,s.height],16);v.set([...s.size,s.resolution,s.side],20);if(o.lightPosition)v.set([...o.lightPosition,1],24);else unitLight(v,24,[...s.d,0]);v.set([s.ior,s.exit,o.backside===false?0:1,o.maxEvents??8],28);
    v.set([...(o.color??[1,1,1]).map(x=>x*(o.intensity??1)),0],32);v.set([Math.max(...s.size)**2/4,s.radius,Math.max(...s.size)*1e-5,0],36);
    const key=Array.from(v.subarray(16,32)).join('|');if(key!==this.key){this.count=0;this.key=key;}
    c.device.queue.writeBuffer(r.uniform,0,v);
    if(this.count<s.frames){c.encoder.clearBuffer(r.energy);const pass=c.encoder.beginComputePass();pass.setPipeline(r.pipeline);pass.setBindGroup(0,r.group);pass.dispatchWorkgroups(Math.ceil(s.side*s.side/64));pass.end();this.count++;}
    const format=c.descriptor.depthStencil!.format,keyFloor=[c.format,format,c.descriptor.multisample?.count??1].join('|');
    if(!this.floor||keyFloor!==this.floorKey){const module=c.device.createShaderModule({code:causticFloor});this.floor=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:c.format,blend:{color:{srcFactor:'one',dstFactor:'one',operation:'add'},alpha:{srcFactor:'zero',dstFactor:'one',operation:'add'}}}]},primitive:{topology:'triangle-strip',cullMode:'none'},multisample:c.descriptor.multisample,depthStencil:{format,depthWriteEnabled:false,depthCompare:'greater-equal'}});this.floorKey=keyFloor;this.floorGroup=undefined;}
    this.floorGroup??=c.device.createBindGroup({layout:this.floor.getBindGroupLayout(0),entries:[{binding:7,resource:{buffer:r.uniform}},{binding:8,resource:{buffer:r.energy}}]});
    const pass=c.encoder.beginRenderPass({colorAttachments:[{view:c.color,loadOp:'load',storeOp:'store'}],depthStencilAttachment:{view:c.depth,depthLoadOp:'load',depthStoreOp:'store',...(format.includes('stencil')?{stencilLoadOp:'load',stencilStoreOp:'store'}:{})}});
    try{applyView(pass,c);pass.setPipeline(this.floor);pass.setBindGroup(0,this.floorGroup);pass.draw(4);}finally{pass.end();}
  }
}
