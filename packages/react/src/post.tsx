'use client';
import {createContext, useContext, useMemo, useRef, type ReactNode} from 'react';
import type {EngineKernel} from '@margoengine/core';
import type {Bloom as BloomEffect, BloomOptions} from '@margoengine/post/bloom';
import type {SSAO as SSAOEffect, SSAOOptions} from '@margoengine/post/ssao';
import type {DOF as DepthOfFieldEffect, DOFOptions} from '@margoengine/dof';
import type {Tonemap as TonemapEffect, TonemapOptions, CubeLUT} from '@margoengine/tonemap';
import type {TAA as TAAEffect, TAAOptions, VelocityPrimitive, VelocitySource} from '@margoengine/taa';
import {useScene, useCommit, useResourceEffect, type Scene} from './internal.js';

type Kind='bloom'|'ssao'|'dof'|'tonemap'|'taa';
type Effect=BloomEffect|SSAOEffect|DepthOfFieldEffect|TonemapEffect|TAAEffect;
type Options=Record<string, unknown>;
interface Callbacks<T> {onReady?:(effect:T)=>void;onError?:(error:unknown)=>void}
export interface EffectComposerProps {children?:ReactNode;enabled?:boolean;onError?:(error:unknown)=>void}
export interface BloomProps extends BloomOptions, Callbacks<BloomEffect> {}
export interface SSAOProps extends SSAOOptions, Callbacks<SSAOEffect> {}
export interface DepthOfFieldProps extends DOFOptions, Callbacks<DepthOfFieldEffect> {}
export interface TonemapProps extends TonemapOptions, Callbacks<TonemapEffect> {lut?:CubeLUT|string|null}
export interface TAAProps extends TAAOptions, Callbacks<TAAEffect> {}
interface Pass {kind:Kind;options:Options;lut?:CubeLUT|string|null;onReady?:(effect:Effect)=>void;onError?:(error:unknown)=>void}
class PassLoadFailure {
  constructor(readonly pass:Pass,readonly failure:unknown) {}
}
type Model=Scene['resources']['models'] extends Set<infer T>?T:never;
interface SourceBinding {remove:()=>void;refresh?:()=>void}
interface RecordEntry {pass:Pass;effect:Effect;options:Options;lut?:CubeLUT|string|null;sources:Map<Model,SourceBinding>}
interface Lease {active:boolean;closed:boolean}
type Factory=(engine:EngineKernel, options:never)=>Effect;
const priority:Record<Kind,number>={bloom:0,ssao:0,dof:0,tonemap:1,taa:2};
declare const GPUBufferUsage:{VERTEX:number;STORAGE:number;COPY_DST:number};

