import test from 'node:test';
import assert from 'node:assert/strict';
import {Shadows} from '../dist/index.js';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';

test('shadow cascades reuse descriptors, attachments, callback contexts and matrix views',()=>{
  const h=optionalGPU(),descriptors=[],contexts=[],engine=h.engine;
  engine.gpu.limits.maxTextureDimension2D=8192;engine.gpu.limits.maxTextureArrayLayers=256;
  engine.lighting={direction:new Float32Array([1,2,3,3])};
  const render=h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass=descriptor=>{descriptors.push(descriptor);return render(descriptor);};
  const shadows=new Shadows({resolution:64});
  shadows.add({drawShadow(context){contexts.push(context);}});engine.use(shadows);
  const frame=()=>{h.context.shader='let linear=direct*vec3f(1);';h.context.bindings.length=0;engine.frameGraph.execute(h.context);};
  frame();const descriptor=descriptors[0],attachment=descriptor.depthStencilAttachment,groups=h.counts.groups,views=h.counts.views;
  const matrices=contexts.map(context=>context.matrix);
  for(let i=0;i<4;i++)assert.equal(contexts[i].cascade,i);
  frame();
  for(const value of descriptors){assert.equal(value,descriptor);assert.equal(value.depthStencilAttachment,attachment);assert.equal(value.colorAttachments.length,0);}
  for(let i=0;i<4;i++){assert.equal(contexts[i+4],contexts[i]);assert.equal(contexts[i+4].matrix,matrices[i]);}
  assert.equal(h.counts.groups,groups);assert.equal(h.counts.views,views);
  shadows.onDeviceRestored(engine);frame();shadows.dispose();assert.ok(h.resources.every(resource=>resource.destroyed));
});

test('static shadow maps skip empty dynamic passes and retain cache invalidation',()=>{
  const h=optionalGPU(),engine=h.engine,passes=[],render=h.context.encoder.beginRenderPass;
  engine.gpu.limits.maxTextureDimension2D=8192;engine.gpu.limits.maxTextureArrayLayers=256;
  engine.lighting={direction:new Float32Array([1,2,3,3])};
  h.context.encoder.beginRenderPass=descriptor=>{passes.push(descriptor.depthStencilAttachment.depthLoadOp);return render(descriptor);};
  let staticDraws=0,dynamicDraws=0;
  const source={shadowVersion:0,drawShadow(){staticDraws++;}},shadows=new Shadows({resolution:64});
  shadows.add(source,{static:true});engine.use(shadows);
  const frame=()=>{passes.length=0;h.context.shader='let linear=direct*vec3f(1);';h.context.bindings.length=0;engine.frameGraph.execute(h.context);};
  frame();assert.deepEqual(passes,Array(4).fill('clear'));assert.equal(staticDraws,4);assert.equal(h.counts.copies,1);
  frame();assert.deepEqual(passes,[]);assert.equal(staticDraws,4);assert.equal(h.counts.copies,2);assert.equal(shadows.stats.cacheHits,1);
  const dynamic={disposed:false,drawShadow(){dynamicDraws++;}};
  shadows.add(dynamic);frame();assert.deepEqual(passes,[...Array(4).fill('clear'),...Array(4).fill('load')]);assert.equal(dynamicDraws,4);
  frame();assert.deepEqual(passes,Array(4).fill('load'));assert.equal(dynamicDraws,8);
  dynamic.disposed=true;frame();assert.deepEqual(passes,Array(4).fill('clear'));assert.equal(dynamicDraws,8);
  frame();assert.deepEqual(passes,[]);
  source.shadowVersion++;frame();assert.deepEqual(passes,Array(4).fill('clear'));assert.equal(staticDraws,16);
  shadows.onDeviceRestored(engine);frame();assert.deepEqual(passes,Array(4).fill('clear'));assert.equal(staticDraws,20);
  shadows.dispose();assert.ok(h.resources.every(resource=>resource.destroyed));
});

