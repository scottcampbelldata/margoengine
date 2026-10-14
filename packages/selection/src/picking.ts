import type {EngineKernel} from '@margoengine/core';
import {engineRuntime,type Engine,type Mesh,type Geometry,type EnginePlugin,type FrameGraph,type PassContext,type DrawOptions} from '@margoengine/core/extension';
import {meshVertex} from '../../shared/gpu.js';
import {Models,ModelDraws,modelCode,modelPipeline,sphere,hidden,type Model,type ModelPrimitive} from './models.js';

declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number;MAP_READ:number};
declare const GPUTextureUsage:{RENDER_ATTACHMENT:number;COPY_SRC:number};
declare const GPUMapMode:{READ:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
type Snapshot={geometry:Geometry|null;values:Float32Array;visible:number};
const buffers:GPUVertexBufferLayout[]=[
 {arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'}]},
 {arrayStride:96,stepMode:'instance',attributes:Array.from({length:6},(_,i)=>({shaderLocation:i+2,offset:i*16,format:'float32x4' as const}))}
];
const microShader=meshVertex
 .replace('id:u32}', 'id:u32,@location(1) position:vec3f,@location(2) material:vec4f}')
 .replace('u32(i.factors.w))','u32(i.factors.w),p.xyz,vec4f(i.factors.xyz,sign(dot(i.m0.xyz,cross(i.m1.xyz,i.m2.xyz)))))')+`
@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) u32 {
 let facing=front==(i.material.w>0.0);if(!facing&&i.material.z<0.5){discard;}return i.id+1u;
}`;

function mrtShader(code:string):string {
 return code.replace('@location(3) material:vec4f','@location(3) material:vec4f,@location(4) @interpolate(flat) id:u32')
  .replace('o.color=i.color.rgb','o.id=u32(i.factors.w);o.color=i.color.rgb')
  .replace('@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f','fn shade(i:Output,front:bool)->vec4f')+`
struct PickPixel {@location(0) color:vec4f,@location(1) id:u32}
@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->PickPixel {return PickPixel(shade(i,front),i.id+1u);}`;
}

const idFragment=`@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) u32 {if(culled(i,front)){discard;}return i.info.x;}`;
/** A pick result: the core mesh, or for gltf-pro models the glTF node with its model and primitive. */
export interface PickHit {mesh:Mesh;model?:Model;primitive?:ModelPrimitive;primitiveIndex?:number}

function intersects(matrix:Float32Array,model:Float32Array,b:ArrayLike<number>,clip:Float64Array):boolean {
 for(let c=0;c<4;c++)for(let r=0;r<4;r++)clip[c*4+r]=matrix[r]*model[c*4]+matrix[4+r]*model[c*4+1]+matrix[8+r]*model[c*4+2]+matrix[12+r]*model[c*4+3];
 // Pull each plane into local space so nonuniform scale, mirrors and hierarchy shear stay conservative.
 for(let plane=0;plane<6;plane++){
  const row=plane>>1,sign=plane%2===0?1:-1;
  const a=plane===4?clip[2]:clip[3]+sign*clip[row],d=plane===4?clip[6]:clip[7]+sign*clip[4+row],e=plane===4?clip[10]:clip[11]+sign*clip[8+row],f=plane===4?clip[14]:clip[15]+sign*clip[12+row];
  if(a*b[0]+d*b[1]+e*b[2]+f+b[3]*Math.hypot(a,d,e)<0)return false;
 }
 return true;
}

/** Optional picking of core meshes (forward-pass IDs, or a culled 3x3 pass when the frame is stale) and gltf-pro models (always the 3x3 pass). */
export class Picking implements EnginePlugin {
 readonly name='picking';private engine?:Engine;private device?:GPUDevice;private disposed=false;private pending=false;
 private readonly models=new Models();private readonly draws=new ModelDraws();private modelPipeline?:GPURenderPipeline;private last:PickHit|null=null;
 private ids?:GPUTexture;private idsView?:GPUTextureView;private micro?:GPUTexture;private depth?:GPUTexture;private uniform?:GPUBuffer;private read?:GPUBuffer;
 private readonly pipelines=new Map<string,GPURenderPipeline>();private readonly groups=new Map<GPURenderPipeline,{entries:GPUBindGroupEntry[];group:GPUBindGroup}>();
 private readonly frame=new Float32Array(28);private readonly camera=new Float32Array(16);private readonly clip=new Float64Array(16);
 private readonly snapshot=new Map<Mesh,Snapshot>();private graphRevision=-1;private captured=false;
 private original?:Context['draw'];private context?:Context;
 /** `capture:false` skips the per-frame ID target and snapshot; every pick then uses the culled 3x3 pass. */
 constructor(readonly options:{capture?:boolean}={}){}
 static attach(engine:EngineKernel,options:{capture?:boolean}={}):Picking {const picking=new Picking(options);engineRuntime(engine).use(picking);return picking;}
 setup(engine:Engine):void {
  if(this.disposed||!engine.gpu)throw new Error('Picking requires WebGPU');this.engine=engine;this.device=engine.gpu;
  this.uniform=this.device.createBuffer({size:112,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  // Three 12-byte rows use WebGPU's 256-byte copy pitch; padding is never resolved as IDs.
  this.read=this.device.createBuffer({size:768,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  this.micro=this.device.createTexture({size:[3,3],format:'r32uint',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
  this.depth=this.device.createTexture({size:[3,3],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT});
 }
 registerPasses(graph:FrameGraph):void {
  if(this.options.capture===false)return;
  graph.add({name:'picking:capture',order:-1,execute:c=>{if(c.backend==='webgpu')this.capture(c);}});
  graph.add({name:'picking:restore',order:0.01,execute:c=>{if(c.backend==='webgpu'&&this.original){c.draw=this.original;this.original=undefined;}}});
 }
 private pipeline(c:Context,code:string,mrt:boolean):GPURenderPipeline {
  const key=code+':'+mrt+':'+c.format+':'+c.descriptor.depthStencil!.format;let pipeline=this.pipelines.get(key);
  if(!pipeline){
   if(this.pipelines.size>=64)throw new RangeError('Too many picking shader variants');
   const module=c.device.createShaderModule({code});
   pipeline=c.device.createRenderPipeline({...c.descriptor,layout:'auto',vertex:{...c.descriptor.vertex,module},fragment:{module,entryPoint:'fragment',targets:mrt?[{format:c.format},{format:'r32uint'}]:[{format:'r32uint'}]},
    depthStencil:mrt?c.descriptor.depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater-equal'}});this.pipelines.set(key,pipeline);
  }
  return pipeline;
 }
 private capture(c:Context):void {
  this.captured=false;this.context=c;
  // Integer IDs cannot be resolved; retain the existing single-sample micro pass under MSAA. Scenes with models always pick through it too.
  if((c.descriptor.multisample?.count??1)>1||this.models.update(this.engine!).length)return;
  if(this.ids?.width!==c.width||this.ids.height!==c.height){this.ids?.destroy();this.ids=c.device.createTexture({size:[c.width,c.height],format:'r32uint',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});this.idsView=this.ids.createView();}
  this.original=c.draw;const original=c.draw;
  c.draw=(options:DrawOptions={})=>{
   if(options.pipeline||!c.shader.includes('@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f')){original(options);return;}
   original({...options,pipeline:this.pipeline(c,mrtShader(c.shader),true),colorAttachments:[{view:this.idsView!,loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:0}}]});
   this.camera.set(c.camera.matrix);this.graphRevision=this.engine!.frameGraph.revision;
   for(const mesh of this.snapshot.keys())if(this.engine!.meshes.get(mesh.id)!==mesh)this.snapshot.delete(mesh);
   for(const mesh of this.engine!.meshes.values()){
    let saved=this.snapshot.get(mesh);if(!saved){saved={geometry:mesh.geometry,values:new Float32Array(24),visible:0};this.snapshot.set(mesh,saved);}
    saved.values.set(mesh.matrix);saved.values.set(mesh.material.data,16);saved.geometry=mesh.geometry;saved.visible=this.engine!.store.visible[mesh.id];
   }
   this.captured=true;
  };
 }
 private fresh():boolean {
  const e=this.engine!;
  // shortcut: mutable clipping uniforms have no revision, use the micro pass while sections are attached.
  if(!this.captured||e.hasPlugin('section-planes')||this.graphRevision!==e.frameGraph.revision||this.snapshot.size!==e.meshes.size||this.ids?.width!==e.canvas.width||this.ids.height!==e.canvas.height)return false;
  if(this.camera.some((v,i)=>v!==e.camera.matrix[i]))return false;
  for(const mesh of e.meshes.values()){
   const saved=this.snapshot.get(mesh);
   if(!saved||saved.geometry!==mesh.geometry||saved.visible!==e.store.visible[mesh.id]||saved.values.some((v,i)=>v!==(i<16?mesh.matrix[i]:mesh.material.data[i-16])))return false;
  }
  return true;
 }
 /** `engine.pick` hook: the core mesh, or the glTF node of a gltf-pro model, at a canvas CSS pixel. */
 async onPick(x:number,y:number):Promise<Mesh|null> {const hit=await this.resolve(x,y);this.last=hit;return hit?.mesh??null;}
 /** `engine.pick` (transforms and camera refreshed first), with the model and primitive for model hits. */
 async pick(x:number,y:number):Promise<PickHit|null> {
  if(this.disposed||!this.engine)throw new Error('Picking is disposed');
  this.last=null;const mesh=await this.engine.pick(x,y),hit=this.last as PickHit|null;this.last=null;return mesh&&hit?.mesh===mesh?hit:null;
 }
 private async resolve(x:number,y:number):Promise<PickHit|null> {
  if(this.disposed||!this.engine)throw new Error('Picking is disposed');if(this.pending)throw new Error('A pick is already pending');
  if(![x,y].every(Number.isFinite))throw new RangeError('Invalid pick coordinates');
  if(x<0||y<0||x>=this.engine.canvas.clientWidth||y>=this.engine.canvas.clientHeight)return null;
  this.pending=true;const e=this.engine,device=this.device!,read=this.read!,meshes=new Map(e.meshes),models=this.models.update(e),starts=this.models.starts,capacity=e.store.capacity;
  try {
   const px=Math.floor(x*e.canvas.width/e.canvas.clientWidth),py=Math.floor(y*e.canvas.height/e.canvas.clientHeight),x0=Math.max(0,px-1),y0=Math.max(0,py-1),width=Math.min(e.canvas.width,px+2)-x0,height=Math.min(e.canvas.height,py+2)-y0;
   const encoder=device.createCommandEncoder();let texture:GPUTexture,origin:number[];
   // Model IDs are not in the forward pass (gltf-pro draws its own pipelines), so scenes with models use the micro pass.
   if(!models.length&&this.fresh()){texture=this.ids!;origin=[x0,y0];}
   else {this.renderMicro(encoder,px,py);texture=this.micro!;origin=[1+x0-px,1+y0-py];}
   encoder.copyTextureToBuffer({texture,origin},{buffer:read,bytesPerRow:256},[width,height]);device.queue.submit([encoder.finish()]);
   await read.mapAsync(GPUMapMode.READ);
   try {
    const data=new Uint32Array(read.getMappedRange()),cx=px-x0,cy=py-y0;let id=data[cy*64+cx];
    if(!id)for(const [dx,dy] of [[0,-1],[-1,0],[1,0],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]]){
     const nx=cx+dx,ny=cy+dy;if(nx>=0&&ny>=0&&nx<width&&ny<height&&data[ny*64+nx]){id=data[ny*64+nx];break;}
    }
    let hit:PickHit|null=null;
    if(id>capacity){
     // Model slots follow the core slots: capacity + 1 + the model's first slot + primitive index.
     const slot=id-capacity-1;let m=models.length-1;while(m>0&&starts[m]>slot)m--;
     const model=models[m],primitiveIndex=slot-(starts[m]??0),primitive=model?.primitives[primitiveIndex];
     if(primitive&&!model.disposed)hit={mesh:primitive.node,model,primitive,primitiveIndex};
    } else {const mesh=meshes.get(id-1);if(mesh)hit={mesh};}
    if(this.disposed||device!==this.device||!hit||e.meshes.get(hit.mesh.id)!==hit.mesh||hidden(e,hit.mesh.id))return null;
    return hit;
   } finally {read.unmap();}
  } catch(error){if(this.disposed||device!==this.device||e.gpu!==device)return null;throw error;}
  finally {this.pending=false;}
 }
 private renderMicro(encoder:GPUCommandEncoder,x:number,y:number):void {
  const e=this.engine!,device=this.device!,matrix=e.camera.matrix.slice(),nx=2*(x+0.5)/e.canvas.width-1,ny=1-2*(y+0.5)/e.canvas.height;
  for(let c=0;c<4;c++){matrix[c*4]=(matrix[c*4]-nx*matrix[c*4+3])*e.canvas.width/3;matrix[c*4+1]=(matrix[c*4+1]-ny*matrix[c*4+3])*e.canvas.height/3;}
  this.frame.set(matrix);this.frame.set(e.camera.position,16);this.frame.set(e.lighting.direction,20);this.frame.set(e.lighting.radiance,24);device.queue.writeBuffer(this.uniform!,0,this.frame as Float32Array<ArrayBuffer>);
  const c:Context={backend:'webgpu',device,encoder,camera:e.camera,width:e.canvas.width,height:e.canvas.height,delta:0,color:this.micro!.createView(),depth:this.depth!.createView(),format:'r32uint',shader:microShader,bindings:[],indirect:false,
   descriptor:{layout:'auto',vertex:{module:undefined!,entryPoint:'vertex',buffers},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater-equal'}},draw:()=>{}};
  e.frameGraph.prepare(c);const pipeline=this.pipeline(c,c.shader,false);let cached=this.groups.get(pipeline);
  if(!cached||cached.entries.length!==c.bindings.length||c.bindings.some((entry,i)=>entry.resource!==cached!.entries[i].resource)){
   cached={entries:c.bindings.slice(),group:device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform!}},...c.bindings]})};this.groups.set(pipeline,cached);
  }
  const batches=new Map<Geometry,number[]>();
  for(const mesh of e.meshes.values())if(mesh.geometry&&e.store.visible[mesh.id]&&intersects(matrix,mesh.matrix,mesh.geometry.bounds,this.clip)){
   let values=batches.get(mesh.geometry);if(!values){values=[];batches.set(mesh.geometry,values);}values.push(...mesh.matrix,...mesh.material.data);values[values.length-1]=mesh.id;
  }
  const pass=encoder.beginRenderPass({colorAttachments:[{view:c.color,clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:c.depth,depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'store'}});
  pass.setPipeline(pipeline);pass.setBindGroup(0,cached.group);
  for(const [geometry,values] of batches){const gpu=e.geometryBuffers(geometry)!;device.queue.writeBuffer(gpu.instance,0,new Float32Array(values));pass.setVertexBuffer(0,gpu.vertex);pass.setVertexBuffer(1,gpu.instance);pass.setIndexBuffer(gpu.index,'uint32');pass.drawIndexed(geometry.indices.length,values.length/24);}
  // gltf-pro primitives whose bounding sphere meets the micro frustum, alpha cut-outs and transparency ignored, deformed (skinned) buffers used.
  const draws=this.draws,models=this.models.list,starts=this.models.starts;draws.reset();
  for(let m=0;m<models.length;m++){
   const model=models[m];if(model.disposed)continue;
   for(let i=0;i<model.primitives.length;i++){const p=model.primitives[i];if(p.buffers&&!hidden(e,p.node.id)&&intersects(matrix,p.node.matrix,sphere(p),this.clip))draws.add(p,e.store.capacity+1+starts[m]+i);}
  }
  if(draws.count){this.modelPipeline??=modelPipeline(device,modelCode(idFragment),'r32uint',{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater-equal'});draws.draw(device,pass,this.modelPipeline,matrix);}
  pass.end();
 }
 private release():void {
  for(const resource of [this.ids,this.micro,this.depth,this.uniform,this.read])resource?.destroy();
  this.ids=this.micro=this.depth=undefined;this.idsView=undefined;this.uniform=this.read=undefined;this.pipelines.clear();this.draws.release();this.modelPipeline=undefined;this.groups.clear();this.snapshot.clear();this.captured=false;this.context=undefined;
 }
 onDeviceRestored(engine:Engine):void {this.release();this.setup(engine);}
 dispose():void {
  if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);
  if(this.original&&this.context)this.context.draw=this.original;this.original=undefined;this.release();this.engine=undefined;
 }
}
