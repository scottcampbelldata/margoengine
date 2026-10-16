'use client';
import { createContext, useContext, useEffect, useMemo, useRef, useState, useImperativeHandle, forwardRef, type ReactNode, type CSSProperties } from 'react';
import { Engine, Mesh as EngineMesh, box, PbrMaterial as Material, type EngineOptions, type Vec3, type Geometry } from '@margoengine/core/extension';
import type {EngineKernel,Mesh as MeshHandle,FrameCallback} from '@margoengine/core';
import {Stage as StageFacade} from 'margoengine';
import {optionalPeer} from './optional.js';
import {preparePicking,releasePicking} from './picking.js';
import type {PBRModel, LightingEffect} from '@margoengine/gltf-pro';
import type {Shadows} from '@margoengine/shadows';
import type {Environment as IBLEnvironment, EnvironmentBackground} from '@margoengine/environment';
import type {OrbitControls as CameraControls} from '@margoengine/controls';
import {createAssetCache,activateAssetCache,disposeAssetCache,environmentAsset,retainAsset} from './assets.js';
export {preload} from './assets.js';

import {Context,useScene,useMesh,live,setGeometry,zero,one,useCommit,useResourceEffect,type Scene,type Registry,type Resources,type Frames,type PointerHandlers} from './internal.js';
export type {MargoPointerEvent,PointerHandlers} from './internal.js';

