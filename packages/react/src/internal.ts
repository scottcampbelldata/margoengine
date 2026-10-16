import {createContext,useContext,useEffect,useLayoutEffect,useRef} from 'react';
import type {Engine,Mesh as EngineMesh,Vec3,Geometry} from '@margoengine/core/extension';
import type {FrameCallback,Mesh as MeshHandle} from '@margoengine/core';
import type {PBRModel,LightingEffect} from '@margoengine/gltf-pro';
import type {Shadows} from '@margoengine/shadows';
import type {AssetCache} from './assets.js';

export interface Registry {
  current:EngineMesh|null;children:Set<EngineMesh>;attachments:Set<(mesh:EngineMesh)=>void>;
  register(mesh:EngineMesh):void;unregister(mesh:EngineMesh):void;
  geometry?:Geometry|null;
  geometryOverride?:(mesh:EngineMesh,geometry:Geometry|null)=>void;
}
export interface Resources {models:Set<PBRModel>;lighting:Map<LightingEffect,Map<PBRModel,()=>void>>}
export interface MargoPointerEvent {
  nativeEvent:PointerEvent;object:MeshHandle;mesh:MeshHandle;target:MeshHandle;
  clientX:number;clientY:number;x:number;y:number;
}
export interface PointerHandlers {
  onClick?:(event:MargoPointerEvent)=>void;onPointerOver?:(event:MargoPointerEvent)=>void;onPointerOut?:(event:MargoPointerEvent)=>void;
}
export interface Frames {elapsed:number;last:number|null;mode:'always'|'demand';callbacks:Set<FrameCallback>}
export interface Scene {
  engine:Engine;registry:Registry|null;resources:Resources;shadows:Shadows|null;
  requestShadows:()=>()=>void;cameraOverrides:Set<()=>void>;pointerHandlers:Map<number,PointerHandlers>;
  frames:Frames;assetCache:AssetCache;
}
export const Context=createContext<Scene|null>(null);
export function useScene():Scene {const scene=useContext(Context);if(!scene)throw new Error('Engine components require <Canvas>');return scene;}
export function useMesh():Registry {const {registry}=useScene();if(!registry)throw new Error('Geometry and material require <Mesh>');return registry;}
export function live(registry:Registry):EngineMesh|null {const mesh=registry.current;return mesh&&!mesh.engine.disposed&&mesh.engine.meshes.get(mesh.id)===mesh?mesh:null;}
export function setGeometry(registry:Registry,mesh:EngineMesh,geometry:Geometry|null):void {
  registry.geometry=geometry;
  if(registry.geometryOverride)registry.geometryOverride(mesh,geometry);else mesh.setGeometry(geometry);
}
export const zero:Vec3=[0,0,0],one:Vec3=[1,1,1];
export const useCommit=typeof window==='undefined'?useEffect:useLayoutEffect;
export interface ResourceLease {active:boolean;closed:boolean;generation:number;keys:readonly unknown[];release:()=>void}
// Retain a committed resource through StrictMode's Suspense reveal replay.
export function useResourceEffect(setup:(lease:ResourceLease)=>(()=>void)|undefined,keys:readonly unknown[]):void {
  const saved=useRef<ResourceLease|null>(null);
  useEffect(()=>{
    let lease=saved.current;
    if(!lease||lease.closed||keys.some((key,index)=>key!==lease!.keys[index])){
      if(lease&&!lease.closed){lease.closed=true;lease.release();}
      lease={active:true,closed:false,generation:0,keys,release:()=>{}};saved.current=lease;
      lease.release=setup(lease)??(()=>{});
    }else{lease.active=true;lease.generation++;}
    const current=lease;
    return()=>{current.active=false;const generation=++current.generation;queueMicrotask(()=>{if(!current.active&&!current.closed&&current.generation===generation){current.closed=true;current.release();}});};
  },keys);
}
