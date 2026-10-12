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
