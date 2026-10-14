import test from 'node:test';import assert from 'node:assert/strict';import {Water} from '../dist/index.js';import {optionalGPU} from '../../../tests/support/optional-gpu.js';
import {SceneTarget} from '../../shared/msaa.js';
test('water validates nonfolding waves, samples shared scene depth, accumulates foam and restores',()=>{
 const h=optionalGPU(),effect=new Water({segments:4});h.engine.use(effect);assert.equal(effect.depthTexture,undefined);h.frame();h.frame();assert.equal(h.counts.indexed,2);assert.equal(h.engine.hasPlugin('optional:scene-depth'),true);
 const depth=effect.depthTexture;assert.ok(depth);h.context.width=64;h.frame();assert.notEqual(effect.depthTexture,depth);assert.equal(effect.depthTexture.width,64);assert.equal(depth.destroyed,true);
 const resized=effect.depthTexture;effect.onDeviceRestored(h.engine);h.frame();assert.notEqual(effect.depthTexture,resized);assert.equal(resized.destroyed,true);effect.dispose();assert.equal(effect.depthTexture,undefined);assert.equal(h.engine.hasPlugin('optional:scene-depth'),false);assert.ok(h.resources.every(r=>r.destroyed));
 assert.throws(()=>new Water({waves:[{direction:[1,0],amplitude:10,wavelength:1}]}),/fold/);assert.throws(()=>new Water({size:[0,1]}),/options/);
});

test('moon radiance drives wave glints, foam and the water ambient floor',()=>{
 const h=optionalGPU();h.engine.lighting={direction:new Float32Array([0.2,0.95,-0.3,0.6]),radiance:new Float32Array([0.25,0.45,0.75,0.09])};
 const water=new Water({segments:4});h.engine.use(water);h.frame();const uniform=h.resources.find(r=>r.size===512),values=new Float32Array(uniform.data);
 assert.deepEqual(Array.from(values.subarray(104,108)),Array.from(h.engine.lighting.direction));assert.deepEqual(Array.from(values.subarray(108,111)),Array.from(h.engine.lighting.radiance.subarray(0,3)));assert.equal(values[19],Math.fround(0.09));
 assert.deepEqual(values.subarray(112,116),values.subarray(104,108));assert.deepEqual(values.subarray(116,119),values.subarray(108,111));assert.equal(values[123],0);
 h.engine.lighting.direction[3]=0;h.engine.lighting.radiance[3]=0;h.frame();assert.equal(values[107],0);assert.equal(values[19],0);assert.equal(values[115],0);
 water.onDeviceRestored(h.engine);h.frame();water.dispose();assert.ok(h.resources.every(r=>r.destroyed));
});