// Native static glTF vertex buffers are VERTEX-only. TAA's snapshot compute
// needs STORAGE too; retain a separate upload without changing the model or its
// beauty/shadow buffers. Animation's STORAGE buffers already satisfy that API.
function velocitySource(scene:Scene,model:Model) {
  const copies=new Map<GPUBuffer,{buffer:GPUBuffer;vertices:Float32Array}>();
  let device=scene.engine.gpu,closed=false,primitives:VelocityPrimitive[]=[];
  const release=()=>{for(const copy of copies.values())copy.buffer.destroy();copies.clear();};
  const refresh=()=>{
    if(closed||model.disposed||scene.engine.disposed){release();primitives=[];return;}
    if(device!==scene.engine.gpu){release();device=scene.engine.gpu;}
    if(!device){primitives=[];return;}
    const inputs=model.primitives.filter(primitive=>primitive.material.settings[0]!==2),originals=model.shadowPrimitives,used=new Set<GPUBuffer>(),next:VelocityPrimitive[]=[];
    try {
      for(let index=0;index<originals.length;index++) {
        const primitive=originals[index];
        if(primitive.vertex.usage&GPUBufferUsage.STORAGE){next.push(primitive);continue;}
        const input=inputs[index];
        if(!input||input.node!==primitive.node||input.indices.length!==primitive.count||input.deformed||input.vertices.byteLength!==primitive.vertex.size)
          throw new Error('TAA requires matching static PBR vertex data or a storage-capable deformed buffer');
        used.add(primitive.vertex);let copy=copies.get(primitive.vertex);
        if(copy&&copy.vertices!==input.vertices){copy.buffer.destroy();copies.delete(primitive.vertex);copy=undefined;}
        if(!copy) {
          const buffer=device.createBuffer({size:input.vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
          try{device.queue.writeBuffer(buffer,0,input.vertices as Float32Array<ArrayBuffer>);}catch(error){buffer.destroy();throw error;}
          copy={buffer,vertices:input.vertices};copies.set(primitive.vertex,copy);
        }
        next.push({...primitive,vertex:copy.buffer});
      }
      for(const [original,copy] of copies)if(!used.has(original)){copy.buffer.destroy();copies.delete(original);}
      primitives=next;
    }catch(error){release();primitives=[];throw error;}
  };
  const source:VelocitySource={get shadowPrimitives(){refresh();return primitives;},get disposed(){return closed||model.disposed||scene.engine.disposed;}};
  return {source,refresh,dispose(){closed=true;release();primitives=[];}};
}

async function factory(kind:Kind):Promise<Factory> {
  switch(kind) {
    case 'bloom':return (await import('@margoengine/post/bloom')).Bloom.attach;
    case 'ssao':return (await import('@margoengine/post/ssao')).SSAO.attach;
    case 'dof':return (await import('@margoengine/dof')).DOF.attach;
    case 'tonemap':return (await import('@margoengine/tonemap')).Tonemap.attach;
    case 'taa':return (await import('@margoengine/taa')).TAA.attach;
  }
}

// Each engine plugin keeps its existing frame-graph ownership. This is a lifecycle
// coordinator; combinations rejected by the native plugins remain unsupported.
function composer(scene:Scene, error:()=>EffectComposerProps['onError']) {
  const passes=new Set<Pass>(),records=new Map<Kind,RecordEntry>();
  let lease:Lease|undefined,revision=0,scheduled=false,queue=Promise.resolve();
  const live=(current=lease)=>!!current&&current===lease&&current.active&&!current.closed&&!scene.engine.disposed;
  const report=(failure:unknown,pass?:Pass)=>{const handler=pass?.onError??error();if(handler)handler(failure);else scene.engine.onError(failure);};
  const dispose=(record:RecordEntry)=>{
    for(const binding of record.sources.values())binding.remove();record.sources.clear();record.effect.dispose();
  };
  const clear=()=>{for(const record of [...records.values()].reverse())dispose(record);records.clear();};
  const depth=()=>{
    const record=records.get('dof')??records.get('ssao')??records.get('bloom');
    return record?(record.effect as DepthOfFieldEffect|SSAOEffect|BloomEffect).depthTexture:undefined;
  };
  const source=()=>(records.get('dof')?.effect as DepthOfFieldEffect|undefined)?.outputTexture;
  const syncSources=()=>{
    if(!live())return;
    for(const [kind,record] of records) {
      if(kind!=='ssao'&&kind!=='taa')continue;
      for(const [model,binding] of record.sources)if(!scene.resources.models.has(model)||model.disposed){binding.remove();record.sources.delete(model);}else binding.refresh?.();
      for(const model of scene.resources.models)if(!model.disposed&&!record.sources.has(model)) {
        if(kind==='ssao')record.sources.set(model,{remove:(record.effect as SSAOEffect).add(model)});
        else {
          const adapter=velocitySource(scene,model);
          try {
            const remove=(record.effect as TAAEffect).add(adapter.source);
            record.sources.set(model,{refresh:adapter.refresh,remove(){remove();adapter.dispose();}});
          }catch(error){adapter.dispose();throw error;}
        }
      }
    }
  };
  const validate=(desired:Pass[])=>{
    const kinds=new Set<Kind>();
    for(const pass of desired){if(kinds.has(pass.kind))throw new Error('EffectComposer cannot attach duplicate '+pass.kind+' passes');kinds.add(pass.kind);}
    if(['bloom','ssao','dof'].filter(kind=>kinds.has(kind as Kind)).length>1)
      throw new Error('EffectComposer: Bloom, SSAO and DepthOfField own scene capture and cannot be combined; choose one capture effect');
    if(kinds.has('bloom')&&kinds.has('tonemap'))throw new Error('EffectComposer: Bloom already owns tone mapping and cannot be combined with Tonemap');
    if(kinds.has('ssao')&&desired.some(pass=>pass.kind==='tonemap'&&!pass.options.source))
      throw new Error('EffectComposer: Tonemap with SSAO requires an explicit HDR source');
  };
  const reconcile=async(version:number)=>{
    const current=lease;if(!live(current)||version!==revision)return;
    const desired=[...passes].sort((a,b)=>priority[a.kind]-priority[b.kind]);
    let attaching:Pass|undefined;
    try {
      if(desired.length&&(scene.engine.backend!=='webgpu'||!scene.engine.gpu))throw new Error('EffectComposer requires WebGPU');
      validate(desired);
      const imports=await Promise.all(desired.map(async pass=>{
        try{return [pass.kind,await factory(pass.kind)] as const;}
        catch(failure){throw new PassLoadFailure(pass,failure);}
      }));
      if(!live(current)||version!==revision)return;
      const factories=new Map(imports),kinds=new Set(desired.map(pass=>pass.kind));
      const optionsFor=(pass:Pass):Options=>({...pass.options,
        ...(pass.kind==='tonemap'&&!pass.options.source&&kinds.has('dof')?{source}:{}),
        ...(pass.kind==='taa'&&!pass.options.depth&&['dof','ssao','bloom'].some(kind=>kinds.has(kind as Kind))?{depth}:{}),
      });
      for(const [kind,record] of [...records].reverse()) {
        const next=desired.find(pass=>pass.kind===kind);
        if(!next||next!==record.pass||kind==='tonemap'&&record.options.source!==optionsFor(next).source) {dispose(record);records.delete(kind);}
      }
      for(const pass of desired) {
        attaching=pass;const options=optionsFor(pass);let record=records.get(pass.kind);
        if(!record) {
          const effect=factories.get(pass.kind)!(scene.engine as unknown as EngineKernel,options as never);
          record={pass,effect,options,lut:undefined,sources:new Map()};records.set(pass.kind,record);
          if(pass.kind==='tonemap'&&pass.lut!==undefined){(effect as TonemapEffect).setLUT(pass.lut);record.lut=pass.lut;}
          pass.onReady?.(effect);
        }else {
          const changed=Object.keys({...record.options,...options}).some(key=>record!.options[key]!==options[key]);
          if(changed) {
            const target=record.effect.options as Options;
            for(const key of Object.keys(target))if(!(key in options))delete target[key];
            Object.assign(target,options);record.options=options;
            if(pass.kind==='taa')(record.effect as TAAEffect).reset();
          }
          if(pass.kind==='tonemap'&&record.lut!==pass.lut){(record.effect as TonemapEffect).setLUT(pass.lut??null);record.lut=pass.lut;}
        }
      }
      syncSources();
    }catch(failure){if(live(current)){clear();if(failure instanceof PassLoadFailure)report(failure.failure,failure.pass);else report(failure,attaching);}}
  };
  const schedule=()=>{
    revision++;if(scheduled)return;scheduled=true;
    queueMicrotask(()=>{scheduled=false;const version=revision;queue=queue.then(()=>reconcile(version)).catch(failure=>{if(live())report(failure);});});
  };
  return {passes,schedule,start(current:Lease){lease=current;scene.frames.callbacks.add(syncSources);schedule();return()=>{if(lease!==current)return;lease=undefined;revision++;scene.frames.callbacks.delete(syncSources);clear();};}};
}

type Composer=ReturnType<typeof composer>;
const Context=createContext<Composer|null>(null);
export function EffectComposer({children,enabled=true,onError}:EffectComposerProps) {
  const scene=useScene(),errors=useRef(onError);errors.current=onError;
  const manager=useMemo(()=>composer(scene,()=>errors.current),[scene.engine,scene.resources,scene.frames]);
  useResourceEffect(lease=>enabled?manager.start(lease):undefined,[manager,enabled]);
  return <Context.Provider value={manager}>{children}</Context.Provider>;
}
function usePass<T extends Effect>(kind:Kind,options:Options,callbacks:Callbacks<T>,lut?:CubeLUT|string|null) {
  const manager=useContext(Context);if(!manager)throw new Error('Post effects require <EffectComposer>');
  const pass=useMemo<Pass>(()=>({kind,options:{}}),[manager,kind]);
  pass.options=options;pass.lut=lut;pass.onReady=callbacks.onReady as Pass['onReady'];pass.onError=callbacks.onError;
  useResourceEffect(()=>{manager.passes.add(pass);manager.schedule();return()=>{manager.passes.delete(pass);manager.schedule();};},[manager,pass]);
  useCommit(()=>{manager.schedule();});
}
export function Bloom({onReady,onError,...options}:BloomProps) {usePass('bloom',options,{onReady,onError});return null;}
export function SSAO({onReady,onError,...options}:SSAOProps) {usePass('ssao',options,{onReady,onError});return null;}
export function DepthOfField({onReady,onError,...options}:DepthOfFieldProps) {usePass('dof',options,{onReady,onError});return null;}
export function Tonemap({onReady,onError,lut,...options}:TonemapProps) {usePass('tonemap',options,{onReady,onError},lut);return null;}
export function TAA({onReady,onError,...options}:TAAProps) {usePass('taa',options,{onReady,onError});return null;}
