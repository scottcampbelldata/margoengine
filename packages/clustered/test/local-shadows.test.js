import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Clustered,clusteredSampling} from '../dist/index.js';
import {wgsl} from '../../core/src/shaders.ts';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';

const identity=()=>new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
const point=(shadow=true)=>({position:[0,2,1],range:6,intensity:18,shadow});
const spot=(shadow=true)=>({...point(shadow),direction:[0,-1,0],outerAngle:Math.PI/4,innerAngle:Math.PI/8});
function harness(){
 const h=optionalGPU(),limits=h.engine.gpu.limits;
 Object.assign(limits,{maxTextureDimension2D:8192,maxTextureArrayLayers:256,maxStorageBuffersPerShaderStage:8,maxSampledTexturesPerShaderStage:16,maxSamplersPerShaderStage:16,maxBindGroups:4,maxBindingsPerBindGroup:1000});
 h.borrowed=new Set();
 h.frame=()=>{h.context.shader=wgsl;h.context.bindings.length=0;h.engine.frameGraph.execute(h.context);};
 return h;
}
function caster(h,stride=24){
 const vertex=h.engine.gpu.createBuffer({size:stride*3,usage:GPUBufferUsage.VERTEX}),index=h.engine.gpu.createBuffer({size:12,usage:GPUBufferUsage.INDEX});
 const node={id:0,engine:h.engine,matrix:identity(),check(){}};
 h.engine.meshes.set(node.id,node);
 h.borrowed.add(vertex);h.borrowed.add(index);
 return {node,vertex,index,count:3,stride};
}
function snapshotLights(effect){return new Uint8Array(effect.bindings().find(entry=>entry.binding===5).resource.buffer.data).slice();}
function assertDisposed(h){assert.ok(h.resources.every(resource=>resource.destroyed||h.borrowed.has(resource)),'Owned GPU resources must be released');h.cleanup();}

test('unconfigured clustered lighting retains the exact baseline sampling source and bindings',()=>{
 assert.equal(createHash('sha256').update(clusteredSampling(0)).digest('hex'),'6e9e15161c74a7597698b1f2cbeb00125973d0f8a7a812508d7faaa1b3f13eee');
 assert.equal(createHash('sha256').update(clusteredSampling(2)).digest('hex'),'46f98a88d2eb1f3d55a72bf776fca1299b36ad692e4aef74d20e6430d929ea78');
 const h=harness(),effect=new Clustered({grid:[2,2,2]});
 try{
  effect.setLights([point(false),spot(false)]);h.engine.use(effect);h.frame();
  assert.deepEqual(effect.bindings().map(entry=>entry.binding),[4,5,6,7]);
  assert.deepEqual(h.context.bindings.map(entry=>entry.binding),[4,5,6,7]);
  assert.equal(h.counts.buffers,4);assert.equal(h.counts.textures,0);assert.equal(h.counts.render,0);assert.equal(h.counts.compute,1);
  assert.equal(effect.shader(wgsl),clusteredSampling(0)+wgsl.replace(/let linear=([^;]+);/,'let linear=$1+clusterLighting(i.clip.xy,i.position,n,frame.eye.xyz,i.color,i.material.x,i.material.y);'));
  assert.doesNotMatch(h.context.shader,/clusterShadow|localShadow|binding\(1[678]\)/);
 }finally{effect.dispose();assertDisposed(h);}
});

test('local shadow options validate before allocating or attaching anything',()=>{
 for(const shadows of [{resolution:0},{resolution:15},{resolution:16.5},{resolution:Infinity},{maxLights:0},{maxLights:1.5},{maxLights:33},{maxLights:1025},{maxLights:NaN}]){
  assert.throws(()=>new Clustered({grid:[1,1,1],shadows}),/shadow|resolution|light/i);
 }
 for(const shadows of [{},{resolution:16,maxLights:1},{resolution:512,maxLights:32}])assert.doesNotThrow(()=>new Clustered({grid:[1,1,1],shadows}).dispose());
 const effect=new Clustered();
 assert.throws(()=>effect.setLights([point()]),/shadow/i);
 assert.throws(()=>effect.addShadowCaster({shadowPrimitives:[]}),/shadow/i);
 effect.dispose();
});

