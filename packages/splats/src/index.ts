/// <reference lib="esnext.disposable" preserve="true" />
import type {EngineKernel} from '@margoengine/core';
import {engineRuntime,type Engine,type EnginePlugin,type FrameGraph,type PassContext} from '@margoengine/core/extension';
import {viewMatrix} from '../../shared/view.js';
import {orthographic} from '../../shared/projection.js';
import {validateSplats,type SplatData} from './data.js';
import {project,render} from './shader.js';
import {histogram,scan,scanTotals,scatter} from './sort.js';
export {parseSplat,validateSplats,type SplatData} from './data.js';
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number;COPY_SRC:number;STORAGE:number;INDEX:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
let nextId=0;
export class Splats implements EnginePlugin {
  readonly name='splats:'+nextId++;readonly count:number;
  private readonly positions:Float32Array;private readonly covariances:Float32Array;private readonly colors:Float32Array;private readonly sh:Float32Array;
  private engine?:Engine;private device?:GPUDevice;private buffers:GPUBuffer[]=[];private uniform?:GPUBuffer;private index?:GPUBuffer;private projected?:GPUBuffer;private evaluated?:GPUBuffer;private keys:GPUBuffer[]=[];
  private projection?:GPUComputePipeline;private projectionGroup?:GPUBindGroup;private sortPipelines:GPUComputePipeline[]=[];private sortGroups:GPUBindGroup[][]=[];
  private renders=new Map<string,{pipeline:GPURenderPipeline;group:GPUBindGroup}>();private disposed=false;
  // Reused each frame: the draw pass descriptor and the pipeline record for the current target formats.
  private readonly attachment:GPURenderPassColorAttachment={view:undefined!,loadOp:'load',storeOp:'store'};
  private readonly plainDepth:GPURenderPassDepthStencilAttachment={view:undefined!,depthReadOnly:true};private readonly stencilDepth:GPURenderPassDepthStencilAttachment={view:undefined!,depthReadOnly:true,stencilReadOnly:true};
  private readonly presentation:GPURenderPassDescriptor={colorAttachments:[this.attachment],depthStencilAttachment:this.plainDepth};
  private record?:{pipeline:GPURenderPipeline;group:GPUBindGroup};private recordSamples?:number;private recordFormat?:GPUTextureFormat;private recordDepth?:GPUTextureFormat;
  private readonly values=new Float32Array(48);private readonly integers=new Uint32Array(this.values.buffer);private readonly view=this.values.subarray(16,32);
  constructor(data:SplatData){
    this.count=validateSplats(data);this.positions=new Float32Array(this.count*4);this.covariances=new Float32Array(this.count*8);this.colors=data.colors.slice();this.sh=data.sphericalHarmonics?.slice()??new Float32Array(4);
    for(let i=0;i<this.count;i++){this.positions.set(data.positions.subarray(i*3,i*3+3),i*4);this.positions[i*4+3]=data.colors[i*4+3];this.covariances.set(data.covariances.subarray(i*6,i*6+6),i*8);}
  }
  static attach(instance:EngineKernel,data:SplatData):Splats {const effect=new Splats(data);engineRuntime(instance).use(effect);return effect;}
  setup(engine:Engine):void {
    if(this.disposed||!engine.gpu)throw new Error('Splats require WebGPU and a live cloud');this.engine=engine;this.device=engine.gpu;
    const d=this.device,groups=Math.ceil(this.count/256),blocks=Math.ceil(groups/256);
    if(blocks*16>1024||groups>d.limits.maxComputeWorkgroupsPerDimension||d.limits.maxComputeInvocationsPerWorkgroup<256||d.limits.maxComputeWorkgroupSizeX<256||d.limits.maxStorageBuffersPerShaderStage<7)throw new RangeError('Splat compute exceeds device limits');
    for(const size of [this.positions.byteLength,this.covariances.byteLength,this.colors.byteLength,this.sh.byteLength,this.count*32,this.count*16,this.count*8,groups*16*4])if(size>d.limits.maxBufferSize||size>d.limits.maxStorageBufferBindingSize)throw new RangeError('Splat attributes exceed device storage limits');
    const buffer=(size:number,usage:number,data?:Float32Array|Uint32Array)=>{const b=d.createBuffer({size,usage:usage|GPUBufferUsage.COPY_DST});this.buffers.push(b);if(data)d.queue.writeBuffer(b,0,data as Float32Array<ArrayBuffer>);return b;};
    this.uniform=buffer(192,GPUBufferUsage.UNIFORM);this.index=buffer(24,GPUBufferUsage.INDEX,new Uint32Array([0,1,2,2,1,3]));
    const positions=buffer(this.positions.byteLength,GPUBufferUsage.STORAGE,this.positions),covariances=buffer(this.covariances.byteLength,GPUBufferUsage.STORAGE,this.covariances),colors=buffer(this.colors.byteLength,GPUBufferUsage.STORAGE,this.colors),sh=buffer(this.sh.byteLength,GPUBufferUsage.STORAGE,this.sh);
    this.projected=buffer(this.count*32,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);this.evaluated=buffer(this.count*16,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
    this.keys=[0,1].map(()=>buffer(this.count*8,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC));
    const hist=buffer(groups*16*4,GPUBufferUsage.STORAGE),offsets=buffer(groups*16*4,GPUBufferUsage.STORAGE),totals=buffer(blocks*16*4,GPUBufferUsage.STORAGE),bases=buffer(blocks*16*4,GPUBufferUsage.STORAGE);
    const compute=(code:string)=>d.createComputePipeline({layout:'auto',compute:{module:d.createShaderModule({code}),entryPoint:'main'}}),bind=(pipeline:GPUComputePipeline,list:GPUBuffer[])=>d.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:list.map((b,binding)=>({binding,resource:{buffer:b}}))});
    this.projection=compute(project);this.projectionGroup=bind(this.projection,[this.uniform,positions,covariances,colors,sh,this.projected,this.evaluated,this.keys[0]]);
    this.sortPipelines=[histogram,scan,scanTotals,scatter].map(compute);
    for(let pass=0;pass<8;pass++){const parameters=buffer(16,GPUBufferUsage.UNIFORM,new Uint32Array([this.count,groups,blocks,pass*4])),front=pass%2;
      this.sortGroups.push([bind(this.sortPipelines[0],[parameters,this.keys[front],hist]),bind(this.sortPipelines[1],[parameters,hist,offsets,totals]),bind(this.sortPipelines[2],[parameters,totals,bases]),bind(this.sortPipelines[3],[parameters,this.keys[front],this.keys[1-front],offsets,bases])]);}
  }
  registerPasses(graph:FrameGraph):void {graph.add({name:this.name+':project-sort',order:-7,execute:c=>{if(c.backend==='webgpu')this.sort(c);}});graph.add({name:this.name+':draw',order:3,execute:c=>{if(c.backend==='webgpu')this.draw(c);}});}
  private sort(c:Context):void {
    this.values.set(c.camera.matrix);viewMatrix(this.view,c.camera);this.values.set(c.camera.position,32);const focal=c.height/(2*Math.tan(c.camera.fov*Math.PI/360));
    const v=this.values,n=this.integers,e=c.encoder;v[36]=c.width;v[37]=c.height;v[38]=v[39]=focal;v[40]=c.camera.near;v[41]=c.camera.far;v[42]=+(c.format==='rgba16float');v[43]=0;
    // Orthographic clip matrix (e.g. @margoengine/cameras): affine Jacobian in pixels per world unit, signed near/far.
    const o=orthographic(c.camera.matrix,c.camera.position);if(o){v[38]=o.sx*c.width/2;v[39]=o.sy*c.height/2;v[40]=o.near;v[41]=o.far;v[43]=1;}
    n[44]=this.count;n[45]=this.sh.length===4?0:this.sh.length/this.count/3;n[46]=n[47]=0;c.device.queue.writeBuffer(this.uniform!,0,this.values as Float32Array<ArrayBuffer>);
    const groups=Math.ceil(this.count/256),blocks=Math.ceil(groups/256);this.dispatch(e,this.projection!,this.projectionGroup!,groups,1);
    for(let pass=0;pass<8;pass++){const binds=this.sortGroups[pass];this.dispatch(e,this.sortPipelines[0],binds[0],groups,1);this.dispatch(e,this.sortPipelines[1],binds[1],blocks,16);this.dispatch(e,this.sortPipelines[2],binds[2],1,1);this.dispatch(e,this.sortPipelines[3],binds[3],groups,1);}
  }
  private dispatch(encoder:GPUCommandEncoder,pipeline:GPUComputePipeline,group:GPUBindGroup,x:number,y:number):void {const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(x,y);pass.end();}
  private draw(c:Context):void {
    const samples=c.descriptor.multisample?.count,depthFormat=c.descriptor.depthStencil!.format;let record=this.record;
    if(!record||this.recordSamples!==samples||this.recordFormat!==c.format||this.recordDepth!==depthFormat){const key=samples+':'+c.format+':'+depthFormat;record=this.renders.get(key);
    if(!record){const module=c.device.createShaderModule({code:render}),pipeline=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:c.format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},multisample:c.descriptor.multisample,depthStencil:{format:c.descriptor.depthStencil!.format,depthWriteEnabled:false,depthCompare:'greater-equal'}});
      record={pipeline,group:c.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[this.uniform!,this.projected!,this.evaluated!,this.keys[0]].map((buffer,binding)=>({binding,resource:{buffer}}))})};this.renders.set(key,record);}
      this.record=record;this.recordSamples=samples;this.recordFormat=c.format;this.recordDepth=depthFormat;this.presentation.depthStencilAttachment=depthFormat.includes('stencil')?this.stencilDepth:this.plainDepth;}
    // shortcut: clouds sort independently, combine overlapping clouds into one data set.
    this.attachment.view=c.color;this.presentation.depthStencilAttachment!.view=c.depth;const pass=c.encoder.beginRenderPass(this.presentation);pass.setPipeline(record.pipeline);pass.setBindGroup(0,record.group);pass.setIndexBuffer(this.index!,'uint32');pass.drawIndexed(6,this.count);pass.end();this.engine!.stats.drawCalls++;
  }
  get gpuState():{sorted:GPUBuffer;ellipses:GPUBuffer;colors:GPUBuffer} {if(!this.projected||!this.evaluated||!this.keys.length)throw new Error('Splats are not attached');return {sorted:this.keys[0],ellipses:this.projected,colors:this.evaluated};}
  private release():void {for(const b of this.buffers)b.destroy();this.buffers=[];this.keys=[];this.sortGroups=[];this.sortPipelines=[];this.renders.clear();this.record=undefined;this.uniform=this.index=this.projected=this.evaluated=undefined;this.projection=undefined;this.projectionGroup=undefined;}
  onDeviceRestored(engine:Engine):void {this.release();this.setup(engine);}
  dispose():void {if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);this.release();this.engine=this.device=undefined;}
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
  /** @deprecated Use dispose(); kept as an alias until 1.0. */
  destroy():void {this.dispose();}
}
