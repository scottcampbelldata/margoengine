import test from 'node:test';
import assert from 'node:assert/strict';
import {VFX} from '../dist/index.js';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';

test('initial population is emitted once at attachment and again after device restoration',()=>{
 const h=optionalGPU();h.engine.stats={drawCalls:0};
 const effect=new VFX({capacity:32,initialCount:17,rate:0});h.engine.use(effect);
 const budget=()=>new Uint32Array(h.resources.findLast(r=>r.size===224&&!r.destroyed).data)[53];
 h.frame();assert.equal(budget(),17);h.frame();assert.equal(budget(),0);
 const old=effect.gpuState.particles;effect.onDeviceRestored(h.engine);assert.ok(old.destroyed);
 h.frame();assert.equal(budget(),17);h.frame();assert.equal(budget(),0);
 effect.dispose();assert.ok(h.resources.every(r=>r.destroyed));
 for(const initialCount of [-1,1.5,33,NaN])assert.throws(()=>new VFX({capacity:32,initialCount}),/initial/);
});

test('one current 64-byte particle buffer survives frames and is retired once on restoration/disposal',()=>{
 const h=optionalGPU();h.engine.stats={drawCalls:0};
 const destroyed=new Map(),create=h.engine.gpu.createBuffer;
 h.engine.gpu.createBuffer=descriptor=>{const buffer=create(descriptor),destroy=buffer.destroy.bind(buffer);buffer.destroy=()=>{destroyed.set(buffer,(destroyed.get(buffer)??0)+1);destroy();};return buffer;};
 const effect=new VFX({capacity:32,initialCount:17,rate:0});h.engine.use(effect);
 const first=effect.gpuState,owned=h.resources.slice();
 assert.equal(owned.filter(buffer=>buffer.size===32*64).length,1);
 assert.equal(first.particles.size,32*64);assert.equal(first.indirect.size,20);
 for(let frame=0;frame<4;frame++){h.frame();assert.equal(effect.gpuState.particles,first.particles);assert.equal(effect.gpuState.indirect,first.indirect);}
 effect.onDeviceRestored(h.engine);
 assert.ok(owned.every(buffer=>buffer.destroyed&&destroyed.get(buffer)===1));assert.notEqual(effect.gpuState.particles,first.particles);assert.notEqual(effect.gpuState.indirect,first.indirect);
 h.frame();const current=h.resources.filter(buffer=>!buffer.destroyed);effect.dispose();effect.dispose();
 assert.ok(current.every(buffer=>buffer.destroyed&&destroyed.get(buffer)===1));assert.ok(!h.engine.hasPlugin(effect.name));assert.throws(()=>effect.gpuState,/not attached/);
});
