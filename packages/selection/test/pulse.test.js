import assert from 'node:assert/strict';
import test from 'node:test';
import { XRaySelection } from '../dist/xray.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
test('pulse validates period, amplitude and manual time without owning scene meshes',()=>{
 for(const pulse of [{period:0},{period:Infinity},{minimum:-0.1},{minimum:1.1}])assert.throws(()=>new XRaySelection({pulse}),RangeError);
 for(const pulse of ['bad',1])assert.throws(()=>new XRaySelection({pulse}),TypeError);
 const h=optionalGPU(), effect=new XRaySelection();h.engine.use(effect);
 effect.time=3;h.context.delta=0.5;h.frame();assert.equal(effect.time,3);
 effect.play();h.context.view={index:0};h.frame();assert.equal(effect.time,3.5);
 h.context.view={index:1};h.frame();assert.equal(effect.time,3.5,'secondary views must not advance the pulse');
 assert.throws(()=>{effect.time=NaN},RangeError);effect.dispose();effect.dispose();assert.equal(h.engine.plugins.size,0);
});