export interface MargoContextValue {
  stage:StageFacade|null;ready:boolean;canvas:HTMLCanvasElement|null;
  camera:EngineKernel['camera']|null;size:{width:number;height:number};gl:EngineKernel|null;readonly clock:number;invalidate():void;
}
export const MargoContext=createContext<MargoContextValue|null>(null);
export function useMargo():MargoContextValue {const value=useContext(MargoContext);if(!value)throw new Error('useMargo requires <MargoCanvas>');return value;}
export interface CanvasProps extends EngineOptions {
  children?: ReactNode; style?:CSSProperties; className?:string; label?:string;
  shadows?:boolean;onCreated?:(stage:StageFacade)=>void; onError?:(error:unknown)=>void;
  frameloop?:'always'|'demand';
}
export type MargoCanvasProps=CanvasProps;
export function MargoCanvas({children,style,className,label='Interactive 3D scene',capacity=1024,backend='auto',camera,fallback,shadows=false,frameloop='always',onCreated,onError}:CanvasProps) {
  const canvas=useRef<HTMLCanvasElement>(null),queue=useRef<Promise<void>>(Promise.resolve()),created=useRef(onCreated),errorHandler=useRef(onError);
  const [stage,setStage]=useState<StageFacade|null>(null),[error,setError]=useState<unknown>(null),[shadow,setShadow]=useState<Shadows|null>(null);
  const [shadowRequests,setShadowRequests]=useState(0),enableShadows=shadows||shadowRequests>0;
  const requestShadows=useMemo(()=>()=>{setShadowRequests(count=>count+1);return()=>setShadowRequests(count=>count-1);},[]);
  const engine=stage?.engine as unknown as Engine|null;
  const cameraOverrides=useMemo(()=>new Set<()=>void>(),[engine]);
  const pointerHandlers=useMemo(()=>new Map<number,PointerHandlers>(),[engine]);
  const frames=useMemo<Frames>(()=>({elapsed:0,last:null,mode:frameloop,callbacks:new Set()}),[engine]);frames.mode=frameloop;
  const assetCache=useMemo(()=>createAssetCache(engine as unknown as EngineKernel|null),[engine]);
  const resources=useMemo<Resources>(()=>({models:new Set(),lighting:new Map()}),[engine]);
  useEffect(()=>{if(engine)activateAssetCache(assetCache);return()=>disposeAssetCache(assetCache);},[engine,assetCache]);
  const cameraOptions=useRef(camera),frameloopOptions=useRef(frameloop),engineMode=useRef(frameloop);
  created.current=onCreated;errorHandler.current=onError;cameraOptions.current=camera;frameloopOptions.current=frameloop;
  const advance=useMemo(()=>(delta:number)=>{frames.elapsed+=delta;for(const callback of frames.callbacks)callback(engine as unknown as EngineKernel,delta);},[engine,frames]);
  const invalidate=useMemo(()=>()=>{
    if(!engine||engine.disposed||frameloopOptions.current!=='demand')return;
    const now=performance.now(),delta=frames.last===null?0:Math.max(0,Math.min((now-frames.last)/1000,0.1));frames.last=now;
    try{advance(delta);if(!engine.disposed)engine.render({delta});}catch(error){engine.onError(error);}
  },[engine,frames,advance]);
  useEffect(()=>{
    const element=canvas.current!;
    let cancelled=false,current:Engine|undefined,observer:ResizeObserver|undefined;setStage(null);setError(null);
    const report=(error:unknown)=>{if(!cancelled){setError(error);errorHandler.current?.(error);}};
    queue.current=queue.current.catch(()=>{}).then(async()=>{
      if(cancelled)return;
      const instance=await Engine.create(element,{capacity,backend,camera:cameraOptions.current,fallback});
      if(cancelled){instance.dispose();return;}
      current=instance;instance.onError=report;
      try {
      const resize=()=>{const bounds=element.getBoundingClientRect(),ratio=element.ownerDocument.defaultView?.devicePixelRatio??1;element.width=Math.max(1,Math.round(bounds.width*ratio));element.height=Math.max(1,Math.round(bounds.height*ratio));};
      resize();
      if(typeof ResizeObserver!=='undefined'){observer=new ResizeObserver(resize);observer.observe(element);}
      const next=new StageFacade(instance as unknown as EngineKernel);
      if(cameraOptions.current)Object.assign(instance.camera,cameraOptions.current);
      created.current?.(next);if(!cancelled&&!instance.disposed){setStage(next);engineMode.current=frameloopOptions.current;if(engineMode.current==='always')instance.start();}
      }catch(error){observer?.disconnect();instance.dispose();setStage(null);throw error;}
    }).catch(report);
    return()=>{cancelled=true;observer?.disconnect();current?.dispose();};
  },[capacity,backend,fallback]);
  useCommit(()=>{if(engine)return engine.onFrame((_,delta)=>advance(delta));},[engine,advance]);
  useCommit(()=>{
    if(!engine||engine.disposed||engineMode.current===frameloop)return;
    frames.last=null;engineMode.current=frameloop;if(frameloop==='demand')engine.stop();else engine.start();
  },[engine,frameloop,frames]);
  useEffect(()=>{
    if(!engine||engine.disposed)return;
    const element=engine.canvas;
    let active=true,hover:EngineMesh|null=null,hoverRequest=0;
    let down:{id:number;x:number;y:number;movement:number}|null=null;
    type PickRequest={x:number;y:number;receive:(mesh:EngineMesh|null)=>void};
    let picking=false,pendingHover:PickRequest|null=null;
    const clicks:PickRequest[]=[];
    const coordinates=(event:PointerEvent)=>{const bounds=element.getBoundingClientRect();return {x:event.clientX-bounds.left,y:event.clientY-bounds.top};};
    const dispatch=(kind:keyof PointerHandlers,mesh:EngineMesh,event:PointerEvent)=>{
      if(engine.disposed||engine.meshes.get(mesh.id)!==mesh)return;
      const object=mesh as unknown as MeshHandle;
      pointerHandlers.get(mesh.id)?.[kind]?.({nativeEvent:event,object,mesh:object,target:object,clientX:event.clientX,clientY:event.clientY,...coordinates(event)});
    };
    const move=(event:PointerEvent)=>{
      if(!down||down.id!==event.pointerId)return;
      down.movement+=Math.hypot(event.clientX-down.x,event.clientY-down.y);down.x=event.clientX;down.y=event.clientY;
    };
    const canPick=()=>{
      if(engine.backend==='webgl2')return false;
      for(const handlers of pointerHandlers.values())if(handlers.onClick||handlers.onPointerOver||handlers.onPointerOut)return true;
      return false;
    };
    const nextPick=()=>{
      if(picking||!active||engine.disposed)return;
      const request=clicks.shift()??pendingHover;if(!request)return;
      if(request===pendingHover)pendingHover=null;
      picking=true;
      // GPU readback permits one pending pick. Preserve clicks and coalesce hover bursts.
      void Promise.resolve().then(async()=>{
        if(!active||engine.disposed||!canPick())return null;
        if(resources.models.size)await preparePicking(engine,resources,frames);
        return active&&!engine.disposed?engine.pick(request.x,request.y):null;
      })
        .then(mesh=>{if(active&&!engine.disposed)request.receive(mesh);})
        .catch(error=>{if(active&&!engine.disposed)engine.onError(error);})
        .finally(()=>{picking=false;nextPick();});
    };
    const pick=(kind:'click'|'hover',event:PointerEvent,receive:(mesh:EngineMesh|null)=>void)=>{
      if(!canPick()){receive(null);return;}
      const request={...coordinates(event),receive};
      if(kind==='click')clicks.push(request);else pendingHover=request;
      nextPick();
    };
    const pointerdown=(event:PointerEvent)=>{if(event.button!==0||event.isPrimary===false)return;down={id:event.pointerId,x:event.clientX,y:event.clientY,movement:0};};
    const pointerup=(event:PointerEvent)=>{
      if(!down||down.id!==event.pointerId)return;
      move(event);const clicked=down.movement<=3;down=null;
      if(clicked)pick('click',event,mesh=>{if(mesh)dispatch('onClick',mesh,event);});
    };
    const pointermove=(event:PointerEvent)=>{
      move(event);const request=++hoverRequest;
      pick('hover',event,mesh=>{
        if(request!==hoverRequest||hover===mesh)return;
        const previous=hover;hover=mesh;
        if(previous)dispatch('onPointerOut',previous,event);
        if(mesh)dispatch('onPointerOver',mesh,event);
      });
    };
    const pointerleave=(event:PointerEvent)=>{++hoverRequest;pendingHover=null;down=null;const previous=hover;hover=null;if(previous)dispatch('onPointerOut',previous,event);};
    const pointercancel=(event:PointerEvent)=>{if(down?.id===event.pointerId)down=null;pointerleave(event);};
    element.addEventListener('pointerdown',pointerdown);element.addEventListener('pointerup',pointerup);element.addEventListener('pointermove',pointermove);
    element.addEventListener('pointerleave',pointerleave);element.addEventListener('pointercancel',pointercancel);
    return()=>{active=false;++hoverRequest;down=null;hover=null;pendingHover=null;clicks.length=0;releasePicking(engine);element.removeEventListener('pointerdown',pointerdown);element.removeEventListener('pointerup',pointerup);element.removeEventListener('pointermove',pointermove);element.removeEventListener('pointerleave',pointerleave);element.removeEventListener('pointercancel',pointercancel);};
  },[engine,pointerHandlers,resources,frames]);
  useCommit(()=>{if(engine&&camera){Object.assign(engine.camera,camera);for(const apply of cameraOverrides)apply();}},[engine,cameraOverrides,camera?.position?.[0],camera?.position?.[1],camera?.position?.[2],camera?.target?.[0],camera?.target?.[1],camera?.target?.[2],camera?.fov,camera?.near,camera?.far]);
  useEffect(()=>{
    setShadow(null);if(!engine||!enableShadows)return;
    let cancelled=false,effect:Shadows|undefined;
    optionalPeer('@margoengine/shadows',()=>import('@margoengine/shadows')).then(({Shadows})=>{if(cancelled||engine.disposed)return;effect=Shadows.attach(engine as unknown as EngineKernel);setShadow(effect);}).catch(error=>{if(!cancelled)engine.onError(error);});
    return()=>{cancelled=true;effect?.dispose();};
  },[engine,enableShadows]);
  const scene=useMemo<Scene|null>(()=>engine?{engine,registry:null,resources,shadows:enableShadows&&shadow?.owner===engine?shadow:null,requestShadows,cameraOverrides,pointerHandlers,frames,assetCache}:null,[engine,resources,enableShadows,shadow,requestShadows,cameraOverrides,pointerHandlers,frames,assetCache]);
  const value=useMemo<MargoContextValue>(()=>({stage,ready:!!stage&&!stage.engine.disposed,canvas:canvas.current,camera:stage?.engine.camera??null,gl:stage?.engine??null,get size(){return {width:canvas.current?.clientWidth??0,height:canvas.current?.clientHeight??0};},get clock(){return frames.elapsed;},invalidate}),[stage,frames,invalidate]);
  return <MargoContext.Provider value={value}><canvas ref={canvas} className={className} style={{display:'block',width:'100%',height:'100%',...style}} role="img" aria-label={label}/>{error!==null&&<p role="alert">{String(error)}</p>}{scene&&!engine?.disposed&&<Context.Provider value={scene}>{children}</Context.Provider>}</MargoContext.Provider>;
}
export const Canvas=MargoCanvas;
export function useMargoStage():EngineKernel {return useScene().engine as unknown as EngineKernel;}

