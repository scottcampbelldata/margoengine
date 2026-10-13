import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine,TransformStore} from '../packages/core/dist/extension.js';
import {parseGLTF} from '../packages/gltf-pro/dist/index.js';
import {animatedTriangle} from './support/gltf-pro-fixture.js';
import {optionalGPU} from './support/optional-gpu.js';

test('PBR lighting observes in-place buffer binding edits without rebuilding its pipeline',async()=>{
 const h=optionalGPU(),store=await TransformStore.create(16),device=h.engine.gpu;
 const engine=new Engine({width:128,height:96,clientWidth:128,clientHeight:96},store,{backend:'webgpu',gpu:device,add(){},remove(){},render(){},dispose(){}},{position:[0,0,4],target:[0,0,0]},null);
 const fixture=animatedTriangle(),model=parseGLTF(engine,fixture.doc,fixture.buffers),first=device.createBuffer({size:512,usage:GPUBufferUsage.UNIFORM}),second=device.createBuffer({size:512,usage:GPUBufferUsage.UNIFORM});
 engine.camera.update(128/96,true);store.tick(false);
 const resource={buffer:first,offset:0,size:64},entry={binding:4,resource};model.addLighting({shader(source){return '@group(2) @binding(4) var<uniform> local:vec4f;\n'+source.replace('direct+ambient(s)','direct*local.x+ambient(s)');},bindings(){return [entry];}});
 const context={...h.context,camera:engine.camera};const frame=()=>model.draw(context,'beauty',context.color,context.depth);
 try {
  frame();const initial=h.counts.groups,pipelines=h.pipelines.length;
  for(let i=0;i<120;i++)frame();assert.equal(h.counts.groups,initial);
  resource.offset=256;frame();assert.equal(h.counts.groups,initial+1);assert.equal(h.pipelines.length,pipelines);
  resource.size=16;frame();assert.equal(h.counts.groups,initial+2);
  resource.buffer=second;frame();assert.equal(h.counts.groups,initial+3);frame();assert.equal(h.counts.groups,initial+3);
  const create=device.createBindGroup,failure=new Error('Lighting bind failed');resource.offset=0;device.createBindGroup=()=>{throw failure;};assert.throws(frame,error=>error===failure);device.createBindGroup=create;
  frame();assert.equal(h.counts.groups,initial+4);frame();assert.equal(h.counts.groups,initial+4);
  assert.equal(h.groups.at(-1).entries[0].resource.buffer,second);assert.equal(h.groups.at(-1).entries[0].resource.offset,0);
 } finally {first.destroy();second.destroy();engine.dispose();assert.ok(h.resources.every(r=>r.destroyed));}
});
