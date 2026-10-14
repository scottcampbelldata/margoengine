/// <reference lib="esnext.disposable" preserve="true" />
import {SceneTarget} from '../../shared/msaa.js';
import type {EngineKernel} from '@margoengine/core';
import {engineRuntime,type Engine,type EnginePlugin,type FrameGraph,type PassContext} from '@margoengine/core/extension';
import {fullscreen,render,group} from '../../shared/gpu.js';
import type {StackStage} from '../../shared/stack.js';
declare const GPUTextureUsage:{RENDER_ATTACHMENT:number;TEXTURE_BINDING:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
// FXAA 3.11-style edge walk (after Timothy Lottes) on display-encoded colour, so luma is already perceptual.
const shader=fullscreen+`
@group(0) @binding(0) var image:texture_2d<f32>;
@group(0) @binding(1) var bilinear:sampler;
fn luma(uv:vec2f)->f32 {return dot(textureSampleLevel(image,bilinear,uv,0).rgb,vec3f(0.299,0.587,0.114));}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
 let texel=1/vec2f(textureDimensions(image));let uv=p.xy*texel;let center=textureSampleLevel(image,bilinear,uv,0);
 let m=dot(center.rgb,vec3f(0.299,0.587,0.114));
 let n=luma(uv-vec2f(0,texel.y));let s=luma(uv+vec2f(0,texel.y));let w=luma(uv-vec2f(texel.x,0));let e=luma(uv+vec2f(texel.x,0));
 let high=max(m,max(max(n,s),max(w,e)));let range=high-min(m,min(min(n,s),min(w,e)));
 if(range<max(0.0312,high*0.125)){return center;}
 let nw=luma(uv-texel);let se=luma(uv+texel);let ne=luma(uv+vec2f(texel.x,-texel.y));let sw=luma(uv+vec2f(-texel.x,texel.y));
 // A horizontal edge has the larger vertical second derivative.
 let horizontal=abs(nw+sw-2*w)+2*abs(n+s-2*m)+abs(ne+se-2*e)>=abs(nw+ne-2*n)+2*abs(w+e-2*m)+abs(sw+se-2*s);
 let l1=select(w,n,horizontal);let l2=select(e,s,horizontal);let g1=abs(l1-m);let g2=abs(l2-m);let gradient=0.25*max(g1,g2);
 var stride=select(texel.x,texel.y,horizontal);var edge=0.5*(m+l2);if(g1>=g2){stride=-stride;edge=0.5*(m+l1);}
 let across=select(vec2f(stride,0),vec2f(0,stride),horizontal);let along=select(vec2f(0,texel.y),vec2f(texel.x,0),horizontal);
 var p1=uv+across*0.5-along;var p2=uv+across*0.5+along;var d1=luma(p1)-edge;var d2=luma(p2)-edge;
 var done1=abs(d1)>=gradient;var done2=abs(d2)>=gradient;var steps=array<f32,11>(1,1,1,1,1.5,2,2,2,2,4,8);
 for(var i=0;i<11&&!(done1&&done2);i++){
  if(!done1){p1-=along*steps[i];d1=luma(p1)-edge;done1=abs(d1)>=gradient;}
  if(!done2){p2+=along*steps[i];d2=luma(p2)-edge;done2=abs(d2)>=gradient;}
 }
 let dist1=select(uv.y-p1.y,uv.x-p1.x,horizontal);let dist2=select(p2.y-uv.y,p2.x-uv.x,horizontal);
 // Shift toward the nearer edge end only when its luma turns the right way; blend sub-pixel aliasing either way.
 let correct=(select(d2,d1,dist1<dist2)<0)!=(m<edge);
 let sub=clamp(abs((2*(n+s+w+e)+nw+ne+sw+se)/12-m)/range,0,1);let blend=(3-2*sub)*sub*sub;
 let offset=max(select(0.0,0.5-min(dist1,dist2)/(dist1+dist2),correct),blend*blend*0.75);
 return vec4f(textureSampleLevel(image,bilinear,uv+across*offset,0).rgb,center.a);
}`;

/** Fast approximate anti-aliasing for single-sampled (phone or light-tier) output. Alone it captures the finished frame
 * outside every other effect; in a PostStack it runs after the display effect. */
export class FXAA implements EnginePlugin {
  readonly name='fxaa';
  private engine?:Engine;private sampler?:GPUSampler;private pipeline?:GPURenderPipeline;private group?:GPUBindGroup;private input?:GPUTextureView;private key='';
  private target?:SceneTarget;private color?:GPUTexture;private depth?:GPUTexture;private view?:GPUTextureView;private original?:GPUTextureView;private multisample?:GPUMultisampleState;
  private stacked=false;private disposed=false;
  private readonly attachment:GPURenderPassColorAttachment={view:undefined!,loadOp:'clear',storeOp:'store'};private readonly descriptor:GPURenderPassDescriptor={colorAttachments:[this.attachment]};
  static attach(instance:EngineKernel):FXAA {const effect=new FXAA();engineRuntime(instance).use(effect);return effect;}
  private joinStack():StackStage {
    if(this.engine||this.stacked||this.disposed)throw new Error('FXAA is already attached');
    this.stacked=true;return {kind:'ldr',render:(c,input,output)=>this.paint(c,input,output.format,output.multisample,output.view)};
  }
  setup(engine:Engine):void {
    if(this.disposed||!engine.gpu)throw new Error('FXAA requires WebGPU and a live effect');
    this.engine=engine;this.sampler=engine.gpu.createSampler({magFilter:'linear',minFilter:'linear'});
  }
  registerPasses(graph:FrameGraph):void {
    if(this.stacked)return;
    graph.add({name:'fxaa:capture',order:-80,execute:c=>{if(c.backend==='webgpu')this.capture(c);}});
    graph.add({name:'fxaa:resolve',order:50,execute:c=>{if(c.backend!=='webgpu')return;
      this.target!.resolve(c.encoder,true);this.paint(c,this.view!,this.color!.format,this.multisample,this.original!);this.target!.restore(c);}});
  }
  private capture(c:Context):void {
    const samples=c.descriptor.multisample?.count??4,depth=c.descriptor.depthStencil!.format;
    if(this.color?.width!==c.width||this.color.height!==c.height||this.color.format!==c.format||this.depth!.format!==depth||this.target!.samples!==samples){
      this.release();const usage=GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING;
      this.color=c.device.createTexture({size:[c.width,c.height],format:c.format,usage});this.depth=c.device.createTexture({size:[c.width,c.height],format:depth,usage});
      this.target=new SceneTarget(c.device,this.color,this.depth,samples);this.view=this.color.createView();
    }
    this.original=c.color;this.multisample=c.descriptor.multisample;this.target!.begin(c);
  }
  private paint(c:Context,input:GPUTextureView,format:GPUTextureFormat,multisample:GPUMultisampleState|undefined,view:GPUTextureView):void {
    const key=format+':'+(multisample?.count??1);
    if(this.key!==key){this.key=key;this.pipeline=render(c.device,shader,format,{multisample});this.input=undefined;}
    if(this.input!==input){this.input=input;this.group=group(c.device,this.pipeline!,[input,this.sampler!]);}
    this.attachment.view=view;const pass=c.encoder.beginRenderPass(this.descriptor);pass.setPipeline(this.pipeline!);pass.setBindGroup(0,this.group!);pass.draw(3);pass.end();
  }
  private release():void {this.target?.dispose();this.color?.destroy();this.depth?.destroy();this.target=this.color=this.depth=this.view=this.input=undefined;}
  onDeviceRestored(engine:Engine):void {this.release();this.key='';this.setup(engine);}
  dispose():void {if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);this.release();this.engine=this.sampler=this.pipeline=this.group=undefined;this.original=undefined;}
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
  /** @deprecated Use dispose(); kept as an alias until 1.0. */
  destroy():void {this.dispose();}
}
