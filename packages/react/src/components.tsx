'use client';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useImperativeHandle, forwardRef, type ReactNode, type CSSProperties } from 'react';
import { Engine, Mesh as EngineMesh, box, PbrMaterial as Material, type EngineOptions, type Vec3, type Geometry } from '@margoengine/core/extension';
import type {EngineKernel,Mesh as MeshHandle,FrameCallback} from '@margoengine/core';
import {Stage} from 'margoengine';
import type {PBRModel, LightingEffect} from '@margoengine/gltf-pro';
import type {Shadows} from '@margoengine/shadows';
import type {Environment as IBLEnvironment, EnvironmentBackground} from '@margoengine/environment';
import type {OrbitControls as CameraControls} from '@margoengine/controls';

interface Registry {
  current: EngineMesh|null;
  children: Set<EngineMesh>;
  attachments: Set<(mesh: EngineMesh)=>void>;
  register(mesh: EngineMesh): void;
  unregister(mesh: EngineMesh): void;
}
interface Resources {models:Set<PBRModel>;lighting:Map<LightingEffect,Map<PBRModel,()=>void>>}
interface Scene {engine:Engine;registry:Registry|null;resources:Resources;shadows:Shadows|null}
const Context=createContext<Scene|null>(null);
export interface MargoContextValue {stage:Stage|null;ready:boolean;canvas:HTMLCanvasElement|null}
export const MargoContext=createContext<MargoContextValue|null>(null);
export function useMargo():MargoContextValue {const value=useContext(MargoContext);if(!value)throw new Error('useMargo requires <MargoCanvas>');return value;}
function useScene():Scene {const scene=useContext(Context);if(!scene)throw new Error('Engine components require <Canvas>');return scene;}
function useMesh(): Registry {const {registry}=useScene();if(!registry)throw new Error('Geometry and material require <Mesh>');return registry;}
function live(registry:Registry):EngineMesh|null {const mesh=registry.current;return mesh&&!mesh.engine.disposed&&mesh.engine.meshes.get(mesh.id)===mesh?mesh:null;}
const zero:Vec3=[0,0,0],one:Vec3=[1,1,1];
const useCommit=typeof window==='undefined'?useEffect:useLayoutEffect;

export interface CanvasProps extends EngineOptions {
  children?: ReactNode; style?:CSSProperties; className?:string; label?:string;
  shadows?:boolean;onCreated?:(stage:Stage)=>void; onError?:(error:unknown)=>void;
}
export type MargoCanvasProps=CanvasProps;
export function MargoCanvas({children,style,className,label='Interactive 3D scene',capacity=1024,backend='auto',camera,shadows=false,onCreated,onError}:CanvasProps) {
  const canvas=useRef<HTMLCanvasElement>(null),queue=useRef<Promise<void>>(Promise.resolve()),created=useRef(onCreated),errorHandler=useRef(onError);
  const [stage,setStage]=useState<Stage|null>(null),[error,setError]=useState<unknown>(null),[shadow,setShadow]=useState<Shadows|null>(null);
  const engine=stage?.engine as unknown as Engine|null;
  const cameraOptions=useRef(camera);created.current=onCreated;errorHandler.current=onError;cameraOptions.current=camera;
  useEffect(()=>{
    const element=canvas.current!;
    let cancelled=false,current:Engine|undefined,observer:ResizeObserver|undefined;setStage(null);setError(null);
    const report=(error:unknown)=>{if(!cancelled){setError(error);errorHandler.current?.(error);}};
    queue.current=queue.current.catch(()=>{}).then(async()=>{
      if(cancelled)return;
      const instance=await Engine.create(element,{capacity,backend,camera:cameraOptions.current});
      if(cancelled){instance.dispose();return;}
      current=instance;instance.onError=report;
      try {
      const resize=()=>{const bounds=element.getBoundingClientRect(),ratio=element.ownerDocument.defaultView?.devicePixelRatio??1;element.width=Math.max(1,Math.round(bounds.width*ratio));element.height=Math.max(1,Math.round(bounds.height*ratio));};
      resize();
      if(typeof ResizeObserver!=='undefined'){observer=new ResizeObserver(resize);observer.observe(element);}
      const next=new Stage(instance as unknown as EngineKernel);
      if(cameraOptions.current)Object.assign(instance.camera,cameraOptions.current);
      created.current?.(next);if(!cancelled&&!instance.disposed){setStage(next);instance.start();}
      }catch(error){observer?.disconnect();instance.dispose();setStage(null);throw error;}
    }).catch(report);
    return()=>{cancelled=true;observer?.disconnect();current?.dispose();};
  },[capacity,backend]);
  useCommit(()=>{if(engine&&camera)Object.assign(engine.camera,camera);},[engine,camera?.position?.[0],camera?.position?.[1],camera?.position?.[2],camera?.target?.[0],camera?.target?.[1],camera?.target?.[2],camera?.fov,camera?.near,camera?.far]);
  useEffect(()=>{
    setShadow(null);if(!engine||!shadows)return;
    let cancelled=false,effect:Shadows|undefined;
    import('@margoengine/shadows').then(({Shadows})=>{if(cancelled||engine.disposed)return;effect=Shadows.attach(engine as unknown as EngineKernel);setShadow(effect);}).catch(error=>{if(!cancelled)engine.onError(error);});
    return()=>{cancelled=true;effect?.dispose();};
  },[engine,shadows]);
  const resources=useMemo<Resources>(()=>({models:new Set(),lighting:new Map()}),[engine]);
  const scene=useMemo<Scene|null>(()=>engine?{engine,registry:null,resources,shadows:shadows&&shadow?.owner===engine?shadow:null}:null,[engine,resources,shadows,shadow]);
  const value=useMemo<MargoContextValue>(()=>({stage,ready:!!stage&&!stage.engine.disposed,canvas:canvas.current}),[stage]);
  return <MargoContext.Provider value={value}><canvas ref={canvas} className={className} style={{display:'block',width:'100%',height:'100%',...style}} role="img" aria-label={label}/>{error!==null&&<p role="alert">{String(error)}</p>}{scene&&!engine?.disposed&&<Context.Provider value={scene}>{children}</Context.Provider>}</MargoContext.Provider>;
}
export const Canvas=MargoCanvas;
export function useMargoStage():EngineKernel {return useScene().engine as unknown as EngineKernel;}

