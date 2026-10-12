import {Geometry,PbrMaterial,type EngineKernel} from '@margoengine/core';
export {ScatterInstances, type ScatterBatch} from './instances.js';
export {randomPlacements, radialPlacements} from './candidates.js';
export {PlacementLayout, spacePlacements, clearPlacements, placementBounds, instanceTransforms, groundTransforms, type GroundPlacement, type GroundBounds, type GroundCircle, type Placement} from './placement.js';
import {windShader,validateWind,type ScatterWind} from './wind.js';
export type {ScatterWind} from './wind.js';
import {validateExclusions, type GroundBounds} from './placement.js';
import {engineRuntime,type Engine,type EnginePlugin,type FrameGraph,type PassContext} from '@margoengine/core/extension';
import {group,compute,dispatch} from '../../shared/gpu.js';
declare const GPUBufferUsage:{VERTEX:number;INDEX:number;STORAGE:number;INDIRECT:number;UNIFORM:number;COPY_DST:number};
declare const GPUTextureUsage:{TEXTURE_BINDING:number;COPY_DST:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
const heightFormats=['r32float','r16float','rgba32float','rgba16float','r8unorm'];
export interface ScatterOptions {count?:number;area?:readonly [number,number];center?:readonly [number,number,number];density?:number;minHeight?:number;maxHeight?:number;maxSlope?:number;scale?:readonly [number,number];lod?:readonly [number,number,number];lodFade?:number;seed?:number;color?:readonly [number,number,number];material?:PbrMaterial;exclusions?:readonly GroundBounds[];heightmap?:()=>GPUTexture|undefined;wind?:ScatterWind}
const frame=`
struct Frame {camera:mat4x4f,eye:vec4f,area:vec4f,rules:vec4f,scale:vec4f,lod:vec4f,ids:vec4u,color:vec4f,planes:array<vec4f,6>,wind:vec4f}
struct Instance {position:vec4f,rotation:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
`;
const cull=frame+`
@group(0) @binding(1) var terrain:texture_2d<f32>;
@group(0) @binding(2) var<storage,read_write> near:array<Instance>;
@group(0) @binding(3) var<storage,read_write> middle:array<Instance>;
@group(0) @binding(4) var<storage,read_write> far:array<Instance>;
struct Command {indices:u32,count:atomic<u32>,first:u32,base:u32,instance:u32}
@group(0) @binding(5) var<storage,read_write> commands:array<Command,3>;
@group(0) @binding(6) var<storage,read> exclusions:array<vec4f>;
fn hash(value:u32)->f32 {var x=value^frame.ids.y;x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;x=x^(x>>16u);return f32(x)/4294967296.0;}
fn height(p:vec2i)->f32 {return textureLoad(terrain,clamp(p,vec2i(0),vec2i(textureDimensions(terrain))-1),0).r;}
fn emit(ring:u32,instance:Instance){
 let slot=atomicAdd(&commands[ring].count,1u);
 if(ring==0u){near[slot]=instance;}else if(ring==1u){middle[slot]=instance;}else{far[slot]=instance;}
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let i=id.x;if(i>=frame.ids.x||hash(i*7u+1u)>frame.rules.w){return;}
 let columns=frame.ids.z;let rows=(frame.ids.x+columns-1u)/columns;
 let uv=vec2f((f32(i%columns)+hash(i*7u+2u))/f32(columns),(f32(i/columns)+hash(i*7u+3u))/f32(rows));
 let size=vec2i(textureDimensions(terrain));let pixel=clamp(vec2i(uv*vec2f(size)),vec2i(0),size-1);let h=height(pixel)+frame.scale.z;
 let normal=normalize(vec3f(-(height(pixel+vec2i(1,0))-height(pixel-vec2i(1,0)))*f32(size.x)/(2.0*frame.area.x),1.0,-(height(pixel+vec2i(0,1))-height(pixel-vec2i(0,1)))*f32(size.y)/(2.0*frame.area.y)));
 if(h<frame.rules.x||h>frame.rules.y||normal.y<frame.rules.z){return;}
 let p=vec3f((uv.x-0.5)*frame.area.x+frame.area.z,h,(uv.y-0.5)*frame.area.y+frame.area.w);
 let scale=mix(frame.scale.x,frame.scale.y,hash(i*7u+4u));let radius=frame.lod.w*scale;
 for(var j=0u;j<u32(frame.eye.w);j++){
  let bounds=exclusions[j];let offset=p.xz-clamp(p.xz,bounds.xy,bounds.zw);
  if(dot(offset,offset)<=radius*radius){return;}
 }
 for(var j=0u;j<6u;j++){if(dot(frame.planes[j].xyz,p)+frame.planes[j].w < -radius){return;}}
 let d=distance(p,frame.eye.xyz);if(d>frame.lod.z){return;}
 let angle=hash(i*7u+5u)*6.2831853;var instance=Instance(vec4f(p,scale),vec4f(cos(angle),sin(angle),0,0));
 for(var ring=0u;ring<2u;ring++){
  if((frame.ids.w&(1u<<ring))!=0u&&frame.scale.w>0.0&&abs(d-frame.lod[ring])<frame.scale.w*0.5){
   instance.rotation.z=(d-frame.lod[ring])/frame.scale.w+0.5;instance.rotation.w=1.0;emit(ring,instance);
   instance.rotation.w=2.0;emit(ring+1u,instance);return;
  }
 }
 emit(select(select(2u,1u,d<frame.lod.y),0u,d<frame.lod.x),instance);
}`;
const fadeCode=`
fn lodVisible(pixel:vec2f,fade:vec2f)->bool {
 if(fade.y==0.0){return true;}
 let bayer=array<u32,16>(0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5);let p=vec2u(pixel)%4u;
 let threshold=(f32(bayer[p.y*4u+p.x])+0.5)/16.0;
 return select(fade.x>=threshold,fade.x<threshold,fade.y==1.0);
}
`;
const renderCode=frame+fadeCode+windShader+`
@group(0) @binding(1) var<storage,read> instances:array<Instance>;
struct Output {@builtin(position) clip:vec4f,@location(0) normal:vec3f,@location(1) @interpolate(flat) lodFade:vec2f}
@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f,@builtin(instance_index) index:u32)->Output{
 let data=instances[index];let c=data.rotation.x;let s=data.rotation.y;
 var world=vec3f(c*p.x+s*p.z,p.y,-s*p.x+c*p.z)*data.position.w+data.position.xyz;let bend=windBend(world.y-data.position.y,data.position.xz,frame.wind);world+=vec3f(bend.x,0,bend.y);
 return Output(frame.camera*vec4f(world,1),windNormal(vec3f(c*n.x+s*n.z,n.y,-s*n.x+c*n.z),bend,frame.wind),data.rotation.zw);
}
@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f {if(!lodVisible(i.clip.xy,i.lodFade)){discard;}var color=frame.color.rgb*(0.25+max(0.0,dot(normalize(i.normal)*select(-1.0,1.0,front),normalize(vec3f(1,2,1))))*0.75);if(frame.color.w<0.5){color=pow(color/(1.0+color),vec3f(1.0/2.2));}return vec4f(color,1);}
`;
const pbrVertex=windShader+`
struct ScatterInstance {position:vec4f,rotation:vec4f}
@group(1) @binding(0) var<storage,read> instances:array<ScatterInstance>;
@group(1) @binding(1) var<uniform> material:array<vec4f,3>;
@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f,@builtin(instance_index) index:u32)->Output {
 let data=instances[index];let c=data.rotation.x;let s=data.rotation.y;
 var o:Output;o.position=vec3f(c*p.x+s*p.z,p.y,-s*p.x+c*p.z)*data.position.w+data.position.xyz;
 let bend=windBend(o.position.y-data.position.y,data.position.xz,material[2]);o.position+=vec3f(bend.x,0,bend.y);
 o.clip=frame.camera*vec4f(o.position,1);o.normal=windNormal(vec3f(c*n.x+s*n.z,n.y,-s*n.x+c*n.z),bend,material[2]);
 o.color=material[0].rgb;o.material=vec4f(material[1].xyz,1);o.lodFade=data.rotation.zw;return o;
}
`;
let serial=0;
export class Scatter implements EnginePlugin {
 readonly name='scatter:'+ ++serial;private engine?:Engine;private uniform?:GPUBuffer;private instances:GPUBuffer[]=[];private vertices:GPUBuffer[]=[];private indices:GPUBuffer[]=[];private commands?:GPUBuffer;private fallback?:GPUTexture;private compute?:GPUComputePipeline;private pipelines=new Map<string,GPURenderPipeline>();private readonly values=new Float32Array(72);private readonly meta=new Uint32Array(this.values.buffer);private readonly geometries:readonly Geometry[];private disposed=false;readonly count:number;
 private readonly materialValues=new Float32Array(12);private time=0;private terrain?:GPUTexture;private computeGroup?:GPUBindGroup;private readonly renderGroups=new Map<GPURenderPipeline,GPUBindGroup[]>();
 private exclusionBuffer?:GPUBuffer;private readonly exclusionValues:Float32Array;
 private pbrUniform?:GPUBuffer;private materialUniform?:GPUBuffer;private readonly pbrValues=new Float32Array(28);private pbrShader='';private pbrBindings:GPUBindGroupEntry[]=[];private readonly pbrGroups=new Map<GPURenderPipeline,GPUBindGroup>();
 private readonly attachment:GPURenderPassColorAttachment={view:undefined!,loadOp:'load',storeOp:'store'};
 private readonly depthAttachment:GPURenderPassDepthStencilAttachment={view:undefined!,depthLoadOp:'load',depthStoreOp:'store',stencilReadOnly:true};
 private readonly presentation:GPURenderPassDescriptor={colorAttachments:[this.attachment],depthStencilAttachment:this.depthAttachment};
 constructor(geometry:Geometry|readonly [Geometry,Geometry,Geometry],private readonly options:ScatterOptions={}){
  this.geometries=geometry instanceof Geometry?[geometry,geometry,geometry]:[...geometry];
  const {count=10000,area=[50,50],center=[0,0,0],density=1,minHeight=-10000,maxHeight=10000,maxSlope=45,scale=[0.7,1.3],lod=[25,60,120],lodFade=2,seed=1,color=[0.12,0.35,0.08]}=options;
  if(this.geometries.length!==3||this.geometries.some(g=>!(g instanceof Geometry))||!Number.isInteger(count)||count<1||count>1000000||area.length!==2||area.some(v=>!Number.isFinite(v)||v<=0||v>100000)||center.length!==3||center.some(v=>!Number.isFinite(Math.fround(v)))||![density,minHeight,maxHeight,maxSlope].every(Number.isFinite)||density<0||density>1||minHeight>maxHeight||maxSlope<0||maxSlope>90||scale.length!==2||scale.some(v=>!Number.isFinite(v)||v<=0||v>100)||scale[0]>scale[1]||lod.length!==3||lod.some((v,i)=>!Number.isFinite(v)||v<=0||v>100000||i>0&&v<=lod[i-1])||!Number.isInteger(seed)||seed<0||seed>0xffffffff||color.length!==3||color.some(v=>!Number.isFinite(v)||v<0||v>1)||options.heightmap!==undefined&&typeof options.heightmap!=='function')throw new RangeError('Invalid scatter rules');
  if(options.material!==undefined&&!(options.material instanceof PbrMaterial))throw new TypeError('Expected a PBR scatter material');
  if(!Number.isFinite(lodFade)||lodFade<0||lodFade>100000)throw new RangeError('Invalid scatter LOD fade');
  if(options.wind)validateWind(options.wind);
  const exclusions=options.exclusions??[];validateExclusions(exclusions);
  this.exclusionValues=new Float32Array(Math.max(1,exclusions.length)*4);
  for(let i=0;i<exclusions.length;i++)this.exclusionValues.set(exclusions[i],i*4);
  this.values[19]=exclusions.length; // eye.w holds the fixed exclusion count.
  this.count=count;this.values.set([area[0],area[1],center[0],center[2],minHeight,maxHeight,Math.cos(maxSlope*Math.PI/180),density,scale[0],scale[1],center[1],0,...lod,Math.max(...this.geometries.map(g=>g.bounds[3]+Math.hypot(g.bounds[0],g.bounds[1],g.bounds[2])))],20);
  this.values[35]*=(options.wind?2:1);
  this.values[31]=Math.min(lodFade,2*lod[0],lod[1]-lod[0],2*(lod[2]-lod[1]));
  this.meta.set([count,seed,Math.ceil(Math.sqrt(count*area[0]/area[1])),+(this.geometries[0]!==this.geometries[1])+2*+(this.geometries[1]!==this.geometries[2])],36);this.values.set(color,40);
 }
 static attach(engine:EngineKernel,geometry:Geometry|readonly [Geometry,Geometry,Geometry],options:ScatterOptions={}):Scatter {const effect=new Scatter(geometry,options);engineRuntime(engine).use(effect);return effect;}
 setup(engine:Engine):void {
  if(this.disposed||!engine.gpu)throw new Error('Scatter requires WebGPU');const d=engine.gpu;this.engine=engine;
  if(Math.max(this.count*32,this.exclusionValues.byteLength)>Math.min(d.limits.maxStorageBufferBindingSize,d.limits.maxBufferSize)||Math.ceil(this.count/64)>d.limits.maxComputeWorkgroupsPerDimension)throw new RangeError('Scatter exceeds GPU limits');
  this.uniform=d.createBuffer({size:this.values.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  this.exclusionBuffer=d.createBuffer({size:this.exclusionValues.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});d.queue.writeBuffer(this.exclusionBuffer,0,this.exclusionValues as Float32Array<ArrayBuffer>);
  if(this.options.material){this.pbrUniform=d.createBuffer({size:112,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.materialUniform=d.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.materialValues.set(this.options.material.data);}
  this.commands=d.createBuffer({size:60,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST});
  const commands=new Uint32Array(15);for(let i=0;i<3;i++){const g=this.geometries[i];commands[i*5]=g.indices.length;
   const v=d.createBuffer({size:g.vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}),index=d.createBuffer({size:g.indices.byteLength,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});
   this.vertices.push(v);this.indices.push(index);d.queue.writeBuffer(v,0,g.vertices as Float32Array<ArrayBuffer>);d.queue.writeBuffer(index,0,g.indices as Uint32Array<ArrayBuffer>);
   this.instances.push(d.createBuffer({size:this.count*32,usage:GPUBufferUsage.STORAGE}));
  }d.queue.writeBuffer(this.commands,0,commands);
  this.fallback=d.createTexture({size:[1,1],format:'r32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});d.queue.writeTexture({texture:this.fallback},new Float32Array(1),{bytesPerRow:4},[1,1]);this.compute=compute(d,cull);
 }
 onPreUpdate(delta:number):void {if(!Number.isFinite(delta)||delta<0)throw new RangeError('Invalid scatter delta');this.time+=delta;}
 registerPasses(graph:FrameGraph):void {
  graph.add({name:this.name+':distribute',order:-10,execute:c=>{if(c.backend!=='webgpu')return;
   const terrain=this.options.heightmap?.()??this.fallback!;
   if(!heightFormats.includes(terrain.format)||!(terrain.usage&GPUTextureUsage.TEXTURE_BINDING))throw new Error('Scatter needs a sampleable floating-height texture');
   this.values.fill(0,68,71);if(this.options.wind){const wind=this.options.wind,length=validateWind(wind);this.values[68]=wind[0]/length;this.values[69]=wind[1]/length;this.values[70]=wind[2];}this.values[71]=this.time;
   this.values.set(c.camera.matrix);this.values.set(c.camera.position,16);this.values.set(c.camera.planes,44);this.values[43]=+(c.format==='rgba16float');c.device.queue.writeBuffer(this.uniform!,0,this.values as Float32Array<ArrayBuffer>);
   for(let i=0;i<3;i++)c.encoder.clearBuffer(this.commands!,i*20+4,4);
   if(this.terrain!==terrain||!this.computeGroup){this.computeGroup=group(c.device,this.compute!,[{buffer:this.uniform!},terrain.createView(),...this.instances.map(buffer=>({buffer})),{buffer:this.commands!},{buffer:this.exclusionBuffer!}]);this.terrain=terrain;}
   dispatch(c,this.compute!,this.computeGroup,Math.ceil(this.count/64));
  }});
  graph.add({name:this.name+':lod',order:1.5,execute:c=>{if(c.backend==='webgpu')this.draw(c);}});
 }
 private draw(c:Context):void {
  const lit=!!this.options.material;
  if(lit){
   this.materialValues.set(this.options.material!.data);this.materialValues.set(this.values.subarray(68,72),8);c.device.queue.writeBuffer(this.materialUniform!,0,this.materialValues as Float32Array<ArrayBuffer>);
   if(this.pbrShader!==c.shader){this.pipelines.clear();this.renderGroups.clear();this.pbrGroups.clear();this.pbrShader=c.shader;}
   let changed=this.pbrBindings.length!==c.bindings.length;for(let i=0;!changed&&i<this.pbrBindings.length;i++)changed=this.pbrBindings[i].resource!==c.bindings[i].resource;
   if(changed){this.pbrGroups.clear();this.pbrBindings=c.bindings.slice();}
   this.pbrValues.set(c.camera.matrix);this.pbrValues.set(c.camera.position,16);this.pbrValues.set(this.engine!.lighting.direction,20);this.pbrValues.set(this.engine!.lighting.radiance,24);c.device.queue.writeBuffer(this.pbrUniform!,0,this.pbrValues as Float32Array<ArrayBuffer>);
  }
  const key=c.format+':'+c.descriptor.multisample?.count;let pipeline=this.pipelines.get(key);if(!pipeline){const code=lit?c.shader.replace(/struct Input \{[^}]+\}/,'').replace('@location(3) material:vec4f','@location(3) material:vec4f,@location(4) @interpolate(flat) lodFade:vec2f').replace(/@vertex fn vertex\([\s\S]*?(?=@fragment)/,pbrVertex).replace(/(@fragment fn fragment[^{]+\{)/,'$1\n if(!lodVisible(i.clip.xy,i.lodFade)){discard;}')+fadeCode:renderCode;const module=c.device.createShaderModule({code});pipeline=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'}]}]},fragment:{module,entryPoint:'fragment',targets:[{format:c.format}]},multisample:c.descriptor.multisample,depthStencil:{format:c.descriptor.depthStencil!.format,depthWriteEnabled:true,depthCompare:'greater-equal'}});this.pipelines.set(key,pipeline);}
  let groups=this.renderGroups.get(pipeline);if(!groups){groups=this.instances.map(buffer=>lit?c.device.createBindGroup({layout:pipeline!.getBindGroupLayout(1),entries:[{binding:0,resource:{buffer}},{binding:1,resource:{buffer:this.materialUniform!}}]}):group(c.device,pipeline!,[{buffer:this.uniform!},{buffer}]));this.renderGroups.set(pipeline,groups);}
  let lighting=this.pbrGroups.get(pipeline);if(lit&&!lighting){lighting=c.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.pbrUniform!}},...c.bindings]});this.pbrGroups.set(pipeline,lighting);}
  this.attachment.view=c.color;this.depthAttachment.view=c.depth;const pass=c.encoder.beginRenderPass(this.presentation);
  pass.setPipeline(pipeline);if(lit)pass.setBindGroup(0,lighting!);for(let i=0;i<3;i++){pass.setBindGroup(lit?1:0,groups[i]);pass.setVertexBuffer(0,this.vertices[i]);pass.setIndexBuffer(this.indices[i],'uint32');pass.drawIndexedIndirect(this.commands!,i*20);}pass.end();
 }
 private release():void {for(const b of [...this.instances,...this.vertices,...this.indices])b.destroy();this.instances=[];this.vertices=[];this.indices=[];this.exclusionBuffer?.destroy();this.exclusionBuffer=undefined;this.uniform?.destroy();this.commands?.destroy();this.fallback?.destroy();this.pbrUniform?.destroy();this.materialUniform?.destroy();this.pbrUniform=this.materialUniform=undefined;this.pbrShader='';this.pbrBindings.length=0;this.pbrGroups.clear();this.uniform=this.commands=undefined;this.fallback=undefined;this.compute=undefined;this.pipelines.clear();this.terrain=undefined;this.computeGroup=undefined;this.renderGroups.clear();}
 onDeviceRestored(engine:Engine):void {this.release();this.setup(engine);}
 dispose():void {if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);this.release();this.engine=undefined;}
}
