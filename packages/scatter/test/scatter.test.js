import test from 'node:test';import assert from 'node:assert/strict';import {box,Geometry} from '@margoengine/core';import {Scatter} from '../dist/index.js';import {optionalGPU} from '../../../tests/support/optional-gpu.js';
test('scatter distributes on GPU and issues three bounded indirect LOD draws',()=>{
 const h=optionalGPU(),effect=new Scatter([box(),box(0.5),box(0.25)],{count:64});h.engine.use(effect);h.frame();assert.equal(h.counts.compute,1);assert.equal(h.counts.indirect,3);effect.onDeviceRestored(h.engine);h.frame();effect.dispose();assert.ok(h.resources.every(r=>r.destroyed));
 assert.throws(()=>new Scatter(box(),{lod:[20,10,30]}),/rules/);assert.throws(()=>new Scatter(box(),{maxSlope:91}),/rules/);
});
test('scatter frustum bounds include geometry displaced from its local origin',()=>{
 const h=optionalGPU(),geometry=new Geometry([10,0,0,11,0,0,10,1,0],[0,0,1,0,0,1,0,0,1],[0,1,2]),effect=new Scatter(geometry,{count:1});
 h.engine.use(effect);h.frame();const uniform=h.resources.find(r=>r.data?.byteLength===68*4),radius=new Float32Array(uniform.data)[35];
 assert.ok(radius>=10.5+geometry.bounds[3]);effect.dispose();
});
