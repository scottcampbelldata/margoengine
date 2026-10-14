import type {EngineKernel,Mesh} from '@margoengine/core';
export {Picking,type PickHit} from './picking.js';
export type {Model,ModelPrimitive} from './models.js';
import {engineRuntime,meshRuntime,type Engine,type EnginePlugin,type FrameGraph,type PassContext,type DrawOptions} from '@margoengine/core/extension';
import {fullscreen,meshVertex,group,compute,render,dispatch,draw} from '../../shared/gpu.js';
import {Models,ModelDraws,modelCode,modelPipeline,hidden,isModel,type Model,type ModelPrimitive} from './models.js';
const maskFragment=`@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {if(culled(i,front)){discard;}return vec4f(1,0,0,1);}`;
declare const GPUBufferUsage:{STORAGE:number;UNIFORM:number;COPY_DST:number};
declare const GPUTextureUsage:{RENDER_ATTACHMENT:number;TEXTURE_BINDING:number;STORAGE_BINDING:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
export interface SelectionOptions {algorithm?:'jfa'|'morphological';width?:number;color?:readonly [number,number,number]}
const seedCode=`
@group(0) @binding(0) var mask:texture_2d<f32>;
@group(0) @binding(1) var output:texture_storage_2d<rg32sint,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){let p=vec2i(id.xy);if(any(id.xy>=textureDimensions(mask))){return;}let v=select(vec2i(-1),p,textureLoad(mask,p,0).r>0.5);textureStore(output,p,vec4i(v,0,0));}`;
const jumpCode=`
@group(0) @binding(0) var input:texture_2d<i32>;
@group(0) @binding(1) var output:texture_storage_2d<rg32sint,write>;
@group(0) @binding(2) var<uniform> settings:vec4i;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let p=vec2i(id.xy);let size=vec2i(textureDimensions(input));if(any(p>=size)){return;}var best=vec2i(-1);var distance=1e30;
 for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){let q=p+vec2i(x,y)*settings.x;if(any(q<vec2i(0))||any(q>=size)){continue;}let seed=textureLoad(input,q,0).xy;if(seed.x<0){continue;}let delta=vec2f(seed-p);let d=dot(delta,delta);if(d<distance){distance=d;best=seed;}}}
 textureStore(output,p,vec4i(best,0,0));
}`;
const composite=fullscreen+`
@group(0) @binding(0) var<uniform> settings:array<vec4f,2>;
@group(0) @binding(1) var mask:texture_2d<f32>;
@group(0) @binding(2) var seeds:texture_2d<i32>;
@fragment fn fragment(i:Vertex)->@location(0) vec4f{
 let p=vec2i(i.position.xy);if(textureLoad(mask,p,0).r>0.5){discard;}var hit=false;
 if(settings[0].y<0.5){let seed=textureLoad(seeds,p,0).xy;hit=seed.x>=0&&distance(vec2f(p),vec2f(seed))<=settings[0].x;}
 else {let size=vec2i(textureDimensions(mask));let radius=i32(ceil(settings[0].x));for(var y=-radius;y<=radius;y++){for(var x=-radius;x<=radius;x++){if(f32(x*x+y*y)>settings[0].x*settings[0].x){continue;}let q=clamp(p+vec2i(x,y),vec2i(0),size-1);hit=hit||textureLoad(mask,q,0).r>0.5;}}}
 if(!hit){discard;}return vec4f(settings[1].rgb,1);
}`;
export class Selection implements EnginePlugin {
 readonly name='selection';private engine?:Engine;private selected=new Set<Mesh|Model>();
 private readonly models=new Models();private readonly draws=new ModelDraws();private modelMask?:GPURenderPipeline;private resolved:ModelPrimitive[]=[];private readonly resolvedKey=[-1,-1];private revision=0;private flags=new Uint32Array(0);private buffer?:GPUBuffer;private uniform?:GPUBuffer;
 private mask?:GPUTexture;private msaaMask?:GPUTexture;private sampleCount=1;private fields:GPUTexture[]=[];private steps:GPUBuffer[]=[];private jumps:GPUBindGroup[]=[];private seed?:GPUComputePipeline;private jump?:GPUComputePipeline;private seedGroup?:GPUBindGroup;
 private maskView?:GPUTextureView;private msaaMaskView?:GPUTextureView;private readonly maskDraw:DrawOptions={clear:false};
 private maskPipeline?:GPURenderPipeline;private composite?:GPURenderPipeline;private bind?:GPUBindGroup;private format='';private depthFormat='';private readonly values=new Float32Array(8);private disposed=false;
 constructor(readonly options:SelectionOptions={}){this.validate();}
 static attach(engine:EngineKernel,options:SelectionOptions={}):Selection {const effect=new Selection(options);engineRuntime(engine).use(effect);return effect;}
 /** Core meshes, gltf-pro models, or glTF nodes (from `engine.pick`); a node outlines its own and its descendants' primitives. */
 set(meshes:Iterable<Mesh|Model>):void {
  if(this.disposed)throw new Error('Selection is disposed');const values=new Set(meshes);if(values.size>4096)throw new RangeError('Selection budget exceeded');
  if(this.engine)for(const value of values){const mesh=isModel(value)?value.root:value;if(isModel(value)&&value.disposed||this.engine.meshes.get(meshRuntime(mesh).id)!==mesh)throw new TypeError('Foreign or disposed selection mesh');}
  this.selected=values;this.revision++;
 }
 /** Selected model primitives, resolved again only when the selection or the attached models change. */
 private primitives(e:Engine):ModelPrimitive[] {
  const models=this.models.update(e);if(this.resolvedKey[0]===this.revision&&this.resolvedKey[1]===this.models.version)return this.resolved;
  const ids=new Set<number>();for(const value of this.selected)ids.add(meshRuntime(isModel(value)?value.root:value).id);
  this.resolved=[];this.resolvedKey[0]=this.revision;this.resolvedKey[1]=this.models.version;
  for(const model of models)for(const p of model.primitives)for(let id=p.node.id;id!==-1;id=e.store.parents[id])if(ids.has(id)){this.resolved.push(p);break;}
  return this.resolved;
 }
 private validate():void {const o=this.options;if(o.algorithm!==undefined&&!['jfa','morphological'].includes(o.algorithm)||!Number.isFinite(o.width??3)||(o.width??3)<1||(o.width??3)>32||(o.color??[1,0.5,0]).length!==3||(o.color??[]).some(v=>!Number.isFinite(v)||v<0||v>1))throw new RangeError('Invalid selection options');}
 setup(engine:Engine):void {
  if(this.disposed||!engine.gpu)throw new Error('Selection requires WebGPU');this.engine=engine;this.set(this.selected);
  this.flags=new Uint32Array(engine.store.capacity);this.buffer=engine.gpu.createBuffer({size:this.flags.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
  this.maskDraw.bindings=[{binding:1,resource:{buffer:this.buffer}}];
  this.uniform=engine.gpu.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.seed=compute(engine.gpu,seedCode);this.jump=compute(engine.gpu,jumpCode);
 }
 registerPasses(graph:FrameGraph):void {graph.add({name:'selection:outline',order:40,execute:c=>{if(c.backend==='webgpu')this.draw(c);}});}
 private resize(c:Context):void {
  if(this.mask?.width===c.width&&this.mask.height===c.height&&this.format===c.format&&this.depthFormat===c.descriptor.depthStencil!.format&&this.sampleCount===(c.descriptor.multisample?.count??1))return;
  this.releaseTargets();this.format=c.format;this.depthFormat=c.descriptor.depthStencil!.format;this.sampleCount=c.descriptor.multisample?.count??1;
  this.mask=c.device.createTexture({size:[c.width,c.height],format:'r8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
  if(this.sampleCount>1)this.msaaMask=c.device.createTexture({size:[c.width,c.height],sampleCount:this.sampleCount,format:'r8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT});
  this.maskView=this.mask.createView();this.msaaMaskView=this.msaaMask?.createView();
  this.fields=[0,1].map(()=>c.device.createTexture({size:[c.width,c.height],format:'rg32sint',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING}));
  this.seedGroup=group(c.device,this.seed!,[this.maskView,this.fields[0].createView()]);
  let step=2**Math.ceil(Math.log2(Math.max(c.width,c.height)))/2,index=0;
  for(;step>=1;step/=2,index++){
   const b=c.device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.steps.push(b);c.device.queue.writeBuffer(b,0,new Int32Array([step,0,0,0]));
   this.jumps.push(group(c.device,this.jump!,[this.fields[index%2].createView(),this.fields[(index+1)%2].createView(),{buffer:b}]));
  }
  const code=meshVertex+'@group(0) @binding(1) var<storage,read> selected:array<u32>; @fragment fn fragment(i:Output)->@location(0) vec4f{return vec4f(f32(selected[i.id]),0,0,1);}';
  const module=c.device.createShaderModule({code});
  this.maskPipeline=c.device.createRenderPipeline({...c.descriptor,layout:'auto',vertex:{...c.descriptor.vertex,module},fragment:{module,entryPoint:'fragment',targets:[{format:'r8unorm'}]},depthStencil:{...c.descriptor.depthStencil!,depthWriteEnabled:false,depthCompare:'equal'}});
  this.maskDraw.pipeline=this.maskPipeline;
  this.composite=render(c.device,composite,c.format,{multisample:c.descriptor.multisample});this.bind=group(c.device,this.composite,[{buffer:this.uniform!},this.maskView,this.fields[index%2].createView()]);
 }
 private draw(c:Context):void {
  if(!this.selected.size)return;
  this.validate();this.resize(c);this.flags.fill(0);for(const mesh of this.selected){if(isModel(mesh))continue;const id=meshRuntime(mesh).id;if(this.engine!.meshes.get(id)===mesh)this.flags[id]=1;}
  c.device.queue.writeBuffer(this.buffer!,0,this.flags as Uint32Array<ArrayBuffer>);this.values[0]=this.options.width??3;this.values[1]=+(this.options.algorithm==='morphological');this.values.set(this.options.color??[1,0.5,0],4);c.device.queue.writeBuffer(this.uniform!,0,this.values as Float32Array<ArrayBuffer>);
  const color=c.color;c.color=(this.msaaMaskView??this.maskView)!;
  try{const clear=c.encoder.beginRenderPass({colorAttachments:[{view:c.color,clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});clear.end();c.draw(this.maskDraw);this.drawModels(c);}
  finally{c.color=color;}
  if(this.msaaMaskView)c.encoder.beginRenderPass({colorAttachments:[{view:this.msaaMaskView,resolveTarget:this.maskView!,loadOp:'load',storeOp:'discard'}]}).end();
  if(this.options.algorithm!=='morphological'){dispatch(c,this.seed!,this.seedGroup!,Math.ceil(c.width/8),Math.ceil(c.height/8));for(const bind of this.jumps)dispatch(c,this.jump!,bind,Math.ceil(c.width/8),Math.ceil(c.height/8));}
  draw(c,this.composite!,this.bind!);
 }
 /** Selected gltf-pro primitives into the mask, equal depth against the scene so occluded parts stay unmarked. */
 private drawModels(c:Context):void {
  const e=this.engine!,draws=this.draws,list=this.primitives(e);draws.reset();
  for(let i=0;i<list.length;i++){const p=list[i];if(p.buffers&&!hidden(e,p.node.id))draws.add(p,1);}
  if(!draws.count)return;
  const format=c.descriptor.depthStencil!.format;
  this.modelMask??=modelPipeline(c.device,modelCode(maskFragment),'r8unorm',{format,depthWriteEnabled:false,depthCompare:'equal'},c.descriptor.multisample);
  const pass=c.encoder.beginRenderPass({colorAttachments:[{view:c.color,loadOp:'load',storeOp:'store'}],depthStencilAttachment:{view:c.depth,depthReadOnly:true,...(format.includes('stencil')?{stencilReadOnly:true}:{})}});
  draws.draw(c.device,pass,this.modelMask,c.camera.matrix);pass.end();
 }
 private releaseTargets():void {this.modelMask=undefined;this.mask?.destroy();this.msaaMask?.destroy();this.msaaMask=undefined;this.maskView=this.msaaMaskView=undefined;for(const t of this.fields)t.destroy();for(const b of this.steps)b.destroy();this.mask=undefined;this.fields=[];this.steps=[];this.jumps=[];this.bind=this.seedGroup=undefined;this.maskPipeline=this.composite=this.maskDraw.pipeline=undefined;}
 private release():void {this.releaseTargets();this.draws.release();this.buffer?.destroy();this.uniform?.destroy();this.buffer=this.uniform=undefined;this.maskDraw.bindings=undefined;this.seed=this.jump=undefined;}
 onDeviceRestored(engine:Engine):void {this.release();this.setup(engine);}
 dispose():void {if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);this.release();this.selected.clear();this.engine=undefined;}
}
