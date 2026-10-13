import test from 'node:test';
import assert from 'node:assert/strict';
import {box} from '../packages/core/dist/extension.js';
import {Sky} from '../packages/sky/dist/index.js';
import {Scatter} from '../packages/scatter/dist/index.js';
import {Terrain} from '../packages/terrain/dist/index.js';
import {SSAO,Bloom} from '../packages/post/dist/index.js';
import {TAA} from '../packages/taa/dist/index.js';
import {DOF} from '../packages/dof/dist/index.js';
import {Tonemap} from '../packages/tonemap/dist/index.js';
import {VFX} from '../packages/vfx/dist/index.js';
import {Shadows} from '../packages/shadows/dist/index.js';
import {Clustered} from '../packages/clustered/dist/index.js';
import {Transitions} from '../packages/transitions/dist/index.js';
import {optionalGPU} from './support/optional-gpu.js';

const factories={sky:()=>new Sky(),scatter:()=>new Scatter(box(),{count:2}),ssao:()=>new SSAO(),bloom:()=>new Bloom(),taa:()=>new TAA(),dof:()=>new DOF(),tonemap:()=>new Tonemap(),vfx:()=>new VFX({capacity:2}),shadows:()=>new Shadows({resolution:64}),clustered:()=>new Clustered({grid:[1,1,1]}),transitions:()=>new Transitions(),terrain:h=>{
 const d=h.engine.gpu,heightmap=d.createTexture({size:[2,2],format:'r32float',usage:GPUTextureUsage.TEXTURE_BINDING}),layers=d.createTexture({size:[2,2,4],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING});heightmap.depthOrArrayLayers=1;layers.depthOrArrayLayers=4;
 return new Terrain({textures:()=>({heightmap,layers}),layers:Array.from({length:4},(_,i)=>({height:[i,i+1],slope:[0,1],scale:1})),size:[2,2],resolution:8,levels:1});
}};
function harness(){const h=optionalGPU(),d=h.engine.gpu;d.limits.maxTextureDimension2D=8192;d.limits.maxTextureArrayLayers=256;globalThis.GPUShaderStage={VERTEX:1,FRAGMENT:2};d.createBindGroupLayout=x=>x;d.createPipelineLayout=x=>x;return h;}
for(const [name,factory] of Object.entries(factories))test(name+' releases partial setup allocations when native operations fail',()=>{
 for(const method of ['createBuffer','createTexture','createBindGroup','writeBuffer']) {
  const baseline=harness(),effect=factory(baseline),owner=method==='writeBuffer'?baseline.engine.gpu.queue:baseline.engine.gpu,original=owner[method];let total=0;
  owner[method]=(...args)=>{total++;return original(...args);};baseline.engine.use(effect);effect.dispose();assert.ok(baseline.resources.every(r=>r.destroyed));
  for(let at=1;at<=total;at++) {
   const h=harness(),candidate=factory(h),device=h.engine.gpu,target=method==='writeBuffer'?device.queue:device,operation=target[method],failure=new Error(name+' '+method+' '+at);let calls=0;
   target[method]=(...args)=>{if(++calls===at)throw failure;return operation(...args);};
   try {assert.throws(()=>h.engine.use(candidate),error=>error===failure);assert.equal(h.engine.hasPlugin(candidate.name),false);assert.ok(h.resources.every(r=>r.destroyed),name+' '+method+' failure '+at+' leaked native resources');}
   finally {h.cleanup();}
  }
 }
});
