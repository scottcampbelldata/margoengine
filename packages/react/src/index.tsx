'use client';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useImperativeHandle, forwardRef, type ReactNode, type CSSProperties } from 'react';
import { Engine, Mesh as EngineMesh, box, PbrMaterial as Material, type EngineOptions, type Vec3, type Geometry } from '@vexel/core/extension';
import type {EngineKernel,Mesh as MeshHandle,FrameCallback} from '@vexel/core';

interface Registry {
  current: EngineMesh|null;
  children: Set<EngineMesh>;
  attachments: Set<(mesh: EngineMesh)=>void>;
  register(mesh: EngineMesh): void;
  unregister(mesh: EngineMesh): void;
}
interface Scene {engine:Engine;registry:Registry|null}
const Context=createContext<Scene|null>(null);
function useScene():Scene {const scene=useContext(Context);if(!scene)throw new Error('Engine components require <Canvas>');return scene;}
function useMesh(): Registry {const {registry}=useScene();if(!registry)throw new Error('Geometry and material require <Mesh>');return registry;}
function live(registry:Registry):EngineMesh|null {const mesh=registry.current;return mesh&&!mesh.engine.disposed&&mesh.engine.meshes.get(mesh.id)===mesh?mesh:null;}
const zero:Vec3=[0,0,0],one:Vec3=[1,1,1];
const useCommit=typeof window==='undefined'?useEffect:useLayoutEffect;

export interface CanvasProps extends EngineOptions {
  children?: ReactNode; style?:CSSProperties; className?:string; label?:string;
  onCreated?:(engine:EngineKernel)=>void; onError?:(error:unknown)=>void;
}
export function Canvas({children,style,className,label='Interactive 3D scene',capacity=1024,backend='auto',camera,onCreated,onError}:CanvasProps) {
  const canvas=useRef<HTMLCanvasElement>(null),queue=useRef<Promise<void>>(Promise.resolve()),created=useRef(onCreated),errorHandler=useRef(onError);
  const [engine,setEngine]=useState<Engine|null>(null),[error,setError]=useState<unknown>(null);
  created.current=onCreated;errorHandler.current=onError;
  useEffect(()=>{
    let cancelled=false,current:Engine|undefined;setEngine(null);setError(null);
    const report=(error:unknown)=>{if(!cancelled){setError(error);errorHandler.current?.(error);}};
    queue.current=queue.current.catch(()=>{}).then(async()=>{
      if(cancelled)return;
      const instance=await Engine.create(canvas.current!,{capacity,backend});
      if(cancelled){instance.dispose();return;}
      current=instance;instance.onError=report;setEngine(instance);
      try{created.current?.(instance as unknown as EngineKernel);instance.start();}catch(error){instance.dispose();setEngine(null);throw error;}
    }).catch(report);
    return()=>{cancelled=true;current?.dispose();};
  },[capacity,backend]);
  useCommit(()=>{if(engine&&camera)Object.assign(engine.camera,camera);},[engine,camera]);
  const scene=useMemo<Scene|null>(()=>engine?{engine,registry:null}:null,[engine]);
  return <><canvas ref={canvas} className={className} style={{display:'block',width:'100%',height:'100%',...style}} role="img" aria-label={label}/>{error!==null&&<p role="alert">{String(error)}</p>}{scene&&!engine?.disposed&&<Context.Provider value={scene}>{children}</Context.Provider>}</>;
}

export type MeshRef=MeshHandle;
export interface MeshProps {position?:Vec3;rotation?:Vec3;scale?:Vec3;children?:ReactNode}
export const Mesh=forwardRef<MeshRef,MeshProps>(function Mesh({position=zero,rotation=zero,scale=one,children},ref){
  const {engine,registry:parent}=useScene();const [node,setNode]=useState<EngineMesh|null>(null);
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
  const scene=useMemo(()=>({engine,registry}),[engine,registry]);
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