test('shadow alpha replacements invalidate draw groups and share the fallback white view',()=>{
 const h=optionalGPU(),engine=h.engine;engine.gpu.limits.maxTextureDimension2D=8192;engine.gpu.limits.maxTextureArrayLayers=256;engine.lighting={direction:new Float32Array([1,2,3,3])};
 const vertex=engine.gpu.createBuffer({size:240,usage:GPUBufferUsage.VERTEX}),index=engine.gpu.createBuffer({size:12,usage:GPUBufferUsage.INDEX}),node={id:0,engine,matrix:h.context.camera.matrix.slice(),check(){}};
 const primitive={node,vertex,index,count:3,stride:80},source={shadowPrimitives:[primitive]},shadows=new Shadows({resolution:64});
 const alpha=engine.gpu.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING}),sampler=engine.gpu.createSampler(),replacement=alpha.createView();
 const frame=()=>{h.context.shader='let linear=direct*vec3f(1);';h.context.bindings=[];engine.frameGraph.execute(h.context);};
 try {
  engine.use(shadows);shadows.add(source);frame();const groups=h.groups.filter(g=>g.entries.length===3&&g.entries[0].binding===0);
  assert.equal(new Set(groups.map(g=>g.entries[1].resource)).size,1,'Fallback white view is shared across cascades');
  const initial=h.counts.groups;for(let i=0;i<120;i++)frame();assert.equal(h.counts.groups,initial);
  primitive.alphaTexture=replacement;primitive.alphaSampler=sampler;frame();assert.equal(h.counts.groups,initial+4);
  for(const group of h.groups.slice(-4)){assert.equal(group.entries[1].resource,replacement);assert.equal(group.entries[2].resource,sampler);}
  frame();assert.equal(h.counts.groups,initial+4);shadows.onDeviceRestored(engine);frame();
 } finally {shadows.dispose();alpha.destroy();vertex.destroy();index.destroy();assert.ok(h.resources.every(r=>r.destroyed));}
});

test('failed shadow draw allocation releases partial buffers and closes its pass before retry',()=>{
 const h=optionalGPU(),engine=h.engine;engine.gpu.limits.maxTextureDimension2D=8192;engine.gpu.limits.maxTextureArrayLayers=256;engine.lighting={direction:new Float32Array([1,2,3,3])};
 const vertex=engine.gpu.createBuffer({size:72,usage:GPUBufferUsage.VERTEX}),index=engine.gpu.createBuffer({size:12,usage:GPUBufferUsage.INDEX}),node={id:0,engine,matrix:h.context.camera.matrix.slice(),check(){}};
 const shadows=new Shadows({resolution:64});engine.use(shadows);shadows.add({shadowPrimitives:[{node,vertex,index,count:3,stride:24}]});
 const create=engine.gpu.createBuffer,begin=h.context.encoder.beginRenderPass,failure=new Error('Shadow allocation failed');let attempts=0,ends=0;
 engine.gpu.createBuffer=(...args)=>{if(++attempts===3)throw failure;return create(...args);};h.context.encoder.beginRenderPass=(...args)=>({...begin(...args),end(){ends++;}});
 const frame=()=>{h.context.shader='let linear=direct*vec3f(1);';h.context.bindings=[];engine.frameGraph.execute(h.context);};
 try {
  assert.throws(frame,error=>error===failure);assert.equal(ends,5,'Four static clears and the failed dynamic cascade pass are ended');
  assert.ok(h.resources.filter(r=>r.size===144).every(r=>r.destroyed),'Partial draw buffers were leaked');
  engine.gpu.createBuffer=create;frame();const groups=h.counts.groups;frame();assert.equal(h.counts.groups,groups);
 } finally {engine.gpu.createBuffer=create;h.context.encoder.beginRenderPass=begin;shadows.dispose();vertex.destroy();index.destroy();assert.ok(h.resources.every(r=>r.destroyed));}
});
