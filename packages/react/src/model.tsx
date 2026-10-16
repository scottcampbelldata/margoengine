'use client';
import {createContext,useRef,useState,type ReactNode} from 'react';
import type {EngineKernel,Mesh as MeshHandle} from '@margoengine/core';
import type {Vec3} from '@margoengine/core/extension';
import type {PBRModel} from '@margoengine/gltf-pro';
import {useScene,useCommit,useResourceEffect,zero,one,type PointerHandlers} from './internal.js';
import {modelAsset,retainAsset,instantiateModel,type ModelFormat} from './assets.js';
interface Loading {src:string;pending:boolean;promise:Promise<void>}
export interface MaterialOverride {
  baseColor?:Vec3|readonly [number,number,number,number];roughness?:number;metalness?:number;
  emissive?:Vec3;normalScale?:number;occlusionStrength?:number;alphaCutoff?:number;doubleSided?:boolean;
}
export interface ModelProps extends PointerHandlers {
  src:string;position?:Vec3;rotation?:Vec3;scale?:Vec3;materials?:Record<string,MaterialOverride>;
  children?:ReactNode;castShadow?:boolean;receiveShadow?:boolean;onLoad?:(mesh:MeshHandle)=>void;onError?:(error:unknown)=>void;
}
// Optional model behaviours share the instance that this mount owns. The URL
// cache keeps source data only; animation state is never shared between mounts.
export const ModelContext=createContext<PBRModel|null|undefined>(undefined);
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
export function ModelResource({format='model',position=zero,rotation=zero,scale=one,castShadow=false,receiveShadow=false,...props}:ModelProps & {format?:ModelFormat}) {
  const {engine,registry,resources,shadows,assetCache,pointerHandlers}=useScene(),[model,setModel]=useState<PBRModel|null>(null);
  const [loading,setLoading]=useState<Loading|null>(null);
  const latest=useRef({...props,position,rotation,scale}),originals=useRef(new Map<object,any>());
  latest.current={...props,position,rotation,scale};
  useResourceEffect(lease=>{
    let current:PBRModel|undefined;
    const map=format==='fbx'?assetCache.fbx:assetCache.models;
    const asset=modelAsset(assetCache,props.src,format),releaseAsset=retainAsset(assetCache,props.src,asset,map);
    const handlers:PointerHandlers={get onClick(){return latest.current.onClick;},get onPointerOver(){return latest.current.onPointerOver;},get onPointerOut(){return latest.current.onPointerOut;}};
    const ids=new Set<number>();
    setModel(null);
    const release=()=>{
      if(!current)return;
      for(const id of ids)if(pointerHandlers.get(id)===handlers)pointerHandlers.delete(id);ids.clear();
      resources.models.delete(current);
      for(const models of resources.lighting.values()){models.get(current)?.();models.delete(current);}
      registry?.unregister(current.root);current.dispose();current=undefined;
    };
    const request:Loading={src:props.src,pending:asset.status==='pending',promise:Promise.resolve()};
    request.promise=(async()=>{
      await asset.promise;if(!lease.active||engine.disposed)return;
      if(asset.status==='rejected')throw asset.error;
      const loaded=await instantiateModel(asset.value!,engine as unknown as EngineKernel);
      if(!lease.active||engine.disposed){loaded.dispose();return;}
      current=loaded;
      const saved=new Map<object,any>();for(const primitive of loaded.primitives)if(!saved.has(primitive.material))saved.set(primitive.material,{...primitive.material,base:[...primitive.material.base],factors:[...primitive.material.factors],emission:[...primitive.material.emission],settings:[...primitive.material.settings]});
      originals.current=saved;
      const p=latest.current;loaded.root.setPosition(p.position).setRotation(p.rotation).setScale(p.scale);applyMaterials(saved,p.materials);loaded.root.visible=true;
      registry?.register(loaded.root);resources.models.add(loaded);
      for(const [effect,models] of resources.lighting)models.set(loaded,loaded.addLighting(effect));
      for(const node of [loaded.root,...loaded.nodes,...loaded.primitives.map(primitive=>primitive.node)])if(node){ids.add(node.id);pointerHandlers.set(node.id,handlers);}
      setModel(loaded);p.onLoad?.(loaded.root);
    })().catch(error=>{release();if(lease.active&&!engine.disposed){setModel(null);try{latest.current.onError?.(error);}finally{engine.onError(error);}}}).finally(()=>{request.pending=false;});
    setLoading(request);
    return()=>{releaseAsset();release();if(asset.users===0&&asset.value?.first){asset.value.first.dispose();asset.value.first=null;}};
  },[engine,registry,resources,assetCache,pointerHandlers,props.src,format]);
  useCommit(()=>{if(model&&!model.disposed){model.root.setPosition(position).setRotation(rotation).setScale(scale);}},[model,position[0],position[1],position[2],rotation[0],rotation[1],rotation[2],scale[0],scale[1],scale[2]]);
  useCommit(()=>{if(model&&!model.disposed)applyMaterials(originals.current,props.materials);},[model,props.materials]);
  useCommit(()=>{
    if(!model||model.disposed||!shadows)return;
    const removeCaster=castShadow?shadows.add({get shadowPrimitives(){return model.shadowPrimitives;},get disposed(){return model.disposed;}}):undefined;
    let removeReceiver:(()=>void)|undefined;
    try{if(receiveShadow)removeReceiver=model.addLighting(shadows);}catch(error){removeCaster?.();throw error;}
    return()=>{removeCaster?.();removeReceiver?.();};
  },[model,shadows,castShadow,receiveShadow]);
  // Start after the first commit so even an initially hidden Suspense subtree
  // has a passive unmount cleanup that can abort its outstanding request.
  if(loading?.src===props.src&&loading.pending)throw loading.promise;
  return <ModelContext.Provider value={model&&!model.disposed&&loading?.src===props.src?model:null}>{props.children}</ModelContext.Provider>;
}

export function Model(props:ModelProps){return <ModelResource {...props}/>;}
