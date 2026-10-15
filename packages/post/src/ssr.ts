/// <reference lib="esnext.disposable" preserve="true" />
import type {SceneTarget} from '../../shared/msaa.js';
import type {EngineKernel} from '@margoengine/core';
import type {Engine,EnginePlugin,FrameGraph,PassContext} from '@margoengine/core/extension';
import {invertMatrixStable} from '@margoengine/math/mat4';
import {render,compute,group as bind} from '../../shared/gpu.js';
import {preset} from '../../shared/preset.js';
import type {StackHost,StackStage,StageOutput} from '../../shared/stack.js';
import {PostStack} from './stack.js';
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number};
declare const GPUTextureUsage:{RENDER_ATTACHMENT:number;TEXTURE_BINDING:number;STORAGE_BINDING:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
export interface SSROptions {
  /** Surfaces rougher than this (perceptual, 0..1) get no screen-space reflection; fades out from half of it. Default 0.6. */
  maxRoughness?:number;
  /** Scene units a ray may pass behind the depth buffer and still count as a hit. Default 0.5. */
  thickness?:number;
  /** Longest reflection ray in scene units; hits fade out over the last 20%. Default 100. */
  maxDistance?:number;
  /** Hierarchical-depth march iterations per pixel (1-256). Default 64. */
  steps?:number;
  enabled?:boolean;
}
/** gltf-pro's capture hook (its `PBRCapture`, declared here so post does not import gltf-pro). */
export interface SSRCapture {declarations(code:string):string;readonly targets:readonly GPUColorTargetState[];begin():GPURenderPassEncoder}
/** What `ssr.add` takes: a gltf-pro `PBRModel` or `@margoengine/materials` mesh. */
export interface SSRModel {setCapture(hook:SSRCapture):()=>void;onDispose(callback:()=>void):()=>void;draw(context:Context,mode:'capture',color:GPUTextureView,depth:GPUTextureView):void}

const vertex='@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}\n';
// Material replay outputs: environment specular already in the scene (rgb) + roughness, split-sum weight F0*A+B (rgb) +
// coverage, world normal. With `margoAmbient` from EnvironmentLighting the weight and specular come from its own LUT and
// prefiltered cube, so the composite removes exactly the IBL specular it replaces; without IBL nothing is removed and
// the weight is Karis' analytic split-sum fit.
const replayTail=(ibl:boolean)=>`
struct MargoSSR {@location(0) specular:vec4f,@location(1) weight:vec4f,@location(2) normal:vec4f}
fn margoSSR(n:vec3f,v:vec3f,base:vec3f,metal:f32,rough:f32)->MargoSSR {
let nv=clamp(dot(n,v),1e-4,1.0);let f0=mix(vec3f(0.04),base,metal);
${ibl?'let ab=iblBrdfTerms(nv,rough);let w=f0*ab.x+ab.y;let e=iblPrefiltered(iblSpecular,iblSampler,iblParams,reflect(-v,n),rough)*w*iblParams.w;'
:'let r=rough*vec4f(-1,-0.0275,-0.572,0.022)+vec4f(1,0.0425,1.04,-0.04);let k=min(r.x*r.x,exp2(-9.28*nv))*r.x+r.y;let w=f0*(r.z-1.04*k)+(r.w+1.04*k);let e=vec3f(0);'}
return MargoSSR(vec4f(e,rough),vec4f(w,1),vec4f(n*0.5+0.5,1));
}`;
// gltf-pro capture: the same targets from the model's Surface. Its environment ambient is iblShade(...)*s.occlusion, and
// clearcoat/sheen scale it by k, so the specular to replace and the weight it is replaced with carry both factors.
const modelTail=(ibl:boolean)=>replayTail(ibl)+`
struct MargoCapture {@location(0) specular:vec4f,@location(1) weight:vec4f,@location(2) normal:vec4f}
fn margoCapture(s:Surface,v:vec3f,k:vec3f)->MargoCapture {let m=margoSSR(s.n,v,s.base.rgb,s.metal,s.roughness);let o=k*s.occlusion;return MargoCapture(vec4f(m.specular.rgb*o,m.specular.a),vec4f(m.weight.rgb*o,1),m.normal);}
`;
const lit=(code:string)=>code.includes('let margoAmbient=')&&code.includes('fn iblBrdfTerms(');
// Hierarchical depth (Hi-Z) level: each texel keeps the closest (largest reversed-Z) depth of its 2x2 source texels, and
// the last row and column also take an odd source's remainder, so every texel bounds its whole cell.
const reduceShader=(source:string,load:string)=>`
@group(0) @binding(0) var source:${source};
@group(0) @binding(1) var reduced:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
let size=vec2i(textureDimensions(reduced));let p=vec2i(id.xy);if(any(p>=size)){return;}
let base=p*2;let end=select(base+1,vec2i(textureDimensions(source))-1,p==size-1);var m=0.0;
for(var y=base.y;y<=end.y;y++){for(var x=base.x;x<=end.x;x++){m=max(m,textureLoad(source,vec2i(x,y),0)${load});}}
textureStore(reduced,p,vec4f(m));
}`;
const downsampleShader=vertex+`
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var bilinear:sampler;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {return textureSampleLevel(source,bilinear,p.xy*2.0/vec2f(textureDimensions(source)),0.0);}
`;
// One ray per pixel along the mirror direction, marched over the Hi-Z pyramid in screen space (pixel x, y and NDC depth
// are linear along a projected segment for perspective and orthographic cameras alike). Roughness widens the cone:
// the hit colour comes from a blurred mip of the scene. Deterministic, so frames are stable without TAA.
const compositeShader=vertex+`
struct U {inverse:mat4x4f,matrix:mat4x4f,a:vec4f,b:vec4f}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var blurred:texture_2d<f32>;
@group(0) @binding(3) var bilinear:sampler;
@group(0) @binding(4) var depth:texture_depth_2d;
@group(0) @binding(5) var hiz:texture_2d<f32>;
@group(0) @binding(6) var specular:texture_2d<f32>;
@group(0) @binding(7) var weight:texture_2d<f32>;
@group(0) @binding(8) var normals:texture_2d<f32>;
fn world(q:vec2f,d:f32)->vec3f {let w=u.inverse*vec4f(q.x/u.a.x*2.0-1.0,1.0-q.y/u.a.y*2.0,d,1.0);return w.xyz/w.w;}
fn screen(p:vec4f)->vec3f {let n=p.xyz/p.w;return vec3f((n.x*0.5+0.5)*u.a.x,(0.5-n.y*0.5)*u.a.y,n.z);}
fn closest(cell:vec2i,level:i32)->f32 {
if(level==0){return textureLoad(depth,cell,0);}
return textureLoad(hiz,min(cell,vec2i(textureDimensions(hiz,level-1))-1),level-1).r;
}
@fragment fn fragment(@builtin(position) frag:vec4f)->@location(0) vec4f {
let q=vec2i(frag.xy);let s=textureLoad(scene,q,0);var c=s.rgb;
let m=textureLoad(weight,q,0);let e=textureLoad(specular,q,0);let rough=e.a;let d=textureLoad(depth,q,0);
if(u.b.w>0.5&&m.a>0.5&&rough<=u.a.z&&d>0.0){
let px=vec2f(q)+0.5;let p=world(px,d);let v=normalize(world(px,1.0)-p);
let n=normalize(textureLoad(normals,q,0).xyz*2.0-1.0);let r=reflect(-v,n);let toward=dot(r,v);
if(toward<0.5){
let start=u.matrix*vec4f(p,1.0);var end=u.matrix*vec4f(p+r*u.b.x,1.0);
// Clip to the near plane (reversed-Z: z<=w) and the far plane (z>=0), then to the screen.
if(end.z>end.w){end=mix(start,end,0.999*(start.w-start.z)/((start.w-start.z)-(end.w-end.z)));}
if(end.z<0.0){end=mix(start,end,start.z/(start.z-end.z));}
let o=screen(start);var dir=screen(end)-o;
let room=select(vec2f(0.5)-o.xy,u.a.xy-0.5-o.xy,dir.xy>vec2f(0));
let fit=select(vec2f(1),room/dir.xy,abs(dir.xy)>vec2f(1e-6));dir*=clamp(min(fit.x,fit.y),0.0,1.0);
let len=length(dir.xy);
if(len>1.5){
var t=1.5/len;var level=0;var hit=false;let top=i32(u.b.z);let nudge=0.01/max(abs(dir.x),abs(dir.y));
for(var i=0;i<i32(u.b.y);i++){
if(t>1.0){break;}
let h=o+dir*t;let size=exp2(f32(level));let cell=floor(h.xy/size);let z=closest(vec2i(cell),level);
let edge=(cell+select(vec2f(0),vec2f(1),dir.xy>vec2f(0)))*size;
let across=select(vec2f(1e30),(edge-o.xy)/dir.xy,abs(dir.xy)>vec2f(1e-6));let exit=min(across.x,across.y)+nudge;
if(h.z>z){
// In front of everything in this cell: drop to its closest depth if the ray gets there inside the cell, else move on.
let plane=select(2.0,(z-o.z)/dir.z,dir.z<0.0);
if(plane<exit){t=max(t,plane);if(level==0){hit=z>0.0;break;}level--;}else{t=exit;level=min(level+1,top);}
}else if(level>0){level--;}
else if(z>0.0&&distance(world(h.xy,z),world(h.xy,h.z))<u.a.w){hit=true;break;}
else{t=exit;}
}
if(hit){
let h=o+dir*t;let hq=vec2i(h.xy);let hp=world(vec2f(hq)+0.5,textureLoad(depth,hq,0));let hn=textureLoad(normals,hq,0).xyz*2.0-1.0;
// Fades: rays toward the camera, back faces, roughness, screen edges, distance.
let f=(1.0-smoothstep(0.0,0.5,toward))*(1.0-smoothstep(0.0,0.3,dot(hn,r)))*(1.0-smoothstep(u.a.z*0.5,u.a.z,rough))
*clamp(min(min(h.x,u.a.x-h.x),min(h.y,u.a.y-h.y))/(0.08*min(u.a.x,u.a.y)),0.0,1.0)*(1.0-smoothstep(0.8*u.b.x,u.b.x,distance(p,hp)));
let lod=log2(max(t*len*rough*rough*2.0,1.0));var reflected=textureLoad(scene,hq,0).rgb;
if(lod>0.0){reflected=mix(reflected,textureSampleLevel(blurred,bilinear,h.xy/u.a.xy,min(lod-1.0,f32(textureNumLevels(blurred)-1))).rgb,min(lod,1.0));}
c=max(vec3f(0),c+f*(m.rgb*reflected-e.rgb));
}}}}
c=c/(1+c);c=select(c*12.92,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>=vec3f(0.0031308));return vec4f(c,s.a);
}`;
const linearComposite=compositeShader.replace(/c=c\/\(1\+c\);[^\n]+/,'return vec4f(c,s.a);');
// With models added, never remove more IBL specular than the pixel holds: at 4x a silhouette pixel is the resolve of both
// sides while its material is the centre sample's, so removal and replacement are scaled by the share the pixel can hold
// (1 wherever scene and material agree, so exact there). Without models the composite is unchanged.
const guarded=(code:string)=>code.replace('c=max(vec3f(0),c+f*(m.rgb*reflected-e.rgb));','let q=select(vec3f(1),c/e.rgb,e.rgb>vec3f(1e-6));c=max(vec3f(0),c+f*min(1.0,min(q.x,min(q.y,q.z)))*(m.rgb*reflected-e.rgb));');
const formats:GPUTextureFormat[]=['rgba16float','rgb10a2unorm','rgb10a2unorm'],blurLevels=5,targets=formats.map(format=>({format}));

/** Screen-space reflections in a PostStack (HDR effect): a material replay of core meshes and of models added with
 * `add(model)` (roughness, split-sum weight, normal, and the IBL specular to replace), a Hi-Z ray march per pixel, and a
 * composite that swaps the environment specular for the reflected scene where a ray hits; misses keep the IBL. */
export class SSR implements EnginePlugin {
  readonly name='ssr';
  private engine?:Engine;private host?:StackHost;private stack?:PostStack;private disposed=false;
  private uniform?:GPUBuffer;private sampler?:GPUSampler;private reduceDepth?:GPUComputePipeline;private reduce?:GPUComputePipeline;private downsample?:GPURenderPipeline;
  private textures:GPUTexture[]=[];private width=0;private height=0;private target?:SceneTarget;
  private depthView?:GPUTextureView;private ownDepth?:GPUTextureView;private base?:GPURenderPipelineDescriptor;private single?:GPURenderPipelineDescriptor;private hiz?:GPUTextureView;private hizGroups:GPUBindGroup[]=[];private hizSizes:number[][]=[];
  private material:GPUTextureView[]=[];private blur?:GPUTextureView;private blurViews:GPUTextureView[]=[];private blurGroups:GPUBindGroup[]=[];
  private replay?:GPURenderPipeline;private replayKey?:string;private composite?:GPURenderPipeline;private compositeGroup?:GPUBindGroup;private input?:GPUTextureView;private key='';
  private clearPass?:GPURenderPassDescriptor;private extra:GPURenderPassColorAttachment[]=[];private blurPasses:GPURenderPassDescriptor[]=[];
  private readonly compositeAttachment:GPURenderPassColorAttachment={view:undefined!,loadOp:'clear',storeOp:'store'};private readonly compositePass:GPURenderPassDescriptor={colorAttachments:[this.compositeAttachment]};
  private readonly models=new Map<SSRModel,()=>void>();private readonly modelCode=new Map<string,string>();private context?:Context;private pass?:GPURenderPassEncoder;
  // gltf-pro capture hook: model materials into the same three targets, after the core replay.
  private readonly hook:SSRCapture={targets,
    declarations:code=>{let out=this.modelCode.get(code);if(out===undefined){if(this.modelCode.size>=64)this.modelCode.clear();this.modelCode.set(code,out=modelTail(lit(code)));}return out;},
    begin:()=>{if(this.pass)return this.pass;const c=this.context!,stencil=c.descriptor.depthStencil!.format.includes('stencil')?{stencilLoadOp:'load',stencilStoreOp:'store'} as const:{};
      return this.pass=c.encoder.beginRenderPass({colorAttachments:this.material.map(view=>({view,loadOp:'load',storeOp:'store'})),depthStencilAttachment:{view:c.depth,depthLoadOp:'load',depthStoreOp:'store',...stencil}});}};
  private readonly values=new Float32Array(40);private readonly workspace=new Float64Array(52);private readonly inverse=this.values.subarray(0,16);
  constructor(readonly options:SSROptions={}){this.options=preset('ssr',options);this.validate();}
  /** Alone, SSR runs in its own one-effect PostStack (tone mapped like SSAO alone); to combine it, put it in your PostStack. */
  static attach(engine:EngineKernel,options:SSROptions={}):SSR {const effect=new SSR(options);effect.stack=PostStack.attach(engine,[effect]);return effect;}
  /** Makes a gltf-pro model or materials mesh reflect: its own materials (maps, alpha mask, instances, skinning) are drawn
   * into SSR's material targets. Returns a remover; models not added are still reflected but do not reflect. */
  add(model:SSRModel):()=>void {
    if(this.disposed)throw new Error('SSR is disposed');
    let release=this.models.get(model);
    if(!release){
      const restore=model.setCapture(this.hook),forget=model.onDispose(()=>this.models.delete(model));
      release=()=>{if(this.models.get(model)===release){this.models.delete(model);forget();restore();}};this.models.set(model,release);
    }
    return release;
  }
  get enabled():boolean{return this.options.enabled??true;}
  set enabled(value:boolean){if(typeof value!=='boolean')throw new TypeError('SSR enabled must be boolean');this.options.enabled=value;}
  private joinStack(host:StackHost):StackStage {
    if(this.engine||this.host||this.disposed)throw new Error('SSR is already attached');
    this.host=host;return {kind:'hdr',render:(c,input,output)=>this.stage(c,input,output)};
  }
  private validate():void {
    const o=this.options,r=o.maxRoughness??0.6,t=o.thickness??0.5,d=o.maxDistance??100,s=o.steps??64;
    if(!(r>0&&r<=1)||!(t>0&&Number.isFinite(t))||!(d>0&&Number.isFinite(Math.fround(d)))||!Number.isInteger(s)||s<1||s>256||o.enabled!==undefined&&typeof o.enabled!=='boolean')throw new RangeError('Invalid SSR options');
  }
  setup(engine:Engine):void {
    if(this.disposed)throw new Error('SSR is disposed');
    if(!this.host)throw new Error('SSR runs in a PostStack: SSR.attach(engine) or PostStack.attach(engine, [..., new SSR(), ...])');
    if(!engine.gpu)throw new Error('SSR requires WebGPU');
    this.engine=engine;const device=engine.gpu;
    this.uniform=device.createBuffer({size:160,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.sampler=device.createSampler({magFilter:'linear',minFilter:'linear',mipmapFilter:'linear'});
    this.reduceDepth=compute(device,reduceShader('texture_depth_2d',''));this.reduce=compute(device,reduceShader('texture_2d<f32>','.r'));
    this.downsample=render(device,downsampleShader,'rgba16float');
  }
  registerPasses(graph:FrameGraph):void {
    // After the scene and SSAO's replays (10-13), before the stack composes (30).
    graph.add({name:'ssr:gbuffer',order:14,execute:c=>{if(c.backend==='webgpu'&&this.host?.target)this.prepare(c);}});
  }
  private prepare(c:Context):void {
    this.validate();this.resize(c);const v=this.values,o=this.options,own=this.ownDepth;
    if(!invertMatrixStable(c.camera.matrix,this.inverse,this.workspace))throw new Error('Invalid SSR camera');
    v.set(c.camera.matrix,16);v[32]=c.width;v[33]=c.height;v[34]=o.maxRoughness??0.6;v[35]=o.thickness??0.5;v[36]=o.maxDistance??100;v[37]=o.steps??64;v[38]=this.hizGroups.length;v[39]=+this.enabled;
    c.device.queue.writeBuffer(this.uniform!,0,v as Float32Array<ArrayBuffer>);
    if(!this.enabled)return;
    // Material replay of core's lit shader with its lighting in a dead block (every binding stays statically used, so the
    // pass bindings fit the auto layout, but none of the light is computed), from its shading normal `let n=normalize(i.normal)…` and view vector
    // `let v=normalize(frame.eye.xyz-i.position)` (tests/shader-contracts). A 1x scene is replayed depth-equal against its
    // own depth; a 4x scene at 1x into SSR's own depth (pixel-centre materials and depth, no multisampled targets).
    if(this.base!==c.descriptor){this.base=c.descriptor;this.single={...c.descriptor,multisample:{count:1},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater-equal'}};}
    const key=c.shader+!!own;
    if(this.replayKey!==key){
      const code=c.shader.replace(/(@fragment[^{]*)->@location\(0\) vec4f/,'$1->MargoSSR').replace(/(let direct=[\s\S]*)return (vec4f\([^\n]+\));/,'if(false){$1_=$2;}return margoSSR(n,v,i.color,i.material.y,i.material.x);');
      if(!code.includes('->MargoSSR')||!code.includes('return margoSSR('))throw new Error('SSR requires the standard core lighting shader');
      const module=c.device.createShaderModule({code:code+replayTail(lit(code))});
      this.replay=c.device.createRenderPipeline({...this.single!,layout:'auto',vertex:{...c.descriptor.vertex,module},fragment:{module,entryPoint:'fragment',targets:formats.map(format=>({format}))},
        depthStencil:own?this.single!.depthStencil:{...c.descriptor.depthStencil!,depthWriteEnabled:false,depthCompare:'equal'}});
      this.replayKey=key;
    }
    const {color,depth,descriptor}=c;c.color=this.material[0];
    if(own){c.depth=own;c.descriptor=this.single!;}else c.encoder.beginRenderPass(this.clearPass!).end();
    try{
      c.draw({pipeline:this.replay,clear:!!own,bindings:c.bindings,colorAttachments:this.extra});
      // Added models draw their own materials on top, depth tested against (and, at 4x, into) the same depth.
      if(this.models.size){this.context=c;for(const model of this.models.keys())model.draw(c,'capture',c.color,c.depth);}
    }finally{this.pass?.end();this.pass=this.context=undefined;Object.assign(c,{color,depth,descriptor});}
    // Hi-Z over the depth the materials match.
    const pass=c.encoder.beginComputePass();
    for(let i=0;i<this.hizGroups.length;i++){pass.setPipeline(i?this.reduce!:this.reduceDepth!);pass.setBindGroup(0,this.hizGroups[i]);pass.dispatchWorkgroups(Math.ceil(this.hizSizes[i][0]/8),Math.ceil(this.hizSizes[i][1]/8));}
    pass.end();
  }
  private stage(c:Context,input:GPUTextureView,output:StageOutput):void {
    const models=this.models.size>0,key=output.format+output.multisample.count+output.hdr+models,code=output.hdr?linearComposite:compositeShader;
    if(this.key!==key){this.key=key;this.composite=render(c.device,models?guarded(code):code,output.format,{multisample:output.multisample});this.input=undefined;}
    if(this.input!==input){this.input=input;
      this.blurGroups[0]=bind(c.device,this.downsample!,[input,this.sampler!]);
      this.compositeGroup=bind(c.device,this.composite!,[{buffer:this.uniform!},input,this.blur!,this.sampler!,this.depthView!,this.hiz!,...this.material]);
    }
    if(this.enabled)for(let i=0;i<blurLevels;i++){const pass=c.encoder.beginRenderPass(this.blurPasses[i]);pass.setPipeline(this.downsample!);pass.setBindGroup(0,this.blurGroups[i]);pass.draw(3);pass.end();}
    this.compositeAttachment.view=output.view;const pass=c.encoder.beginRenderPass(this.compositePass);
    pass.setPipeline(this.composite!);pass.setBindGroup(0,this.compositeGroup!);pass.draw(3);pass.end();
  }
  private resize(c:Context):void {
    const target=this.host!.target!;if(this.width===c.width&&this.height===c.height&&this.target===target)return;
    this.release();this.width=c.width;this.height=c.height;this.target=target;
    const device=c.device,sampled=GPUTextureUsage.TEXTURE_BINDING,texture=(size:number[],format:GPUTextureFormat,usage:number,mipLevelCount=1)=>{const t=device.createTexture({size,format,usage,mipLevelCount});this.textures.push(t);return t;};
    const scene=this.host!.depthTexture!,depth=target.samples===4?texture([c.width,c.height],'depth32float',sampled|GPUTextureUsage.RENDER_ATTACHMENT):scene;
    this.depthView=depth.createView({aspect:'depth-only'});if(depth!==scene)this.ownDepth=depth.createView();
    // Hi-Z levels 1..n (level 0 is the depth itself), cells up to 64 px.
    const half=[Math.max(1,c.width>>1),Math.max(1,c.height>>1)],levels=Math.max(1,Math.min(6,Math.floor(Math.log2(Math.min(c.width,c.height)))));
    const hiz=texture(half,'r32float',sampled|GPUTextureUsage.STORAGE_BINDING,levels);this.hiz=hiz.createView();
    for(let i=0;i<levels;i++){this.hizSizes.push([Math.max(1,half[0]>>i),Math.max(1,half[1]>>i)]);
      this.hizGroups.push(bind(device,i?this.reduce!:this.reduceDepth!,[i?hiz.createView({baseMipLevel:i-1,mipLevelCount:1}):this.depthView,hiz.createView({baseMipLevel:i,mipLevelCount:1})]));}
    const attachment=sampled|GPUTextureUsage.RENDER_ATTACHMENT,clear={r:0.5,g:0.5,b:0.5,a:0};
    this.material=formats.map(format=>texture([c.width,c.height],format,attachment).createView());
    // Attachment 0 is core's draw target (cleared with the depth at 4x, else by clearPass); the other two clear themselves.
    this.clearPass={colorAttachments:[{view:this.material[0],loadOp:'clear',storeOp:'store'}]};
    this.extra=[1,2].map(i=>({view:this.material[i],loadOp:'clear',storeOp:'store',clearValue:i===2?clear:{r:0,g:0,b:0,a:0}}));
    // Blurred scene for rough hits: half resolution and down, filled from the stage input each frame.
    const blur=texture(half,'rgba16float',attachment,blurLevels);this.blur=blur.createView();
    for(let i=0;i<blurLevels;i++){const view=blur.createView({baseMipLevel:i,mipLevelCount:1});this.blurViews.push(view);this.blurPasses.push({colorAttachments:[{view,loadOp:'clear',storeOp:'store'}]});
      if(i)this.blurGroups[i]=bind(device,this.downsample!,[this.blurViews[i-1],this.sampler!]);}
  }
  private release():void {
    for(const t of this.textures)t.destroy();this.textures=[];this.width=this.height=0;this.target=undefined;this.input=undefined;
    this.hizGroups=[];this.hizSizes=[];this.material=[];this.blurViews=[];this.blurGroups=[];this.blurPasses=[];this.extra=[];
    this.depthView=this.ownDepth=this.hiz=this.blur=undefined;this.compositeGroup=undefined;this.clearPass=undefined;this.compositeAttachment.view=undefined!;
  }
  onDeviceRestored(engine:Engine):void {this.release();this.uniform?.destroy();this.replay=this.composite=undefined;this.replayKey=this.base=undefined;this.key='';this.setup(engine);}
  dispose():void {
    if(this.disposed)return;this.disposed=true;const stack=this.stack;this.stack=undefined;
    for(const release of [...this.models.values()])release();
    this.engine?.removePlugin(this.name);this.release();this.uniform?.destroy();this.uniform=undefined;this.replay=this.composite=undefined;this.engine=undefined;stack?.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
}