test('explicit reflection lights stay separate, update in place and survive restoration',()=>{
 const h=optionalGPU(),lights=[{direction:new Float32Array([3,4,0,2]),radiance:new Float32Array([1,0.8,0.5])},{direction:new Float32Array([0,1,-1,0.6]),radiance:new Float32Array([0.25,0.45,0.75])}];
 const water=new Water({segments:4,lights});h.engine.use(water);h.frame();
 const read=()=>new Float32Array(h.resources.find(r=>!r.destroyed&&r.size===512).data),first=read().slice(112),allocated={...h.counts};
 assert.deepEqual(Array.from(first.slice(0,3)),[Math.fround(0.6),Math.fround(0.8),0]);assert.equal(first[3],2);assert.equal(first[11],Math.fround(0.6));
 for(let i=0;i<60;i++)h.frame();assert.deepEqual(read().slice(112),first);for(const key of ['buffers','textures','groups','views'])assert.equal(h.counts[key],allocated[key]);
 lights[0].direction[3]=0;lights[1].direction[3]=0.7;h.frame();assert.equal(read()[115],0);assert.equal(read()[123],Math.fround(0.7));
 water.onDeviceRestored(h.engine);h.frame();assert.equal(read()[123],Math.fround(0.7));
 lights.pop();h.frame();assert.equal(read()[123],0);lights.length=0;h.frame();assert.ok(read().slice(112).every(v=>v===0));water.dispose();assert.ok(h.resources.every(r=>r.destroyed));
 for(const lights of [null,42,[{}, {}, {}],[{}],[{direction:[0,0,0,1],radiance:[1,1,1]}],[{direction:[1,0,0,-1],radiance:[1,1,1]}],[{direction:[1,0,0,1],radiance:[1,NaN,1]}]])assert.throws(()=>new Water({lights}),/light/);
 const invalid=new Water({segments:4,lights:[{direction:[1,0,0,1],radiance:[1,1,1]}]});h.engine.use(invalid);invalid.options.lights[0].radiance[0]=-1;assert.throws(h.frame,/light/);invalid.dispose();
});
test('wave height adjusts the existing spectrum atomically and rejects folded surfaces',()=>{
 const h=optionalGPU(),effect=new Water({segments:4,waves:[{direction:[1,0],amplitude:0.3,wavelength:12},{direction:[0,1],amplitude:0.15,wavelength:7}]});h.engine.use(effect);
 effect.setWaveHeight(0.6);h.frame();const uniform=h.resources.find(r=>r.size===512),values=new Float32Array(uniform.data);
 assert.ok(Math.abs(values[34]-0.6)<1e-6);assert.ok(Math.abs(values[42]-0.3)<1e-6);
 assert.throws(()=>effect.setWaveHeight(100),/fold/);h.frame();assert.ok(Math.abs(values[34]-0.6)<1e-6);
 effect.setWaveHeight(0);h.frame();assert.equal(values[34],0);assert.equal(values[42],0);
 assert.throws(()=>effect.setWaveHeight(NaN),/Invalid/);effect.dispose();assert.throws(()=>effect.setWaveHeight(0),/Invalid/);
});
test('steady water frames reuse bind groups, views and their render descriptor',()=>{
 const h=optionalGPU(),effect=new Water({segments:4});h.engine.use(effect);h.frame();
 const descriptors=[];const begin=h.context.encoder.beginRenderPass;h.context.encoder.beginRenderPass=d=>{descriptors.push(d);return begin(d);};
 const groups=h.counts.groups,views=h.counts.views;
 for(let i=0;i<100;i++)h.frame();
 assert.equal(h.counts.groups,groups);assert.equal(h.counts.views,views);
 const perFrame=descriptors.length/100;assert.ok(perFrame>2);for(let i=perFrame;i<descriptors.length;i++)assert.equal(descriptors[i],descriptors[i%perFrame]);
 effect.dispose();
});
test('default reflection lights copy exact uniform bits without creating temporary typed-array views',()=>{
 const h=optionalGPU(),water=new Water({segments:4});h.engine.use(water);h.frame();
 const original=Float32Array.prototype.subarray;let views=0;
 try{Float32Array.prototype.subarray=function(...args){views++;return original.apply(this,args);};for(let i=0;i<120;i++)h.frame();}
 finally{Float32Array.prototype.subarray=original;}
 assert.equal(views,0);const values=new Uint32Array(h.resources.find(r=>r.size===512).data);
 assert.deepEqual(values.slice(112,116),values.slice(104,108));assert.deepEqual(values.slice(116,119),values.slice(108,111));
 water.dispose();assert.ok(h.resources.every(r=>r.destroyed));
});
test('default swells share a wind cone and keep distinct wavelengths',()=>{
 const h=optionalGPU(),effect=new Water({segments:4});h.engine.use(effect);h.frame();const v=new Float32Array(h.resources.find(r=>r.size===512).data);
 assert.ok(v[32]*v[40]+v[33]*v[41]>Math.cos(25*Math.PI/180));assert.notEqual(v[35],v[43]);effect.dispose();
});
test('borrowed HDR optics retain resources and copy descriptors between frames',()=>{
 const h=optionalGPU(),device=h.engine.gpu;
 const sky=device.createTexture({size:[64,32],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING});
 const scene=device.createTexture({size:[128,96],format:'rgba16float',usage:GPUTextureUsage.COPY_SRC});
 const effect=new Water({segments:4,reflection:()=>sky,sceneColor:()=>scene});h.engine.use(effect);h.context.format='rgba16float';
 const copies=[];h.context.encoder.copyTextureToTexture=(source,target,size)=>copies.push([source,target,size]);
 const frame=()=>h.engine.frameGraph.execute(h.context);frame();const allocated={...h.counts};
 for(let i=0;i<100;i++)frame();
 for(const name of ['textures','buffers','groups','views'])assert.equal(h.counts[name],allocated[name]);
 for(let i=1;i<copies.length;i++)for(let j=0;j<3;j++)assert.equal(copies[i][j],copies[0][j]);
 scene.sampleCount=4;assert.throws(frame,/copyable HDR/);scene.sampleCount=1;sky.depthOrArrayLayers=2;assert.throws(frame,/sky texture/);sky.depthOrArrayLayers=1;
 effect.dispose();assert.equal(sky.destroyed,false);assert.equal(scene.destroyed,false);sky.destroy();scene.destroy();assert.ok(h.resources.every(r=>r.destroyed));
 assert.throws(()=>new Water({spray:true}),/spray/);assert.throws(()=>new Water({reflection:42}),/optics/);
});