test('shadow lights validate near planes, biases, flags and capacity atomically',()=>{
 const h=harness(),effect=new Clustered({grid:[1,1,1],shadows:{resolution:16,maxLights:1}});
 effect.setLights([point({near:0.05,bias:0.0002,normalBias:0.02})]);h.engine.use(effect);h.frame();const before=snapshotLights(effect);
 try{
  for(const shadow of [null,1,'true',[],{near:0},{near:-1},{near:6},{near:7},{near:Infinity},{near:NaN},{bias:-1},{bias:Infinity},{normalBias:-1},{normalBias:NaN}]){
   assert.throws(()=>effect.setLights([point(shadow)]),/shadow|near|bias/i,JSON.stringify(shadow));
   h.frame();assert.deepEqual(snapshotLights(effect),before,'Rejected shadow settings changed the uploaded light list');
  }
  assert.throws(()=>effect.setLights([point(),spot()]),/shadow|light|capacity/i);
  h.frame();assert.deepEqual(snapshotLights(effect),before,'Capacity rejection partially replaced the light list');
  const bad=spot();bad.direction=[0,0,0];assert.throws(()=>effect.setLights([point(false),bad]),/spot|direction/i);
  h.frame();assert.deepEqual(snapshotLights(effect),before);
  assert.doesNotThrow(()=>effect.setLights([point(),...Array.from({length:20},()=>point(false))]));
 }finally{effect.dispose();assertDisposed(h);}
});

test('local shadow attachment checks texture and storage limits without leaking resources',()=>{
 for(const limits of [{maxTextureDimension2D:8},{maxTextureArrayLayers:5},{maxStorageBufferBindingSize:16},{maxBufferSize:16}]){
  const h=harness();Object.assign(h.engine.gpu.limits,limits);const effect=new Clustered({grid:[1,1,1],shadows:{resolution:16,maxLights:1}});
  assert.throws(()=>h.engine.use(effect),/limit|shadow|cluster/i);assert.ok(h.resources.every(resource=>resource.destroyed),'Rejected attachment leaked GPU resources');
 }
});

test('failed local shadow setup releases resources created before the device failure',()=>{
 for(const target of ['createTexture','createBuffer','createBindGroup']){
  const h=harness(),effect=new Clustered({grid:[1,1,1],shadows:{resolution:16,maxLights:1}}),create=h.engine.gpu[target],failure=new Error(`failed ${target}`);let calls=0;
  h.engine.gpu[target]=(...args)=>{if(++calls===(target==='createBindGroup'?1:2))throw failure;return create(...args);};
  try{assert.throws(()=>h.engine.use(effect),error=>error===failure);assert.ok(h.resources.every(resource=>resource.destroyed),'Partial attachment leaked GPU resources');}
  finally{h.engine.gpu[target]=create;effect.dispose();assertDisposed(h);}
 }
});

test('point and spot shadows reserve six and one depth faces and run before clustered culling',()=>{
 const h=harness(),effect=new Clustered({grid:[1,1,1],shadows:{resolution:16,maxLights:2}}),events=[],begin=h.context.encoder.beginRenderPass,compute=h.context.encoder.beginComputePass;
 h.context.encoder.beginRenderPass=descriptor=>{events.push({kind:'depth',descriptor,view:descriptor.depthStencilAttachment.view});return begin(descriptor);};
 h.context.encoder.beginComputePass=()=>{events.push({kind:'compute'});return compute();};
 effect.setLights([point(),spot()]);h.engine.use(effect);
 try{
  h.frame();assert.equal(events.filter(event=>event.kind==='depth').length,7);assert.equal(events.at(-1).kind,'compute');
  assert.deepEqual(effect.bindings().map(entry=>entry.binding),[4,5,6,7,16,17,18]);
  const shadowTexture=h.resources.find(resource=>resource.format==='depth32float');assert.ok(shadowTexture);assert.deepEqual(shadowTexture.size,[16,16,12]);
  assert.match(h.context.shader,/@binding\(16\)/);assert.match(h.context.shader,/texture_depth_2d_array/);assert.match(h.context.shader,/sampler_comparison/);
  assert.match(effect.shader(wgsl,2),/@group\(2\) @binding\(16\)/);
  assert.equal(new Set(events.filter(event=>event.kind==='depth').map(event=>event.view)).size,7);
  for(const event of events.filter(event=>event.kind==='depth')){assert.equal(event.descriptor.colorAttachments.length,0);assert.equal(event.descriptor.depthStencilAttachment.depthClearValue,1);}
  events.length=0;effect.setLights([point(false),spot(false)]);h.frame();assert.deepEqual(events.map(event=>event.kind),['compute']);
 }finally{effect.dispose();assertDisposed(h);}
});

