import test from 'node:test';import assert from 'node:assert/strict';import {Water} from '../dist/index.js';import {optionalGPU} from '../../../tests/support/optional-gpu.js';
test('water validates nonfolding waves, samples shared scene depth, accumulates foam and restores',()=>{
 const h=optionalGPU(),effect=new Water({segments:4});h.engine.use(effect);h.frame();h.frame();assert.equal(h.counts.indexed,2);assert.equal(h.engine.hasPlugin('optional:scene-depth'),true);h.context.width=64;h.frame();effect.onDeviceRestored(h.engine);h.frame();effect.dispose();assert.equal(h.engine.hasPlugin('optional:scene-depth'),false);assert.ok(h.resources.every(r=>r.destroyed));
 assert.throws(()=>new Water({waves:[{direction:[1,0],amplitude:10,wavelength:1}]}),/fold/);assert.throws(()=>new Water({size:[0,1]}),/options/);
});
