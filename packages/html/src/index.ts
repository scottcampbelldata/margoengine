import type {EngineKernel} from '@margoengine/core';
import {engineRuntime,type Engine,type FrameGraph,type PassContext} from '@margoengine/core/extension';
import {LabelRenderer,Label,type CSS3DObject,type LabelRendererOptions,type LabelOptions} from '@margoengine/labels';
import {acquireDepth,compute,group,dispatch} from '../../shared/gpu.js';
import {resolveMSAA} from '../../shared/msaa.js';
export {Label,CSS3DObject,projectPoint} from '@margoengine/labels';
export type {LabelOptions,CSS3DOptions,LabelInfo} from '@margoengine/labels';
declare const GPUBufferUsage:{STORAGE:number;COPY_DST:number;COPY_SRC:number;MAP_READ:number};
declare const GPUMapMode:{READ:number};
export interface HTMLOptions extends LabelRendererOptions {depth?:false|(()=>GPUTexture|undefined);capacity?:number;depthBias?:number}
const shader=`
@group(0) @binding(0) var depth:texture_depth_2d;
@group(0) @binding(1) var<storage,read> points:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> output:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&points)){return;}let point=points[id.x];let p=vec2i(point.xy);let size=vec2i(textureDimensions(depth));
 output[id.x]=0u;if(any(p<vec2i(0))||any(p>=size)){return;}
 let d=textureLoad(depth,p,0);output[id.x]=select(0u,1u,d>point.z+point.w);
}`;
interface Record {label:Label;index:number;hidden:boolean;x:number;y:number;z:number}
/** DOM projection from labels, with asynchronous rendered-depth occlusion for 2D anchors. */
export class HTML extends LabelRenderer {
 private runtime?:Engine;private readonly records=new Map<Label,Record>();private slots:(Record|undefined)[];private readonly values:Float32Array;private readonly capacity:number;
 private shared?:ReturnType<typeof acquireDepth>;private source?:()=>GPUTexture|undefined;private input?:GPUBuffer;private output?:GPUBuffer;private read?:GPUBuffer;private pipeline?:GPUComputePipeline;private pending=false;private generation=0;private disposed=false;
 private sampledDepth?:GPUTexture;private depthGroup?:GPUBindGroup;
 constructor(private readonly settings:HTMLOptions={}){
  super({...settings,name:settings.name??'html',order:1000});
  const capacity=settings.capacity??1024,bias=settings.depthBias??0.0001;
  if(!Number.isInteger(capacity)||capacity<1||capacity>4096||!Number.isFinite(bias)||bias<0||bias>0.05||settings.depth!==undefined&&settings.depth!==false&&typeof settings.depth!=='function')throw new RangeError('Invalid HTML depth options');
  this.capacity=capacity;this.values=new Float32Array(capacity*4);this.slots=new Array(capacity);
 }
 static attach(engine:EngineKernel,options:HTMLOptions={}):HTML {const overlay=new HTML(options);engineRuntime(engine).use(overlay);return overlay;}
 override add(element:HTMLElement,options:LabelOptions={}):Label {
  if(this.disposed)throw new Error('HTML is disposed');const index=this.slots.findIndex(record=>!record);
  if(index<0)throw new RangeError('HTML anchor capacity exceeded');
  const label=super.add(element,{...options,occlude:(item,info)=>{
   const record=this.records.get(item)!;record.x=info.x;record.y=info.y;record.z=1-info.depth;
   const canvas=this.runtime?.canvas;if(canvas){const scaleX=canvas.width/(canvas.clientWidth||canvas.width),scaleY=canvas.height/(canvas.clientHeight||canvas.height),at=index*4;this.values[at]=info.x*scaleX;this.values[at+1]=info.y*scaleY;this.values[at+2]=record.z;this.values[at+3]=this.settings.depthBias??0.0001;}
   return !!(options.occlude??this.settings.occlude)?.(item,info)||record.hidden;
  }});
  const record={label,index,hidden:false,x:0,y:0,z:0};this.records.set(label,record);this.slots[index]=record;return label;
 }
 override remove(item:Label|CSS3DObject):void {const record=this.records.get(item as Label);if(record){this.slots[record.index]=undefined;this.records.delete(item as Label);this.values.set([-1,-1,0,0],record.index*4);}super.remove(item);}
 override setup(instance:EngineKernel):void {if(this.disposed)throw new Error('HTML is disposed');this.runtime=engineRuntime(instance);super.setup(instance);this.setupGPU();}
 private setupGPU():void {
  const engine=this.runtime!;if(!engine.gpu||this.settings.depth===false)return;
  this.shared=this.settings.depth?undefined:acquireDepth(engine);this.source=this.settings.depth||this.shared!.texture;
  this.input=engine.gpu.createBuffer({size:this.values.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
  this.output=engine.gpu.createBuffer({size:this.capacity*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
  this.read=engine.gpu.createBuffer({size:this.capacity*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});this.pipeline=compute(engine.gpu,shader);
 }
 override registerPasses(graph:FrameGraph):void {super.registerPasses(graph);graph.add({name:this.name+':depth',order:1001,execute:c=>{if(c.backend==='webgpu'&&this.pipeline&&!this.pending)this.sample(c);}});}
 private sample(c:Extract<PassContext,{backend:'webgpu'}>):void {
  resolveMSAA(c);
  const depth=this.source!();if(!depth||depth.width!==c.width||depth.height!==c.height||!depth.format.startsWith('depth'))throw new Error('HTML requires viewport-sized scene depth');
  if(!this.records.size)return;
  for(let i=0;i<this.capacity;i++)if(!this.slots[i]||!this.slots[i]!.label.visible||!this.slots[i]!.label.screen.inFrustum){const at=i*4;this.values[at]=this.values[at+1]=-1;this.values[at+2]=this.values[at+3]=0;}
  c.device.queue.writeBuffer(this.input!,0,this.values as Float32Array<ArrayBuffer>);
  if(!this.depthGroup||depth!==this.sampledDepth){this.depthGroup=group(c.device,this.pipeline!,[depth.createView({aspect:'depth-only'}),{buffer:this.input!},{buffer:this.output!}]);this.sampledDepth=depth;}
  dispatch(c,this.pipeline!,this.depthGroup,Math.ceil(this.capacity/64));
  const read=this.read!,generation=this.generation,requests=this.slots.map(record=>record?{record,x:record.x,y:record.y,z:record.z}:undefined);
  c.encoder.copyBufferToBuffer(this.output!,0,read,0,this.capacity*4);this.pending=true;
  queueMicrotask(async()=>{try{
   await read.mapAsync(GPUMapMode.READ);if(this.disposed||generation!==this.generation)return;
   const result=new Uint32Array(read.getMappedRange());
   for(let i=0;i<this.capacity;i++){const request=requests[i];if(request&&this.slots[i]===request.record&&Math.abs(request.x-request.record.x)+Math.abs(request.y-request.record.y)<4&&Math.abs(request.z-request.record.z)<0.001)request.record.hidden=!!result[i];}
  }catch{for(const record of this.records.values())record.hidden=false;}
  finally{if(read.mapState==='mapped')read.unmap();if(generation===this.generation)this.pending=false;}});
 }
 private release():void {this.generation++;this.pending=false;this.shared?.release();this.shared=undefined;this.input?.destroy();this.output?.destroy();this.read?.destroy();this.input=this.output=this.read=undefined;this.pipeline=undefined;this.sampledDepth=this.depthGroup=undefined;}
 onDeviceRestored():void {this.release();for(const record of this.records.values())record.hidden=false;this.setupGPU();}
 override dispose():void {if(this.disposed)return;this.disposed=true;this.runtime?.removePlugin(this.name);this.release();super.dispose();this.records.clear();this.slots.fill(undefined);this.runtime=undefined;}
}