test('point face and spot cone matrices map their near/far planes to WebGPU clip depths',()=>{
 const h=harness(),effect=new Clustered({grid:[1,1,1],shadows:{resolution:16,maxLights:2}}),position=[2,3,4],near=0.25,far=10,outerAngle=Math.PI/6;
 effect.setLights([point(false),{position,range:far,shadow:{near,bias:0.001,normalBias:0.03}},{position,range:far,direction:[0,0,-2],outerAngle,shadow:{near}}]);h.engine.use(effect);
 const clip=(m,offset,p)=>{const result=[];for(let row=0;row<4;row++)result.push(m[offset+row]*p[0]+m[offset+4+row]*p[1]+m[offset+8+row]*p[2]+m[offset+12+row]);return result;};
 const close=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<2e-5,`${label}: ${actual} != ${expected}`);
 try{
  h.frame();const packed=new Float32Array(effect.bindings().find(entry=>entry.binding===16).resource.buffer.data),lights=new Float32Array(effect.bindings().find(entry=>entry.binding===5).resource.buffer.data);
  assert.deepEqual([lights[14],lights[30],lights[46]],[0,1,2]);
  const directions=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  for(let face=0;face<6;face++){
   for(const [distance,expected] of [[near,0],[far,1]]){const p=position.map((v,i)=>v+directions[face][i]*distance),result=clip(packed,face*20,p);close(result[0]/result[3],0,'Face center x');close(result[1]/result[3],0,'Face center y');close(result[2]/result[3],expected,'Point clip depth');assert.ok(result[3]>0);}
   close(packed[face*20+16],0.001,'Point bias');close(packed[face*20+17],0.03,'Point normal bias');
  }
  const offset=6*20;
  for(const [distance,expected] of [[near,0],[far,1]]){const result=clip(packed,offset,[position[0],position[1],position[2]-distance]);close(result[2]/result[3],expected,'Spot clip depth');close(result[0],0,'Spot center x');close(result[1],0,'Spot center y');}
  const edge=clip(packed,offset,[position[0]+Math.tan(outerAngle),position[1],position[2]-1]);close(Math.abs(edge[0]/edge[3]),1,'Spot outer cone edge');
  assert.ok(packed.every(Number.isFinite));
 }finally{effect.dispose();assertDisposed(h);}
});

test('disposed sources and removed primitives release cached local shadow draw buffers',()=>{
 const h=harness(),effect=new Clustered({grid:[1,1,1],shadows:{resolution:16,maxLights:1}}),primitive=caster(h),source={shadowPrimitives:[primitive],disposed:false};effect.setLights([spot()]);h.engine.use(effect);effect.addShadowCaster(source);
 try{
  h.frame();const drawBuffers=()=>h.resources.filter(resource=>resource.size===144&&!h.borrowed.has(resource));assert.equal(drawBuffers().filter(resource=>!resource.destroyed).length,1);
  source.shadowPrimitives=[];h.frame();assert.ok(drawBuffers().every(resource=>resource.destroyed));
  source.shadowPrimitives=[primitive];h.frame();assert.equal(drawBuffers().filter(resource=>!resource.destroyed).length,1);const drawn=h.counts.indexed;
  source.disposed=true;h.frame();assert.equal(h.counts.indexed,drawn);assert.ok(drawBuffers().every(resource=>resource.destroyed));
 }finally{effect.dispose();assertDisposed(h);}
});

test('registered shadow casters draw only visible live nodes and removal is idempotent',()=>{
 const h=harness(),effect=new Clustered({grid:[1,1,1],shadows:{resolution:16,maxLights:1}}),primitive=caster(h),source={shadowPrimitives:[primitive]};
 effect.setLights([spot()]);h.engine.use(effect);const remove=effect.addShadowCaster(source);
 try{
  assert.throws(()=>effect.addShadowCaster(source),/duplicate|caster/i);h.frame();assert.equal(h.counts.indexed,1);
  h.engine.store.hidden[0]=1;h.frame();assert.equal(h.counts.indexed,1);
  h.engine.store.hidden[0]=0;h.engine.store.parents[0]=1;h.engine.store.hidden[1]=1;h.frame();assert.equal(h.counts.indexed,1);
  h.engine.store.parents[0]=-1;h.engine.store.hidden[1]=0;h.frame();assert.equal(h.counts.indexed,2);
  remove();remove();h.frame();assert.equal(h.counts.indexed,2);
  assert.equal(primitive.vertex.destroyed,false);assert.equal(primitive.index.destroyed,false,'Caster geometry remains caller owned');
 }finally{effect.dispose();assertDisposed(h);}
});

