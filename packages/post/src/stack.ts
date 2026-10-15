/// <reference lib="esnext.disposable" preserve="true" />
import {SceneTarget} from '../../shared/msaa.js';
import type {EngineKernel} from '@margoengine/core';
import {engineRuntime,type Engine,type EnginePlugin,type FrameGraph,type PassContext} from '@margoengine/core/extension';
import type {StackHost,StackStage,StageOutput} from '../../shared/stack.js';
declare const GPUTextureUsage:{RENDER_ATTACHMENT:number;TEXTURE_BINDING:number;COPY_SRC:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;
const owners=['bloom','ssao','dof','tonemap','post-processing'],rank={hdr:0,display:1,ldr:2},single={count:1};

/** One HDR scene capture shared by several effects, applied in array order: HDR effects (SSAO, DOF, Bloom), at most one
 * display effect (Tonemap or creative PostProcessing), then LDR effects (FXAA). Without a display effect the last HDR
 * effect tonemaps as it does alone. The stack attaches, restores and disposes its effects. */
export class PostStack implements EnginePlugin {
  readonly name='post:stack';
  private engine?:Engine;private color?:GPUTexture;private colorView?:GPUTextureView;
  private readonly host:StackHost={};private readonly stages:StackStage[];private readonly live:boolean[]=[];
  private count=0;private attached=0;private disposed=false;private source?:string;private linear='';
  private slots:(GPUTexture|undefined)[]=[];private views:GPUTextureView[]=[];
  private readonly hdr:StageOutput={view:undefined!,format:'rgba16float',multisample:single,hdr:true};
  private readonly ldr:StageOutput={view:undefined!,format:'bgra8unorm',multisample:single,hdr:false};
  private readonly final:StageOutput={view:undefined!,format:'bgra8unorm',multisample:single,hdr:false};
  constructor(readonly effects:readonly EnginePlugin[]){
    if(!Array.isArray(effects)||!effects.length||new Set(effects.map(effect=>effect?.name)).size!==effects.length)throw new TypeError('PostStack needs distinct effects');
    let last=0,displays=0;
    this.stages=effects.map(effect=>{
      const join=(effect as {joinStack?:(host:StackHost)=>StackStage}).joinStack;if(typeof join!=='function')throw new TypeError(`${effect.name} cannot join a PostStack`);
      const stage=join.call(effect,this.host);
      if(rank[stage.kind]<last||(displays+=+(stage.kind==='display'))>1)throw new RangeError('PostStack order: HDR effects, at most one display effect, then LDR effects');
      last=rank[stage.kind];return stage;
    });
  }
  static attach(engine:EngineKernel,effects:readonly EnginePlugin[]):PostStack {const stack=new PostStack(effects);engineRuntime(engine).use(stack);return stack;}
  /** Resolved 1x scene depth, e.g. for TAA({depth:()=>stack.depthTexture}). */
  get depthTexture():GPUTexture|undefined{return this.host.depthTexture;}
  /** The 1x linear HDR scene capture (rgba16float) while the stack has an HDR or display effect, e.g. for
   * Water({sceneColor:()=>stack.sceneTexture}) refraction alongside SSAO; undefined with only LDR effects or before the first frame. */
  get sceneTexture():GPUTexture|undefined{return this.color?.format==='rgba16float'?this.color:undefined;}
  setup(engine:Engine):void {
    if(this.disposed||!engine.gpu)throw new Error('PostStack requires WebGPU and a live stack');
    for(const name of owners)if(engine.hasPlugin(name))throw new Error(`Add ${name} to the PostStack instead of attaching it alone`);
    this.engine=engine;for(const effect of this.effects){engine.use(effect);this.attached++;}
  }
  registerPasses(graph:FrameGraph):void {
    graph.add({name:'post:stack:capture',order:-65,execute:c=>{if(c.backend==='webgpu')this.capture(c);}});
    graph.add({name:'post:stack:compose',order:30,execute:c=>{if(c.backend==='webgpu')this.compose(c);}});
  }
  private capture(c:Context):void {
    let hdr=false;this.count=0;
    for(let i=0;i<this.stages.length;i++)if(this.live[i]=this.engine!.hasPlugin(this.effects[i].name)){this.count++;hdr||=this.stages[i].kind!=='ldr';}
    if(!this.count)return;
    if(hdr&&this.source!==c.shader){
      const linear=c.shader.replace(/let mapped=linear\/[\s\S]*?return vec4f\([^\n]+\);/,'return vec4f(linear,1);');
      if(linear===c.shader)throw new Error('PostStack requires the standard core lighting shader');this.source=c.shader;this.linear=linear;
    }
    const samples=c.descriptor.multisample?.count??4,depth=c.descriptor.depthStencil!.format,format=hdr?'rgba16float':c.format,h=this.host;
    if(this.color?.width!==c.width||this.color.height!==c.height||this.color.format!==format||h.depthTexture!.format!==depth||h.target!.samples!==samples){
      this.release();const usage=GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING;
      this.color=c.device.createTexture({size:[c.width,c.height],format,usage:usage|GPUTextureUsage.COPY_SRC});this.colorView=this.color.createView();
      h.depthTexture=c.device.createTexture({size:[c.width,c.height],format:depth,usage});h.target=new SceneTarget(c.device,this.color,h.depthTexture,samples);
    }
    const f=this.final;f.view=c.color;f.format=this.ldr.format=c.format;f.multisample=c.descriptor.multisample??single;
    h.target!.begin(c);if(hdr)c.shader=this.linear;
  }
  private compose(c:Context):void {
    if(!this.count)return;
    try{
      this.host.target!.resolve(c.encoder,true);
      let input=this.colorView!,last=0,display=-1,h=0,l=2;
      for(let i=0;i<this.stages.length;i++)if(this.live[i]){last=i;if(this.stages[i].kind!=='ldr')display=i;}
      for(let i=0;i<=last;i++){
        if(!this.live[i])continue;
        const out=i===last?this.final:i<display?this.hdr:this.ldr;
        // Ping-pong per kind so no stage reads the texture it writes.
        if(out===this.hdr){out.view=this.slot(c,h,'rgba16float');h^=1;}else if(out===this.ldr){out.view=this.slot(c,l,out.format);l^=1;}
        input=this.stages[i].render(c,input,out)||out.view;
      }
    }finally{this.host.target!.restore(c);}
  }
  private slot(c:Context,i:number,format:GPUTextureFormat):GPUTextureView {
    const t=this.slots[i];
    if(t?.width!==c.width||t.height!==c.height||t.format!==format){t?.destroy();const n=this.slots[i]=c.device.createTexture({size:[c.width,c.height],format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});this.views[i]=n.createView();}
    return this.views[i];
  }
  private release():void {
    this.host.target?.dispose();this.color?.destroy();this.host.depthTexture?.destroy();for(const t of this.slots)t?.destroy();
    this.slots=[];this.views=[];this.host.target=this.host.depthTexture=this.color=this.colorView=undefined;
  }
  onDeviceRestored():void {this.release();}
  dispose():void {
    if(this.disposed)return;this.disposed=true;const engine=this.engine;this.engine=undefined;engine?.removePlugin(this.name);
    for(let i=0;i<this.attached;i++)if(engine?.hasPlugin(this.effects[i].name))engine.removePlugin(this.effects[i].name);this.release();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
}