export interface StageProps {camera?:EngineOptions['camera'];shadows?:boolean;children?:ReactNode}
export function Stage({camera,shadows=false,children}:StageProps) {
  const {stage,ready}=useMargo(),scene=useContext(Context);
  const requestShadows=scene?.requestShadows,cameraOverrides=scene?.cameraOverrides;
  const active=ready&&!!stage&&!stage.engine.disposed;
  useCommit(()=>{
    if(!active||!camera)return;
    // Reapply wrapper settings when Canvas updates its camera defaults.
    const apply=()=>{Object.assign(stage.engine.camera,camera);};
    cameraOverrides?.add(apply);apply();
    return()=>{cameraOverrides?.delete(apply);};
  },[stage,active,cameraOverrides,camera?.position?.[0],camera?.position?.[1],camera?.position?.[2],camera?.target?.[0],camera?.target?.[1],camera?.target?.[2],camera?.fov,camera?.near,camera?.far]);
  useEffect(()=>{if(active&&shadows)return requestShadows?.();},[active,stage,shadows,requestShadows]);
  return active?<>{children}</>:null;
}

export type MeshRef=MeshHandle;
export interface MeshProps extends PointerHandlers {position?:Vec3;rotation?:Vec3;scale?:Vec3;children?:ReactNode}
export const Mesh=forwardRef<MeshRef,MeshProps>(function Mesh({position=zero,rotation=zero,scale=one,children,onClick,onPointerOver,onPointerOut},ref){
  const parentScene=useScene(),{engine,registry:parent,pointerHandlers}=parentScene;const [node,setNode]=useState<EngineMesh|null>(null);
  const registry=useMemo<Registry>(()=>({
    current:null,children:new Set(),attachments:new Set(),geometry:null,
    register(mesh){this.children.add(mesh);if(this.current)mesh.setParent(this.current);},
    unregister(mesh){this.children.delete(mesh);if(engine.meshes.get(mesh.id)===mesh&&!engine.disposed)mesh.setParent(null);}
  }),[engine]);
  useCommit(()=>{
    const mesh=engine.createMesh();registry.current=mesh;
    try {
      parent?.register(mesh);
      for(const child of registry.children)if(engine.meshes.get(child.id)===child)child.setParent(mesh);
      for(const attach of registry.attachments)attach(mesh);
      setNode(mesh);
    }catch(error){parent?.unregister(mesh);registry.current=null;mesh.dispose();throw error;}
    return()=>{parent?.unregister(mesh);registry.current=null;mesh.dispose();};
  },[engine,parent,registry]);
  useCommit(()=>{
    const mesh=registry.current;if(!mesh||!(onClick||onPointerOver||onPointerOut))return;
    const handlers={onClick,onPointerOver,onPointerOut};pointerHandlers.set(mesh.id,handlers);
    return()=>{if(pointerHandlers.get(mesh.id)===handlers)pointerHandlers.delete(mesh.id);};
  },[registry,node,pointerHandlers,onClick,onPointerOver,onPointerOut]);
  useCommit(()=>{const mesh=registry.current;if(mesh){mesh.setPosition(position);mesh.setRotation(rotation);mesh.setScale(scale);}},[registry,node,position[0],position[1],position[2],rotation[0],rotation[1],rotation[2],scale[0],scale[1],scale[2]]);
  useImperativeHandle(ref,()=>node!,[node]);
  const scene=useMemo(()=>({...parentScene,registry}),[parentScene,registry]);
  return <Context.Provider value={scene}>{children}</Context.Provider>;
});

