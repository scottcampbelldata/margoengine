import {SceneTarget,resolveMSAA,sceneTarget} from '../../shared/msaa.js';
import type {EngineKernel} from '@margoengine/core';
import {engineRuntime,type Engine,type EnginePlugin,type FrameGraph,type PassContext,type Mesh} from '@margoengine/core/extension';
import {invert} from '../../shared/math.js';
import {meshTriangles} from '../../shared/mesh-source.js';
import {jitterProjection} from './jitter.js';
import {fullscreen,cameraVelocity,objectVelocity,snapshot,resolve,present} from './shader.js';
export {halton,jitterProjection} from './jitter.js';
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number;COPY_SRC:number;STORAGE:number};
declare const GPUTextureUsage:{RENDER_ATTACHMENT:number;TEXTURE_BINDING:number;STORAGE_BINDING:number;COPY_SRC:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
export interface TAAOptions {historyWeight?:number;depthThreshold?:number;depth?:()=>GPUTexture|undefined}
export interface VelocityPrimitive {primitive?:object;node:Mesh;vertex:GPUBuffer;index:GPUBuffer;count:number;stride:number;alphaTexture?:GPUTextureView;alphaSampler?:GPUSampler;alpha?:number;cutoff?:number;texCoord?:number;alphaTransform?:Float32Array}
export interface VelocitySource {readonly shadowPrimitives:readonly VelocityPrimitive[];readonly disposed?:boolean}
interface Draw {uniform:GPUBuffer;values:Float32Array;previous:Float32Array;vertices?:GPUBuffer;source?:GPUBuffer;snapshot?:GPUBindGroup;group:GPUBindGroup;pipeline:GPURenderPipeline;vertex:GPUBuffer;alpha?:GPUTextureView;sampler?:GPUSampler;frame:number}
export class TAA implements EnginePlugin {
  readonly name='taa';
  private engine?:Engine;private device?:GPUDevice;private uniform?:GPUBuffer;private cameraPipeline?:GPURenderPipeline;private snapshotPipeline?:GPUComputePipeline;private resolvePipeline?:GPUComputePipeline;private presentPipeline?:GPURenderPipeline;
  private cameraBinding?:GPUBindGroupEntry;
  private captureTarget?:SceneTarget;
  private textures:GPUTexture[]=[];private scene?:GPUTexture;private depth?:GPUTexture;private velocity?:GPUTexture;private expected?:GPUTexture;private histories:GPUTexture[]=[];private historyDepths:GPUTexture[]=[];
  private colorView?:GPUTextureView;private depthView?:GPUTextureView;private sampledDepth?:GPUTextureView;private velocityView?:GPUTextureView;private expectedView?:GPUTextureView;private original?:GPUTextureView;
  private cameraGroup?:GPUBindGroup;private resolveGroups:GPUBindGroup[]=[];private presentGroups:GPUBindGroup[]=[];private depthSource?:GPUTexture;
  private motionViews:GPUTextureView[]=[];private motionResolve?:GPURenderPipeline;private motionGroup?:GPUBindGroup;private motionDepth?:GPUTextureView;
  private objectPipelines=new Map<string,GPURenderPipeline>();private draws=new Map<Mesh,Map<object,Draw>>();private sources=new Set<VelocitySource>();
  private readonly values=new Float32Array(52);private readonly jittered=new Float32Array(16);private readonly previous=new Float32Array(16);private readonly workspace=new Float64Array(52);
  private originalCamera?:Context['camera'];private cameraView?:Context['camera'];
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
    // Renderers cache bind groups by resource identity; only restoration replaces this buffer.
    this.cameraBinding={binding:8,resource:{buffer:this.uniform,size:64}};
    const compute=(code:string)=>this.device!.createComputePipeline({layout:'auto',compute:{module:this.device!.createShaderModule({code}),entryPoint:'main'}});
    this.snapshotPipeline=compute(snapshot);this.resolvePipeline=compute(resolve);this.reset();
  }
  registerPasses(graph:FrameGraph):void {
    graph.add({name:'taa:capture',order:-70,execute:c=>{if(c.backend==='webgpu')this.capture(c);}});
    graph.add({name:'taa:velocity',order:9,execute:c=>{if(c.backend==='webgpu')try{this.motion(c);}catch(error){this.restoreCamera(c);this.reset();throw error;}}});
    graph.add({name:'taa:resolve',order:40,execute:c=>{if(c.backend==='webgpu')this.finish(c);}});
  }
  private capture(c:Context):void {
    this.validate();this.resize(c);this.original=c.color;this.captureTarget!.begin(c);
    const camera=c.camera===this.cameraView?this.originalCamera!:c.camera;
    if(this.originalCamera!==camera||!this.cameraView)this.cameraView=Object.assign(Object.create(camera),{matrix:this.jittered});
    this.originalCamera=camera;try{jitterProjection(this.jittered,camera.matrix,this.frame,c.width,c.height);c.camera=this.cameraView!;
    const projection=[c.camera.fov,c.camera.near,c.camera.far].join(':');if(projection!==this.projection){this.reset();this.projection=projection;}
    this.values.set(c.camera.matrix);this.values.set(this.valid?this.previous:c.camera.matrix,16);
    if(!invert(this.values.subarray(32,48),c.camera.matrix,0,this.workspace))throw new Error('Invalid TAA camera');
    this.values.set([this.options.historyWeight??0.9,this.options.depthThreshold??0.01,+this.valid,0],48);c.device.queue.writeBuffer(this.uniform!,0,this.values as Float32Array<ArrayBuffer>);
    // Core uploads its frame before extension passes; use the jittered matrix through an existing shader binding.
    c.shader='@group(0) @binding(8) var<uniform> taaCamera:mat4x4f;\n'+c.shader.replace('o.clip=frame.camera*p','o.clip=taaCamera*p');
    c.bindings.push(this.cameraBinding!);
    }catch(error){this.restoreCamera(c);this.reset();throw error;}
  }
  private restoreCamera(c:Context):void {if(c.camera===this.cameraView)c.camera=this.originalCamera!;}
  private resize(c:Context):void {
    if(this.scene?.width===c.width&&this.scene.height===c.height&&this.format===c.format&&this.depth?.format===c.descriptor.depthStencil!.format&&this.captureTarget?.samples===(c.descriptor.multisample?.count??4))return;
    this.captureTarget?.dispose();for(const t of this.textures)t.destroy();this.textures=[];this.histories=[];this.historyDepths=[];this.format=c.format;
    const texture=(format:GPUTextureFormat,usage:number)=>{const t=c.device.createTexture({size:[c.width,c.height],format,usage:usage|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC});this.textures.push(t);return t;};
    this.scene=texture(c.format,GPUTextureUsage.RENDER_ATTACHMENT);this.depth=texture(c.descriptor.depthStencil!.format,GPUTextureUsage.RENDER_ATTACHMENT);
    this.velocity=texture('rg16float',GPUTextureUsage.RENDER_ATTACHMENT);this.expected=texture('r32float',GPUTextureUsage.RENDER_ATTACHMENT);
    for(let i=0;i<2;i++){this.histories.push(texture('rgba16float',GPUTextureUsage.STORAGE_BINDING));this.historyDepths.push(texture('r32float',GPUTextureUsage.STORAGE_BINDING));}
    this.captureTarget=new SceneTarget(c.device,this.scene,this.depth,c.descriptor.multisample?.count??4);
    this.colorView=this.scene.createView();this.depthView=this.depth.createView();this.velocityView=this.velocity.createView();this.expectedView=this.expected.createView();
    this.motionViews=[];this.motionResolve=undefined;this.motionGroup=undefined;this.motionDepth=undefined;
    const cameraModule=c.device.createShaderModule({code:cameraVelocity});this.cameraPipeline=c.device.createRenderPipeline({layout:'auto',vertex:{module:cameraModule,entryPoint:'vertex'},fragment:{module:cameraModule,entryPoint:'fragment',targets:[{format:'rg16float'},{format:'r32float'}]},multisample:c.descriptor.multisample});
    if(this.captureTarget.samples===4){
      for(const format of ['rg16float','r32float'] as GPUTextureFormat[]){const t=c.device.createTexture({size:[c.width,c.height],format,sampleCount:4,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});this.textures.push(t);this.motionViews.push(t.createView());}
      const module=c.device.createShaderModule({code:fullscreen+`
@group(0) @binding(0) var velocity:texture_multisampled_2d<f32>;
@group(0) @binding(1) var expected:texture_multisampled_2d<f32>;
@group(0) @binding(2) var depth:texture_depth_multisampled_2d;
struct Motion {@location(0) velocity:vec2f,@location(1) depth:f32}
@fragment fn fragment(i:Fullscreen)->Motion {let p=vec2i(i.clip.xy);var sample=0;var nearest=textureLoad(depth,p,0);
 for(var n=1;n<4;n++){let d=textureLoad(depth,p,n);if(d>nearest){nearest=d;sample=n;}}
 var o:Motion;o.velocity=textureLoad(velocity,p,sample).xy;o.depth=textureLoad(expected,p,sample).r;return o;}`});
      this.motionResolve=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:'rg16float'},{format:'r32float'}]}});
    }
    const module=c.device.createShaderModule({code:present});this.presentPipeline=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:c.format}]},multisample:c.descriptor.multisample});
    this.presentGroups=this.histories.map(t=>c.device.createBindGroup({layout:this.presentPipeline!.getBindGroupLayout(0),entries:[{binding:0,resource:t.createView()}]}));
    this.depthSource=undefined;this.reset();
  }
  private motion(c:Context):void {
    resolveMSAA(c);
    const depth=c.depth===this.captureTarget!.depth?this.depth:this.options.depth?.();
    if(!depth||depth.width!==c.width||depth.height!==c.height||!(depth.usage&GPUTextureUsage.TEXTURE_BINDING)||!depth.format.startsWith('depth'))throw new Error('TAA needs the current sampleable scene depth; provide options.depth for an HDR/SSAO capture');
    if(depth!==this.depthSource){this.sampledDepth=depth.createView({aspect:'depth-only'});
      const group=(p:GPUComputePipeline|GPURenderPipeline,resources:(GPUTextureView|GPUBufferBinding)[])=>c.device.createBindGroup({layout:p.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
      this.cameraGroup=group(this.cameraPipeline!,[{buffer:this.uniform!},this.sampledDepth]);
      this.resolveGroups=[0,1].map(i=>group(this.resolvePipeline!,[{buffer:this.uniform!},this.colorView!,this.velocityView!,this.expectedView!,this.sampledDepth!,this.histories[i].createView(),this.historyDepths[i].createView(),this.histories[1-i].createView(),this.historyDepths[1-i].createView()]));
      this.depthSource=depth;
    }
    const views=this.motionViews.length?this.motionViews:[this.velocityView!,this.expectedView!];
    const attachments=views.map(view=>({view,loadOp:'clear' as const,storeOp:'store' as const}));
    const camera=c.encoder.beginRenderPass({colorAttachments:attachments});camera.setPipeline(this.cameraPipeline!);camera.setBindGroup(0,this.cameraGroup!);camera.draw(3);camera.end();
    const submitted=new Map<Mesh,Set<object>>(),draw=(primitive:VelocityPrimitive)=>{const key=primitive.primitive??primitive.index;let indices=submitted.get(primitive.node);if(indices?.has(key))return;if(!indices){indices=new Set();submitted.set(primitive.node,indices);}indices.add(key);this.drawMotion(c,primitive);};
    for(const mesh of this.engine!.meshes.values()){const triangles=meshTriangles(mesh);if(triangles?.kind==='core'&&this.engine!.store.visible[mesh.id]){const buffers=this.engine!.geometryBuffers(triangles.geometry)!;draw({node:mesh,...buffers,count:triangles.geometry.indices.length,stride:24});}else if(triangles?.kind==='pbr')for(const primitive of triangles.source.shadowPrimitives)draw(primitive);}
    for(const source of this.sources){if(source.disposed){this.sources.delete(source);continue;}for(const primitive of source.shadowPrimitives)draw(primitive);}
    if(this.motionViews.length){
      const depth=sceneTarget(c)!.depthSource!;
      if(this.motionDepth!==depth){this.motionDepth=depth;this.motionGroup=c.device.createBindGroup({layout:this.motionResolve!.getBindGroupLayout(0),entries:[...this.motionViews,depth].map((resource,binding)=>({binding,resource}))});}
      const pass=c.encoder.beginRenderPass({colorAttachments:[this.velocityView!,this.expectedView!].map(view=>({view,loadOp:'clear',storeOp:'store'}))});pass.setPipeline(this.motionResolve!);pass.setBindGroup(0,this.motionGroup!);pass.draw(3);pass.end();
    }
    for(const [mesh,records] of this.draws)for(const [index,r] of records)if(r.frame!==this.frame){r.uniform.destroy();r.vertices?.destroy();r.source?.destroy();records.delete(index);if(!records.size)this.draws.delete(mesh);}
  }
  private drawMotion(c:Context,p:VelocityPrimitive):void {
    p.node.check();if(p.node.engine!==this.engine||![24,80].includes(p.stride))throw new Error('Invalid TAA velocity primitive');
    for(let id=p.node.id;id!==-1;id=this.engine!.store.parents[id])if(this.engine!.store.hidden[id])return;
    const transform=p.alphaTransform;
    if(transform&&(!(transform instanceof Float32Array)||transform.length!==8||transform.some(value=>!Number.isFinite(value))||p.stride!==80))throw new TypeError('Invalid TAA alpha transform');
    const pbr=p.stride===80,key=p.stride+':'+!!transform+':'+c.descriptor.depthStencil!.format+':'+c.descriptor.multisample?.count;let pipeline=this.objectPipelines.get(key);
    if(!pipeline){const module=c.device.createShaderModule({code:objectVelocity(pbr,!!transform)});pipeline=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:p.stride,attributes:pbr?[{shaderLocation:0,offset:0,format:'float32x4'},{shaderLocation:1,offset:48,format:'float32x4'},{shaderLocation:2,offset:64,format:'float32x4'}]:[{shaderLocation:0,offset:0,format:'float32x3'}]}]},fragment:{module,entryPoint:'fragment',targets:[{format:'rg16float'},{format:'r32float'}]},primitive:{cullMode:'none'},depthStencil:{format:c.descriptor.depthStencil!.format,depthWriteEnabled:false,depthCompare:'equal'},multisample:c.descriptor.multisample});this.objectPipelines.set(key,pipeline);}
    const identity=p.primitive??p.index;let records=this.draws.get(p.node);if(!records){records=new Map();this.draws.set(p.node,records);}let r=records.get(identity);
    if(!r||!r.group||r.pipeline!==pipeline||r.vertex!==p.vertex||r.alpha!==p.alphaTexture||r.sampler!==p.alphaSampler){r?.uniform.destroy();r?.vertices?.destroy();r?.source?.destroy();const uniform=c.device.createBuffer({size:transform?320:288,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      r={uniform,values:new Float32Array(transform?80:72),previous:p.node.matrix.slice(),group:undefined!,pipeline,vertex:p.vertex,alpha:p.alphaTexture,sampler:p.alphaSampler,frame:-2};records.set(identity,r);
      if(pbr){if(!p.alphaTexture||!p.alphaSampler||p.vertex.size>c.device.limits.maxStorageBufferBindingSize)throw new Error('TAA PBR source needs alpha bindings and a storage-sized vertex buffer');
        let source=p.vertex;
        if(p.vertex.usage!==undefined&&!(p.vertex.usage&GPUBufferUsage.STORAGE)){
          const primitive=p.primitive as {vertices?:Float32Array;deformed?:GPUBuffer}|undefined,vertices=primitive?.vertices;
          if(!(p.vertex.usage&GPUBufferUsage.COPY_SRC)&&(primitive?.deformed===p.vertex||!(vertices instanceof Float32Array)||vertices.byteLength!==p.vertex.size))throw new Error('TAA deformed sources require STORAGE or COPY_SRC; static PBR sources need retained CPU vertices');
          r.source=c.device.createBuffer({size:p.vertex.size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
          if(!(p.vertex.usage&GPUBufferUsage.COPY_SRC))c.device.queue.writeBuffer(r.source,0,vertices as Float32Array<ArrayBuffer>);source=r.source;
        }
        r.vertices=c.device.createBuffer({size:p.vertex.size,usage:GPUBufferUsage.STORAGE});r.snapshot=c.device.createBindGroup({layout:this.snapshotPipeline!.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:source}},{binding:1,resource:{buffer:r.vertices}}]});}
      r.group=c.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}},...(pbr?[{binding:1,resource:{buffer:r.vertices!}},{binding:2,resource:p.alphaTexture!},{binding:3,resource:p.alphaSampler!}]:[])]});
    }
    r.values.set(c.camera.matrix);r.values.set(this.valid?this.previous:c.camera.matrix,16);r.values.set(p.node.matrix,32);r.values.set(r.previous,48);
    r.values.set([c.width,c.height,+(this.valid&&r.frame===this.frame-1),0,p.alpha??1,p.cutoff??0,p.texCoord??0,0],64);if(transform)r.values.set(transform,72);c.device.queue.writeBuffer(r.uniform,0,r.values as Float32Array<ArrayBuffer>);
    if(r.source&&p.vertex.usage&GPUBufferUsage.COPY_SRC)c.encoder.copyBufferToBuffer(p.vertex,0,r.source,0,p.vertex.size);
    const pass=c.encoder.beginRenderPass({colorAttachments:(this.motionViews.length?this.motionViews:[this.velocityView!,this.expectedView!]).map(view=>({view,loadOp:'load',storeOp:'store'})),depthStencilAttachment:{view:c.depth,depthReadOnly:true,...(c.descriptor.depthStencil!.format.includes('stencil')?{stencilReadOnly:true}:{})}});
    pass.setPipeline(pipeline);pass.setBindGroup(0,r.group);pass.setVertexBuffer(0,p.vertex);pass.setIndexBuffer(p.index,'uint32');pass.drawIndexed(p.count);pass.end();
    r.previous.set(p.node.matrix);r.frame=this.frame;
    if(r.snapshot){const copy=c.encoder.beginComputePass();copy.setPipeline(this.snapshotPipeline!);copy.setBindGroup(0,r.snapshot);copy.dispatchWorkgroups(Math.ceil(p.vertex.size/16/256));copy.end();}
  }
  private finish(c:Context):void {
    try{this.captureTarget!.resolve(c.encoder,true);const compute=c.encoder.beginComputePass();compute.setPipeline(this.resolvePipeline!);compute.setBindGroup(0,this.resolveGroups[this.front]);compute.dispatchWorkgroups(Math.ceil(c.width/8),Math.ceil(c.height/8));compute.end();this.front=1-this.front;
      const pass=c.encoder.beginRenderPass({colorAttachments:[{view:this.original!,loadOp:'clear',storeOp:'store'}]});pass.setPipeline(this.presentPipeline!);pass.setBindGroup(0,this.presentGroups[this.front]);pass.draw(3);pass.end();
      this.previous.set(c.camera.matrix);this.valid=true;this.frame++;this.captureTarget!.restore(c);
    }finally{this.restoreCamera(c);}
  }
  get gpuState():{velocity:GPUTexture;history:GPUTexture;depth:GPUTexture} {if(!this.velocity||!this.histories.length)throw new Error('TAA is not rendered');return {velocity:this.velocity,history:this.histories[this.front],depth:this.historyDepths[this.front]};}
  private release():void {this.motionViews=[];this.motionResolve=undefined;this.motionGroup=undefined;this.motionDepth=undefined;this.captureTarget?.dispose();this.captureTarget=undefined;for(const t of this.textures)t.destroy();for(const records of this.draws.values())for(const r of records.values()){r.uniform.destroy();r.vertices?.destroy();r.source?.destroy();}this.uniform?.destroy();this.textures=[];this.histories=[];this.historyDepths=[];this.draws.clear();this.objectPipelines.clear();this.scene=this.depth=this.velocity=this.expected=undefined;this.uniform=undefined;this.cameraBinding=undefined;this.depthSource=undefined;this.cameraPipeline=this.presentPipeline=undefined;this.snapshotPipeline=this.resolvePipeline=undefined;this.cameraGroup=undefined;this.resolveGroups=[];this.presentGroups=[];this.colorView=this.depthView=this.sampledDepth=this.velocityView=this.expectedView=this.original=undefined;this.originalCamera=this.cameraView=undefined;this.format=undefined;this.frame=this.front=0;this.reset();}
  onDeviceRestored(engine:Engine):void {this.release();this.setup(engine);}
  dispose():void {if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);this.release();this.sources.clear();this.engine=this.device=undefined;}
  destroy():void {this.dispose();}
}
