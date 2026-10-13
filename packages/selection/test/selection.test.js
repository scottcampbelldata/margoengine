import test from 'node:test';import assert from 'node:assert/strict';import {Selection} from '../dist/index.js';import {optionalGPU} from '../../../tests/support/optional-gpu.js';
import {Camera} from '../../core/dist/extension.js';
import {GPURenderer} from '../../core/dist/renderer.js';
test('selection replays only visible depth, switches between JFA and morphology and cleans up',()=>{
 const h=optionalGPU(),effect=new Selection(),mesh={id:2};h.engine.meshes.set(2,mesh);h.engine.use(effect);effect.set([mesh]);let options;h.context.draw=value=>{if(value)options=value;};h.frame();
 assert.equal(options.pipeline.depthStencil.depthCompare,'equal');assert.ok(h.counts.compute>=8);const computes=h.counts.compute;effect.options.algorithm='morphological';h.frame();assert.equal(h.counts.compute,computes);
 assert.throws(()=>effect.set([{id:3}]),/Foreign/);effect.options.width=0;assert.throws(()=>h.frame(),/options/);effect.options.width=3;h.context.width=64;h.frame();effect.onDeviceRestored(h.engine);h.frame();effect.dispose();assert.ok(h.resources.every(r=>r.destroyed));
});

test('selection mask reuses renderer bindings and texture views, replacing them on resize and restoration',async()=>{
 const keys=['navigator','GPUBufferUsage','GPUTextureUsage','GPUMapMode'],globals=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const h=optionalGPU(),device=h.engine.gpu,canvas={width:128,height:96,getContext:()=>({configure(){},unconfigure(){},getCurrentTexture:()=>({createView:()=>({})})})};
 device.lost=new Promise(()=>{});device.addEventListener=()=>{};device.destroy=()=>{};device.queue.submit=()=>{};
 device.createRenderPipelineAsync=async descriptor=>device.createRenderPipeline(descriptor);h.context.encoder.finish=()=>({});device.createCommandEncoder=()=>h.context.encoder;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userAgent:'',gpu:{requestAdapter:async()=>({features:device.features,requestDevice:async()=>device}),getPreferredCanvasFormat:()=> 'bgra8unorm'}}});
 const camera=new Camera();camera.update(128/96,true);const lighting={direction:new Float32Array([0,1,0,1]),radiance:new Float32Array([1,1,1,.1])},effect=new Selection(),mesh={id:2};h.engine.meshes.set(2,mesh);
 let renderer;
 try{
  renderer=await GPURenderer.create(canvas);h.engine.use(effect);effect.set([mesh]);
  const frame=()=>renderer.render(camera,lighting,[],h.engine.frameGraph,1/60);
  frame();const stable={groups:h.counts.groups,views:h.counts.views,pipelines:h.pipelines.length,buffers:h.counts.buffers,textures:h.counts.textures};
  for(let i=0;i<8;i++)frame();
  assert.deepEqual({groups:h.counts.groups,views:h.counts.views,pipelines:h.pipelines.length,buffers:h.counts.buffers,textures:h.counts.textures},stable,'Stable mask rendering must not create GPU bindings or views');
  const original=h.groups.find(g=>g.entries.some(e=>e.binding===1&&e.resource.buffer));
  canvas.width=256;frame();const afterResize={groups:h.counts.groups,views:h.counts.views};frame();assert.deepEqual({groups:h.counts.groups,views:h.counts.views},afterResize);
  assert.equal(original.entries[1].resource.buffer.destroyed,false,'Resize keeps the selection storage buffer');
  effect.onDeviceRestored(h.engine);assert.equal(original.entries[1].resource.buffer.destroyed,true);frame();
  const restored=h.groups.at(-1);assert.notEqual(restored.entries[1].resource.buffer,original.entries[1].resource.buffer);
  const afterRestore={groups:h.counts.groups,views:h.counts.views};frame();assert.deepEqual({groups:h.counts.groups,views:h.counts.views},afterRestore);
 }finally{
  effect.dispose();renderer?.dispose();assert.ok(h.resources.every(r=>r.destroyed));
  for(const [key,descriptor] of globals)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];
 }
});