export function BoxGeometry({args=one}: {args?:Vec3}) {
  const registry=useMesh();
  useCommit(()=>{
    const geometry=box(...args),attach=(mesh:EngineMesh)=>{setGeometry(registry,mesh,geometry);};
    registry.attachments.add(attach);try{if(registry.current)attach(registry.current);}catch(error){registry.attachments.delete(attach);throw error;}
    return()=>{registry.attachments.delete(attach);const mesh=live(registry);if(mesh&&registry.geometry===geometry)setGeometry(registry,mesh,null);};
  },[registry,args[0],args[1],args[2]]);return null;
}
export function GeometryResource({geometry}: {geometry:Geometry}) {
  const registry=useMesh();
  useCommit(()=>{const attach=(mesh:EngineMesh)=>{setGeometry(registry,mesh,geometry);};registry.attachments.add(attach);try{if(registry.current)attach(registry.current);}catch(error){registry.attachments.delete(attach);throw error;}return()=>{registry.attachments.delete(attach);const mesh=live(registry);if(mesh&&registry.geometry===geometry)setGeometry(registry,mesh,null);};},[registry,geometry]);return null;
}
export interface PbrMaterialProps {color?:string|readonly number[];roughness?:number;metalness?:number}
export function PbrMaterial({color='#4f46e5',roughness=0.5,metalness=0}:PbrMaterialProps) {
  const registry=useMesh();
  useCommit(()=>{
    const material=new Material({color,roughness,metalness}),attach=(mesh:EngineMesh)=>{mesh.setMaterial(material);};
    registry.attachments.add(attach);if(registry.current)attach(registry.current);
    return()=>{registry.attachments.delete(attach);const mesh=live(registry);if(mesh?.material===material)mesh.setMaterial(new Material());};
  },[registry,color,roughness,metalness]);return null;
}
export type GroupProps=MeshProps;
export {Mesh as mesh,Mesh as Group,Mesh as group,BoxGeometry as boxGeometry,PbrMaterial as meshStandardMaterial};
export function useFrame(callback:FrameCallback):void {
  const {frames}=useScene(),latest=useRef(callback);useCommit(()=>{latest.current=callback;});
  useCommit(()=>{const frame:FrameCallback=(state,delta)=>latest.current(state,delta);frames.callbacks.add(frame);return()=>{frames.callbacks.delete(frame);};},[frames]);
}

