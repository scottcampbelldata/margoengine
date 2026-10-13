import type {EngineKernel} from '@margoengine/core';
import {engineRuntime, type Engine, type EnginePlugin, type FrameGraph, type PassContext} from '@margoengine/core/extension';
import {sceneSamples} from '../../shared/quality.js';
import {fullscreen} from '../../shared/gpu.js';
import {afterPresented as presented} from '../../shared/demo-frame.js';
export const afterPresented: (queue: Pick<GPUQueue, 'onSubmittedWorkDone'>, signal: AbortSignal) => Promise<void> = presented;
declare const GPUTextureUsage:{RENDER_ATTACHMENT:number;COPY_SRC:number;COPY_DST:number;TEXTURE_BINDING:number};
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number};

const shader=fullscreen+`
@group(0) @binding(0) var previous:texture_2d<f32>;
@group(0) @binding(1) var<uniform> settings:vec4f;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
 let size=vec2i(textureDimensions(previous));
 let q=clamp(vec2i(p.xy/settings.xy*vec2f(size)),vec2i(0),size-1);
 return vec4f(textureLoad(previous,q,0).rgb,settings.z);
}`;

/** Briefly blends a captured, already-visible scene over its upgraded effects.
 * Attach before the base render, capture immediately after it, then warm before
 * installing effects. Start only after their first GPU frame has completed.
 */
export class SceneFade implements EnginePlugin {
  readonly name='post:scene-fade';
  readonly finished:Promise<void>;
  private finish!:()=>void;
  private engine?:Engine;
  private device?:GPUDevice;
  private context?:GPUCanvasContext;
  private snapshot?:GPUTexture;
  private uniform?:GPUBuffer;
  private pipeline?:GPURenderPipeline;
  private group?:GPUBindGroup;
  private readonly values=new Float32Array(4);
  private started?:number;
  private disposed=false;
  constructor(readonly duration=180){
    if(!Number.isFinite(duration)||duration<0||duration>1000)throw new RangeError('Invalid scene fade duration');
    this.finished=new Promise(resolve=>{this.finish=resolve;});
  }
  static attach(instance:EngineKernel,duration=180):SceneFade {
    const fade=new SceneFade(duration);engineRuntime(instance).use(fade);return fade;
  }
  setup(engine:Engine):void {
    if(this.disposed||!engine.gpu)throw new Error('SceneFade requires WebGPU and a live effect');
    this.engine=engine;this.device=engine.gpu;
    const context=engine.canvas.getContext('webgpu') as GPUCanvasContext|null;
    if(!context)throw new Error('SceneFade requires a WebGPU canvas');this.context=context;
    this.context.configure({device:this.device,format:navigator.gpu.getPreferredCanvasFormat(),usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
    this.uniform=this.device.createBuffer({label:'scene-fade:uniform',size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  }
  capture():void {
    if(this.disposed||!this.device||this.pipeline)throw new Error('SceneFade must capture a live scene before warming');
    const source=this.context!.getCurrentTexture(),device=this.device;
    if(!this.snapshot||this.snapshot.width!==source.width||this.snapshot.height!==source.height){
      this.snapshot?.destroy();this.snapshot=device.createTexture({size:[source.width,source.height],format:source.format,usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});
    }
    const encoder=device.createCommandEncoder();encoder.copyTextureToTexture({texture:source},{texture:this.snapshot},[source.width,source.height]);device.queue.submit([encoder.finish()]);
  }
  async warm():Promise<void> {
    if(this.disposed||!this.snapshot)throw new Error('Capture a scene before warming its fade');
    const device=this.device!,module=device.createShaderModule({code:shader});
    const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:this.snapshot.format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},multisample:{count:sceneSamples()}});
    if(this.disposed)throw new Error('SceneFade was disposed while warming');
    this.pipeline=pipeline;this.group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:this.snapshot.createView()},{binding:1,resource:{buffer:this.uniform!}}]});
  }
  start():void {
    if(this.disposed||!this.pipeline)throw new Error('Warm a live SceneFade before starting');
    this.started??=performance.now();
  }
  registerPasses(graph:FrameGraph):void {graph.add({name:this.name,order:100,execute:c=>{if(c.backend==='webgpu')this.draw(c);}});}
  private draw(c:Extract<PassContext,{backend:'webgpu'}>):void {
    if(!this.pipeline||this.disposed)return;
    const t=this.started===undefined?0:this.duration?Math.min(1,(performance.now()-this.started)/this.duration):1;
    this.values.set([c.width,c.height,1-t*t*(3-2*t),0]);
    c.device.queue.writeBuffer(this.uniform!,0,this.values as Float32Array<ArrayBuffer>);
    if(t===1){this.finish();return;}
    const pass=c.encoder.beginRenderPass({colorAttachments:[{view:c.color,loadOp:'load',storeOp:'store'}]});
    pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.group!);pass.draw(3);pass.end();
  }
  onDeviceRestored():void {this.dispose();}
  dispose():void {
    if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);
    this.snapshot?.destroy();this.uniform?.destroy();this.finish();
    this.snapshot=this.uniform=this.pipeline=this.group=this.context=this.device=this.engine=undefined;
  }
}
