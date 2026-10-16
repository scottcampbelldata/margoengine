'use client';
import {useContext,useRef} from 'react';
import type {Animation as ClipAnimation} from '@margoengine/animation';
import type {Animator} from '@margoengine/animator';
import type {PBRModel} from '@margoengine/gltf-pro';
import type {Vec3} from '@margoengine/core/extension';
import {useCommit,useResourceEffect,useScene} from './internal.js';
import {ModelContext} from './model.js';
import {optionalPeer} from './optional.js';

export interface AnimationProps {
  clip:string;playing?:boolean;loop?:boolean;
  /** Crossfade duration in seconds when clip changes. Uses @margoengine/animator. */
  blend?:number;onError?:(error:unknown)=>void;
}
interface Playback {animation:ClipAnimation;animator?:Animator;clip:string;prepareMixer:()=>void}
interface Pose {nodes:Array<{position:Vec3;scale:Vec3;rotation:number[]}>;weights:Float32Array[]}
function pose(model:PBRModel):Pose {
  return {nodes:model.nodes.map(node=>{const t=node.engine.store.transforms,id=node.id;return {position:[t.x[id],t.y[id],t.z[id]],scale:[t.sx[id],t.sy[id],t.sz[id]],rotation:[t.qx[id],t.qy[id],t.qz[id],t.qw[id]]};}),weights:model.primitives.map(primitive=>primitive.weights.slice())};
}
function restore(model:PBRModel,value:Pose):void {
  model.nodes.forEach((node,index)=>{const saved=value.nodes[index];node.setPosition(saved.position).setScale(saved.scale).setQuaternion(saved.rotation);});
  model.primitives.forEach((primitive,index)=>primitive.weights.set(value.weights[index]));
}
function validate({clip,playing=true,loop=true,blend=0}:AnimationProps):void {
  if(typeof clip!=='string'||!clip)throw new TypeError('Animation: clip must name a glTF animation');
  if(typeof playing!=='boolean'||typeof loop!=='boolean'||!Number.isFinite(blend)||blend<0)throw new RangeError('Animation: invalid playing, loop, or blend option');
}
function select(current:Playback,props:AnimationProps):void {
  validate(props);
  if(!current.animation.clips.some(clip=>clip.name===props.clip))throw new RangeError('Animation: unknown clip "'+props.clip+'"');
  current.animation.options.loop=props.loop??true;
  if(!current.clip){current.animation.play(props.clip);current.clip=props.clip;}
  if(current.animator){
    if(current.clip!==props.clip){current.animator.transition(props.clip,props.blend??0);current.clip=props.clip;}
  }else{
    // Keep the source clip and its clock alive while the optional mixer loads.
    if((props.blend??0)>0)current.prepareMixer();
    else if(current.clip!==props.clip){current.animation.play(props.clip);current.clip=props.clip;}
    current.animation.playing=props.playing??true;
  }
}
/** Play a named clip on the nearest Gltf/Fbx instance without sharing state. */
export function Animation(props:AnimationProps) {
  const scene=useScene(),model=useContext(ModelContext),latest=useRef(props),current=useRef<Playback|null>(null);latest.current=props;
  if(model===undefined)throw new Error('Animation requires a parent <Gltf>, <Model>, or <Fbx>');
  const report=(error:unknown)=>{try{latest.current.onError?.(error);}finally{scene.engine.onError(error);}};
  useResourceEffect(lease=>{
    if(!model)return;
    let owned:Playback|undefined;
    const release=()=>{if(!owned)return;if(current.current===owned)current.current=null;owned.animator?.dispose();owned.animation.dispose();owned=undefined;};
    void (async()=>{
      validate(latest.current);
      const api=await optionalPeer('@margoengine/animation',()=>import('@margoengine/animation'));
      if(!lease.active||scene.engine.disposed||model.disposed)return;
      if(scene.engine.hasPlugin('animation:'+model.name))throw new Error('Animation: this model already has an animation plugin');
      const animation=new api.Animation(model,{loop:latest.current.loop??true});
      const rest=pose(model);
      owned={animation,clip:'',prepareMixer:()=>{}};
      if(!animation.clips.some(value=>value.name===latest.current.clip))throw new RangeError('Animation: unknown clip "'+latest.current.clip+'"');
      // Native setup owns deformation buffers and the picking preparation hook.
      scene.engine.use(animation);
      const playback=owned;let preparing:Promise<void>|undefined;
      playback.prepareMixer=()=>{
        if(preparing||playback.animator)return;
        preparing=(async()=>{
          const mixer=await optionalPeer('@margoengine/animator',()=>import('@margoengine/animator'));
          if(!lease.active||scene.engine.disposed||model.disposed||owned!==playback||(latest.current.blend??0)<=0)return;
          const time=animation.time,visual=pose(model);let animator:Animator;
          // Animator captures its rest pose at construction. Restore the mount's
          // original pose temporarily, then let its native sampler reconstruct
          // the running source clip at the existing clock before transitioning.
          restore(model,rest);
          try{animator=new mixer.Animator(animation,{states:Object.fromEntries(animation.clips.map(value=>[value.name,value.name])),initial:playback.clip});}
          finally{restore(model,visual);}
          if(scene.engine.hasPlugin(animator.name))throw new Error('Animation: this model already has an animator plugin');
          scene.engine.use(animator);playback.animator=animator;
          const advance=animator.onPreUpdate.bind(animator);let terminal:string|undefined;
          // Native code owns all sampling and blending. Gate only its clock.
          animator.onPreUpdate=delta=>{
            if(latest.current.playing===false)return;
            if(latest.current.loop!==false){terminal=undefined;advance(delta);return;}
            const duration=animation.clips.find(value=>value.name===animator.state)?.duration??0;
            if(terminal===animator.state&&animator.time>=duration)return;
            const remaining=Math.max(0,duration-animator.time);
            if(remaining>0)advance(Math.min(delta,remaining));
            if(delta>=remaining){animation.clip=animation.clips.findIndex(value=>value.name===animator.state);animation.seek(duration);terminal=animator.state;}
          };
          advance(time);select(playback,latest.current);
        })().catch(error=>{if(lease.active&&!scene.engine.disposed&&!model.disposed)report(error);}).finally(()=>{preparing=undefined;});
      };
      select(owned,latest.current);current.current=owned;
    })().catch(error=>{release();if(lease.active&&!scene.engine.disposed&&!model.disposed)report(error);});
    return release;
  },[scene.engine,model]);
  useCommit(()=>{if(current.current){try{select(current.current,props);}catch(error){report(error);}}},[model,props.clip,props.playing,props.loop,props.blend]);
  return null;
}
