import test from 'node:test';
import assert from 'node:assert/strict';
import {GPUParticles} from '../packages/creative/dist/particles.js';
import {optionalGPU} from './support/optional-gpu.js';

test('Sorted particle setup releases a stage buffer when its upload or bind group fails',async t=>{
 for(const fault of ['upload','group'])await t.test(fault,()=>{
  const h=optionalGPU(),particles=new GPUParticles({count:2,sort:true}),error=new Error('Stage '+fault+' failed');
  const group=h.engine.gpu.createBindGroup,write=h.engine.gpu.queue.writeBuffer;let calls=0;
  h.engine.gpu.createBindGroup=function(...args){if(fault==='group'&&++calls===3)throw error;return Reflect.apply(group,this,args);};
  h.engine.gpu.queue.writeBuffer=function(buffer,offset,value){if(fault==='upload'&&value instanceof Uint32Array&&value.length===4)throw error;return Reflect.apply(write,this,[buffer,offset,value]);};
  try{assert.throws(()=>h.engine.use(particles),value=>value===error);assert.ok(h.resources.every(resource=>resource.destroyed),'A newly created sort stage buffer was not released');}
  finally{particles.dispose();h.cleanup();}
 });
});

test('Failed particle device restoration releases all new resources and a later restoration can retry',()=>{
 const h=optionalGPU(),particles=new GPUParticles({count:2,sort:true});h.engine.use(particles);
 const start=h.resources.length,error=new Error('Restore stage group failed'),group=h.engine.gpu.createBindGroup;let calls=0;
 h.engine.gpu.createBindGroup=function(...args){if(++calls===3)throw error;return Reflect.apply(group,this,args);};
 try{
  assert.throws(()=>particles.onDeviceRestored(h.engine),value=>value===error);
  assert.ok(h.resources.slice(start).every(resource=>resource.destroyed),'Failed restoration retained native resources');
  assert.equal(particles.device,undefined);
  h.engine.gpu.createBindGroup=group;particles.onDeviceRestored(h.engine);h.engine.frameGraph.execute(h.context);assert.equal(h.counts.draws,1);
 }finally{particles.dispose();h.cleanup();}
});

test('Particle compute and render passes close once when synchronous command encoding throws',async t=>{
 for(const kind of ['compute','render'])await t.test(kind,()=>{
  const h=optionalGPU(),particles=new GPUParticles({count:1}),error=new Error(kind+' encoding failed');h.engine.use(particles);let ended=0;
  const pass={setPipeline(){throw error;},setBindGroup(){},dispatchWorkgroups(){},draw(){},end(){ended++;}};
  if(kind==='compute')h.context.encoder.beginComputePass=()=>pass;else h.context.encoder.beginRenderPass=()=>pass;
  try{assert.throws(()=>kind==='compute'?particles.update(h.context):particles.draw(h.context),value=>value===error);assert.equal(ended,1,'Owned pass remained open after encoding failure');}
  finally{particles.dispose();h.cleanup();}
 });
});