test('core mesh casters follow geometry-buffer replacement and live engine membership',()=>{
 const h=harness(),effect=new Clustered({grid:[1,1,1],shadows:{resolution:16,maxLights:1}}),primitive=caster(h),node=primitive.node;
 node.geometry={indices:new Uint32Array([0,1,2])};let buffers={vertex:primitive.vertex,index:primitive.index};h.engine.geometryBuffers=geometry=>geometry===node.geometry?buffers:undefined;
 effect.setLights([spot()]);effect.addShadowCaster(node);h.engine.use(effect);
 try{
  h.frame();assert.equal(h.counts.indexed,1);assert.equal(h.pipelines.find(pipeline=>pipeline.vertex).vertex.buffers[0].arrayStride,24);
  const original=h.resources.find(resource=>resource.size===144&&!h.borrowed.has(resource));buffers={vertex:h.engine.gpu.createBuffer({size:72,usage:GPUBufferUsage.VERTEX}),index:h.engine.gpu.createBuffer({size:12,usage:GPUBufferUsage.INDEX})};h.borrowed.add(buffers.vertex);h.borrowed.add(buffers.index);
  h.frame();assert.equal(h.counts.indexed,2);assert.equal(original.destroyed,true,'Replaced core geometry kept a stale draw buffer');
  h.engine.meshes.delete(node.id);h.frame();assert.equal(h.counts.indexed,2);assert.ok(h.resources.filter(resource=>resource.size===144&&!h.borrowed.has(resource)).every(resource=>resource.destroyed));
 }finally{effect.dispose();assertDisposed(h);}
});

test('local shadow caster registration rejects disposed, foreign and invalid sources',()=>{
 const h=harness(),effect=new Clustered({grid:[1,1,1],shadows:{resolution:16,maxLights:1}});h.engine.use(effect);
 try{
  for(const value of [null,{}, {disposed:true,shadowPrimitives:[]},{shadowPrimitives:[{...caster(h),node:{id:0,engine:{},matrix:identity(),check(){}}}]}])assert.throws(()=>effect.addShadowCaster(value),/caster|source|disposed|engine/i);
  effect.dispose();assert.throws(()=>effect.addShadowCaster({shadowPrimitives:[]}),/disposed|caster|live.*shadow/i);
 }finally{effect.dispose();assertDisposed(h);}
});

test('local shadow alpha UV1 transforms and geometry replacements update their draw resources',()=>{
 const h=harness(),effect=new Clustered({grid:[1,1,1],shadows:{resolution:16,maxLights:1}}),primitive=caster(h,80);
 const texture=h.engine.gpu.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING}),view=texture.createView(),sampler=h.engine.gpu.createSampler();
 h.borrowed.add(texture);
 Object.assign(primitive,{alphaTexture:view,alphaSampler:sampler,alpha:0.7,cutoff:0.35,texCoord:1,alphaTransform:new Float32Array([0,2,0.25,0,-3,0,0.75,0])});
 effect.setLights([spot()]);h.engine.use(effect);effect.addShadowCaster({shadowPrimitives:[primitive]});
 try{
  h.frame();const groups=h.groups.filter(group=>group.entries.length===3&&group.entries[0].binding===0),initial=h.counts.groups;
  assert.ok(groups.length);const drawGroup=groups[0];assert.equal(drawGroup.entries[1].resource,view);assert.equal(drawGroup.entries[2].resource,sampler);
  const values=new Float32Array(drawGroup.entries[0].resource.buffer.data);
  assert.ok(Math.abs(values[32]-0.7)<1e-6);assert.ok(Math.abs(values[33]-0.35)<1e-6);assert.equal(values[34],1);assert.deepEqual(values.slice(36,44),primitive.alphaTransform);
  const pipeline=h.pipelines.find(pipeline=>pipeline.vertex);assert.equal(pipeline.vertex.buffers[0].arrayStride,80);assert.match(pipeline.vertex.module.code,/discard/);assert.match(pipeline.vertex.module.code,/alphaUV/);
  h.frame();assert.equal(h.counts.groups,initial);
  const previous=drawGroup.entries[0].resource.buffer;primitive.vertex=h.engine.gpu.createBuffer({size:240,usage:GPUBufferUsage.VERTEX});h.borrowed.add(primitive.vertex);h.frame();assert.ok(previous.destroyed,'Replaced geometry retained stale per-draw buffers');
  const nextView=texture.createView();primitive.alphaTexture=nextView;h.frame();assert.equal(h.groups.at(-1).entries[1].resource,nextView);
 }finally{effect.dispose();assertDisposed(h);}
});

