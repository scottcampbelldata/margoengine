import test from 'node:test';
import assert from 'node:assert/strict';
import {Clustered} from '../dist/index.js';
import {wgsl} from '../../core/src/shaders.ts';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';

test('clustered camera updates retain their view and GPU resources between frames',()=>{
 const h=optionalGPU(),lights=new Clustered({grid:[2,2,2]});
 lights.setLights([{position:[0,2,1],range:6,intensity:18}]);h.engine.use(lights);
 const frame=()=>{h.context.shader=wgsl;h.context.bindings.length=0;h.engine.frameGraph.execute(h.context);};
 try{
  frame();const allocated={...h.counts},uniform=lights.bindings()[0].resource.buffer,before=new Float32Array(uniform.data).slice();
  const subarray=Float32Array.prototype.subarray;let views=0;
  Float32Array.prototype.subarray=function(...args){views++;return subarray.apply(this,args);};
  try{for(let i=0;i<120;i++)frame();}finally{Float32Array.prototype.subarray=subarray;}
  assert.equal(views,0,'Steady clustered frames created temporary typed array views');
  for(const key of ['buffers','textures','views','groups'])assert.equal(h.counts[key],allocated[key]);
  assert.deepEqual(new Float32Array(uniform.data),before);
  h.context.camera.position[2]=5;frame();const moved=new Float32Array(uniform.data).slice();
  assert.notDeepEqual(moved,before);assert.ok(moved.every(Number.isFinite));
  lights.onDeviceRestored(h.engine);frame();assert.ok(uniform.destroyed);
  assert.deepEqual(new Float32Array(lights.bindings()[0].resource.buffer.data),moved);
 }finally{lights.dispose();}
 assert.ok(h.resources.every(resource=>resource.destroyed));
});

test('clustered steady frames reuse patched shaders and avoid temporary uniform arrays',()=>{
 const h=optionalGPU(),lights=new Clustered({grid:[2,2,2]});lights.setLights([{position:[0,2,1],range:6}]);h.engine.use(lights);
 const frame=()=>{h.context.shader=wgsl;h.context.bindings.length=0;h.engine.frameGraph.execute(h.context);};
 try {
  frame();const expectedShader=h.context.shader,uniform=lights.bindings()[0].resource.buffer,expected=new Uint8Array(uniform.data).slice();
  const replace=String.prototype.replace,setF=Float32Array.prototype.set,setU=Uint32Array.prototype.set;let patches=0,temporaryArrays=0;
  String.prototype.replace=function(...args){patches++;return replace.apply(this,args);};
  Float32Array.prototype.set=function(source,...args){if(Array.isArray(source))temporaryArrays++;return setF.call(this,source,...args);};
  Uint32Array.prototype.set=function(source,...args){if(Array.isArray(source))temporaryArrays++;return setU.call(this,source,...args);};
  try {for(let i=0;i<120;i++){frame();assert.equal(h.context.shader,expectedShader);}} finally {String.prototype.replace=replace;Float32Array.prototype.set=setF;Uint32Array.prototype.set=setU;}
  assert.equal(patches,0,'Repeated shader patching in stable frames');assert.equal(temporaryArrays,0,'Temporary arrays for stable uniforms');assert.deepEqual(new Uint8Array(uniform.data),expected);
  const other=wgsl.replace('i.material.y','(i.material.y*0.8)');assert.notEqual(lights.shader(other),expectedShader);assert.match(lights.shader(wgsl,1),/@group\(1\)/);
  assert.equal(lights.shader(wgsl),expectedShader);lights.intensityScale=0;frame();assert.equal(new Uint32Array(uniform.data)[19],0);
  lights.onDeviceRestored(h.engine);frame();assert.equal(h.context.shader,expectedShader);
 } finally {lights.dispose();assert.ok(h.resources.every(resource=>resource.destroyed));}
});