for(const [samples,kind] of [[4,'resolved'],[1,'resolved'],[4,'external'],[4,'copy-only']])test(`refraction ${samples}x ${kind} uses a distinct sampled texture without steady allocations`,()=>{
 const h=optionalGPU(),c=h.context,device=h.engine.gpu;
 const texture=(format,usage)=>device.createTexture({size:[128,96],format,usage});
 const color=texture('rgba16float',GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC|(kind==='copy-only'?0:GPUTextureUsage.TEXTURE_BINDING));
 const depth=texture('depth32float',GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING),target=new SceneTarget(device,color,depth,samples);
 const scene=kind==='external'?texture('rgba16float',GPUTextureUsage.COPY_SRC|GPUTextureUsage.TEXTURE_BINDING):color;
 const water=new Water({segments:4,depth:()=>depth,sceneColor:()=>scene});h.engine.use(water);
 const frame=()=>{c.color=h.originalColor;c.depth=h.originalDepth;c.format='rgba16float';c.descriptor.multisample.count=samples;target.begin(c);h.engine.frameGraph.execute(c);target.resolve(c.encoder,true);target.restore(c);};
 try{
  frame();const borrow=samples===4&&kind==='resolved',sampled=water.groups[0].entries.find(e=>e.binding===6).resource.texture;
  assert.equal(sampled,borrow?scene:water.captured);assert.notEqual(sampled,water.presentation.colorAttachments[0].view.texture,'Refraction must not sample the active color attachment');
  assert.equal(water.captured===undefined,borrow);assert.equal(h.counts.copies??0,borrow?0:1);
  const warm={...h.counts};for(let i=0;i<120;i++)frame();
  for(const name of ['textures','buffers','groups','views'])assert.equal(h.counts[name],warm[name]);
  assert.equal(h.counts.copies??0,borrow?0:121);water.dispose();assert.equal(scene.destroyed,false);assert.equal(color.destroyed,false);
 }finally{water.dispose();target.dispose();h.cleanup();}
});