test('steady local shadow frames allocate no GPU resources, views, shader patches or temporary uniform arrays',()=>{
 const h=harness(),effect=new Clustered({grid:[1,1,1],shadows:{resolution:16,maxLights:1}}),primitive=caster(h,80);
 effect.setLights([point()]);h.engine.use(effect);effect.addShadowCaster({shadowPrimitives:[primitive]});
 try{
  h.frame();const allocated={...h.counts},shader=h.context.shader;
  const subarray=Float32Array.prototype.subarray,replace=String.prototype.replace,set=Float32Array.prototype.set;let views=0,patches=0,arrays=0;
  Float32Array.prototype.subarray=function(...args){views++;return subarray.apply(this,args);};
  String.prototype.replace=function(...args){patches++;return replace.apply(this,args);};
  Float32Array.prototype.set=function(source,...args){if(Array.isArray(source))arrays++;return set.call(this,source,...args);};
  try{for(let i=0;i<120;i++){h.frame();assert.equal(h.context.shader,shader);}}finally{Float32Array.prototype.subarray=subarray;String.prototype.replace=replace;Float32Array.prototype.set=set;}
  assert.equal(views,0);assert.equal(patches,0);assert.equal(arrays,0);
  for(const key of ['buffers','textures','views','groups'])assert.equal(h.counts[key],allocated[key],`${key} grew in steady frames`);
 }finally{effect.dispose();assertDisposed(h);}
});

test('local shadow device restoration releases previous attachments and rebuilds draws once',()=>{
 const h=harness(),effect=new Clustered({grid:[1,1,1],shadows:{resolution:16,maxLights:1}}),primitive=caster(h,80);effect.setLights([spot()]);h.engine.use(effect);effect.addShadowCaster({shadowPrimitives:[primitive]});
 try{
  h.frame();const before=[...h.resources].filter(resource=>resource!==primitive.vertex&&resource!==primitive.index),shader=h.context.shader;
  effect.onDeviceRestored(h.engine);assert.ok(before.every(resource=>resource.destroyed));h.frame();assert.equal(h.context.shader,shader);
  assert.equal(primitive.vertex.destroyed,false);assert.equal(primitive.index.destroyed,false);const allocated={...h.counts};h.frame();for(const key of ['buffers','textures','views','groups'])assert.equal(h.counts[key],allocated[key]);
  effect.dispose();effect.destroy();assert.throws(()=>effect.bindings(),/attached|disposed/i);
 }finally{effect.dispose();assertDisposed(h);}
});

test('failed local shadow caster bind group releases its uniform and ends the active pass',()=>{
 const h=harness(),effect=new Clustered({grid:[1,1,1],shadows:{resolution:16,maxLights:1}}),primitive=caster(h);effect.setLights([point()]);h.engine.use(effect);effect.addShadowCaster({shadowPrimitives:[primitive]});
 const create=h.engine.gpu.createBindGroup,begin=h.context.encoder.beginRenderPass,failure=new Error('Local shadow bind group allocation failed');let calls=0,ends=0;
 h.engine.gpu.createBindGroup=(...args)=>{if(++calls===3)throw failure;return create(...args);};h.context.encoder.beginRenderPass=(...args)=>({...begin(...args),end(){ends++;}});
 try{
  assert.throws(h.frame,error=>error===failure);assert.ok(ends>=1,'Failed depth pass was not ended');
  assert.equal(h.resources.filter(resource=>resource.size===144).at(-1).destroyed,true,'Failed face uniform leaked');
  h.engine.gpu.createBindGroup=create;h.frame();const groups=h.counts.groups;h.frame();assert.equal(h.counts.groups,groups);
 }finally{h.engine.gpu.createBindGroup=create;h.context.encoder.beginRenderPass=begin;effect.dispose();assertDisposed(h);}
});
