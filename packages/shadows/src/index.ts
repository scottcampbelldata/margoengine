import type {EngineKernel,Mesh as MeshHandle} from '@margoengine/core';
import {engineRuntime,meshRuntime,type Engine,type EnginePlugin,type FrameGraph,type PassContext,type Mesh} from '@margoengine/core/extension';
import {viewMatrix} from '../../shared/view.js';
import {cascadeSplits,fitCascades} from './cascades.js';
import {shadowSampling,shadowDepth} from './shader.js';
export {cascadeSplits,fitCascades} from './cascades.js';
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number};
declare const GPUTextureUsage:{RENDER_ATTACHMENT:number;TEXTURE_BINDING:number;COPY_SRC:number;COPY_DST:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
export interface ShadowOptions {resolution?:number;distance?:number;lambda?:number;lightSize?:number;bias?:number;normalBias?:number;casterMargin?:number}
export interface ShadowContext {context:Context;pass:GPURenderPassEncoder;matrix:Float32Array;cascade:number}
export interface ShadowPrimitive {node:Mesh;vertex:GPUBuffer;index:GPUBuffer;count:number;stride:number;alphaTexture?:GPUTextureView;alphaSampler?:GPUSampler;alpha?:number;cutoff?:number;texCoord?:number;/** Two packed vec4 affine rows applied after UV selection. */alphaTransform?:Float32Array}
export interface ShadowSource {shadowPrimitives?:readonly ShadowPrimitive[];shadowVersion?:number;drawShadow?(context:ShadowContext):void;addLighting?(effect:Shadows):()=>void;disposed?:boolean}
interface Source {source:ShadowSource|Mesh;static:boolean;version:number;removeLighting?:()=>void;meshPrimitive?:ShadowPrimitive[]}
interface Draw {uniforms:GPUBuffer[];groups:GPUBindGroup[];values:Float32Array;vertex:GPUBuffer;index:GPUBuffer;pipeline:GPURenderPipeline;alpha?:GPUTextureView;sampler?:GPUSampler}
const emptyPrimitives:readonly ShadowPrimitive[]=[];
export class Shadows implements EnginePlugin {
  readonly name='shadows';readonly matrices=new Float32Array(64);readonly splits=new Float32Array(4);
  readonly stats={staticDraws:0,dynamicDraws:0,cacheHits:0};
  private engine?:Engine;private device?:GPUDevice;private uniform?:GPUBuffer;private cached?:GPUTexture;private combined?:GPUTexture;private white?:GPUTexture;private sampler?:GPUSampler;private alphaSampler?:GPUSampler;
  private views:GPUTextureView[]=[];private cachedViews:GPUTextureView[]=[];private entries:GPUBindGroupEntry[]=[];private pipelines=new Map<number,GPURenderPipeline>();private draws=new Map<Mesh,Map<GPUBuffer,Draw>>();private sources:Source[]=[];
  private readonly values=new Float32Array(92);private readonly ranges=this.values.subarray(84,88);private readonly previous=new Float32Array(64);private readonly view=this.values.subarray(64,80);
  private dirty=true;private disposed=false;
  private whiteView?:GPUTextureView;
  private readonly light=new Float32Array(3);
  private readonly fitted={matrices:this.matrices,ranges:this.ranges};
  private readonly cascadeMatrices=Array.from({length:4},(_,i)=>this.matrices.subarray(i*16,i*16+16));
  private readonly shadowContexts=this.cascadeMatrices.map((matrix,cascade)=>({context:undefined!,pass:undefined!,matrix,cascade}) as ShadowContext);
  private readonly shaders=new Map<number,Map<string,string>>();
  private readonly depthAttachment:GPURenderPassDepthStencilAttachment={view:undefined!,depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'};
  private readonly depthPass:GPURenderPassDescriptor={colorAttachments:[],depthStencilAttachment:this.depthAttachment};
  private readonly copySource:GPUTexelCopyTextureInfo={texture:undefined!};private readonly copyDestination:GPUTexelCopyTextureInfo={texture:undefined!};private readonly copySize={width:0,height:0,depthOrArrayLayers:4};
  constructor(readonly options:ShadowOptions={}) {this.validate();}
  get owner():Engine|undefined {return this.engine;}
  static attach(instance:EngineKernel,options:ShadowOptions={}):Shadows {const effect=new Shadows(options);engineRuntime(instance).use(effect);return effect;}
  private validate():void {const o=this.options;
    if(!Number.isInteger(o.resolution??2048)||(o.resolution??2048)<16||!Number.isFinite(o.distance??500)||(o.distance??500)<=0||!Number.isFinite(o.lambda??0.5)||(o.lambda??0.5)<0||(o.lambda??0.5)>1)throw new RangeError('Invalid shadow options');
    for(let i=0;i<4;i++){const v=i===0?o.lightSize??0.02:i===1?o.bias??0.0005:i===2?o.normalBias??0.02:o.casterMargin??100;if(!Number.isFinite(Math.fround(v))||v<0)throw new RangeError('Invalid shadow options');}
  }
  add(source:ShadowSource|MeshHandle,{static:cached=false}:{static?:boolean}={}):()=>void {
    if(this.disposed||!source||typeof cached!=='boolean')throw new TypeError('Invalid shadow source');
    if('disposed' in source&&source.disposed)throw new Error('Shadow source is disposed');
    const runtime='id' in source?meshRuntime(source as MeshHandle):source as ShadowSource;
    if('id' in runtime){runtime.check();if(this.engine&&runtime.engine!==this.engine)throw new Error('Shadow mesh belongs to another engine');}
    else if(!('shadowPrimitives' in runtime)&&typeof runtime.drawShadow!=='function')throw new TypeError('Invalid shadow source');
    if(this.engine&&'shadowPrimitives' in runtime&&runtime.shadowPrimitives?.some(p=>p.node.engine!==this.engine))throw new Error('Shadow source belongs to another engine');
    if(this.sources.some(r=>r.source===runtime))throw new Error('Duplicate shadow source');
    const r:Source={source:runtime,static:cached,version:-1,removeLighting:'addLighting' in runtime?runtime.addLighting?.(this):undefined};this.sources.push(r);this.invalidate();
    return()=>{const index=this.sources.indexOf(r);if(index>=0){this.sources.splice(index,1);r.removeLighting?.();this.invalidate();this.clearDraws();}};
  }
  invalidate():void {this.dirty=true;}
  bindings():GPUBindGroupEntry[] {if(!this.uniform||this.disposed)throw new Error('Shadows are not attached');return this.entries;}
  shader(source:string,group=0):string {
    let cache=this.shaders.get(group);const cached=cache?.get(source);if(cached)return cached;
    let code=source.replace('let linear=direct*','let linear=direct*shadowVisibility(i.position,i.normal)*');
    if(code===source)code=source.replace('direct+ambient(s)','direct*shadowVisibility(i.position,s.n)+ambient(s)');
    if(code===source)throw new Error('Shadows require the standard PBR lighting shader');const output=shadowSampling(group)+code;if(!cache){cache=new Map();this.shaders.set(group,cache);}cache.set(source,output);return output;
  }
  setup(engine:Engine):void {
    if(this.disposed||!engine.gpu)throw new Error('Shadows require WebGPU and a live effect');this.engine=engine;this.device=engine.gpu;this.validate();
    const size=this.options.resolution??2048;if(size>this.device.limits.maxTextureDimension2D||this.device.limits.maxTextureArrayLayers<4)throw new RangeError('Shadow map exceeds device limit');
    for(const r of this.sources)if('id' in r.source&&r.source.engine!==engine)throw new Error('Shadow mesh belongs to another engine');
    const texture=()=>this.device!.createTexture({size:[size,size,4],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST});
    this.cached=texture();this.combined=texture();this.views=Array.from({length:4},(_,baseArrayLayer)=>this.combined!.createView({dimension:'2d',baseArrayLayer,arrayLayerCount:1}));this.cachedViews=Array.from({length:4},(_,baseArrayLayer)=>this.cached!.createView({dimension:'2d',baseArrayLayer,arrayLayerCount:1}));
    this.uniform=this.device.createBuffer({size:368,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.sampler=this.device.createSampler({compare:'less-equal',magFilter:'linear',minFilter:'linear'});this.alphaSampler=this.device.createSampler();
    this.white=this.device.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});this.device.queue.writeTexture({texture:this.white},new Uint8Array([255,255,255,255]),{bytesPerRow:4},[1,1]);
    this.whiteView=this.white.createView();
    this.entries=[{binding:1,resource:{buffer:this.uniform}},{binding:2,resource:this.combined.createView({dimension:'2d-array'})},{binding:3,resource:this.sampler}];this.dirty=true;
  }
  registerPasses(graph:FrameGraph):void {graph.add({name:this.name,order:-5,execute:c=>{if(c.backend!=='webgpu')return;this.render(c);c.shader=this.shader(c.shader);c.bindings.push(...this.bindings());}});}
  private render(c:Context):void {
    this.validate();const far=Math.min(c.camera.far,this.options.distance??500);cascadeSplits(c.camera.near,far,this.options.lambda??0.5,this.splits);
    for(let i=0;i<3;i++)this.light[i]=this.engine!.lighting.direction[i];
    fitCascades(c.camera,c.width/c.height,this.light as unknown as [number,number,number],this.options.resolution??2048,this.splits,this.matrices,this.ranges,this.options.casterMargin??100,this.fitted);
    for(let i=0;i<64;i++)if(this.matrices[i]!==this.previous[i])this.dirty=true;
    for(let i=this.sources.length-1;i>=0;i--){const r=this.sources[i];if('disposed' in r.source&&r.source.disposed||'id' in r.source&&this.engine!.meshes.get(r.source.id)!==r.source){this.sources.splice(i,1);r.removeLighting?.();this.clearDraws();this.dirty=true;}}
    let dynamic=false;
    for(let i=0;i<this.sources.length;i++){const r=this.sources[i];if(!r.static)dynamic=true;else if('shadowVersion' in r.source&&r.version!==r.source.shadowVersion){r.version=r.source.shadowVersion??0;this.dirty=true;}}
    this.values.set(this.matrices);viewMatrix(this.view,c.camera);this.values.set(this.splits,80);this.values[88]=this.options.lightSize??0.02;this.values[89]=this.options.bias??0.0005;this.values[90]=this.options.normalBias??0.02;c.device.queue.writeBuffer(this.uniform!,0,this.values as Float32Array<ArrayBuffer>);
    this.stats.staticDraws=this.stats.dynamicDraws=0;
    if(this.dirty){for(let cascade=0;cascade<4;cascade++)this.depth(c,cascade,true);this.previous.set(this.matrices);this.dirty=false;}else this.stats.cacheHits++;
    this.copySource.texture=this.cached!;this.copyDestination.texture=this.combined!;this.copySize.width=this.copySize.height=this.options.resolution??2048;c.encoder.copyTextureToTexture(this.copySource,this.copyDestination,this.copySize);
    if(dynamic)for(let cascade=0;cascade<4;cascade++)this.depth(c,cascade,false);
  }
  private depth(c:Context,cascade:number,cached:boolean):void {
    this.depthAttachment.view=(cached?this.cachedViews:this.views)[cascade];this.depthAttachment.depthLoadOp=cached?'clear':'load';const pass=c.encoder.beginRenderPass(this.depthPass),matrix=this.cascadeMatrices[cascade];
    try{for(let i=0;i<this.sources.length;i++){const r=this.sources[i];if(r.static!==cached||'disposed' in r.source&&r.source.disposed)continue;
      if('drawShadow' in r.source&&r.source.drawShadow){const shadow=this.shadowContexts[cascade];shadow.context=c;shadow.pass=pass;r.source.drawShadow(shadow);continue;}
      let primitives:readonly ShadowPrimitive[];
      if('id' in r.source){const node=r.source;if(this.engine!.meshes.get(node.id)!==node||!node.geometry)continue;const buffers=this.engine!.geometryBuffers(node.geometry);if(!buffers)continue;if(!r.meshPrimitive)r.meshPrimitive=[{node,vertex:buffers.vertex,index:buffers.index,count:node.geometry.indices.length,stride:24}];const primitive=r.meshPrimitive[0];primitive.vertex=buffers.vertex;primitive.index=buffers.index;primitive.count=node.geometry.indices.length;primitives=r.meshPrimitive;}
      else primitives=r.source.shadowPrimitives??emptyPrimitives;
      for(let i=0;i<primitives.length;i++){const primitive=primitives[i],node=primitive.node;node.check();if(node.engine!==this.engine)throw new Error('Shadow source belongs to another engine');let visible=true;
        for(let id=node.id;id!==-1;id=this.engine!.store.parents[id])if(this.engine!.store.hidden[id])visible=false;if(!visible)continue;
        this.draw(pass,primitive,matrix,cascade);if(cached)this.stats.staticDraws++;else this.stats.dynamicDraws++;
      }
    }}catch(error){try{pass.end();}catch{}throw error;}pass.end();
  }
  private draw(pass:GPURenderPassEncoder,p:ShadowPrimitive,matrix:Float32Array,cascade:number):void {
    if(p.stride!==24&&p.stride!==80)throw new RangeError('Unsupported shadow vertex stride');
    const transform=p.alphaTransform;
    if(transform!==undefined&&(!(transform instanceof Float32Array)||transform.length!==8||transform.some(v=>!Number.isFinite(v))||p.stride!==80))throw new TypeError('Shadow alpha transform requires finite affine rows and PBR vertices');
    const key=p.stride+(transform?1:0);let pipeline=this.pipelines.get(key);
    if(!pipeline){const module=this.device!.createShaderModule({code:shadowDepth(p.stride===80,!!transform)});pipeline=this.device!.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:p.stride,attributes:p.stride===80?[{shaderLocation:0,offset:0,format:'float32x4'},{shaderLocation:3,offset:48,format:'float32x4'},{shaderLocation:4,offset:64,format:'float32x4'}]:[{shaderLocation:0,offset:0,format:'float32x3'}]}]},fragment:{module,entryPoint:'fragment',targets:[]},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less-equal'}});this.pipelines.set(key,pipeline);}
    // Primitives sharing a node can have different alpha maps and geometry.
    let records=this.draws.get(p.node);if(!records){records=new Map();this.draws.set(p.node,records);}let record=records.get(p.index);
    if(!record||record.vertex!==p.vertex||record.pipeline!==pipeline||record.alpha!==p.alphaTexture||record.sampler!==p.alphaSampler){
      if(record)for(const b of record.uniforms)b.destroy();records.delete(p.index);
      const uniforms:GPUBuffer[]=[],groups:GPUBindGroup[]=[];
      try{for(let i=0;i<4;i++){
        const buffer=this.device!.createBuffer({size:transform?176:144,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});uniforms.push(buffer);
        groups.push(this.device!.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer}},{binding:1,resource:p.alphaTexture??this.whiteView!},{binding:2,resource:p.alphaSampler??this.alphaSampler!}]}));
      }}catch(error){for(const buffer of uniforms)buffer.destroy();throw error;}
      record={uniforms,groups,values:new Float32Array(transform?44:36),vertex:p.vertex,index:p.index,pipeline,alpha:p.alphaTexture,sampler:p.alphaSampler};records.set(p.index,record);
    }
    record.values.set(matrix);record.values.set(p.node.matrix,16);record.values[32]=p.alpha??1;record.values[33]=p.cutoff??0;record.values[34]=p.texCoord??0;if(transform)record.values.set(transform,36);this.device!.queue.writeBuffer(record.uniforms[cascade],0,record.values as Float32Array<ArrayBuffer>);
    pass.setPipeline(pipeline);pass.setBindGroup(0,record.groups[cascade]);pass.setVertexBuffer(0,p.vertex);pass.setIndexBuffer(p.index,'uint32');pass.drawIndexed(p.count);
  }
  private clearDraws():void {for(const records of this.draws.values())for(const r of records.values())for(const b of r.uniforms)b.destroy();this.draws.clear();}
  private release():void {this.clearDraws();for(const texture of [this.cached,this.combined,this.white])texture?.destroy();this.uniform?.destroy();this.cached=this.combined=this.white=undefined;this.whiteView=undefined;this.uniform=undefined;this.views=[];this.cachedViews=[];this.entries=[];this.pipelines.clear();this.shaders.clear();for(const shadow of this.shadowContexts){shadow.context=undefined!;shadow.pass=undefined!;}}
  onDeviceRestored(engine:Engine):void {this.release();this.setup(engine);}
  dispose():void {if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);for(const r of this.sources)r.removeLighting?.();this.sources.length=0;this.release();this.engine=this.device=undefined;}
  destroy():void {this.dispose();}
}
