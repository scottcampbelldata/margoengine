/// <reference lib="esnext.disposable" preserve="true" />
import {engineRuntime, type Engine, type EnginePlugin, type FrameGraph, type PassContext} from '@margoengine/core/extension';
import type {EngineKernel} from '@margoengine/core';
import {StereoRenderer} from './renderer.js';
import {XRController} from './controller.js';
export {XRController} from './controller.js';
import type {XRBinding,XRFrameState,XRMode,XRNativeFrame,XRNativeSession,XRProjectionLayer,XRSpace,XRSystem} from './types.js';
export type {XRBinding,XRFrameState,XRMode,XRNativeFrame,XRNativeSession,XRInputSource,XRInputPose,XRPose,XRSpace,XRView,XRViewerPose,XRProjectionLayer,XRSubImage,XRSystem} from './types.js';
export interface XRSessionOptions {
  referenceSpace?:'viewer'|'local'|'local-floor'|'bounded-floor'|'unbounded';
  requiredFeatures?:string[];optionalFeatures?:string[];
  onFrame?:(state:XRFrameState)=>void;
}
const platform=()=>globalThis as typeof globalThis&{XRGPUBinding?:new(session:XRNativeSession,device:GPUDevice)=>XRBinding};
const system=():XRSystem|undefined=>(globalThis.navigator as Navigator&{xr?:XRSystem}|undefined)?.xr;

export class XR implements EnginePlugin {
  readonly name='xr';
  session:XRNativeSession|null=null;
  private engine!:Engine;
  private readonly renderer:StereoRenderer;
  private context?:Extract<PassContext,{backend:'webgpu'}>;
  private binding?:XRBinding;
  private layer?:XRProjectionLayer;
  private space?:XRSpace;
  private handle:number|null=null;
  private pending=false;
  private disposed=false;
  private lost=false;
  private last:number|null=null;
  private mode:XRMode='immersive-vr';
  private callback?:XRSessionOptions['onFrame'];
  readonly controllers:XRController[]=[];
  private readonly state:XRFrameState={time:0,delta:0,frame:null!,viewer:null,inputs:this.controllers};
  private readonly renderOptions={culling:false,delta:0};
  private resume=false;

