/// <reference lib="esnext.disposable" preserve="true" />
import { margoError } from '../../shared/errors.js';
import type { XRSessionOptions } from './index.js';
import type { XRNativeSession, XRProjectionLayer, XRView } from './types.js';

/** Performance-related session negotiation options. */
export interface XRPerformanceSessionOptions {
  /** Projection size relative to the runtime recommendation. Default native 1, or the compatibility installXR setting. Set before the session. */
  framebufferScale?: number;
  /** Request pose-synchronized AR camera images. Default false; choose required or optional browser permission. */
  cameraAccess?: false | 'required' | 'optional';
}
/** Copies session options, adding projection scale and the camera-access feature without changing the inputs. */
export function performanceSessionOptions(options:XRPerformanceSessionOptions={},base:XRSessionOptions={}):XRSessionOptions {
  const scale=options.framebufferScale??base.framebufferScale;
  if(scale!==undefined&&(!Number.isFinite(Math.fround(scale))||Math.fround(scale)<=0))throw new RangeError('framebufferScale must be finite and positive; pass 1 for the runtime default');
  const camera=options.cameraAccess??false;
  if(camera!==false&&camera!=='required'&&camera!=='optional')throw new TypeError('cameraAccess must be false, required or optional; pass required to require camera permission');
  const required=new Set(base.requiredFeatures??[]),optional=new Set(base.optionalFeatures??[]);
  if(camera==='required'){required.add('camera-access');optional.delete('camera-access');}
  if(camera==='optional'&&!required.has('camera-access'))optional.add('camera-access');
  return {...base,...(scale===undefined?{}:{framebufferScale:scale}),requiredFeatures:[...required],optionalFeatures:[...optional]};
}
/** The session, layer and device accepted by XRPerformance. */
export interface XRPerformanceHost {
  readonly session:XRNativeSession|null;
  readonly projectionLayer:XRProjectionLayer|undefined;
  readonly layerBinding:{readonly device:GPUDevice;readonly binding:object}|undefined;
}
/** Fixed foveation options. */
export interface XRPerformanceOptions {
  /** Requested peripheral resolution reduction, from zero to one. Unset preserves the browser setting. */
  fixedFoveation?:number;
  /** Restore foveation and release references when aborted. */
  signal?:AbortSignal;
}
/** Raw camera dimensions, supplied by the browser's Raw Camera Access module. */
export interface XRCameraLike {readonly width:number;readonly height:number;}
/** A borrowed WebGL camera image; read only inside its XR frame, and never delete the texture. */
export interface XRCameraImage {
  readonly camera:XRCameraLike;
  readonly texture:WebGLTexture;
  readonly context:WebGL2RenderingContext;
}
/** Live foveation and raw camera access for one immersive session. */
export class XRPerformance {
  private readonly session:XRNativeSession;
  private readonly layer:{fixedFoveation?:number|null};
  private readonly initial:number|null|undefined;
  private cameraBinding?:{getCameraImage(camera:XRCameraLike):WebGLTexture|null};
  private disposed=false;
  private ended=false;
  private readonly stops:(()=>void)[]=[];
  /** Attaches to an active session. Framebuffer scale is set earlier with performanceSessionOptions. */
  static attach(xr:XRPerformanceHost,options:XRPerformanceOptions={}):XRPerformance {return new XRPerformance(xr,options);}
  private constructor(private readonly xr:XRPerformanceHost,options:XRPerformanceOptions) {
    options.signal?.throwIfAborted();
    if(!xr.session||!xr.projectionLayer)throw margoError('state','XRPerformance needs an immersive session; await xr.requestSession first');
    this.session=xr.session;
    this.layer=(xr.projectionLayer.baseLayer??xr.projectionLayer) as {fixedFoveation?:number|null};
    this.initial=this.layer.fixedFoveation;
    if(options.fixedFoveation!==undefined)this.fixedFoveation=options.fixedFoveation;
    const end=()=>{this.ended=true;this.dispose();};this.session.addEventListener('end',end);
    this.stops.push(()=>this.session.removeEventListener('end',end));
    if(options.signal){const abort=()=>this.dispose();options.signal.addEventListener('abort',abort,{once:true});this.stops.push(()=>options.signal!.removeEventListener('abort',abort));}
  }
  private active():void {
    if(this.disposed)throw margoError('disposed','XRPerformance is disposed; attach to a live immersive session');
    if(this.xr.session!==this.session)throw margoError('state','The XR session changed; attach XRPerformance to the new session');
  }
  /** Actual foveation after runtime quantization, or null when unsupported. */
  get fixedFoveation():number|null {this.active();return typeof this.layer.fixedFoveation==='number'?this.layer.fixedFoveation:null;}
  /** Requests foveation from zero (off) to one (maximum). Unsupported runtimes reject. */
  set fixedFoveation(value:number) {
    this.active();
    if(!Number.isFinite(value)||value<0||value>1)throw new RangeError('fixedFoveation must be in [0, 1]; use 0 to disable foveation');
    if(typeof this.layer.fixedFoveation!=='number')throw margoError('unsupported','This XR layer has no fixed foveation; use a runtime that exposes fixedFoveation');
    this.layer.fixedFoveation=value;
  }
  /**
   * Reads a pose-synchronized camera texture during an active XR frame. Returns null when that view has no camera.
   * Raw Camera Access specifies a WebGL texture, so native WebGPU sessions reject; the compatibility route uses its
   * own XR-compatible WebGL2 context. Ask for camera-access before the session starts.
   */
  cameraImage(view:XRView):XRCameraImage|null {
    this.active();
    if(this.session.enabledFeatures&&!this.session.enabledFeatures.includes('camera-access'))
      throw margoError('unsupported','The session has no camera-access feature; request it with performanceSessionOptions before entering AR');
    const gl=(this.xr.layerBinding?.device as GPUDevice&{gl?:WebGL2RenderingContext}|undefined)?.gl;
    if(!gl)throw margoError('unsupported','Raw Camera Access exposes WebGL textures; use the WebGL2 compatibility XR route for cameraImage');
    const camera=(view as XRView&{camera?:XRCameraLike|null}).camera;
    if(!camera)return null;
    if(!this.cameraBinding){
      const Binding=(globalThis as typeof globalThis&{XRWebGLBinding?:new(session:XRNativeSession,gl:WebGL2RenderingContext)=>{getCameraImage?(camera:XRCameraLike):WebGLTexture|null}}).XRWebGLBinding;
      if(!Binding)throw margoError('unsupported','XRWebGLBinding is unavailable; use a browser with Raw Camera Access');
      const binding=new Binding(this.session,gl);
      if(typeof binding.getCameraImage!=='function')throw margoError('unsupported','This XR binding has no camera images; use a runtime with getCameraImage');
      this.cameraBinding=binding as {getCameraImage(camera:XRCameraLike):WebGLTexture|null};
    }
    const texture=this.cameraBinding.getCameraImage(camera);
    return texture?{camera,texture,context:gl}:null;
  }
  /** Restores the original foveation and removes listeners. Never deletes a borrowed camera texture. Idempotent. */
  dispose():void {
    if(this.disposed)return;this.disposed=true;
    if(!this.ended && this.xr.session===this.session && typeof this.initial==='number')this.layer.fixedFoveation=this.initial;
    for(const stop of this.stops)stop();this.stops.length=0;this.cameraBinding=undefined;
  }
  declare [Symbol.dispose]:()=>void;
  [(Symbol.dispose??Symbol()) as symbol]():void{this.dispose();}
}
