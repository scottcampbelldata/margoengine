import test from 'node:test';import assert from 'node:assert/strict';import {Sky,sunDirection} from '../dist/index.js';import {optionalGPU} from '../../../tests/support/optional-gpu.js';
test('clock and sky models reuse four-order scattering tables until turbidity changes',()=>{
 const h=optionalGPU(),effect=new Sky({model:'bruneton',hours:12,timeScale:1});h.engine.use(effect);h.frame();assert.ok(Math.abs(effect.options.hours-12.1)<1e-8);assert.equal(h.counts.compute,11);h.frame();assert.equal(h.counts.compute,11);effect.options.turbidity=3;h.frame();assert.equal(h.counts.compute,22);
 effect.options.model='preetham';h.frame();assert.ok([...sunDirection(12)].every(Number.isFinite));assert.ok(Math.abs(sunDirection(6)[1])<1e-6);assert.ok(sunDirection(0)[1]<-0.99);assert.throws(()=>new Sky({turbidity:0}),/options/);
 effect.onDeviceRestored(h.engine);h.frame();effect.dispose();assert.ok(h.resources.every(r=>r.destroyed));
});