  static async isSupported(mode:XRMode='immersive-vr'):Promise<boolean> {
    if(!system()||mode!=='inline'&&(!platform().XRGPUBinding||!globalThis.navigator?.gpu))return false;
    return system()!.isSessionSupported(mode);
  }
  /** Prepare before the click handler so requestSession preserves the browser's user activation. */
  static attach(engine:EngineKernel):Promise<XR> {return XR.create(engine);}
  static async create(engine:EngineKernel):Promise<XR> {
    const runtime=engineRuntime(engine);
    if(runtime.disposed||runtime.backend!=='webgpu'||runtime.hasPlugin('xr'))throw new Error('XR requires a live WebGPU engine without an XR plugin');
    if(!system())throw new Error('WebXR is unavailable');
    const adapter=await navigator.gpu.requestAdapter({xrCompatible:!!platform().XRGPUBinding} as GPURequestAdapterOptions);
    if(!adapter)throw new Error('XR-compatible WebGPU adapter unavailable');
    const requiredFeatures=runtime.gpu?[...runtime.gpu.features].filter(feature=>adapter.features?.has(feature)) as GPUFeatureName[]:[];
    const device=await adapter.requestDevice({requiredFeatures}),xr=new XR(device);
    try{runtime.use(xr);return xr;}catch(error){xr.dispose();throw error;}
  }
  private constructor(private readonly device:GPUDevice) {
    this.renderer=new StereoRenderer(device);
    device.lost.then(info=>{if(!this.disposed){this.lost=true;this.fail(new Error(`XR GPU device lost: ${info.message}`));}});
    device.addEventListener('uncapturederror',this.uncaptured);
  }
  setup(engine:Engine):void {this.engine=engine;}
  private readonly uncaptured=(event:GPUUncapturedErrorEvent):void=>{if(!this.disposed)this.fail(new Error(event.error.message));};
  registerPasses(graph:FrameGraph):void {
    graph.add({name:'xr-scene-descriptor',order:-1_000_000,execute:context=>{if(context.backend==='webgpu')this.context=context;}});
  }
  async requestSession(mode:XRMode='immersive-vr',options:XRSessionOptions={}):Promise<XRNativeSession> {
    if(this.disposed||this.lost)throw new Error('XR is disposed or its device was lost');
    if(this.session||this.pending)throw new Error('An XR session is already active or pending');
    if(!['inline','immersive-vr','immersive-ar'].includes(mode))throw new TypeError('Unknown XR mode');
    if(mode!=='inline'&&!platform().XRGPUBinding)throw new Error('Native WebGPU XR bindings are unavailable; desktop rendering remains active');
    const referenceSpace=options.referenceSpace??(mode==='inline'?'viewer':'local');
    if(!['viewer','local','local-floor','bounded-floor','unbounded'].includes(referenceSpace))throw new TypeError('Unknown XR reference space');
    this.pending=true;let session:XRNativeSession|undefined;
    try {
      if(mode==='inline'&&[...options.requiredFeatures??[],...options.optionalFeatures??[]].includes('webgpu'))throw new TypeError('WebGPU XR bindings do not support inline sessions');
      session=await system()!.requestSession(mode,{requiredFeatures:[...new Set([...(mode==='inline'?[]:['webgpu']),...(referenceSpace==='viewer'?[]:[referenceSpace]),...options.requiredFeatures??[]])],optionalFeatures:options.optionalFeatures??[]});
      if(this.disposed||this.lost)throw new Error('XR was disposed during session negotiation');
      this.session=session;session.addEventListener('end',this.ended,{once:true});
      this.mode=mode;this.callback=options.onFrame;
      session.addEventListener('inputsourceschange',this.sourcesChanged);this.sourcesChanged();
      // shortcut: inline sessions expose poses with a desktop canvas, upgrade if WebGPU XR permits inline layers.
      if(mode==='inline'){this.space=await session.requestReferenceSpace(referenceSpace);if(this.disposed||this.session!==session)throw new Error('XR session ended during initialization');this.last=null;this.handle=session.requestAnimationFrame(this.frame);return session;}
      this.binding=new (platform().XRGPUBinding!)(session,this.device);
      const colorFormat=this.binding.getPreferredColorFormat();
      this.layer=this.binding.createProjectionLayer({colorFormat,depthStencilFormat:'depth24plus'});
      session.updateRenderState({layers:[this.layer],depthNear:this.engine.camera.near,depthFar:this.engine.camera.far});
      this.space=await session.requestReferenceSpace(referenceSpace);
      if(this.disposed||this.session!==session)throw new Error('XR session ended during initialization');
      this.engine.render({culling:false});
      if(!this.context)throw new Error('WebGPU scene descriptor unavailable');
      this.renderer.configure(this.context,colorFormat);
      this.engine.stop();this.resume=true;this.last=null;this.handle=session.requestAnimationFrame(this.frame);
      return session;
    }catch(error){if(session){try{await session.end();}catch{}finally{if(this.session===session)this.ended();}}throw error;}
    finally{this.pending=false;}
  }
  private readonly frame=(time:number,frame:XRNativeFrame):void=>{
    this.handle=null;if(this.disposed||frame.session!==this.session)return;
    try {
      const delta=this.last===null?0:Math.max(0,Math.min((time-this.last)/1000,0.1));this.last=time;
      const viewer=frame.getViewerPose(this.space!);
      for(let i=0;i<this.controllers.length;i++)this.controllers[i].update(frame,this.space!);
      this.state.time=time;this.state.delta=delta;this.state.frame=frame;this.state.viewer=viewer;this.callback?.(this.state);
      if(this.disposed||frame.session!==this.session)return;
      // shortcut: keep the canvas mirror and duplicate GPU buffers, upgrade when shared XR device hooks are available.
      if(this.mode!=='inline'){this.renderOptions.delta=delta;this.engine.render(this.renderOptions);
      if(viewer)this.renderer.render(this.engine,this.binding!,this.layer!,viewer,this.mode==='immersive-ar');}
      if(this.session===frame.session&&!this.disposed)this.handle=frame.session.requestAnimationFrame(this.frame);
    }catch(error){this.fail(error);}
  };
  private readonly sourcesChanged=():void=>{
    const sources=this.session?.inputSources??[];
    for(let i=this.controllers.length-1;i>=0;i--)if(!Array.prototype.includes.call(sources,this.controllers[i].source))this.controllers.splice(i,1);
    for(const source of sources)if(!this.controllers.some(controller=>controller.source===source))this.controllers.push(new XRController(source));
  };
  private fail(error:unknown):void {
    void this.end().catch(endError=>this.engine.onError(endError));this.engine.onError(error);
  }
  private readonly ended=():void=>{
    const session=this.session;if(session&&this.handle!==null)session.cancelAnimationFrame(this.handle);
    session?.removeEventListener('end',this.ended);session?.removeEventListener('inputsourceschange',this.sourcesChanged);this.controllers.length=0;this.session=null;this.handle=null;this.last=null;this.callback=undefined;this.space=undefined;this.binding=undefined;
    this.layer?.destroy();this.layer=undefined;this.renderer.dispose();
    if(this.resume){this.resume=false;if(!this.disposed&&!this.engine.disposed)this.engine.start();}
  };
  async end():Promise<void> {const session=this.session;if(session){try{await session.end();}finally{if(this.session===session)this.ended();}}}
  dispose():void {
    if(this.disposed)return;this.disposed=true;
    const session=this.session;this.ended();this.device.removeEventListener('uncapturederror',this.uncaptured);this.device.destroy();
    if(session)void session.end().catch(error=>this.engine.onError(error));
    if(this.engine?.hasPlugin(this.name))this.engine.removePlugin(this.name);
  }
  declare [Symbol.dispose]:()=>void;
  [(Symbol.dispose??Symbol()) as symbol]():void {this.dispose();}
}
export {XR as XRManager};
/** Request using a manager prepared before the user gesture. The caller owns manager disposal. */
export function useXRSession(manager:XR,mode:XRMode='immersive-vr',options:XRSessionOptions={}):Promise<XRNativeSession>{return manager.requestSession(mode,options);}
