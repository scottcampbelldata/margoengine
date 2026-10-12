import test from 'node:test';import assert from 'node:assert/strict';import {box,Geometry,PbrMaterial} from '@margoengine/core';import {Scatter} from '../dist/index.js';import {optionalGPU} from '../../../tests/support/optional-gpu.js';
import {wgsl} from '../../core/src/shaders.ts';
test('scatter distributes on GPU and issues three bounded indirect LOD draws',()=>{
 const h=optionalGPU(),effect=new Scatter([box(),box(0.5),box(0.25)],{count:64});h.engine.use(effect);h.frame();assert.equal(h.counts.compute,1);assert.equal(h.counts.indirect,3);effect.onDeviceRestored(h.engine);h.frame();effect.dispose();assert.ok(h.resources.every(r=>r.destroyed));
 assert.throws(()=>new Scatter(box(),{lod:[20,10,30]}),/rules/);assert.throws(()=>new Scatter(box(),{maxSlope:91}),/rules/);
});
test('scatter frustum bounds include geometry displaced from its local origin',()=>{
 const h=optionalGPU(),geometry=new Geometry([10,0,0,11,0,0,10,1,0],[0,0,1,0,0,1,0,0,1],[0,1,2]),effect=new Scatter(geometry,{count:1});
 h.engine.use(effect);h.frame();const uniform=h.resources.find(r=>r.data?.byteLength===72*4),radius=new Float32Array(uniform.data)[35];
 assert.ok(radius>=10.5+geometry.bounds[3]);effect.dispose();
});

test('GPU exclusions are validated and uploaded once across frames and device restoration',()=>{
 const h=optionalGPU(),exclusions=[[-3,-2,1,4]],effect=new Scatter(box(),{count:1,exclusions});
 exclusions[0][0]=100;h.engine.use(effect);h.frame();
 assert.equal(effect.values[19],1);assert.deepEqual(Array.from(new Float32Array(effect.exclusionBuffer.data)),[-3,-2,1,4]);
 const code=h.pipelines.find(p=>p.compute).compute.module.code;
 assert.match(code,/p\.xz-clamp\(p\.xz,bounds\.xy,bounds\.zw\)/);assert.match(code,/dot\(offset,offset\)<=radius\*radius/);
 const created={...h.counts};for(let i=0;i<600;i++)h.frame();
 assert.equal(h.counts.buffers,created.buffers);assert.equal(h.counts.groups,created.groups);
 effect.onDeviceRestored(h.engine);h.frame();assert.deepEqual(Array.from(new Float32Array(effect.exclusionBuffer.data)),[-3,-2,1,4]);
 effect.dispose();assert.ok(h.resources.every(r=>r.destroyed));
 assert.throws(()=>new Scatter(box(),{exclusions:[[1,0,0,1]]}),/exclusion/);
 const limited=optionalGPU();limited.engine.gpu.limits.maxStorageBufferBindingSize=32;
 assert.throws(()=>limited.engine.use(new Scatter(box(),{count:1,exclusions:[[0,0,1,1],[2,0,3,1],[4,0,5,1]]})),/GPU limits/);
 assert.equal(limited.counts.buffers,0);
});

test('scatter defaults to farther LODs and clamps fade bands without changing explicit distances',()=>{
 const near=box(),middle=box(0.8),far=box(0.6),effect=new Scatter([near,middle,far]);
 assert.deepEqual(Array.from(effect.values.slice(32,35)),[25,60,120]);assert.equal(effect.values[31],2);assert.equal(effect.meta[39],3);
 const narrow=new Scatter([near,near,far],{lod:[0.1,0.2,0.3]});
 assert.equal(narrow.values[31],Math.fround(0.1));assert.equal(narrow.meta[39],2);
 assert.equal(new Scatter(near).meta[39],0,'Shared geometry needs no duplicate transition draw');
 assert.equal(new Scatter([near,middle,far],{lodFade:0}).values[31],0);
 for(const lodFade of [-1,NaN,Infinity,100001])assert.throws(()=>new Scatter(near,{lodFade}),/LOD fade/);
});

test('PBR scatter reuses standard lighting and shadow bindings without rebuilding steady-state GPU resources',()=>{
 const h=optionalGPU();h.engine.lighting={direction:new Float32Array([-1,0.13,0,1]),radiance:new Float32Array([1,0.8,0.54,0.18])};
 h.context.shader=wgsl.replace('let linear=direct*','let linear=direct*0.75*');h.context.bindings=[{binding:1,resource:{buffer:{}}}];
 const effect=new Scatter(box(),{count:64,material:new PbrMaterial({color:[0.19,0.28,0.09],roughness:0.95})});h.engine.use(effect);h.engine.frameGraph.execute(h.context);
 const render=h.pipelines.find(p=>p.fragment),code=render.vertex.module.code;
 assert.match(code,/@group\(1\) @binding\(0\)/);assert.match(code,/let linear=direct\*0\.75\*/);assert.doesNotMatch(code,/i\.m0/);
 assert.match(code,/if\(!lodVisible\(i\.clip\.xy,i\.lodFade\)\)\{discard;\}/);
 assert.ok(h.groups.some(g=>g.entries.some(e=>e.resource===h.context.bindings[0].resource)));
 const created={...h.counts};for(let i=0;i<600;i++)h.engine.frameGraph.execute(h.context);
 assert.equal(h.counts.buffers,created.buffers);assert.equal(h.counts.groups,created.groups);
 assert.equal(h.counts.indirect,601*3);effect.onDeviceRestored(h.engine);h.engine.frameGraph.execute(h.context);effect.dispose();assert.ok(h.resources.every(r=>r.destroyed));
 assert.throws(()=>new Scatter(box(),{material:{}}),/material/);
});
