import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL,fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import {gpuHarness} from './support/postfx-gpu.js';
const packageRoot=process.env.DEEP_INGESTION_BASELINE || fileURLToPath(new URL('../',import.meta.url));
let msaaURL=pathToFileURL(packageRoot+'/packages/shared/msaa.js').href,gpuURL=pathToFileURL(packageRoot+'/packages/shared/gpu.js').href;
if(process.env.DEEP_INGESTION_BASELINE){
 // The source-only snapshot omits ignored core dist; use the identical working policy dependency.
 const policyURL=new URL('../packages/shared/quality.js',import.meta.url).href;
 const msaaSource=(await fs.readFile(packageRoot+'/packages/shared/msaa.js','utf8')).replace("'./quality.js'",JSON.stringify(policyURL));
 msaaURL='data:text/javascript;base64,'+Buffer.from(msaaSource).toString('base64');
 const gpuSource=(await fs.readFile(packageRoot+'/packages/shared/gpu.js','utf8')).replace("'./msaa.js'",JSON.stringify(msaaURL));
 gpuURL='data:text/javascript;base64,'+Buffer.from(gpuSource).toString('base64');
}
const {acquireDepth}=await import(gpuURL);
const {SceneTarget,sceneTarget}=await import(msaaURL);
function acquire(h){const added=[],add=h.engine.frameGraph.add.bind(h.engine.frameGraph);h.engine.frameGraph.add=pass=>{added.push(pass);return add(pass);};const lease=acquireDepth(h.engine);return {lease,capture:added.find(pass=>pass.name==='optional:scene-depth:capture')};}
function failures(h,failAt){let operation=0;const failure=new Error('Injected capture allocation '+failAt),create=h.engine.gpu.createTexture;h.engine.gpu.createTexture=descriptor=>{if(++operation===failAt)throw failure;const resource=create(descriptor),view=resource.createView,destroy=resource.destroy;resource.destroyedCount=0;resource.destroy=()=>{resource.destroyedCount++;destroy.call(resource);};resource.createView=(...args)=>{if(++operation===failAt)throw failure;return view.apply(resource,args);};return resource;};return failure;}
test('Shared owned depth retries every interrupted 1x/4x allocation without leaked resources',async t=>{
 for(const samples of [1,4])for(let at=1;at<=(samples===1?2:9);at++)await t.test(samples+'x operation '+at,()=>{
  const h=gpuHarness();h.context.descriptor.multisample.count=samples;
  const {lease,capture}=acquire(h),failure=failures(h,at);
  try{
   assert.throws(()=>capture.execute(h.context),error=>error===failure);
   assert.ok(h.resources.every(resource=>resource.destroyedCount===1),'Interrupted initialization leaked a native texture');
   assert.equal(lease.texture(),undefined);
   assert.doesNotThrow(()=>capture.execute(h.context));
   assert.ok(h.context.depth);assert.ok(lease.texture());
   assert.equal(h.context.depth.texture.sampleCount,samples);
  }finally{lease.release();}
  assert.ok(h.resources.every(resource=>resource.destroyedCount===1),'Release leaked or double destroyed a texture');
 });
});
test('Shared owned depth invalidates sampling, survives failed resize and stays allocation stable',()=>{
 const h=gpuHarness();const first=acquireDepth(h.engine),second=acquireDepth(h.engine);
 try{
  for(const samples of [4,1,4]){
   h.context.descriptor.multisample.count=samples;h.frame();assert.ok(h.context.depth);
   const warm={textures:h.counts.textures,views:h.counts.views,pipelines:h.pipelines.length,groups:h.groups.length};
   for(let i=0;i<120;i++)h.frame();
   assert.deepEqual({textures:h.counts.textures,views:h.counts.views,pipelines:h.pipelines.length,groups:h.groups.length},warm);
  }
  h.context.width=256;const failure=failures(h,3);
  assert.throws(()=>h.frame(),error=>error===failure);
  assert.ok(h.resources.every(resource=>resource.destroyed),'Resize failure leaked partially owned native textures');
  assert.doesNotThrow(()=>h.frame());assert.equal(first.texture().width,256);
  first.release();assert.equal(first.texture(),second.texture());assert.ok(!second.texture().destroyed);
 }finally{first.release();second.release();}
 assert.ok(h.resources.every(resource=>resource.destroyed));
});
test('Shared depth preserves borrowed target ownership and invalid sample rejection',()=>{
 const h=gpuHarness(),color=h.engine.gpu.createTexture({size:[128,96],format:'rgba16float'}),depth=h.engine.gpu.createTexture({size:[128,96],format:'depth32float'}),target=new SceneTarget(h.engine.gpu,color,depth,4);
 h.engine.frameGraph.add({name:'outer owner',order:-20,execute:c=>target.begin(c)});
 const first=acquireDepth(h.engine),second=acquireDepth(h.engine);h.frame();assert.equal(first.texture(),depth);first.release();second.release();
 assert.ok(!color.destroyed&&!depth.destroyed&&target.textures.every(texture=>!texture.destroyed));target.dispose();color.destroy();depth.destroy();
 const invalid=gpuHarness();invalid.context.descriptor.multisample.count=2;const {lease,capture}=acquire(invalid);
 try{assert.throws(()=>capture.execute(invalid.context),/1 or 4/);assert.ok(invalid.resources.every(resource=>resource.destroyed));invalid.context.descriptor.multisample.count=4;assert.doesNotThrow(()=>capture.execute(invalid.context));}finally{lease.release();}
});
function formatHarness(){const h=gpuHarness(),passes=[];h.context.encoder.beginRenderPass=descriptor=>{const record={descriptor};passes.push(record);return {setPipeline(pipeline){record.pipeline=pipeline;const attachment=descriptor.depthStencilAttachment;if(attachment)assert.equal(pipeline.depthStencil.format,attachment.view.texture.format,'Depth copy pipeline must match destination texture format');},setBindGroup(){},draw(){},end(){}};};return {...h,passes};}
function texture(h,format,samples=1){return h.engine.gpu.createTexture({size:[128,96],format,sampleCount:samples,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});}
test('Cross-format captures use their own depth format and restore outer descriptor identity',()=>{
 for(const samples of [1,4]){
  const h=formatHarness(),c=h.context,color=texture(h,'rgba16float'),depth=texture(h,'depth24plus'),target=new SceneTarget(h.engine.gpu,color,depth,samples),outerDepth=texture(h,'depth32float-stencil8',4),descriptor={...c.descriptor,depthStencil:{format:'depth32float-stencil8',depthWriteEnabled:true,depthCompare:'greater-equal'}};
  c.descriptor=descriptor;c.depth=outerDepth.createView();const originalDepth=c.depth;
  try{
   target.begin(c);assert.equal(sceneTarget(c),target);assert.equal(c.descriptor.depthStencil.format,'depth24plus');assert.equal(c.descriptor.depthStencil.depthCompare,'greater-equal');assert.equal(c.descriptor.depthStencil.depthWriteEnabled,true);assert.equal(descriptor.depthStencil.format,'depth32float-stencil8');
   target.resolve(c.encoder,true);target.restore(c);assert.equal(c.depth,originalDepth);assert.equal(c.descriptor,descriptor);
   if(samples===4){assert.deepEqual(h.pipelines.map(p=>[p.depthStencil.format,p.multisample.count]),[['depth24plus',1],['depth32float-stencil8',4]]);assert.match(h.pipelines[0].fragment.module.code,/return max/);assert.match(h.pipelines[1].fragment.module.code,/@builtin\(sample_index\)/);}
  }finally{target.dispose();for(const resource of h.resources)resource.destroy();}
 }
});
test('Depth copy cache includes destination format and preserves three-argument callers',()=>{
 const h=formatHarness(),c=h.context,color=texture(h,'rgba16float'),depth=texture(h,'depth24plus'),target=new SceneTarget(h.engine.gpu,color,depth,4),outerFormats=['depth32float','depth32float-stencil8'],outer=outerFormats.map(format=>texture(h,format,4));
 const originalColor=c.color;
 function frame(index){c.color=originalColor;c.depth=outer[index].createView();c.descriptor={...c.descriptor,depthStencil:{format:outerFormats[index]},multisample:{count:4}};target.begin(c);target.restore(c);}
 try{
  frame(0);frame(1);assert.deepEqual(h.pipelines.map(p=>p.depthStencil.format),outerFormats);
  const pipelines=h.pipelines.length,groups=h.groups.length;
  for(let i=0;i<120;i++)frame(i%2);
  assert.equal(h.pipelines.length,pipelines);assert.equal(h.groups.length,groups);
  target.copyDepth(c.encoder,depth.createView(),4);assert.equal(h.pipelines.at(-1).depthStencil.format,'depth24plus');
  target.copyDepth(c.encoder,outer[0].createView(),4,'depth32float');assert.equal(h.pipelines.length,pipelines+1);
 }finally{target.dispose();for(const resource of h.resources)resource.destroy();}
});
