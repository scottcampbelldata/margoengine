import type {EngineKernel} from '@margoengine/core';
import {optionalPeer} from './optional.js';
import type {GLTFAsset, GLTFImage, PBRModel} from '@margoengine/gltf-pro';

type EnvironmentAPI = typeof import('@margoengine/environment');
export interface ModelSource {api:typeof import('@margoengine/gltf-pro');asset:GLTFAsset;images:GLTFImage[];first:PBRModel|null}
export interface EnvironmentSource {api:EnvironmentAPI;image:Awaited<ReturnType<EnvironmentAPI['loadEnvironmentImage']>>}
export interface AssetEntry<T> {
  status:'pending'|'resolved'|'rejected';promise:Promise<void>;value?:T;error?:unknown;
  abort:AbortController;users:number;
}
export interface AssetCache {
  engine:EngineKernel|null;disposed:boolean;
  models:Map<string,AssetEntry<ModelSource>>;fbx:Map<string,AssetEntry<ModelSource>>;environments:Map<string,AssetEntry<EnvironmentSource>>;
}
const active=new Set<AssetCache>();
export type ModelFormat='model'|'fbx';
type AssetKind=ModelFormat|'environment';
const queued=new Map<string,{src:string;kind:AssetKind;promise:Promise<void>;resolve:()=>void;reject:(error:unknown)=>void}>();
export function createAssetCache(engine:EngineKernel|null):AssetCache {return {engine,disposed:false,models:new Map(),fbx:new Map(),environments:new Map()};}

function closeImages(images:readonly GLTFImage[]):void {for(const image of images)if(image&&'close' in image)image.close();}
async function copyImages(images:readonly GLTFImage[]):Promise<GLTFImage[]> {
  const copies:GLTFImage[]=[];
  try {
    for(let i=0;i<images.length;i++){
      const image=images[i];if(!image)continue;
      copies[i]='ktx2' in image?{...image,close(){}}:'mipmaps' in image?{...image}:await createImageBitmap(image,{colorSpaceConversion:'none',premultiplyAlpha:'none'});
    }
    return copies;
  }catch(error){closeImages(copies);throw error;}
}
function disposeSource(source:ModelSource):void {source.first?.dispose();source.first=null;closeImages(source.images);source.images=[];}
async function loadModel(cache:AssetCache,src:string,signal:AbortSignal,format:ModelFormat):Promise<ModelSource> {
  const api=await optionalPeer('@margoengine/gltf-pro',()=>import('@margoengine/gltf-pro'));signal.throwIfAborted();
  const loader=format==='fbx'?(await optionalPeer('@margoengine/fbx',()=>import('@margoengine/fbx'))).loadFBX:api.loadGLTF;
  signal.throwIfAborted();const model=await loader(cache.engine!,src,{signal});
  model.root.visible=false;
  let copies:GLTFImage[]=[];
  try {
    signal.throwIfAborted();
    // Retain decoded CPU data, never a shared mutable model instance. Every mount
    // owns its transforms, materials, GPU resources and disposable image copies.
    const images:GLTFImage[]=[];
    for(let i=0;i<(model.asset.doc.images?.length??0);i++){
      try{images[i]=model.image(i);}catch(error){if(!(error instanceof TypeError)||error.message!=='Missing decoded glTF image')throw error;}
    }
    copies=await copyImages(images);signal.throwIfAborted();
    return {api,asset:model.asset,images:copies,first:model};
  }catch(error){closeImages(copies);model.dispose();throw error;}
}
export async function instantiateModel(source:ModelSource,engine:EngineKernel):Promise<PBRModel> {
  if(source.first){const model=source.first;source.first=null;return model;}
  const images=await copyImages(source.images);let model:PBRModel|undefined;
  try{model=new source.api.PBRModel(engine,source.asset,images);engine.use(model);return model;}
  catch(error){if(model)model.dispose();else closeImages(images);throw error;}
}
function entry<T>(cache:AssetCache,map:Map<string,AssetEntry<T>>,src:string,load:(signal:AbortSignal)=>Promise<T>,dispose?:(value:T)=>void):AssetEntry<T> {
  const cached=map.get(src);if(cached)return cached;
  const result:AssetEntry<T>={status:'pending',promise:Promise.resolve(),abort:new AbortController(),users:0};
  map.set(src,result);
  result.promise=load(result.abort.signal).then(value=>{
    if(cache.disposed||result.abort.signal.aborted){dispose?.(value);throw result.abort.signal.reason??new Error('Canvas disposed');}
    result.value=value;result.status='resolved';
  }).catch(error=>{result.error=error;result.status='rejected';});
  return result;
}
export function modelAsset(cache:AssetCache,src:string,format:ModelFormat='model'):AssetEntry<ModelSource> {
  return entry(cache,format==='fbx'?cache.fbx:cache.models,src,signal=>loadModel(cache,src,signal,format),disposeSource);
}
export function environmentAsset(cache:AssetCache,src:string):AssetEntry<EnvironmentSource> {
  return entry(cache,cache.environments,src,async signal=>{const api=await optionalPeer('@margoengine/environment',()=>import('@margoengine/environment'));signal.throwIfAborted();const image=await api.loadEnvironmentImage(src,{signal});signal.throwIfAborted();return {api,image};});
}
export function retainAsset<T>(cache:AssetCache,src:string,asset:AssetEntry<T>,map:Map<string,AssetEntry<T>>):()=>void {
  asset.users++;
  return()=>{if(--asset.users===0){asset.abort.abort();if(asset.status!=='resolved'&&map.get(src)===asset)map.delete(src);}if(cache.disposed)asset.abort.abort();};
}
function warm(cache:AssetCache,src:string,kind:AssetKind):Promise<void> {
  const asset=kind==='environment'?environmentAsset(cache,src):modelAsset(cache,src,kind);
  asset.users++;
  return asset.promise.then(()=>{
    if(asset.status==='rejected')throw asset.error;
    // A preloaded model must not appear in the scene before it is mounted.
    if(kind!=='environment'){const source=asset.value as ModelSource;if(source.first){source.first.dispose();source.first=null;}}
  }).finally(()=>{asset.users--;});
}
/** Warm the URL cache of active canvases. Before Canvas is ready, queue the same
 * promise until an engine exists. GPU-backed glTF loading requires that engine. */
export function preload(src:string,kind:AssetKind=/\.(hdr|exr)$/i.test(src.split(/[?#]/,1)[0])?'environment':/\.fbx$/i.test(src.split(/[?#]/,1)[0])?'fbx':'model'):Promise<void> {
  if(active.size)return Promise.all([...active].map(cache=>warm(cache,src,kind))).then(()=>{});
  const key=kind+':'+src,cached=queued.get(key);if(cached)return cached.promise;
  let resolve!:()=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
  queued.set(key,{src,kind,promise,resolve,reject});return promise;
}
export function activateAssetCache(cache:AssetCache):void {
  if(!cache.engine)return;cache.disposed=false;active.add(cache);
  for(const [key,request] of queued){queued.delete(key);warm(cache,request.src,request.kind).then(request.resolve,request.reject);}
}
export function disposeAssetCache(cache:AssetCache):void {
  active.delete(cache);cache.disposed=true;
  for(const map of [cache.models,cache.fbx])for(const asset of map.values()){asset.abort.abort();if(asset.value)disposeSource(asset.value);}
  for(const asset of cache.environments.values())asset.abort.abort();
  cache.models.clear();cache.fbx.clear();cache.environments.clear();
}
