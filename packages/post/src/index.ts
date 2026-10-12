import type {EngineKernel} from '@margoengine/core';
export {Bloom, type BloomOptions} from './bloom.js';
import {engineRuntime,type Engine,type EnginePlugin,type FrameGraph,type PassContext} from '@margoengine/core/extension';
import {invert} from '../../shared/math.js';
import {viewMatrix} from '../../shared/view.js';
import {extractShader,ssaoShader,blurShader,compositeShader} from './shaders.js';
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number;STORAGE:number};
declare const GPUTextureUsage:{RENDER_ATTACHMENT:number;TEXTURE_BINDING:number;STORAGE_BINDING:number;COPY_DST:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
export interface SSAOOptions {radius?:number;bias?:number;samples?:number;enabled?:boolean}
export interface SSAOSource {draw(context:Context,mode:'gbuffer'|'ambient',color:GPUTextureView,depth:GPUTextureView):void}
function kernel():Float32Array {
  const values=new Float32Array(128);
  for(let i=0;i<32;i++){const z=(i+0.5)/32,angle=i*2.399963229728653,r=Math.sqrt(1-z*z),scale=0.1+0.9*(i/31)**2;values.set([Math.cos(angle)*r*scale,Math.sin(angle)*r*scale,z*scale,0],i*4);}
  return values;
}
export class SSAO implements EnginePlugin {
  readonly name='ssao';
  private engine?:Engine;private device?:GPUDevice;private uniform?:GPUBuffer;private samples?:GPUBuffer;private noise?:GPUTexture;
  private extract?:GPUComputePipeline;private occlusion?:GPUComputePipeline;private blur?:GPUComputePipeline;private composite?:GPURenderPipeline;
  private textures:GPUTexture[]=[];private directions:GPUBuffer[]=[];private groups:GPUBindGroup[]=[];
  private width=0;private height=0;private original?:GPUTextureView;private originalFormat?:GPUTextureFormat;private scene?:GPUTextureView;private depth?:GPUTextureView;private gbuffer?:GPUTextureView;private ambient?:GPUTextureView;
  private ambientPipeline?:GPURenderPipeline;private ambientShader='';private readonly sources=new Set<SSAOSource>();
  private disposed=false;
  private readonly values=new Float32Array(56);private readonly inverseWorkspace=new Float64Array(52);
  private readonly inverse=this.values.subarray(0,16);private readonly view=this.values.subarray(16,32);
  constructor(readonly options:SSAOOptions={}){this.validate();}
  static attach(instance:EngineKernel,options:SSAOOptions={}):SSAO {const effect=new SSAO(options);engineRuntime(instance).use(effect);return effect;}
  get enabled():boolean{return this.options.enabled??true;}
  get depthTexture():GPUTexture|undefined{return this.textures[1];}
  set enabled(value:boolean){if(typeof value!=='boolean')throw new TypeError('SSAO enabled must be boolean');this.options.enabled=value;}
  add(source:SSAOSource):()=>void {if(!source||typeof source.draw!=='function')throw new TypeError('Invalid SSAO source');this.sources.add(source);return()=>this.sources.delete(source);}
  private validate():void {
    const o=this.options,r=o.radius??0.5,b=o.bias??0.025,s=o.samples??32;
    if(!Number.isFinite(Math.fround(r))||r<=0||r>100||!Number.isFinite(b)||b<0||b>r||!Number.isInteger(s)||s<1||s>32||o.enabled!==undefined&&typeof o.enabled!=='boolean')throw new RangeError('Invalid SSAO options');
  }
  setup(engine:Engine):void {
    if(this.disposed)throw new Error('SSAO is disposed');
    if(!engine.gpu)throw new Error('SSAO requires WebGPU');
    if(engine.hasPlugin('post-processing')||engine.hasPlugin('bloom'))throw new Error('SSAO owns the output target; remove the other post effect first');
    this.engine=engine;this.device=engine.gpu;
    this.uniform=this.device.createBuffer({size:224,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.samples=this.device.createBuffer({size:512,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});this.device.queue.writeBuffer(this.samples,0,kernel() as Float32Array<ArrayBuffer>);
    const create=(code:string)=>this.device!.createComputePipeline({layout:'auto',compute:{module:this.device!.createShaderModule({code}),entryPoint:'main'}});
    this.extract=create(extractShader);this.occlusion=create(ssaoShader);this.blur=create(blurShader);
    this.noise=this.device.createTexture({size:[4,4],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    const noise=new Uint8Array(64);for(let i=0;i<16;i++){const a=i*2.399963229728653;noise.set([Math.round((Math.cos(a)*0.5+0.5)*255),Math.round((Math.sin(a)*0.5+0.5)*255),128,255],i*4);}
    this.device.queue.writeTexture({texture:this.noise},noise,{bytesPerRow:16},[4,4]);
    for(const data of [[1,0,0.5,0],[0,1,0.5,0]]){const b=this.device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.directions.push(b);this.device.queue.writeBuffer(b,0,new Float32Array(data));}
  }
  registerPasses(graph:FrameGraph):void {
    graph.add({name:'ssao:capture',order:-60,execute:c=>{if(c.backend!=='webgpu')return;
      this.validate();if(this.engine!.hasPlugin('post-processing')||this.engine!.hasPlugin('bloom'))throw new Error('SSAO cannot share the output target with another post effect');
      this.resize(c);this.original=c.color;this.originalFormat=c.format;c.color=this.scene!;c.depth=this.depth!;c.format='rgba16float';
      c.shader=c.shader.replace(/let mapped=linear\/[\s\S]*?return vec4f\([^\n]+\);/,'return vec4f(linear,1);');
      if(!invert(this.inverse,c.camera.matrix,0,this.inverseWorkspace))throw new Error('Invalid SSAO camera');
      viewMatrix(this.view,c.camera);
      const p=this.values.subarray(32,48),near=c.camera.near,far=c.camera.far,f=1/Math.tan(c.camera.fov*Math.PI/360);p.fill(0);p[0]=f*c.height/c.width;p[5]=f;p[10]=near/(far-near);p[11]=-1;p[14]=far*near/(far-near);
      this.values.set([this.options.radius??0.5,this.options.bias??0.025,this.options.samples??32,+this.enabled,c.width,c.height,0,0],48);
      c.device.queue.writeBuffer(this.uniform!,0,this.values as Float32Array<ArrayBuffer>);
      for(let i=0;i<2;i++)c.device.queue.writeBuffer(this.directions[i],0,new Float32Array([1-i,i,this.options.radius??0.5,0]));
    }});
    graph.add({name:'ssao:extract',order:10,execute:c=>{if(c.backend==='webgpu')this.extractScene(c);}});
    graph.add({name:'ssao:occlusion',order:11,execute:c=>{if(c.backend==='webgpu')this.dispatch(c,this.occlusion!,this.groups[1]);}});
    graph.add({name:'ssao:blur-x',order:12,execute:c=>{if(c.backend==='webgpu')this.dispatch(c,this.blur!,this.groups[2]);}});
    graph.add({name:'ssao:blur-y',order:13,execute:c=>{if(c.backend==='webgpu')this.dispatch(c,this.blur!,this.groups[3]);}});
    graph.add({name:'ssao:composite',order:30,execute:c=>{if(c.backend!=='webgpu')return;
      const pass=c.encoder.beginRenderPass({colorAttachments:[{view:this.original!,loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:1}}]});
      pass.setPipeline(this.composite!);pass.setBindGroup(0,this.groups[4]);pass.draw(3);pass.end();
      c.color=this.original!;c.format=this.originalFormat!;
    }});
  }
  private resize(c:Context):void {
    if(this.width===c.width&&this.height===c.height)return;
    for(const t of this.textures)t.destroy();this.textures=[];this.width=c.width;this.height=c.height;
    const texture=(format:GPUTextureFormat,usage:number)=>{const t=c.device.createTexture({size:[c.width,c.height],format,usage});this.textures.push(t);return t;};
    const sampled=GPUTextureUsage.TEXTURE_BINDING,render=sampled|GPUTextureUsage.RENDER_ATTACHMENT,storage=sampled|GPUTextureUsage.STORAGE_BINDING;
    this.scene=texture('rgba16float',render).createView();const depth=texture(c.descriptor.depthStencil!.format,render);
    this.depth=depth.createView();const depthOnly=depth.createView({aspect:'depth-only'});
    // shortcut: linear depth fits 65,504 scene units, use a separate r32float target for larger scenes.
    this.gbuffer=texture('rgba16float',storage|GPUTextureUsage.RENDER_ATTACHMENT).createView();this.ambient=texture('rgba16float',render).createView();
    const raw=texture('r32float',storage).createView(),x=texture('r32float',storage).createView(),y=texture('r32float',storage).createView();
    const group=(p:GPUComputePipeline|GPURenderPipeline,resources:(GPUTextureView|GPUBufferBinding)[])=>c.device.createBindGroup({layout:p.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
    const module=c.device.createShaderModule({code:compositeShader});this.composite=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:navigator.gpu.getPreferredCanvasFormat()}]}});
    this.groups=[group(this.extract!,[{buffer:this.uniform!},depthOnly,this.gbuffer]),
      group(this.occlusion!,[{buffer:this.uniform!},depthOnly,this.gbuffer,this.noise!.createView(),{buffer:this.samples!},raw]),
      group(this.blur!,[raw,this.gbuffer,x,{buffer:this.directions[0]}]),group(this.blur!,[x,this.gbuffer,y,{buffer:this.directions[1]}]),
      group(this.composite,[this.scene,this.ambient,y])];
    this.ambientPipeline=undefined;
  }
  private dispatch(c:Context,pipeline:GPUComputePipeline,group:GPUBindGroup):void {
    const pass=c.encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(c.width/8),Math.ceil(c.height/8));pass.end();
  }
  private extractScene(c:Context):void {
    this.dispatch(c,this.extract!,this.groups[0]);
    for(const source of this.sources)source.draw(c,'gbuffer',this.gbuffer!,this.depth!);
    const clear=c.encoder.beginRenderPass({colorAttachments:[{view:this.ambient!,loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:0}}]});clear.end();
    const code=c.shader.replace(/let direct=[\s\S]*return vec4f\([^\n]+\);/,'return vec4f(i.color*(1.0-i.material.y)*frame.radiance.w,1);');
    if(!this.ambientPipeline||this.ambientShader!==code) {
      if(code===c.shader)throw new Error('SSAO requires the standard core lighting shader');
      const module=c.device.createShaderModule({code});
      this.ambientPipeline=c.device.createRenderPipeline({...c.descriptor,layout:'auto',vertex:{...c.descriptor.vertex,module},
        fragment:{module,entryPoint:'fragment',targets:[{format:'rgba16float'}]},depthStencil:{...c.descriptor.depthStencil!,depthWriteEnabled:false,depthCompare:'equal'}});
      this.ambientShader=code;
    }
    const color=c.color;c.color=this.ambient!;
    // Ambient replay still needs TAA's vertex camera override, while its fragment lighting bindings are unused.
    try{c.draw({pipeline:this.ambientPipeline,clear:false,bindings:c.bindings.filter(entry=>entry.binding===8)});}finally{c.color=color;}
    for(const source of this.sources)source.draw(c,'ambient',this.ambient!,this.depth!);
  }
  private release():void {
    for(const t of this.textures)t.destroy();for(const b of this.directions)b.destroy();this.uniform?.destroy();this.samples?.destroy();this.noise?.destroy();
    this.textures=[];this.directions=[];this.groups=[];this.width=this.height=0;this.uniform=this.samples=undefined;this.noise=undefined;this.extract=this.occlusion=this.blur=undefined;this.composite=this.ambientPipeline=undefined;
    this.original=this.scene=this.depth=this.gbuffer=this.ambient=undefined;this.originalFormat=undefined;
  }
  onDeviceRestored(engine:Engine):void {this.release();this.setup(engine);}
  dispose():void {if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);this.release();this.sources.clear();this.engine=this.device=undefined;}
  destroy():void {this.dispose();}
}