export {Model} from './model.js';
export type {ModelProps,MaterialOverride} from './model.js';
interface Loading {src:string;pending:boolean;promise:Promise<void>}
function values(value:readonly number[],size:number,label:string,min=0,max=1):void {
  if(!Array.isArray(value)||value.length!==size||value.some(v=>typeof v!=='number'||!Number.isFinite(Math.fround(v))||v<min||v>max))throw new RangeError('Invalid '+label);
}

export interface EnvironmentProps {src?:string;exposure?:number;background?:boolean;onError?:(error:unknown)=>void}
export function Environment({src,exposure=1,background=true,onError}:EnvironmentProps) {
  const {engine,resources,assetCache}=useScene(),[environment,setEnvironment]=useState<IBLEnvironment|null>(null);
  const [loading,setLoading]=useState<Loading|null>(null),errorHandler=useRef(onError);errorHandler.current=onError;
  const [module,setModule]=useState<typeof import('@margoengine/environment')|null>(null);
  const previous=useRef<{direction:Float32Array;radiance:Float32Array}|null>(null);
  const backdrop=useRef<EnvironmentBackground|null>(null);
  useCommit(()=>{
    const saved={direction:engine.lighting.direction.slice(),radiance:engine.lighting.radiance.slice()};previous.current=saved;
    return()=>{engine.lighting.direction.set(saved.direction);engine.lighting.radiance.set(saved.radiance);};
  },[engine]);
  useCommit(()=>{
    values([exposure],1,'exposure',0,Infinity);
    if(!src){engine.lighting.direction.set([3,5,4,3]);engine.lighting.radiance.set([exposure,exposure,exposure,0.15*exposure]);}
    else if(previous.current){engine.lighting.direction.set(previous.current.direction);engine.lighting.radiance.set(previous.current.radiance);for(let i=0;i<4;i++)engine.lighting.radiance[i]*=exposure;}
    if(environment&&!environment.disposed)environment.intensity=exposure;
  },[engine,src,exposure,environment]);
  useResourceEffect(lease=>{
    setEnvironment(null);setModule(null);if(!src)return;
    let current:IBLEnvironment|undefined;
    const asset=environmentAsset(assetCache,src),releaseAsset=retainAsset(assetCache,src,asset,assetCache.environments);
    const release=()=>{if(current){engine.removePlugin(current.name);current.dispose();current=undefined;}};
    const request:Loading={src,pending:asset.status==='pending',promise:Promise.resolve()};
    request.promise=(async()=>{
      await asset.promise;if(!lease.active||engine.disposed)return;
      if(asset.status==='rejected')throw asset.error;
      const {api,image}=asset.value!;
      const loaded=await api.Environment.create(engine as unknown as EngineKernel,image);
      if(!lease.active||engine.disposed){loaded.dispose();return;}
      current=loaded;engine.use(loaded as unknown as import('@margoengine/core/extension').EnginePlugin);setModule(api);setEnvironment(loaded);
    })().catch(error=>{release();if(lease.active&&!engine.disposed){try{errorHandler.current?.(error);}finally{engine.onError(error);}}}).finally(()=>{request.pending=false;});
    setLoading(request);
    return()=>{releaseAsset();release();};
  },[engine,src,assetCache]);
  useCommit(()=>{
    if(!environment||environment.disposed||!module)return;
    // Bindings 1..3 belong to Shadows; keep the ambient marker for its shader adapter.
    let entries=module.iblBindGroupEntries(environment,4);
    const change=environment.onChange(()=>{entries=module.iblBindGroupEntries(environment,4);});
    const shaders=new Map<number,Map<string,string>>();
    const effect:LightingEffect={owner:engine,bindings:()=>entries,shader:(source,group)=>{
      let cache=shaders.get(group);const cached=cache?.get(source);if(cached!==undefined)return cached;
      const replaced=source.replace(/fn ambient\(s:Surface\)->vec3f \{[^}]*\}/,'fn ambient(s:Surface)->vec3f {return vec3f(0);}')
        .replace('+s.emissive;','+s.emissive+iblShade(iblSpecular,iblSampler,iblBrdf,iblSh,iblParams,s.n,v,s.base.rgb,s.metal,s.roughness)*s.occlusion;');
      if(replaced===source)throw new Error('Environment requires the standard PBR lighting shader');
      const code=`@group(${group}) @binding(4) var iblSpecular:texture_cube<f32>;
@group(${group}) @binding(5) var iblSampler:sampler;
@group(${group}) @binding(6) var iblBrdf:texture_2d<f32>;
@group(${group}) @binding(7) var<uniform> iblSh:array<vec4f,9>;
@group(${group}) @binding(8) var<uniform> iblParams:vec4f;
${module.IBL_WGSL}\n${replaced}`;
      if(!cache)shaders.set(group,cache=new Map());cache.set(source,code);return code;
    }};
    const models=new Map<PBRModel,()=>void>();resources.lighting.set(effect,models);
    const release=()=>{change();resources.lighting.delete(effect);for(const remove of models.values())remove();models.clear();};
    try{for(const model of resources.models)models.set(model,model.addLighting(effect));}catch(error){release();throw error;}
    return release;
  },[engine,resources,environment,module]);
  useCommit(()=>{
    if(!environment||environment.disposed||!module||!background)return;
    const effect=new module.EnvironmentBackground(environment);engine.use(effect as unknown as import('@margoengine/core/extension').EnginePlugin);backdrop.current=effect;
    return()=>{backdrop.current=null;engine.removePlugin(effect.name);effect.dispose();};
  },[engine,environment,module,background]);
  useCommit(()=>{if(backdrop.current)backdrop.current.exposure=exposure;},[environment,module,background,exposure]);
  if(loading&&loading.src===src&&loading.pending)throw loading.promise;
  return null;
}

