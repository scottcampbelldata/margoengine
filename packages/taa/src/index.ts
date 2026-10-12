import type {EngineKernel} from '@margoengine/core';
import {engineRuntime,type Engine,type EnginePlugin,type FrameGraph,type PassContext,type Mesh} from '@margoengine/core/extension';
import {invert} from '../../shared/math.js';
import {jitterProjection} from './jitter.js';
import {cameraVelocity,objectVelocity,snapshot,resolve,present} from './shader.js';
export {halton,jitterProjection} from './jitter.js';
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number;STORAGE:number};
declare const GPUTextureUsage:{RENDER_ATTACHMENT:number;TEXTURE_BINDING:number;STORAGE_BINDING:number;COPY_SRC:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
export interface TAAOptions {historyWeight?:number;depthThreshold?:number;depth?:()=>GPUTexture|undefined}
export interface VelocityPrimitive {node:Mesh;vertex:GPUBuffer;index:GPUBuffer;count:number;stride:number;alphaTexture?:GPUTextureView;alphaSampler?:GPUSampler;alpha?:number;cutoff?:number;texCoord?:number}
export interface VelocitySource {readonly shadowPrimitives:readonly VelocityPrimitive[];readonly disposed?:boolean}
interface Draw {uniform:GPUBuffer;values:Float32Array;previous:Float32Array;vertices?:GPUBuffer;snapshot?:GPUBindGroup;group:GPUBindGroup;vertex:GPUBuffer;alpha?:GPUTextureView;sampler?:GPUSampler;frame:number}
export class TAA implements EnginePlugin {
  readonly name='taa';
  private engine?:Engine;private device?:GPUDevice;private uniform?:GPUBuffer;private cameraPipeline?:GPURenderPipeline;private snapshotPipeline?:GPUComputePipeline;private resolvePipeline?:GPUComputePipeline;private presentPipeline?:GPURenderPipeline;
  private textures:GPUTexture[]=[];private scene?:GPUTexture;private depth?:GPUTexture;private velocity?:GPUTexture;private expected?:GPUTexture;private histories:GPUTexture[]=[];private historyDepths:GPUTexture[]=[];
  private colorView?:GPUTextureView;private depthView?:GPUTextureView;private sampledDepth?:GPUTextureView;private velocityView?:GPUTextureView;private expectedView?:GPUTextureView;private original?:GPUTextureView;
  private cameraGroup?:GPUBindGroup;private resolveGroups:GPUBindGroup[]=[];private presentGroups:GPUBindGroup[]=[];private depthSource?:GPUTexture;
  private objectPipelines=new Map<string,GPURenderPipeline>();private draws=new Map<Mesh,Map<GPUBuffer,Draw>>();private sources=new Set<VelocitySource>();
  private readonly values=new Float32Array(52);private readonly unjittered=new Float32Array(16);private readonly previous=new Float32Array(16);private readonly workspace=new Float64Array(52);
  private frame=0;private front=0;private valid=false;private disposed=false;private projection='';private format?:GPUTextureFormat;
  constructor(readonly options:TAAOptions={}){this.validate();}
  static attach(instance:EngineKernel,options:TAAOptions={}):TAA {const effect=new TAA(options);engineRuntime(instance).use(effect);return effect;}
  private validate():void {const o=this.options;if(!Number.isFinite(o.historyWeight??0.9)||(o.historyWeight??0.9)<0||(o.historyWeight??0.9)>=1||!Number.isFinite(o.depthThreshold??0.01)||(o.depthThreshold??0.01)<0||(o.depthThreshold??0.01)>1||o.depth!==undefined&&typeof o.depth!=='function')throw new RangeError('Invalid TAA options');}
  add(source:VelocitySource):()=>void {
    if(this.disposed||!source||source.disposed||!Array.isArray(source.shadowPrimitives))throw new TypeError('Invalid TAA velocity source');
    if(source.shadowPrimitives.some(p=>p.node.engine!==this.engine))throw new Error('TAA source belongs to another engine');
    if(this.sources.has(source))throw new Error('Duplicate TAA source');this.sources.add(source);this.reset();return()=>{this.sources.delete(source);this.reset();};
  }
  reset():void {this.valid=false;}
  setup(engine:Engine):void {
    if(this.disposed||!engine.gpu)throw new Error('TAA requires WebGPU and a live effect');this.engine=engine;this.device=engine.gpu;
    this.uniform=this.device.createBuffer({size:208,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const module=this.device.createShaderModule({code:cameraVelocity});this.cameraPipeline=this.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:'rg16float'},{format:'r32float'}]}});
    const compute=(code:string)=>this.device!.createComputePipeline({layout:'auto',compute:{module:this.device!.createShaderModule({code}),entryPoint:'main'}});
    this.snapshotPipeline=compute(snapshot);this.resolvePipeline=compute(resolve);this.reset();
  }
  registerPasses(graph:FrameGraph):void {
    graph.add({name:'taa:capture',order:-70,execute:c=>{if(c.backend==='webgpu')this.capture(c);}});
    graph.add({name:'taa:velocity',order:9,execute:c=>{if(c.backend==='webgpu')this.motion(c);}});
    graph.add({name:'taa:resolve',order:40,execute:c=>{if(c.backend==='webgpu')this.finish(c);}});
  }
  private capture(c:Context):void {
    this.validate();this.resize(c);this.original=c.color;c.color=this.colorView!;c.depth=this.depthView!;
    this.unjittered.set(c.camera.matrix);jitterProjection(c.camera.matrix,this.unjittered,this.frame,c.width,c.height);
    const projection=[c.camera.fov,c.camera.near,c.camera.far].join(':');if(projection!==this.projection){this.reset();this.projection=projection;}
    this.values.set(c.camera.matrix);this.values.set(this.valid?this.previous:c.camera.matrix,16);
    if(!invert(this.values.subarray(32,48),c.camera.matrix,0,this.workspace))throw new Error('Invalid TAA camera');
    this.values.set([this.options.historyWeight??0.9,this.options.depthThreshold??0.01,+this.valid,0],48);c.device.queue.writeBuffer(this.uniform!,0,this.values as Float32Array<ArrayBuffer>);
    // Core uploads its frame before extension passes; use the jittered matrix through an existing shader binding.
    c.shader='@group(0) @binding(8) var<uniform> taaCamera:mat4x4f;\n'+c.shader.replace('o.clip=frame.camera*p','o.clip=taaCamera*p');
    c.bindings.push({binding:8,resource:{buffer:this.uniform!,size:64}});
  }
  private resize(c:Context):void {
    if(this.scene?.width===c.width&&this.scene.height===c.height&&this.format===c.format)return;
    for(const t of this.textures)t.destroy();this.textures=[];this.histories=[];this.historyDepths=[];this.format=c.format;
    const texture=(format:GPUTextureFormat,usage:number)=>{const t=c.device.createTexture({size:[c.width,c.height],format,usage:usage|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC});this.textures.push(t);return t;};
    this.scene=texture(c.format,GPUTextureUsage.RENDER_ATTACHMENT);this.depth=texture(c.descriptor.depthStencil!.format,GPUTextureUsage.RENDER_ATTACHMENT);
    this.velocity=texture('rg16float',GPUTextureUsage.RENDER_ATTACHMENT);this.expected=texture('r32float',GPUTextureUsage.RENDER_ATTACHMENT);
    for(let i=0;i<2;i++){this.histories.push(texture('rgba16float',GPUTextureUsage.STORAGE_BINDING));this.historyDepths.push(texture('r32float',GPUTextureUsage.STORAGE_BINDING));}
    this.colorView=this.scene.createView();this.depthView=this.depth.createView();this.velocityView=this.velocity.createView();this.expectedView=this.expected.createView();
    const module=c.device.createShaderModule({code:present});this.presentPipeline=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:c.format}]}});
    this.presentGroups=this.histories.map(t=>c.device.createBindGroup({layout:this.presentPipeline!.getBindGroupLayout(0),entries:[{binding:0,resource:t.createView()}]}));
    this.depthSource=undefined;this.reset();
  }
  private motion(c:Context):void {
    const depth=c.depth===this.depthView?this.depth:this.options.depth?.();
    if(!depth||depth.width!==c.width||depth.height!==c.height||!(depth.usage&GPUTextureUsage.TEXTURE_BINDING)||!depth.format.startsWith('depth'))throw new Error('TAA needs the current sampleable scene depth; provide options.depth for an HDR/SSAO capture');
    if(depth!==this.depthSource){this.depthSource=depth;this.sampledDepth=depth.createView({aspect:'depth-only'});
      const group=(p:GPUComputePipeline|GPURenderPipeline,resources:(GPUTextureView|GPUBufferBinding)[])=>c.device.createBindGroup({layout:p.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
      this.cameraGroup=group(this.cameraPipeline!,[{buffer:this.uniform!},this.sampledDepth]);
      this.resolveGroups=[0,1].map(i=>group(this.resolvePipeline!,[{buffer:this.uniform!},this.colorView!,this.velocityView!,this.expectedView!,this.sampledDepth!,this.histories[i].createView(),this.historyDepths[i].createView(),this.histories[1-i].createView(),this.historyDepths[1-i].createView()]));
    }
    const attachments=[this.velocityView!,this.expectedView!].map(view=>({view,loadOp:'clear' as const,storeOp:'store' as const}));
    const camera=c.encoder.beginRenderPass({colorAttachments:attachments});camera.setPipeline(this.cameraPipeline!);camera.setBindGroup(0,this.cameraGroup!);camera.draw(3);camera.end();
    for(const mesh of this.engine!.meshes.values())if(mesh.geometry&&this.engine!.store.visible[mesh.id]){const buffers=this.engine!.geometryBuffers(mesh.geometry)!;this.drawMotion(c,{node:mesh,...buffers,count:mesh.geometry.indices.length,stride:24});}
    for(const source of this.sources){if(source.disposed){this.sources.delete(source);continue;}for(const primitive of source.shadowPrimitives)this.drawMotion(c,primitive);}
    for(const [mesh,records] of this.draws)for(const [index,r] of records)if(r.frame!==this.frame){r.uniform.destroy();r.vertices?.destroy();records.delete(index);if(!records.size)this.draws.delete(mesh);}
  }
  private drawMotion(c:Context,p:VelocityPrimitive):void {
    p.node.check();if(p.node.engine!==this.engine||![24,80].includes(p.stride))throw new Error('Invalid TAA velocity primitive');
    for(let id=p.node.id;id!==-1;id=this.engine!.store.parents[id])if(this.engine!.store.hidden[id])return;
    const pbr=p.stride===80,key=p.stride+':'+c.descriptor.depthStencil!.format;let pipeline=this.objectPipelines.get(key);
    if(!pipeline){const module=c.device.createShaderModule({code:objectVelocity(pbr)});pipeline=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:p.stride,attributes:pbr?[{shaderLocation:0,offset:0,format:'float32x4'},{shaderLocation:1,offset:48,format:'float32x4'},{shaderLocation:2,offset:64,format:'float32x4'}]:[{shaderLocation:0,offset:0,format:'float32x3'}]}]},fragment:{module,entryPoint:'fragment',targets:[{format:'rg16float'},{format:'r32float'}]},primitive:{cullMode:'none'},depthStencil:{format:c.descriptor.depthStencil!.format,depthWriteEnabled:false,depthCompare:'equal'}});this.objectPipelines.set(key,pipeline);}
    let records=this.draws.get(p.node);if(!records){records=new Map();this.draws.set(p.node,records);}let r=records.get(p.index);
    if(!r||r.vertex!==p.vertex||r.alpha!==p.alphaTexture||r.sampler!==p.alphaSampler){r?.uniform.destroy();r?.vertices?.destroy();const uniform=c.device.createBuffer({size:288,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      r={uniform,values:new Float32Array(72),previous:p.node.matrix.slice(),group:undefined!,vertex:p.vertex,alpha:p.alphaTexture,sampler:p.alphaSampler,frame:-2};records.set(p.index,r);
      if(pbr){if(!p.alphaTexture||!p.alphaSampler||p.vertex.size>c.device.limits.maxStorageBufferBindingSize)throw new Error('TAA PBR source needs alpha bindings and a storage-sized vertex buffer');r.vertices=c.device.createBuffer({size:p.vertex.size,usage:GPUBufferUsage.STORAGE});r.snapshot=c.device.createBindGroup({layout:this.snapshotPipeline!.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:p.vertex}},{binding:1,resource:{buffer:r.vertices}}]});}
      r.group=c.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}},...(pbr?[{binding:1,resource:{buffer:r.vertices!}},{binding:2,resource:p.alphaTexture!},{binding:3,resource:p.alphaSampler!}]:[])]});
    }
    r.values.set(c.camera.matrix);r.values.set(this.valid?this.previous:c.camera.matrix,16);r.values.set(p.node.matrix,32);r.values.set(r.previous,48);
    r.values.set([c.width,c.height,+(this.valid&&r.frame===this.frame-1),0,p.alpha??1,p.cutoff??0,p.texCoord??0,0],64);c.device.queue.writeBuffer(r.uniform,0,r.values as Float32Array<ArrayBuffer>);
    const pass=c.encoder.beginRenderPass({colorAttachments:[this.velocityView!,this.expectedView!].map(view=>({view,loadOp:'load',storeOp:'store'})),depthStencilAttachment:{view:c.depth,depthReadOnly:true,...(c.descriptor.depthStencil!.format.includes('stencil')?{stencilReadOnly:true}:{})}});
    pass.setPipeline(pipeline);pass.setBindGroup(0,r.group);pass.setVertexBuffer(0,p.vertex);pass.setIndexBuffer(p.index,'uint32');pass.drawIndexed(p.count);pass.end();
    r.previous.set(p.node.matrix);r.frame=this.frame;
    if(r.snapshot){const copy=c.encoder.beginComputePass();copy.setPipeline(this.snapshotPipeline!);copy.setBindGroup(0,r.snapshot);copy.dispatchWorkgroups(Math.ceil(p.vertex.size/16/256));copy.end();}
  }
  private finish(c:Context):void {
    try{const compute=c.encoder.beginComputePass();compute.setPipeline(this.resolvePipeline!);compute.setBindGroup(0,this.resolveGroups[this.front]);compute.dispatchWorkgroups(Math.ceil(c.width/8),Math.ceil(c.height/8));compute.end();this.front=1-this.front;
      const pass=c.encoder.beginRenderPass({colorAttachments:[{view:this.original!,loadOp:'clear',storeOp:'store'}]});pass.setPipeline(this.presentPipeline!);pass.setBindGroup(0,this.presentGroups[this.front]);pass.draw(3);pass.end();
      this.previous.set(c.camera.matrix);this.valid=true;this.frame++;c.color=this.original!;c.format=this.format!;
    }finally{c.camera.matrix.set(this.unjittered);}
  }
  get gpuState():{velocity:GPUTexture;history:GPUTexture;depth:GPUTexture} {if(!this.velocity||!this.histories.length)throw new Error('TAA is not rendered');return {velocity:this.velocity,history:this.histories[this.front],depth:this.historyDepths[this.front]};}
  private release():void {for(const t of this.textures)t.destroy();for(const records of this.draws.values())for(const r of records.values()){r.uniform.destroy();r.vertices?.destroy();}this.uniform?.destroy();this.textures=[];this.histories=[];this.historyDepths=[];this.draws.clear();this.objectPipelines.clear();this.scene=this.depth=this.velocity=this.expected=undefined;this.uniform=undefined;this.depthSource=undefined;this.cameraPipeline=this.presentPipeline=undefined;this.snapshotPipeline=this.resolvePipeline=undefined;this.cameraGroup=undefined;this.resolveGroups=[];this.presentGroups=[];this.colorView=this.depthView=this.sampledDepth=this.velocityView=this.expectedView=this.original=undefined;this.format=undefined;this.frame=this.front=0;this.reset();}
  onDeviceRestored(engine:Engine):void {this.release();this.setup(engine);}
  dispose():void {if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);this.release();this.sources.clear();this.engine=this.device=undefined;}
  destroy():void {this.dispose();}
}
