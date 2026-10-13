import test from 'node:test';
import assert from 'node:assert/strict';
import {SSAO} from '../dist/index.js';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';

test('SSAO retains frame upload arrays, updates radius and restores owned resources',()=>{
 const h=optionalGPU(),effect=new SSAO(),writes=new Map(),upload=h.engine.gpu.queue.writeBuffer;
 h.engine.gpu.queue.writeBuffer=(buffer,offset,data)=>{writes.set(buffer,data);upload(buffer,offset,data);};
 h.engine.use(effect);
 const frame=()=>{
  h.context.color=h.originalColor;h.context.depth=h.originalDepth;h.context.format='bgra8unorm';h.context.bindings.length=0;
  h.context.shader='let direct=vec3f(1);let linear=direct*vec3f(1);\nlet mapped=linear/(1.0+linear); return vec4f(mapped,1);';
  h.engine.frameGraph.execute(h.context);
 };
 try{
  frame();const allocated={...h.counts},directions=h.resources.filter(resource=>resource.size===16),data=directions.map(buffer=>writes.get(buffer));
  assert.equal(directions.length,2);assert.deepEqual(data.map(value=>Array.from(value)),[[1,0,0.5,0],[0,1,0.5,0]]);
  const F32=globalThis.Float32Array;let arrayAllocations=0;
  globalThis.Float32Array=new Proxy(F32,{construct(target,args){arrayAllocations++;return Reflect.construct(target,args);}});
  try{for(let i=0;i<120;i++)frame();}finally{globalThis.Float32Array=F32;}
  assert.equal(arrayAllocations,0,'Steady SSAO frames allocated typed arrays');
  for(let i=0;i<2;i++)assert.equal(writes.get(directions[i]),data[i]);
  for(const key of ['buffers','textures','views','groups'])assert.equal(h.counts[key],allocated[key]);
  effect.options.radius=2;frame();assert.deepEqual(data.map(value=>Array.from(value)),[[1,0,2,0],[0,1,2,0]]);
  const depth=effect.depthTexture;h.context.width=64;frame();assert.equal(effect.depthTexture.width,64);assert.ok(depth.destroyed);
  effect.onDeviceRestored(h.engine);frame();
  const restored=h.resources.filter(resource=>!resource.destroyed&&resource.size===16);
  assert.deepEqual(restored.map(buffer=>Array.from(writes.get(buffer))),[[1,0,2,0],[0,1,2,0]]);
 }finally{effect.dispose();}
 assert.ok(h.resources.every(resource=>resource.destroyed));
});
