import test from 'node:test';import assert from 'node:assert/strict';import {Water} from '../dist/index.js';import {optionalGPU} from '../../../tests/support/optional-gpu.js';
test('water validates nonfolding waves, samples shared scene depth, accumulates foam and restores',()=>{
 const h=optionalGPU(),effect=new Water({segments:4});h.engine.use(effect);h.frame();h.frame();assert.equal(h.counts.indexed,2);assert.equal(h.engine.hasPlugin('optional:scene-depth'),true);h.context.width=64;h.frame();effect.onDeviceRestored(h.engine);h.frame();effect.dispose();assert.equal(h.engine.hasPlugin('optional:scene-depth'),false);assert.ok(h.resources.every(r=>r.destroyed));
 assert.throws(()=>new Water({waves:[{direction:[1,0],amplitude:10,wavelength:1}]}),/fold/);assert.throws(()=>new Water({size:[0,1]}),/options/);
});
test('wave height adjusts the existing spectrum atomically and rejects folded surfaces',()=>{
 const h=optionalGPU(),effect=new Water({segments:4,waves:[{direction:[1,0],amplitude:0.3,wavelength:12},{direction:[0,1],amplitude:0.15,wavelength:7}]});h.engine.use(effect);
 effect.setWaveHeight(0.6);h.frame();const uniform=h.resources.find(r=>r.size===448),values=new Float32Array(uniform.data);
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
 for(let i=2;i<descriptors.length;i++)assert.equal(descriptors[i],descriptors[i%2]);
 effect.dispose();
});
test('default swells share a wind cone and keep distinct wavelengths',()=>{
 const h=optionalGPU(),effect=new Water({segments:4});h.engine.use(effect);h.frame();const v=new Float32Array(h.resources.find(r=>r.size===448).data);
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
test('mesh sampling fades short waves without changing their wavelength or height controls',()=>{
 const h=optionalGPU(),edge=Math.hypot(2,2),ratios=[1.5,2,3,4,8],weights=[0,0,0.5,1,1];
 const effect=new Water({size:[8,8],segments:4,waves:ratios.map(r=>({direction:[1,0],amplitude:0.1,wavelength:r*edge}))});
 h.engine.use(effect);h.frame();const values=new Float32Array(h.resources.find(r=>r.size===448).data);
 for(let i=0;i<ratios.length;i++){assert.ok(Math.abs(values[39+i*8]-weights[i])<1e-6);assert.ok(Math.abs(values[35+i*8]-2*Math.PI/(ratios[i]*edge))<1e-6);}
 effect.setWaveHeight(0.2);h.frame();
 for(let i=0;i<ratios.length;i++){assert.ok(Math.abs(values[34+i*8]-0.2)<1e-6);assert.ok(Math.abs(values[39+i*8]-weights[i])<1e-6);}
 effect.dispose();
});
test('coastal flow reuses its resources and borrows terrain across resize and restoration',()=>{
 const h=optionalGPU(),terrain=h.engine.gpu.createTexture({size:[16,16],format:'r32float',usage:GPUTextureUsage.TEXTURE_BINDING});
 const effect=new Water({segments:4,spray:true,terrain:{heightmap:()=>terrain,origin:[-8,-8],size:[16,16]}});h.engine.use(effect);h.frame();
 const allocated={...h.counts},uniform=h.resources.find(r=>r.size===448),values=new Float32Array(uniform.data);
 assert.deepEqual(Array.from(values.subarray(96,100)),[-8,-8,16,16]);assert.equal(values[103],1);
 for(let i=0;i<100;i++)h.frame();
 for(const name of ['textures','buffers','groups','views'])assert.equal(h.counts[name],allocated[name]);
 h.context.width=64;h.frame();effect.onDeviceRestored(h.engine);h.frame();effect.dispose();
 assert.equal(terrain.destroyed,false);terrain.destroy();assert.ok(h.resources.every(r=>r.destroyed));
 assert.throws(()=>new Water({terrain:{heightmap:()=>terrain,origin:[0,0],size:[0,1]}}),/terrain/);
 const bad=new Water({terrain:{heightmap:()=>undefined,origin:[0,0],size:[16,16]}});h.engine.use(bad);assert.throws(()=>h.frame(),/heightmap/);bad.dispose();
});
