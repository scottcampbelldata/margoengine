import {SceneTarget} from '../../shared/msaa.js';
import type {EngineKernel} from '@margoengine/core';
import {engineRuntime, type Engine, type EnginePlugin, type FrameGraph, type PassContext} from '@margoengine/core/extension';
import {render,group} from '../../shared/gpu.js';
import type {StackHost,StackStage,StageOutput} from '../../shared/stack.js';
import {cocShader, bokehShader, presentShader} from './shaders.js';

declare const GPUBufferUsage: {UNIFORM:number; COPY_DST:number};
declare const GPUTextureUsage: {RENDER_ATTACHMENT:number; TEXTURE_BINDING:number; STORAGE_BINDING:number; COPY_SRC:number};
type Context = Extract<PassContext, {backend:'webgpu'}>;

export interface DOFOptions {
  /** Scene units, measured along the camera's viewing axis. Default 5. */
  focalDistance?:number;
  /** Same units as focalDistance; default 0.05 for a metre-based scene. */
  focalLength?:number;
  /** Lens f-number, default 2.8. */
  aperture?:number;
  /** Maximum disk radius in pixels, 1–32. Default 16. */
  maxRadius?:number;
  enabled?:boolean;
}

export class DOF implements EnginePlugin {
  readonly name='dof';
  private engine?:Engine;
  private uniform?:GPUBuffer;
  private cocPipeline?:GPUComputePipeline;
  private bokehPipeline?:GPUComputePipeline;
  private presentPipeline?:GPURenderPipeline;
  private scene?:GPUTexture;
  private depth?:GPUTexture;
  private coc?:GPUTexture;
  private output?:GPUTexture;
  private sceneView?:GPUTextureView;
  private depthView?:GPUTextureView;
  private groups:GPUBindGroup[]=[];
  private originalColor?:GPUTextureView;
  private originalDepth?:GPUTextureView;
  private format?:GPUTextureFormat;
  private depthFormat?:GPUTextureFormat;
  private readonly values=new Float32Array(8);
  private readonly shaders=new Map<string,string>();
  private readonly attachment:GPURenderPassColorAttachment={view:undefined!,loadOp:'clear',storeOp:'store'};
  private readonly presentation:GPURenderPassDescriptor={colorAttachments:[this.attachment]};
  private captureTarget?:SceneTarget;
  private disposed=false;
  private host?:StackHost;private input?:GPUTextureView;private sceneDepth?:GPUTexture;private cocView?:GPUTextureView;private outputView?:GPUTextureView;private key='';

