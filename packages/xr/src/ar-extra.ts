/// <reference lib="esnext.disposable" preserve="true" />
import { Geometry, PbrMaterial, type EngineKernel, type Mesh, type Scene } from '@margoengine/core';
import { ownScene } from './scene-owner.js';
import { splitTRS } from '@margoengine/math/quat';
import { margoError } from '../../shared/errors.js';
import type { XRSessionOptions } from './index.js';
import type { XRAnchor, XRFrameState, XRNativeFrame, XRNativeSession, XRSpace } from './types.js';

/** Session and frame hooks accepted by AR tracking extras. */
export interface ARExtraHost {
  readonly session:XRNativeSession|null;
  readonly referenceSpace:XRSpace|undefined;
  onFrame(callback:(state:XRFrameState)=>void):()=>void;
}
/** DOM overlay options. */
export interface DOMOverlayOptions {
  /** Suppress duplicate XR-world select actions over the overlay. Default true. */
  preventWorldSelect?:boolean;
  /** Remove event listeners on abort. */
  signal?:AbortSignal;
}
/** Adds the standard dom-overlay session feature and root while preserving other session init members. */
export function domOverlaySessionOptions(root:Element,base:XRSessionOptions={}):XRSessionOptions {
  if(!root||root.nodeType!==1)throw new TypeError('DOM overlay needs an element; pass a container from document.createElement');
  return {...base,requiredFeatures:[...new Set([...(base.requiredFeatures??[]),'dom-overlay'])],init:{...base.init,domOverlay:{root}}};
}
/** Owns beforexrselect handling for a browser-managed DOM overlay. */
export class DOMOverlay {
  private disposed=false;
  private readonly stop:()=>void;
  /** Attaches after negotiating domOverlaySessionOptions. */
  static attach(xr:ARExtraHost,root:Element,options:DOMOverlayOptions={}):DOMOverlay{return new DOMOverlay(xr,root,options);}
  private constructor(xr:ARExtraHost,root:Element,options:DOMOverlayOptions){
    options.signal?.throwIfAborted();
    const session=needSession(xr,'dom-overlay');
    if(!root||root.nodeType!==1)throw new TypeError('DOM overlay needs an element; pass the root used to request the session');
    const select=(event:Event)=>{if(options.preventWorldSelect??true)event.preventDefault();};
    const end=()=>this.dispose();root.addEventListener('beforexrselect',select);
    session.addEventListener('end',end);options.signal?.addEventListener('abort',end,{once:true});
    this.stop=()=>{root.removeEventListener('beforexrselect',select);session.removeEventListener('end',end);options.signal?.removeEventListener('abort',end);};
    this.type=(session as XRNativeSession&{domOverlayState?:{type:string}}).domOverlayState?.type??null;
  }
  /** Browser overlay presentation type, or null if it does not report a type. */
  readonly type:string|null;
  /** Removes listeners; the caller retains the DOM element. Idempotent. */
  dispose():void{if(this.disposed)return;this.disposed=true;this.stop();}
  declare [Symbol.dispose]:()=>void;
  [(Symbol.dispose??Symbol()) as symbol]():void{this.dispose();}
}
/** A bitmap and its physical printed width. The caller owns the bitmap. */
export interface TrackedImageInit {readonly image:ImageBitmap;readonly widthInMeters:number;}
/** Chooses the current marker-tracking feature or legacy image-tracking feature explicitly. */
export interface ImageTrackingSessionOptions {
  /** Use image-tracking/getImageTrackingScores on older runtimes. Default false. */
  legacy?:boolean;
}
/** Configures image targets before session negotiation. Default current marker-tracking feature. */
export function imageTrackingSessionOptions(images:readonly TrackedImageInit[],options:ImageTrackingSessionOptions={},base:XRSessionOptions={}):XRSessionOptions {
  if(!Array.isArray(images)||!images.length)throw new TypeError('Provide image targets before entering AR; pass [{ image, widthInMeters: 0.2 }]');
  const targets=images.map(target=>{
    if(!target?.image||!Number.isFinite(target.widthInMeters)||target.widthInMeters<=0)
      throw new RangeError('Each image target needs a bitmap and positive finite widthInMeters; pass the printed image width in metres');
    return {image:target.image,widthInMeters:target.widthInMeters};
  });
  const feature=options.legacy?'image-tracking':'marker-tracking';
  return {...base,requiredFeatures:[...new Set([...(base.requiredFeatures??[]),feature])],init:{...base.init,trackedImages:targets}};
}
/** A copied image observation, retained independently of the browser frame. */
export interface TrackedImage {
  readonly index:number;
  readonly trackingState:'tracked'|'emulated';
  readonly measuredWidthInMeters:number;
  /** Pose in the host reference space, or null while the image pose is unavailable. */
  readonly matrix:Float32Array|null;
}
/** Image tracking subscriptions. */
export interface ImageTrackingOptions {
  /** Called once per frame with copied observations. Default no callback; images remains available. */
  onUpdate?:(images:readonly TrackedImage[])=>void;
  /** Remove frame and session listeners on abort. */
  signal?:AbortSignal;
}
type ImageResult={index:number;imageSpace:XRSpace;trackingState:'tracked'|'emulated';measuredWidthInMeters:number};
const needSession=(host:ARExtraHost,feature:string):XRNativeSession=>{
  const session=host.session;
  if(!session)throw margoError('state','AR tracking needs an active session; await xr.requestSession first');
  if(session.enabledFeatures&&!session.enabledFeatures.includes(feature))
    throw margoError('unsupported',`The session has no '${feature}' feature; request it before entering AR`);
  return session;
};
class SessionLifetime {
  readonly abort=new AbortController();
  readonly stops:(()=>void)[]=[];
  constructor(readonly session:XRNativeSession,signal:AbortSignal|undefined,readonly close:()=>void){
    signal?.throwIfAborted();
    const end=()=>close();session.addEventListener('end',end);signal?.addEventListener('abort',end,{once:true});
    this.stops.push(()=>session.removeEventListener('end',end),()=>signal?.removeEventListener('abort',end));
  }
  stop():void{this.abort.abort(margoError('disposed','AR tracking is disposed; create a tracker for an active session'));for(const stop of this.stops)stop();this.stops.length=0;}
  async wait<T>(work:Promise<T>,signal?:AbortSignal):Promise<T>{
    const combined=signal?AbortSignal.any([this.abort.signal,signal]):this.abort.signal;combined.throwIfAborted();
    let remove=()=>{};
    const cancelled=new Promise<never>((_,reject)=>{const abort=()=>reject(combined.reason);combined.addEventListener('abort',abort,{once:true});remove=()=>combined.removeEventListener('abort',abort);});
    try{return await Promise.race([work,cancelled]);}finally{remove();}
  }
}
/** Tracks supplied image targets with both the current and legacy browser module. */
export class ImageTracking {
  /** Current copied observations, keyed by target index. */
  readonly images=new Map<number,TrackedImage>();
  private readonly lifetime:SessionLifetime;
  private disposed=false;
  /** Attaches to the negotiated current or legacy image tracking session. */
  static attach(host:ARExtraHost,options:ImageTrackingOptions={}):ImageTracking{return new ImageTracking(host,options);}
  private constructor(private readonly host:ARExtraHost,private readonly options:ImageTrackingOptions){
    const session=host.session;
    const feature=session?.enabledFeatures?.includes('marker-tracking')?'marker-tracking':'image-tracking';
    this.lifetime=new SessionLifetime(needSession(host,feature),options.signal,()=>this.dispose());
    this.lifetime.stops.push(host.onFrame(state=>this.update(state)));
  }
  /** Returns trackable/untrackable scores in target order; abort cancels the wait. */
  async trackability(signal?:AbortSignal):Promise<readonly string[]>{
    const session=this.lifetime.session as XRNativeSession&{getImageTrackability?():Promise<readonly string[]>;getImageTrackingScores?():Promise<readonly string[]>};
    const read=session.getImageTrackability??session.getImageTrackingScores;
    if(!read)throw margoError('unsupported','The session cannot report image trackability; use a runtime with the image tracking module');
    this.lifetime.abort.signal.throwIfAborted();signal?.throwIfAborted();
    return Object.freeze([...(await this.lifetime.wait(read.call(session),signal))]);
  }
  private update(state:XRFrameState):void{
    if(this.disposed||state.frame.session!==this.lifetime.session)return;
    const read=(state.frame as XRNativeFrame&{getImageTrackingResults?():readonly ImageResult[]}).getImageTrackingResults;
    if(!read)throw margoError('unsupported','The frame has no image tracking results; request marker-tracking or legacy image-tracking');
    const next=new Map<number,TrackedImage>(),space=this.host.referenceSpace;
    for(const result of read.call(state.frame)){
      const pose=space?state.frame.getPose(result.imageSpace,space):null;
      next.set(result.index,Object.freeze({index:result.index,trackingState:result.trackingState,measuredWidthInMeters:result.measuredWidthInMeters,matrix:pose?new Float32Array(pose.transform.matrix):null}));
    }
    this.images.clear();for(const [index,image] of next)this.images.set(index,image);
    this.options.onUpdate?.(Object.freeze([...this.images.values()]));
  }
  /** Unsubscribes, cancels pending score waits and clears observations. Idempotent. */
  dispose():void{if(this.disposed)return;this.disposed=true;this.lifetime.stop();this.images.clear();}
  declare [Symbol.dispose]:()=>void;
  [(Symbol.dispose??Symbol()) as symbol]():void{this.dispose();}
}
/** Browser mesh detection object. */
export interface XRDetectedMesh {
  readonly meshSpace:XRSpace;
  readonly vertices:Float32Array;
  readonly indices:Uint32Array;
  readonly lastChangedTime:number;
  readonly semanticLabel?:string|null;
}
/** Copied mesh geometry plus a current pose, usable after the browser frame ends. */
export interface DetectedMesh {
  readonly source:XRDetectedMesh;
  readonly vertices:Float32Array;
  readonly indices:Uint32Array;
  readonly matrix:Float32Array|null;
  readonly label:string;
  readonly lastChangedTime:number;
}
/** Mesh tracking options. */
export interface MeshDetectionOptions {
  /** Called for new geometry. */
  onAdd?:(mesh:DetectedMesh)=>void;
  /** Called when geometry or semantic label changes; pose alone does not count as geometry change. */
  onChange?:(mesh:DetectedMesh)=>void;
  /** Called when the browser removes a mesh, or the tracker closes. */
  onRemove?:(mesh:DetectedMesh)=>void;
  /** Optional drawing. Default no visualization. Scene defaults to engine.scene; material defaults to grey. */
  show?:{engine:EngineKernel;scene?:Scene;material?:PbrMaterial};
  /** Close on abort. */
  signal?:AbortSignal;
}
/** Tracks native triangle meshes and optionally displays them as Margo meshes. */
export class MeshDetection {
  /** Current copied records by the browser's stable mesh identity. */
  readonly meshes=new Map<XRDetectedMesh,DetectedMesh>();
  private readonly lifetime:SessionLifetime;
  private readonly visible=new Map<XRDetectedMesh,Mesh>();
  private readonly drawScene?:Scene;
  private disposed=false;
  /** Loads normal generation lazily only for show, then subscribes to an active mesh-detection session. */
  static async create(host:ARExtraHost,options:MeshDetectionOptions={}):Promise<MeshDetection>{
    const session=needSession(host,'mesh-detection');options.signal?.throwIfAborted();
    const geometry=options.show?await import('@margoengine/geometry'):undefined;
    options.signal?.throwIfAborted();
    if(host.session!==session)throw margoError('state','The XR session changed while preparing mesh display; create a tracker for the active session');
    return new MeshDetection(host,options,geometry);
  }
  private constructor(private readonly host:ARExtraHost,private readonly options:MeshDetectionOptions,private readonly geometry:typeof import('@margoengine/geometry')|undefined){
    this.lifetime=new SessionLifetime(needSession(host,'mesh-detection'),options.signal,()=>this.dispose());
    this.drawScene=options.show?.scene??options.show?.engine.scene;
    if(this.drawScene)this.lifetime.stops.push(ownScene(this.drawScene,()=>this.dispose()));
    this.lifetime.stops.push(host.onFrame(state=>this.update(state)));
  }
  private update(state:XRFrameState):void{
    if(this.disposed||state.frame.session!==this.lifetime.session)return;
    const set=(state.frame as XRNativeFrame&{detectedMeshes?:ReadonlySet<XRDetectedMesh>}).detectedMeshes;
    if(!set)throw margoError('unsupported','The frame has no detected meshes; request the mesh-detection feature');
    const removed:DetectedMesh[]=[];
    for(const [source,record] of this.meshes)if(!set.has(source)){
      this.meshes.delete(source);this.visible.get(source)?.dispose();this.visible.delete(source);removed.push(record);
    }
    for(const record of removed){this.options.onRemove?.(record);if(this.disposed)return;}
    for(const source of set){
      const prior=this.meshes.get(source),edited=!prior||prior.lastChangedTime!==source.lastChangedTime||prior.label!==(source.semanticLabel??'');
      const pose=this.host.referenceSpace?state.frame.getPose(source.meshSpace,this.host.referenceSpace):null;
      const record:DetectedMesh=Object.freeze({source,vertices:edited?source.vertices.slice():prior!.vertices,indices:edited?source.indices.slice():prior!.indices,matrix:pose?new Float32Array(pose.transform.matrix):null,label:source.semanticLabel??'',lastChangedTime:source.lastChangedTime});
      this.meshes.set(source,record);
      if(this.options.show)this.draw(record,edited);
      if(!prior)this.options.onAdd?.(record);else if(edited)this.options.onChange?.(record);
      if(this.disposed)return;
    }
  }
  private draw(record:DetectedMesh,edited:boolean):void{
    const show=this.options.show!,scene=this.drawScene!;
    let mesh=this.visible.get(record.source);
    if(!mesh){mesh=scene.createMesh().setMaterial(show.material??new PbrMaterial({color:'#8899aa'}));this.visible.set(record.source,mesh);}
    mesh.visible=record.matrix!==null;
    if(edited){
      const data=this.geometry!.geometryData(record.vertices,new Float32Array(record.vertices.length),new Float32Array(record.vertices.length/3*2),record.indices);
      const normals=this.geometry!.computeVertexNormals(data).normals;
      mesh.setGeometry(new Geometry(record.vertices,normals,record.indices));
    }
    if(record.matrix){const trs=splitTRS(record.matrix);if(!trs.ok)throw new RangeError('Detected mesh pose is not rigid; use a WebXR runtime that returns rigid mesh poses');mesh.setPosition(trs.position).setQuaternion(trs.rotation).setScale(trs.scale);}
  }
  /** Releases visualization meshes and subscriptions, and cancels waits. Idempotent. */
  dispose():void{
    if(this.disposed)return;this.disposed=true;this.lifetime.stop();
    for(const mesh of this.visible.values())mesh.dispose();this.visible.clear();
    const records=[...this.meshes.values()];this.meshes.clear();for(const record of records)this.options.onRemove?.(record);
  }
  declare [Symbol.dispose]:()=>void;
  [(Symbol.dispose??Symbol()) as symbol]():void{this.dispose();}
}
/** A browser anchor that can persist across sessions. */
export interface XRPersistentAnchor extends XRAnchor {requestPersistentHandle():Promise<string>;}
/** The native persistent-anchor session API. */
export interface PersistentAnchorSession extends XRNativeSession {
  readonly persistentAnchors:readonly string[];
  restorePersistentAnchor(handle:string):Promise<XRAnchor>;
  deletePersistentAnchor(handle:string):Promise<void>;
}
/** Persistent anchors remain browser/origin-owned until explicitly deleted. */
export class PersistentAnchors {
  private readonly lifetime:SessionLifetime;
  private readonly session:PersistentAnchorSession;
  private disposed=false;
  private readonly pendingSave=new WeakMap<XRPersistentAnchor,{work:Promise<string>;before:Set<string>;waiters:number;claimed:boolean}>();
  private readonly pendingRestore=new Map<string,{work:Promise<XRAnchor>;waiters:number;claimed:boolean}>();
  /** Binds to an active anchors session. */
  static attach(host:ARExtraHost,options:{signal?:AbortSignal}={}):PersistentAnchors{return new PersistentAnchors(host,options.signal);}
  private constructor(private readonly host:ARExtraHost,signal?:AbortSignal){
    const session=needSession(host,'anchors') as PersistentAnchorSession;
    if(!Array.isArray(session.persistentAnchors)||typeof session.restorePersistentAnchor!=='function'||typeof session.deletePersistentAnchor!=='function')
      throw margoError('unsupported','Persistent anchors are unavailable; use a browser with persistentAnchors and restorePersistentAnchor');
    this.session=session;this.lifetime=new SessionLifetime(session,signal,()=>this.dispose());
  }
  /** Known origin-scoped persistent handles; the array is copied. */
  get handles():readonly string[]{this.active();return Object.freeze([...this.session.persistentAnchors]);}
  private active():void{if(this.disposed)throw margoError('disposed','PersistentAnchors is disposed; attach to an active anchors session');if(this.host.session!==this.session)throw margoError('state','The XR session changed; attach to the active session');}
  /** Saves an anchor and returns the browser's handle. Abort is checked before and after the native operation. */
  async save(anchor:XRPersistentAnchor,signal?:AbortSignal):Promise<string>{
    this.active();signal?.throwIfAborted();
    if(typeof anchor?.requestPersistentHandle!=='function')throw margoError('unsupported','This anchor cannot persist; use an anchor with requestPersistentHandle');
    let pending=this.pendingSave.get(anchor);
    if(!pending){const before=new Set(this.session.persistentAnchors);pending={work:anchor.requestPersistentHandle(),before,waiters:0,claimed:false};this.pendingSave.set(anchor,pending);}
    pending.waiters++;
    let handle:string|undefined;
    try {
      handle=await pending.work;
      if(signal?.aborted)throw signal.reason;
      this.active();pending.claimed=true;return handle;
    }finally{
      pending.waiters--;
      if(pending.waiters===0){this.pendingSave.delete(anchor);if(!pending.claimed&&handle&&!pending.before.has(handle))await this.session.deletePersistentAnchor(handle);}
    }
  }
  /** Restores tracking of a persistent handle; abort releases unclaimed tracking, retaining the saved handle. */
  async restore(handle:string,signal?:AbortSignal):Promise<XRAnchor>{
    this.active();signal?.throwIfAborted();
    if(typeof handle!=='string'||!handle)throw new TypeError('Pass a nonempty browser persistent anchor handle; read handles or save an anchor first');
    let pending=this.pendingRestore.get(handle);
    if(!pending){pending={work:this.session.restorePersistentAnchor(handle),waiters:0,claimed:false};this.pendingRestore.set(handle,pending);}
    pending.waiters++;
    let anchor:XRAnchor|undefined;
    try {
      anchor=await pending.work;
      if(signal?.aborted)throw signal.reason;
      this.active();pending.claimed=true;return anchor;
    }finally{
      pending.waiters--;
      if(pending.waiters===0){this.pendingRestore.delete(handle);if(!pending.claimed)anchor?.delete();}
    }
  }
  /** Explicitly deletes a saved anchor from the browser store. Abort checked before starting the native deletion. */
  async delete(handle:string,signal?:AbortSignal):Promise<void>{this.active();signal?.throwIfAborted();if(typeof handle!=='string'||!handle)throw new TypeError('Pass a nonempty persistent handle; read handles first');await this.session.deletePersistentAnchor(handle);}
  /** Removes subscriptions. Persistent handles are kept until delete is called. Idempotent. */
  dispose():void{if(this.disposed)return;this.disposed=true;this.lifetime.stop();}
  declare [Symbol.dispose]:()=>void;
  [(Symbol.dispose??Symbol()) as symbol]():void{this.dispose();}
}
