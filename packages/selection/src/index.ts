import type {EngineKernel,Mesh} from '@margoengine/core';
export {Picking,type PickHit} from './picking.js';
export type {Model,ModelPrimitive,PickProxy} from './models.js';
import {engineRuntime,meshRuntime,type Engine,type EnginePlugin,type FrameGraph,type PassContext,type DrawOptions} from '@margoengine/core/extension';
import {fullscreen,meshVertex,group,compute,render,dispatch,draw} from '../../shared/gpu.js';
import {Models,ModelDraws,modelCode,modelPipeline,hidden,isModel,type Model,type ModelPrimitive} from './models.js';
const maskFragment=`@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {if(culled(i,front)){discard;}return vec4f(1,0,0,1);}`;
declare const GPUBufferUsage:{STORAGE:number;UNIFORM:number;COPY_DST:number};
declare const GPUTextureUsage:{RENDER_ATTACHMENT:number;TEXTURE_BINDING:number;STORAGE_BINDING:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
/** Hidden-line style for the occluded parts of the selection: `dash` on/off length in pixels (0 = solid), `opacity` 0..1, `color` and `width` default to the outline's. */
export interface XRayOptions {dash?:number;opacity?:number;color?:readonly [number,number,number];width?:number}
export interface SelectionOptions {
 algorithm?:'jfa'|'morphological';width?:number;color?:readonly [number,number,number];
 /** Plugin name, unique per engine: attach one Selection per selection set (default 'selection'). */
 name?:string;
 /** Also outline the hidden (occluded) parts, dashed by default (`true` = `{dash: 4, opacity: 0.85}`). Mutable like the other options. */
 xray?:boolean|XRayOptions;
}
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
// X-ray: the outline of the whole selection (mask drawn without the depth test), dashed by the nearest silhouette pixel's
// coordinate along the edge's dominant axis, so straight and curved edges get dashes of the same screen length.
const xrayComposite=fullscreen+`
@group(0) @binding(0) var<uniform> settings:array<vec4f,2>;
@group(0) @binding(1) var mask:texture_2d<f32>;
@group(0) @binding(2) var seeds:texture_2d<i32>;
@fragment fn fragment(i:Vertex)->@location(0) vec4f{
 let p=vec2i(i.position.xy);if(textureLoad(mask,p,0).r>0.5){discard;}var seed=vec2i(-1);var best=1e30;
 if(settings[0].y<0.5){seed=textureLoad(seeds,p,0).xy;if(seed.x>=0){best=distance(vec2f(p),vec2f(seed));}}
 else {let size=vec2i(textureDimensions(mask));let radius=i32(ceil(settings[0].x));for(var y=-radius;y<=radius;y++){for(var x=-radius;x<=radius;x++){let q=clamp(p+vec2i(x,y),vec2i(0),size-1);let d=length(vec2f(f32(x),f32(y)));if(d<best&&textureLoad(mask,q,0).r>0.5){best=d;seed=q;}}}}
 if(best>settings[0].x){discard;}
 let d=abs(vec2f(p-seed));if(settings[0].z>0&&fract(select(f32(seed.y),f32(seed.x),d.y>=d.x)/(2*settings[0].z))>=0.5){discard;}
 return vec4f(settings[1].rgb,settings[0].w);
}`;
const blend:GPUBlendState={color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}};
export class Selection implements EnginePlugin {
 readonly name:string;private engine?:Engine;private selected=new Set<Mesh|Model>();
 /** X-ray state, created on first use: whole-selection mask pipelines, composite, its bind group and uniform, and model draws. */
 private xr?:{mask?:GPURenderPipeline;model?:GPURenderPipeline;composite?:GPURenderPipeline;bind?:GPUBindGroup;uniform?:GPUBuffer;readonly draw:DrawOptions;readonly draws:ModelDraws;readonly values:Float32Array};private fieldView?:GPUTextureView;
 private readonly models=new Models();private readonly draws=new ModelDraws();private modelMask?:GPURenderPipeline;private resolved:ModelPrimitive[]=[];private readonly resolvedKey=[-1,-1];private revision=0;private flags=new Uint32Array(0);private buffer?:GPUBuffer;private uniform?:GPUBuffer;
 private mask?:GPUTexture;private msaaMask?:GPUTexture;private sampleCount=1;private fields:GPUTexture[]=[];private steps:GPUBuffer[]=[];private jumps:GPUBindGroup[]=[];private seed?:GPUComputePipeline;private jump?:GPUComputePipeline;private seedGroup?:GPUBindGroup;
 private maskView?:GPUTextureView;private msaaMaskView?:GPUTextureView;private readonly maskDraw:DrawOptions={clear:false};
 private maskPipeline?:GPURenderPipeline;private composite?:GPURenderPipeline;private bind?:GPUBindGroup;private format='';private depthFormat='';private readonly values=new Float32Array(8);private disposed=false;
 constructor(readonly options:SelectionOptions={}){this.name=options.name??'selection';if(!this.name||typeof this.name!=='string')throw new TypeError('Invalid selection name');this.validate();}
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
 private validate():void {const o=this.options;if(o.algorithm!==undefined&&!['jfa','morphological'].includes(o.algorithm)||!Number.isFinite(o.width??3)||(o.width??3)<1||(o.width??3)>32||(o.color??[1,0.5,0]).length!==3||(o.color??[]).some(v=>!Number.isFinite(v)||v<0||v>1))throw new RangeError('Invalid selection options');
  const x=o.xray;if(x===undefined||typeof x==='boolean')return;const color=x?.color??[0,0,0],width=x?.width??1;
  if(!x||typeof x!=='object'||!(x.dash===undefined||Number.isFinite(x.dash)&&x.dash>=0&&x.dash<=256)||!(x.opacity===undefined||x.opacity>=0&&x.opacity<=1)||!Number.isFinite(width)||width<1||width>32||color.length!==3||color.some(v=>!Number.isFinite(v)||v<0||v>1))throw new RangeError('Invalid selection x-ray options');}
 setup(engine:Engine):void {
  if(this.disposed||!engine.gpu)throw new Error('Selection requires WebGPU');this.engine=engine;this.set(this.selected);
  this.flags=new Uint32Array(engine.store.capacity);this.buffer=engine.gpu.createBuffer({size:this.flags.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
  this.maskDraw.bindings=[{binding:1,resource:{buffer:this.buffer}}];
  this.uniform=engine.gpu.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.seed=compute(engine.gpu,seedCode);this.jump=compute(engine.gpu,jumpCode);
 }
 registerPasses(graph:FrameGraph):void {graph.add({name:this.name+':outline',order:40,execute:c=>{if(c.backend==='webgpu')this.draw(c);}});}
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
  this.composite=render(c.device,composite,c.format,{multisample:c.descriptor.multisample});this.bind=group(c.device,this.composite,[{buffer:this.uniform!},this.maskView,this.fieldView=this.fields[index%2].createView()]);
 }
 private draw(c:Context):void {
  if(!this.selected.size)return;
  this.validate();this.resize(c);this.flags.fill(0);for(const mesh of this.selected){if(isModel(mesh))continue;const id=meshRuntime(mesh).id;if(this.engine!.meshes.get(id)===mesh)this.flags[id]=1;}
  c.device.queue.writeBuffer(this.buffer!,0,this.flags as Uint32Array<ArrayBuffer>);this.values[0]=this.options.width??3;this.values[1]=+(this.options.algorithm==='morphological');this.values.set(this.options.color??[1,0.5,0],4);c.device.queue.writeBuffer(this.uniform!,0,this.values as Float32Array<ArrayBuffer>);
  if(this.options.xray)this.xray(c);
  this.mark(c,this.maskDraw,false);
  draw(c,this.composite!,this.bind!);
 }
 /** Selected surfaces into the mask (resolved), then the jump-flood field over it. */
 private mark(c:Context,options:DrawOptions,xray:boolean):void {
  const color=c.color;c.color=(this.msaaMaskView??this.maskView)!;
  try{const clear=c.encoder.beginRenderPass({colorAttachments:[{view:c.color,clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});clear.end();c.draw(options);this.drawModels(c,xray);}
  finally{c.color=color;}
  if(this.msaaMaskView)c.encoder.beginRenderPass({colorAttachments:[{view:this.msaaMaskView,resolveTarget:this.maskView!,loadOp:'load',storeOp:'discard'}]}).end();
  if(this.options.algorithm!=='morphological'){dispatch(c,this.seed!,this.seedGroup!,Math.ceil(c.width/8),Math.ceil(c.height/8));for(const bind of this.jumps)dispatch(c,this.jump!,bind,Math.ceil(c.width/8),Math.ceil(c.height/8));}
 }
 /** Hidden lines: the whole selection marked without the depth test and outlined (dashed, blended) before the visible outline, reusing its mask and field. */
 private xray(c:Context):void {
  const o=this.options,x:XRayOptions=o.xray===true?{}:o.xray as XRayOptions,xr=this.xr??={draw:{clear:false},draws:new ModelDraws(),values:new Float32Array(8)};
  if(!xr.mask){
   let module=c.device.createShaderModule({code:meshVertex+'@group(0) @binding(1) var<storage,read> selected:array<u32>; @fragment fn fragment(i:Output)->@location(0) vec4f{if(selected[i.id]==0u){discard;}return vec4f(1,0,0,1);}'});
   xr.draw.pipeline=xr.mask=c.device.createRenderPipeline({...c.descriptor,layout:'auto',vertex:{...c.descriptor.vertex,module},fragment:{module,entryPoint:'fragment',targets:[{format:'r8unorm'}]},depthStencil:{...c.descriptor.depthStencil!,depthWriteEnabled:false,depthCompare:'always'}});
   xr.uniform??=c.device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});module=c.device.createShaderModule({code:xrayComposite});
   xr.composite=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:c.format,blend}]},multisample:c.descriptor.multisample});
   xr.bind=group(c.device,xr.composite,[{buffer:xr.uniform},this.maskView!,this.fieldView!]);
  }
  xr.draw.bindings=this.maskDraw.bindings;const v=xr.values;v[0]=x.width??o.width??3;v[1]=+(o.algorithm==='morphological');v[2]=x.dash??4;v[3]=x.opacity??0.85;v.set(x.color??o.color??[1,0.5,0],4);
  c.device.queue.writeBuffer(xr.uniform!,0,v as Float32Array<ArrayBuffer>);
  this.mark(c,xr.draw,true);draw(c,xr.composite!,xr.bind!);
 }
 /** Selected gltf-pro primitives into the mask, equal depth against the scene so occluded parts stay unmarked (x-ray: no depth test). */
 private drawModels(c:Context,xray:boolean):void {
  const e=this.engine!,draws=xray?this.xr!.draws:this.draws,list=this.primitives(e);draws.reset();
  for(let i=0;i<list.length;i++){const p=list[i];if(p.buffers&&!hidden(e,p.node.id))draws.add(p,1);}
  if(!draws.count)return;
  const format=c.descriptor.depthStencil!.format,pipeline=(compare:GPUCompareFunction)=>modelPipeline(c.device,modelCode(maskFragment),'r8unorm',{format,depthWriteEnabled:false,depthCompare:compare},c.descriptor.multisample);
  const model=xray?this.xr!.model??=pipeline('always'):this.modelMask??=pipeline('equal');
  const pass=c.encoder.beginRenderPass({colorAttachments:[{view:c.color,loadOp:'load',storeOp:'store'}],depthStencilAttachment:{view:c.depth,depthReadOnly:true,...(format.includes('stencil')?{stencilReadOnly:true}:{})}});
  draws.draw(c.device,pass,model,c.camera.matrix);pass.end();
 }
 private releaseTargets():void {if(this.xr)this.xr.mask=this.xr.model=this.xr.composite=this.xr.bind=this.xr.draw.pipeline=undefined;this.fieldView=undefined;this.modelMask=undefined;this.mask?.destroy();this.msaaMask?.destroy();this.msaaMask=undefined;this.maskView=this.msaaMaskView=undefined;for(const t of this.fields)t.destroy();for(const b of this.steps)b.destroy();this.mask=undefined;this.fields=[];this.steps=[];this.jumps=[];this.bind=this.seedGroup=undefined;this.maskPipeline=this.composite=this.maskDraw.pipeline=undefined;}
 private release():void {this.releaseTargets();this.draws.release();this.xr?.draws.release();this.xr?.uniform?.destroy();this.xr=undefined;this.buffer?.destroy();this.uniform?.destroy();this.buffer=this.uniform=undefined;this.maskDraw.bindings=undefined;this.seed=this.jump=undefined;}
 onDeviceRestored(engine:Engine):void {this.release();this.setup(engine);}
 dispose():void {if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);this.release();this.selected.clear();this.engine=undefined;}
}