  constructor(readonly options:DOFOptions={}){this.validate();}
  static attach(instance:EngineKernel, options:DOFOptions={}):DOF {
    const effect=new DOF(options);engineRuntime(instance).use(effect);return effect;
  }
  get depthTexture():GPUTexture|undefined{return this.host?this.host.depthTexture:this.depth;}
  get outputTexture():GPUTexture|undefined{return this.output;}
  get enabled():boolean{return this.options.enabled??true;}
  set enabled(value:boolean){if(typeof value!=='boolean')throw new TypeError('DOF enabled must be boolean');this.options.enabled=value;}
  private joinStack(host:StackHost):StackStage {
    if(this.engine||this.host||this.disposed)throw new Error('DOF is already attached');
    this.host=host;return {kind:'hdr',render:(c,input,output)=>this.stage(c,input,output)};
  }
  private validate():void {
    const o=this.options,f=o.focalLength??0.05,d=o.focalDistance??5,a=o.aperture??2.8,r=o.maxRadius??16;
    if(!Number.isFinite(Math.fround(f))||Math.fround(f)<=0||!Number.isFinite(Math.fround(d))||Math.fround(d)<=Math.fround(f)||
      !Number.isFinite(Math.fround(a))||Math.fround(a)<=0||!Number.isFinite(r)||r<1||r>32||o.enabled!==undefined&&typeof o.enabled!=='boolean')throw new RangeError('Invalid DOF options');
  }
  setup(engine:Engine):void {
    if(this.disposed||!engine.gpu)throw new Error('DOF requires WebGPU and a live effect');
    if(!this.host&&(engine.hasPlugin('ssao')||engine.hasPlugin('post-processing')||engine.hasPlugin('tonemap')&&!engine.hasPlugin(this.name)))throw new Error('DOF owns scene capture; attach it before Tonemap, without SSAO or PostProcessing');
    this.engine=engine;
    this.uniform=engine.gpu.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.cocPipeline=engine.gpu.createComputePipeline({layout:'auto',compute:{module:engine.gpu.createShaderModule({code:cocShader}),entryPoint:'main'}});
    this.bokehPipeline=engine.gpu.createComputePipeline({layout:'auto',compute:{module:engine.gpu.createShaderModule({code:bokehShader}),entryPoint:'main'}});
  }
  registerPasses(graph:FrameGraph):void {
    graph.add({name:'dof:capture',order:-55,execute:c=>{if(c.backend==='webgpu')this.capture(c);}});
    if(this.host)return;
    graph.add({name:'dof:coc',order:20,execute:c=>{if(c.backend==='webgpu')this.dispatch(c,this.cocPipeline!,this.groups[0]);}});
    graph.add({name:'dof:bokeh',order:21,execute:c=>{if(c.backend==='webgpu')this.dispatch(c,this.bokehPipeline!,this.groups[1]);}});
    graph.add({name:'dof:present',order:30,execute:c=>{if(c.backend==='webgpu')this.present(c);}});
  }
  private capture(c:Context):void {
    this.validate();
    if(!this.host){
    if(this.engine!.hasPlugin('ssao')||this.engine!.hasPlugin('post-processing'))throw new Error('DOF cannot share scene capture with SSAO or PostProcessing');
    this.resize(c);this.originalColor=c.color;this.originalDepth=c.depth;
    let shader=this.shaders.get(c.shader);
    if(shader===undefined){
      shader=c.shader.replace(/let mapped=linear\/[\s\S]*?return vec4f\([^\n]+\);/,'return vec4f(linear,1);');
      if(shader===c.shader)throw new Error('DOF requires the standard core lighting shader');
      this.shaders.set(c.shader,shader);
    }
    c.shader=shader;this.captureTarget!.begin(c);}
    const o=this.options,v=this.values;v[0]=o.focalDistance??5;v[1]=o.focalLength??0.05;v[2]=o.aperture??2.8;v[3]=o.maxRadius??16;
    v[4]=c.camera.near;v[5]=c.camera.far;
    v[6]=v[1]*c.height/(4*v[2]*(v[0]-v[1])*Math.tan(c.camera.fov*Math.PI/360));v[7]=+this.enabled;
    if(!Number.isFinite(v[6]))throw new RangeError('DOF lens scale exceeds float32');
    c.device.queue.writeBuffer(this.uniform!,0,v as Float32Array<ArrayBuffer>);
  }
  private resize(c:Context):void {
    const depthFormat=c.descriptor.depthStencil!.format;
    if(this.scene?.width===c.width&&this.scene.height===c.height&&this.format===c.format&&this.depthFormat===depthFormat&&this.captureTarget?.samples===(c.descriptor.multisample?.count??4))return;
    this.releaseTextures();this.format=c.format;this.depthFormat=depthFormat;
    const sampled=GPUTextureUsage.TEXTURE_BINDING,storage=sampled|GPUTextureUsage.STORAGE_BINDING;
    this.scene=c.device.createTexture({size:[c.width,c.height],format:'rgba16float',usage:sampled|GPUTextureUsage.RENDER_ATTACHMENT});
    this.depth=c.device.createTexture({size:[c.width,c.height],format:depthFormat,usage:sampled|GPUTextureUsage.RENDER_ATTACHMENT});
    this.coc=c.device.createTexture({size:[c.width,c.height],format:'rg32float',usage:storage});
    this.output=c.device.createTexture({size:[c.width,c.height],format:'rgba16float',usage:storage|GPUTextureUsage.COPY_SRC});
    this.captureTarget=new SceneTarget(c.device,this.scene,this.depth,c.descriptor.multisample?.count??4);
    this.sceneView=this.scene.createView();this.depthView=this.depth.createView();
    const cocView=this.coc.createView(),outputView=this.output.createView();
    const module=c.device.createShaderModule({code:presentShader});
    this.presentPipeline=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:c.format}]},multisample:c.descriptor.multisample});
    this.groups=[c.device.createBindGroup({layout:this.cocPipeline!.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform!}},{binding:1,resource:this.depth.createView({aspect:'depth-only'})},{binding:2,resource:cocView}]}),
      c.device.createBindGroup({layout:this.bokehPipeline!.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform!}},{binding:1,resource:this.sceneView},{binding:2,resource:cocView},{binding:3,resource:outputView}]}),
      c.device.createBindGroup({layout:this.presentPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:outputView}]})];
  }
  private dispatch(c:Context,pipeline:GPUComputePipeline,group:GPUBindGroup):void {
    if(pipeline===this.cocPipeline)this.captureTarget?.resolve(c.encoder,true);
    const pass=c.encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(c.width/8),Math.ceil(c.height/8));pass.end();
  }
  private present(c:Context):void {
    this.attachment.view=this.originalColor!;
    const pass=c.encoder.beginRenderPass(this.presentation);pass.setPipeline(this.presentPipeline!);pass.setBindGroup(0,this.groups[2]);pass.draw(3);pass.end();
    this.captureTarget!.restore(c);
  }
  /** Stacked: blur `input` by the shared depth into outputTexture, handed on as linear light or presented as the display output. */
  private stage(c:Context,input:GPUTextureView,output:StageOutput):GPUTextureView|void {
    const device=c.device,depth=this.host!.depthTexture!,key=output.format+output.multisample.count;
    if(this.coc?.width!==c.width||this.coc.height!==c.height){
      this.releaseTextures();const storage=GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING;
      this.coc=device.createTexture({size:[c.width,c.height],format:'rg32float',usage:storage});this.output=device.createTexture({size:[c.width,c.height],format:'rgba16float',usage:storage|GPUTextureUsage.COPY_SRC});
      this.cocView=this.coc.createView();this.outputView=this.output.createView();
    }
    if(this.sceneDepth!==depth){this.sceneDepth=depth;this.groups[0]=group(device,this.cocPipeline!,[{buffer:this.uniform!},depth.createView({aspect:'depth-only'}),this.cocView!]);}
    if(this.input!==input){this.input=input;this.groups[1]=group(device,this.bokehPipeline!,[{buffer:this.uniform!},input,this.cocView!,this.outputView!]);}
    this.dispatch(c,this.cocPipeline!,this.groups[0]);this.dispatch(c,this.bokehPipeline!,this.groups[1]);
    if(output.hdr)return this.outputView;
    if(this.key!==key){this.key=key;this.presentPipeline=render(device,presentShader,output.format,{multisample:output.multisample});this.groups[2]=group(device,this.presentPipeline,[this.outputView!]);}
    this.attachment.view=output.view;const pass=c.encoder.beginRenderPass(this.presentation);pass.setPipeline(this.presentPipeline!);pass.setBindGroup(0,this.groups[2]);pass.draw(3);pass.end();
  }
  private releaseTextures():void {this.captureTarget?.dispose();this.captureTarget=undefined;this.scene?.destroy();this.depth?.destroy();this.coc?.destroy();this.output?.destroy();this.scene=this.depth=this.coc=this.output=undefined;this.sceneView=this.depthView=undefined;this.groups=[];this.presentPipeline=undefined;this.input=this.sceneDepth=this.cocView=this.outputView=undefined;this.key='';}
  private release():void {this.releaseTextures();this.uniform?.destroy();this.uniform=undefined;this.cocPipeline=this.bokehPipeline=undefined;this.originalColor=this.originalDepth=undefined;this.shaders.clear();}
  onDeviceRestored(engine:Engine):void {this.release();this.setup(engine);}
  dispose():void {if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);this.release();this.engine=undefined;}
  destroy():void {this.dispose();}
}