type HTMLOverlay=import('@margoengine/html').HTML;
interface OverlayEntry {users:number;promise:Promise<HTMLOverlay>}
const overlays=new WeakMap<Engine,OverlayEntry>();
function acquireOverlay(engine:Engine):OverlayEntry {
  let entry=overlays.get(engine);
  if(!entry){entry={users:0,promise:optionalPeer('@margoengine/html',()=>import('@margoengine/html')).then(({HTML})=>{if(engine.disposed)throw new Error('Canvas disposed');return HTML.attach(engine as unknown as EngineKernel);})};overlays.set(engine,entry);}
  entry.users++;return entry;
}
function releaseOverlay(engine:Engine,entry:OverlayEntry):void {
  if(--entry.users)return;
  queueMicrotask(()=>{if(entry.users||overlays.get(engine)!==entry)return;overlays.delete(engine);void entry.promise.then(overlay=>overlay.dispose(),()=>{});});
}
export interface HtmlProps {children?:ReactNode;position?:Vec3;className?:string;style?:CSSProperties;occlude?:boolean;onError?:(error:unknown)=>void}
/** Optional projected React DOM content, sharing one HTML plugin per canvas. */
export function Html({children,position=zero,className,style,occlude=true,onError}:HtmlProps) {
  const {engine,registry}=useScene();
  const [portal,setPortal]=useState<{element:HTMLElement;create:typeof import('react-dom').createPortal}|null>(null);
  const label=useRef<import('@margoengine/html').Label|null>(null),latest=useRef({position,occlude,onError});latest.current={position,occlude,onError};
  const occlusion=useRef<import('@margoengine/html').Label['occlude']>(null);
  useEffect(()=>{
    let active=true,current:HTMLOverlay|undefined,item:import('@margoengine/html').Label|undefined;
    const entry=acquireOverlay(engine),element=engine.canvas.ownerDocument.createElement('div');
    const attach=(mesh:EngineMesh)=>{item?.setMesh(mesh as unknown as MeshHandle);item?.setOffset(latest.current.position);};
    Promise.all([entry.promise,optionalPeer('react-dom',()=>import('react-dom'))]).then(([overlay,dom])=>{
      if(!active||engine.disposed)return;
      current=overlay;
      const mesh=registry?.current,p=latest.current.position;
      item=overlay.add(element,{mesh:mesh as unknown as MeshHandle|null,position:p,offset:mesh?p:zero});label.current=item;
      occlusion.current=item.occlude;
      if(!latest.current.occlude)item.occlude=()=>false;
      registry?.attachments.add(attach);setPortal({element,create:dom.createPortal});
    }).catch(error=>{if(active&&!engine.disposed){try{latest.current.onError?.(error);}finally{engine.onError(error);}}});
    return()=>{active=false;registry?.attachments.delete(attach);if(item)current?.remove(item);label.current=null;element.remove();releaseOverlay(engine,entry);};
  },[engine,registry]);
  useCommit(()=>{const item=label.current;if(item){if(registry?.current)item.setMesh(registry.current as unknown as MeshHandle).setOffset(position);else item.setPosition(position);item.occlude=occlude?occlusion.current:()=>false;}},[registry,portal,position[0],position[1],position[2],occlude]);
  return portal?portal.create(<div className={className} style={style}>{children}</div>,portal.element):null;
}

