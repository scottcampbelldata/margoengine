import test from 'node:test';
import assert from 'node:assert/strict';
import {DOF} from '../packages/dof/dist/index.js';
import {Tonemap,parseCube} from '../packages/tonemap/dist/index.js';
import {TAA} from '../packages/taa/dist/index.js';
import {SSAO,Bloom} from '../packages/post/dist/index.js';
import {Water} from '../packages/water/dist/index.js';
import {Transitions} from '../packages/transitions/dist/index.js';
import {optionalGPU} from './support/optional-gpu.js';
import {wgsl} from '../packages/core/src/shaders.ts';

function harness(){const h=optionalGPU();h.context.shader=wgsl;h.context.descriptor={...h.context.descriptor,vertex:{entryPoint:'vertex',buffers:[]},fragment:{entryPoint:'fragment'}};return {...h,frame(){h.context.shader=wgsl;h.context.bindings=[];h.engine.frameGraph.execute(h.context);}};}
for(const [name,factory] of Object.entries({dof:()=>new DOF(),tonemap:()=>new Tonemap(),taa:()=>new TAA(),ssao:()=>new SSAO(),bloom:()=>new Bloom(),water:()=>new Water({segments:4}),transitions:()=>new Transitions()}))test(name+' retains ownership of partial first-frame allocations for disposal',()=>{
 for(const method of ['createBuffer','createTexture','createBindGroup']){
  const base=harness(),effect=factory();base.engine.use(effect);const d=base.engine.gpu,original=d[method];let total=0;d[method]=(...args)=>{total++;return original(...args);};base.frame();effect.dispose();assert.ok(base.resources.every(r=>r.destroyed));
  for(let at=1;at<=total;at++){
   const h=harness(),candidate=factory();h.engine.use(candidate);const device=h.engine.gpu,operation=device[method],failure=new Error(name+' '+method+' '+at);let calls=0;
   device[method]=(...args)=>{if(++calls===at)throw failure;return operation(...args);};
   try{assert.throws(h.frame,error=>error===failure);candidate.dispose();assert.ok(h.resources.every(r=>r.destroyed),failure.message+' leaked native resources');}
   finally{h.cleanup();}
  }
 }
});

test('Tonemap destroys a failed LUT upload and retains the prior GPU texture for retry',()=>{
 const h=harness(),effect=new Tonemap();h.engine.use(effect);
 let text='LUT_3D_SIZE 33\n';for(let b=0;b<33;b++)for(let g=0;g<33;g++)for(let r=0;r<33;r++)text+=`${r/32} ${g/32} ${b/32}\n`;const lut=parseCube(text);
 effect.setLUT(lut);const previous=effect.lutTexture,write=h.engine.gpu.queue.writeTexture,failure=new Error('LUT upload failed');
 h.engine.gpu.queue.writeTexture=()=>{throw failure;};
 try{assert.throws(()=>effect.setLUT(lut),error=>error===failure);assert.equal(effect.lutTexture,previous);assert.equal(previous.destroyed,false);assert.equal(h.resources.at(-1).destroyed,true);}
 finally{h.engine.gpu.queue.writeTexture=write;}
 effect.setLUT(lut);assert.equal(previous.destroyed,true);h.frame();effect.dispose();assert.ok(h.resources.every(r=>r.destroyed));
});
