import test from 'node:test';
import assert from 'node:assert/strict';
import {Clustered} from '../dist/index.js';
import {wgsl} from '../../core/src/shaders.ts';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';
import {Camera} from '../../core/dist/index.js';
import {CameraProjection} from '../../cameras/dist/index.js';
import {orthographic} from '../../shared/projection.js';

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

// Orthographic cameras (@margoengine/cameras): the package reads only camera.matrix, so slices are linear and cells are boxes.
test('clustered: orthographic cameras get linear depth slices whose cells contain every fragment that samples them',()=>{
 const h=optionalGPU(),lights=new Clustered({grid:[4,3,6]});lights.setLights([{position:[0,0,0],range:1}]);h.engine.use(lights);
 const camera=new Camera({position:[3,4,8],target:[0.5,0,0],fov:50,far:40}),projection=new CameraProjection({left:-3,right:5,top:2,bottom:-2.5,zoom:1.25,near:-4,far:24});projection.attach(camera);
 const frame=()=>{camera.update(h.context.width/h.context.height,true);Object.assign(h.context.camera,{matrix:camera.matrix,position:camera.position,target:camera.target,fov:camera.fov,near:camera.near,far:camera.far});h.context.shader=wgsl;h.context.bindings.length=0;h.engine.frameGraph.execute(h.context);};
 try{
  frame();const data=lights.bindings()[0].resource.buffer.data,v=new Float32Array(data),grid=[4,3,6];
  assert.equal(v[31],1);assert.ok(Math.abs(v[24]+4)<1e-4&&Math.abs(v[25]-24)<1e-4,'signed near/far of the projection');
  // Mirror of the WGSL: fragment cell lookup (clusteredSampling) and cell bounds (cullingShader).
  const view=v.subarray(0,16),m=camera.matrix,{width,height}=h.context;let checked=0;
  for(let i=0;i<500;i++){
   const p=[Math.random()*12-6,Math.random()*10-5,Math.random()*30-15],c=[0,1,2,3].map(r=>m[r]*p[0]+m[4+r]*p[1]+m[8+r]*p[2]+m[12+r]);
   if(Math.abs(c[0])>1||Math.abs(c[1])>1||c[2]<0||c[2]>1)continue;
   const e=[0,1,2].map(r=>view[r]*p[0]+view[4+r]*p[1]+view[8+r]*p[2]+view[12+r]),depth=-e[2],pixel=[(c[0]*0.5+0.5)*width,(0.5-c[1]*0.5)*height];
   const xy=[0,1].map(k=>Math.min(Math.floor(Math.max(pixel[k],0)/[width,height][k]*grid[k]),grid[k]-1)),z=Math.min(Math.floor(Math.max(0,(depth-v[24])/(v[25]-v[24])*grid[2])),grid[2]-1);
   const z0=v[24]+(v[25]-v[24])*z/grid[2],z1=v[24]+(v[25]-v[24])*(z+1)/grid[2];
   const x0=(xy[0]/grid[0]*2-1-v[29])*v[22]*v[23],x1=((xy[0]+1)/grid[0]*2-1-v[29])*v[22]*v[23],y0=(1-(xy[1]+1)/grid[1]*2-v[30])*v[22],y1=(1-xy[1]/grid[1]*2-v[30])*v[22];
   const slack=1e-3;assert.ok(e[0]>=x0-slack&&e[0]<=x1+slack&&e[1]>=y0-slack&&e[1]<=y1+slack&&depth>=z0-slack&&depth<=z1+slack,`point ${p} outside its cluster`);checked++;
  }
  assert.ok(checked>50,`only ${checked} points in the frustum`);
  // Back to perspective: the orthographic terms are cleared, so the uniform equals a perspective-only run.
  projection.dispose();frame();const perspective=new Float32Array(data).slice();assert.deepEqual([...perspective.subarray(29,32)],[0,0,0]);assert.equal(orthographic(camera.matrix,camera.position),null);
  const fresh=optionalGPU(),other=new Clustered({grid:[4,3,6]});other.setLights([{position:[0,0,0],range:1}]);fresh.engine.use(other);
  Object.assign(fresh.context.camera,{matrix:camera.matrix,position:camera.position,target:camera.target,fov:camera.fov,near:camera.near,far:camera.far});fresh.context.shader=wgsl;fresh.engine.frameGraph.execute(fresh.context);
  assert.deepEqual(new Float32Array(other.bindings()[0].resource.buffer.data),perspective);other.dispose();
 }finally{lights.dispose();}
});