export interface OrbitControlsProps {autoRotate?:boolean;autoRotateSpeed?:number;enableDamping?:boolean;minDistance?:number;maxDistance?:number}
export function OrbitControls({autoRotate=false,autoRotateSpeed=2,enableDamping=false,minDistance=0,maxDistance=Infinity}:OrbitControlsProps) {
  const {engine,frames}=useScene(),[controls,setControls]=useState<CameraControls|null>(null);
  useEffect(()=>{
    let cancelled=false,current:CameraControls|undefined,unsubscribe:(()=>void)|undefined;
    optionalPeer('@margoengine/controls',()=>import('@margoengine/controls')).then(({OrbitControls})=>{
      if(cancelled||engine.disposed)return;
      current=new OrbitControls(engine.camera,engine.canvas);
      try{const instance=current,frame:FrameCallback=(_,delta)=>instance.update(delta);frames.callbacks.add(frame);unsubscribe=()=>{frames.callbacks.delete(frame);};setControls(current);}catch(error){current.dispose();throw error;}
    }).catch(error=>{if(!cancelled&&!engine.disposed)engine.onError(error);});
    return()=>{cancelled=true;unsubscribe?.();current?.dispose();};
  },[engine,frames]);
  useCommit(()=>{
    if(!controls)return;
    if(!Number.isFinite(autoRotateSpeed)||!Number.isFinite(minDistance)||minDistance<0||maxDistance<minDistance||Number.isNaN(maxDistance))throw new RangeError('Invalid orbit controls options');
    Object.assign(controls,{autoRotate,autoRotateSpeed,enableDamping,minDistance,maxDistance});
  },[controls,autoRotate,autoRotateSpeed,enableDamping,minDistance,maxDistance]);
  return null;
}