export type MeshRef=MeshHandle;
export interface MeshProps {position?:Vec3;rotation?:Vec3;scale?:Vec3;children?:ReactNode}
export const Mesh=forwardRef<MeshRef,MeshProps>(function Mesh({position=zero,rotation=zero,scale=one,children},ref){
  const parentScene=useScene(),{engine,registry:parent}=parentScene;const [node,setNode]=useState<EngineMesh|null>(null);
  const registry=useMemo<Registry>(()=>({
    current:null,children:new Set(),attachments:new Set(),
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
  useCommit(()=>{const mesh=registry.current;if(mesh){mesh.setPosition(position);mesh.setRotation(rotation);mesh.setScale(scale);}},[registry,node,position[0],position[1],position[2],rotation[0],rotation[1],rotation[2],scale[0],scale[1],scale[2]]);
  useImperativeHandle(ref,()=>node!,[node]);
  const scene=useMemo(()=>({...parentScene,registry}),[parentScene,registry]);
  return <Context.Provider value={scene}>{children}</Context.Provider>;
});

export function BoxGeometry({args=one}: {args?:Vec3}) {
  const registry=useMesh();
  useCommit(()=>{
    const geometry=box(...args),attach=(mesh:EngineMesh)=>{mesh.setGeometry(geometry);};
    registry.attachments.add(attach);try{if(registry.current)attach(registry.current);}catch(error){registry.attachments.delete(attach);throw error;}
    return()=>{registry.attachments.delete(attach);const mesh=live(registry);if(mesh&&mesh.geometry===geometry)mesh.setGeometry(null);};
  },[registry,args[0],args[1],args[2]]);return null;
}
export function GeometryResource({geometry}: {geometry:Geometry}) {
  const registry=useMesh();
  useCommit(()=>{const attach=(mesh:EngineMesh)=>{mesh.setGeometry(geometry);};registry.attachments.add(attach);try{if(registry.current)attach(registry.current);}catch(error){registry.attachments.delete(attach);throw error;}return()=>{registry.attachments.delete(attach);const mesh=live(registry);if(mesh?.geometry===geometry)mesh.setGeometry(null);};},[registry,geometry]);return null;
}
export function PbrMaterial({color='#4f46e5',roughness=0.5,metalness=0}: {color?:string|readonly number[];roughness?:number;metalness?:number}) {
  const registry=useMesh();
  useCommit(()=>{
    const material=new Material({color,roughness,metalness}),attach=(mesh:EngineMesh)=>{mesh.setMaterial(material);};
    registry.attachments.add(attach);if(registry.current)attach(registry.current);
    return()=>{registry.attachments.delete(attach);const mesh=live(registry);if(mesh?.material===material)mesh.setMaterial(new Material());};
  },[registry,color,roughness,metalness]);return null;
}
export function useFrame(callback:FrameCallback):void {
  const {engine}=useScene(),latest=useRef(callback);useCommit(()=>{latest.current=callback;});
  useCommit(()=>engine.onFrame((state,delta)=>latest.current(state as unknown as EngineKernel,delta)),[engine]);
}

export interface MaterialOverride {
  baseColor?:Vec3|readonly [number,number,number,number];roughness?:number;metalness?:number;
  emissive?:Vec3;normalScale?:number;occlusionStrength?:number;alphaCutoff?:number;doubleSided?:boolean;
}
export interface ModelProps {
  src:string;position?:Vec3;rotation?:Vec3;scale?:Vec3;materials?:Record<string,MaterialOverride>;
  castShadow?:boolean;receiveShadow?:boolean;onLoad?:(mesh:MeshHandle)=>void;
}
function values(value:readonly number[],size:number,label:string,min=0,max=1):void {
  if(!Array.isArray(value)||value.length!==size||value.some(v=>typeof v!=='number'||!Number.isFinite(Math.fround(v))||v<min||v>max))throw new RangeError('Invalid '+label);
}
function applyMaterials(originals:Map<object,any>,overrides:ModelProps['materials']):void {
  for(const [material,original] of originals) {
    const m=material as any,o=overrides?.[original.name];
    Object.assign(m,original,{base:[...original.base],factors:[...original.factors],emission:[...original.emission],settings:[...original.settings]});
    if(!o)continue;
    if(o.baseColor){values(o.baseColor,o.baseColor.length===3?3:4,'base color');m.base.splice(0,o.baseColor.length,...o.baseColor);}
    if(o.emissive){values(o.emissive,3,'emissive');m.emission=[...o.emissive];}
    for(const [key,at,min,max] of [['roughness',0,0,1],['metalness',1,0,1],['normalScale',2,-Infinity,Infinity],['occlusionStrength',3,0,1]] as const) {
      if(o[key]!==undefined){values([o[key]],1,key,min,max);m.factors[at]=o[key];}
    }
    if(o.alphaCutoff!==undefined){values([o.alphaCutoff],1,'alpha cutoff',0,Infinity);m.settings[1]=o.alphaCutoff;}
    if(o.doubleSided!==undefined){if(typeof o.doubleSided!=='boolean')throw new TypeError('Invalid doubleSided');m.settings[2]=+o.doubleSided;}
  }
}
export function Model({position=zero,rotation=zero,scale=one,castShadow=false,receiveShadow=false,...props}:ModelProps) {
  const {engine,registry,resources,shadows}=useScene(),[model,setModel]=useState<PBRModel|null>(null);
  const latest=useRef({...props,position,rotation,scale}),originals=useRef(new Map<object,any>());
  useCommit(()=>{latest.current={...props,position,rotation,scale};});
  useEffect(()=>{
    const abort=new AbortController();let current:PBRModel|undefined;
    setModel(null);
    const release=()=>{
      if(!current)return;
      resources.models.delete(current);
      for(const models of resources.lighting.values()){models.get(current)?.();models.delete(current);}
      registry?.unregister(current.root);current.dispose();current=undefined;
    };
    (async()=>{
      const {loadGLTF}=await import('@margoengine/gltf-pro');if(abort.signal.aborted||engine.disposed)return;
      const loaded=await loadGLTF(engine as unknown as EngineKernel,props.src,{signal:abort.signal});
      if(abort.signal.aborted||engine.disposed){loaded.dispose();return;}
      current=loaded;
      const saved=new Map<object,any>();for(const primitive of loaded.primitives)if(!saved.has(primitive.material))saved.set(primitive.material,{...primitive.material,base:[...primitive.material.base],factors:[...primitive.material.factors],emission:[...primitive.material.emission],settings:[...primitive.material.settings]});
      originals.current=saved;
      const p=latest.current;loaded.root.setPosition(p.position).setRotation(p.rotation).setScale(p.scale);applyMaterials(saved,p.materials);
      registry?.register(loaded.root);resources.models.add(loaded);
      for(const [effect,models] of resources.lighting)models.set(loaded,loaded.addLighting(effect));
      setModel(loaded);p.onLoad?.(loaded.root);
    })().catch(error=>{release();if(!abort.signal.aborted&&!engine.disposed){setModel(null);engine.onError(error);}});
    return()=>{abort.abort();release();};
  },[engine,registry,resources,props.src]);
  useCommit(()=>{if(model&&!model.disposed){model.root.setPosition(position).setRotation(rotation).setScale(scale);}},[model,position[0],position[1],position[2],rotation[0],rotation[1],rotation[2],scale[0],scale[1],scale[2]]);
  useCommit(()=>{if(model&&!model.disposed)applyMaterials(originals.current,props.materials);},[model,props.materials]);
  useCommit(()=>{
    if(!model||model.disposed||!shadows)return;
    const removeCaster=castShadow?shadows.add({get shadowPrimitives(){return model.shadowPrimitives;},get disposed(){return model.disposed;}}):undefined;
    let removeReceiver:(()=>void)|undefined;
    try{if(receiveShadow)removeReceiver=model.addLighting(shadows);}catch(error){removeCaster?.();throw error;}
    return()=>{removeCaster?.();removeReceiver?.();};
  },[model,shadows,castShadow,receiveShadow]);
  return null;
}

export interface EnvironmentProps {src?:string;exposure?:number;background?:boolean}
export function Environment({src,exposure=1,background=true}:EnvironmentProps) {
  const {engine,resources}=useScene(),[environment,setEnvironment]=useState<IBLEnvironment|null>(null);
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
  useEffect(()=>{
    setEnvironment(null);setModule(null);if(!src)return;
    const abort=new AbortController();let current:IBLEnvironment|undefined;
    const release=()=>{if(current){engine.removePlugin(current.name);current.dispose();current=undefined;}};
    (async()=>{
      const api=await import('@margoengine/environment');if(abort.signal.aborted||engine.disposed)return;
      const image=await api.loadEnvironmentImage(src,{signal:abort.signal});if(abort.signal.aborted||engine.disposed)return;
      const loaded=await api.Environment.create(engine as unknown as EngineKernel,image);
      if(abort.signal.aborted||engine.disposed){loaded.dispose();return;}
      current=loaded;engine.use(loaded as unknown as import('@margoengine/core/extension').EnginePlugin);setModule(api);setEnvironment(loaded);
    })().catch(error=>{release();if(!abort.signal.aborted&&!engine.disposed)engine.onError(error);});
    return()=>{abort.abort();release();};
  },[engine,src]);
  useCommit(()=>{
    if(!environment||environment.disposed||!module)return;
    // The package's IBL effect lights core meshes as a plugin and glTF-pro models through addLighting.
    const effect=new module.EnvironmentLighting(environment);engine.use(effect as unknown as import('@margoengine/core/extension').EnginePlugin);
    const models=new Map<PBRModel,()=>void>();resources.lighting.set(effect,models);
    const release=()=>{resources.lighting.delete(effect);for(const remove of models.values())remove();models.clear();engine.removePlugin(effect.name);effect.dispose();};
    try{for(const model of resources.models)models.set(model,model.addLighting(effect));}catch(error){release();throw error;}
    return release;
  },[engine,resources,environment,module]);
  useCommit(()=>{
    if(!environment||environment.disposed||!module||!background)return;
    const effect=new module.EnvironmentBackground(environment);engine.use(effect as unknown as import('@margoengine/core/extension').EnginePlugin);backdrop.current=effect;
    return()=>{backdrop.current=null;engine.removePlugin(effect.name);effect.dispose();};
  },[engine,environment,module,background]);
  useCommit(()=>{if(backdrop.current)backdrop.current.exposure=exposure;},[environment,module,background,exposure]);
  return null;
}

export interface OrbitControlsProps {autoRotate?:boolean;autoRotateSpeed?:number;enableDamping?:boolean;minDistance?:number;maxDistance?:number}
export function OrbitControls({autoRotate=false,autoRotateSpeed=2,enableDamping=false,minDistance=0,maxDistance=Infinity}:OrbitControlsProps) {
  const {engine}=useScene(),[controls,setControls]=useState<CameraControls|null>(null);
  useEffect(()=>{
    let cancelled=false,current:CameraControls|undefined,unsubscribe:(()=>void)|undefined;
    import('@margoengine/controls').then(({OrbitControls})=>{
      if(cancelled||engine.disposed)return;
      current=new OrbitControls(engine.camera,engine.canvas);
      try{const instance=current;unsubscribe=engine.onFrame((_,delta)=>instance.update(delta));setControls(current);}catch(error){current.dispose();throw error;}
    }).catch(error=>{if(!cancelled&&!engine.disposed)engine.onError(error);});
    return()=>{cancelled=true;unsubscribe?.();current?.dispose();};
  },[engine]);
  useCommit(()=>{
    if(!controls)return;
    if(!Number.isFinite(autoRotateSpeed)||!Number.isFinite(minDistance)||minDistance<0||maxDistance<minDistance||Number.isNaN(maxDistance))throw new RangeError('Invalid orbit controls options');
    Object.assign(controls,{autoRotate,autoRotateSpeed,enableDamping,minDistance,maxDistance});
  },[controls,autoRotate,autoRotateSpeed,enableDamping,minDistance,maxDistance]);
  return null;
}