test('4x refraction switches borrowed sources and survives restoration without destroying caller textures',()=>{
 const h=optionalGPU(),c=h.context,device=h.engine.gpu,make=format=>device.createTexture({size:[128,96],format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC|GPUTextureUsage.TEXTURE_BINDING});
 const color=make('rgba16float'),external=make('rgba16float'),depth=make('depth32float'),target=new SceneTarget(device,color,depth,4);let scene=color;
 const water=new Water({segments:4,depth:()=>depth,sceneColor:()=>scene});h.engine.use(water);
 const frame=()=>{c.color=h.originalColor;c.depth=h.originalDepth;c.format='rgba16float';target.begin(c);h.engine.frameGraph.execute(c);target.resolve(c.encoder,true);target.restore(c);};
 const sampled=()=>water.groups[0].entries.find(e=>e.binding===6).resource.texture;
 try{
  frame();assert.equal(sampled(),color);assert.equal(h.counts.copies??0,0);
  scene=external;frame();const copy=water.captured;assert.equal(sampled(),copy);assert.equal(h.counts.copies,1);
  scene=color;frame();assert.equal(sampled(),color);assert.equal(copy.destroyed,true);assert.equal(h.counts.copies,1);
  water.onDeviceRestored(h.engine);frame();assert.equal(sampled(),color);assert.equal(h.counts.copies,1);
  water.dispose();assert.equal(color.destroyed,false);assert.equal(external.destroyed,false);
 }finally{water.dispose();target.dispose();h.cleanup();}
});
test('mesh sampling fades short waves without changing their wavelength or height controls',()=>{
 const h=optionalGPU(),edge=Math.hypot(2,2),ratios=[1.5,2,3,4,8],weights=[0,0,0.5,1,1];
 const effect=new Water({size:[8,8],segments:4,waves:ratios.map(r=>({direction:[1,0],amplitude:0.1,wavelength:r*edge}))});
 h.engine.use(effect);h.frame();const values=new Float32Array(h.resources.find(r=>r.size===512).data);
 for(let i=0;i<ratios.length;i++){assert.ok(Math.abs(values[39+i*8]-weights[i])<1e-6);assert.ok(Math.abs(values[35+i*8]-2*Math.PI/(ratios[i]*edge))<1e-6);}
 effect.setWaveHeight(0.2);h.frame();
 for(let i=0;i<ratios.length;i++){assert.ok(Math.abs(values[34+i*8]-0.2)<1e-6);assert.ok(Math.abs(values[39+i*8]-weights[i])<1e-6);}
 effect.dispose();
});
test('coastal flow reuses its resources and borrows terrain across resize and restoration',()=>{
 const h=optionalGPU(),terrain=h.engine.gpu.createTexture({size:[16,16],format:'r32float',usage:GPUTextureUsage.TEXTURE_BINDING});
 const effect=new Water({segments:4,spray:true,terrain:{heightmap:()=>terrain,origin:[-8,-8],size:[16,16]}});h.engine.use(effect);h.frame();
 const state=effect.coastalDepthTexture;assert.equal(state,effect.coastal.states[effect.coastal.current]);assert.ok(state.usage&GPUTextureUsage.COPY_SRC);
 const topology=h.pipelines.find(p=>p.compute?.entryPoint==='connect').compute.module.code;
 assert.doesNotMatch(topology,/atomicCompareExchangeWeak/,'WebKit emits an invalid Metal result struct for compare-exchange');
 const allocated={...h.counts},uniform=h.resources.find(r=>r.size===512),values=new Float32Array(uniform.data);
 assert.deepEqual(Array.from(values.subarray(96,100)),[-8,-8,16,16]);assert.equal(values[103],1);
 for(let i=0;i<100;i++)h.frame();
 for(const name of ['textures','buffers','groups','views'])assert.equal(h.counts[name],allocated[name]);
 h.context.width=64;h.frame();effect.onDeviceRestored(h.engine);assert.equal(effect.coastalDepthTexture,undefined);assert.ok(state.destroyed);h.frame();assert.notEqual(effect.coastalDepthTexture,state);effect.dispose();assert.equal(effect.coastalDepthTexture,undefined);
 assert.equal(terrain.destroyed,false);terrain.destroy();assert.ok(h.resources.every(r=>r.destroyed));
 assert.throws(()=>new Water({terrain:{heightmap:()=>terrain,origin:[0,0],size:[0,1]}}),/terrain/);
 const bad=new Water({terrain:{heightmap:()=>undefined,origin:[0,0],size:[16,16]}});h.engine.use(bad);assert.throws(()=>h.frame(),/heightmap/);bad.dispose();
});

test('ocean horizon retains the central grid and supplies larger sample footprints offshore',()=>{
 const bounded=new Water({size:[160,160],segments:32}),ocean=new Water({size:[160,160],segments:32,horizon:true});
 assert.equal(ocean.positions.length,bounded.positions.length);assert.deepEqual(ocean.triangles,bounded.triangles);
 for(let i=0;i<bounded.positions.length;i+=3){
  const x=bounded.positions[i],z=bounded.positions[i+1];
  if(Math.abs(x)<55&&Math.abs(z)<55)assert.deepEqual(ocean.positions.subarray(i,i+3),bounded.positions.subarray(i,i+3));
  assert.ok(ocean.positions[i+2]>=bounded.positions[i+2]);
 }
 assert.equal(bounded.positions[0],-80);assert.ok(ocean.positions[0]<-10000);assert.ok(ocean.positions[2]>1000);
 const h=optionalGPU();h.engine.use(ocean);h.frame();const pipeline=h.pipelines.find(p=>p.fragment?.targets.length===2);
 assert.equal(pipeline.vertex.buffers[0].arrayStride,12);assert.match(pipeline.vertex.module.code,/const HORIZON=true;/);
 ocean.dispose();bounded.dispose();assert.ok(h.resources.every(r=>r.destroyed));assert.throws(()=>new Water({horizon:'yes'}),/options/);
});
