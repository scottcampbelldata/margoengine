import test from 'node:test';import assert from 'node:assert/strict';import {Selection} from '../dist/index.js';import {optionalGPU} from '../../../tests/support/optional-gpu.js';
test('selection replays only visible depth, switches between JFA and morphology and cleans up',()=>{
 const h=optionalGPU(),effect=new Selection(),mesh={id:2};h.engine.meshes.set(2,mesh);h.engine.use(effect);effect.set([mesh]);let options;h.context.draw=value=>{if(value)options=value;};h.frame();
 assert.equal(options.pipeline.depthStencil.depthCompare,'equal');assert.ok(h.counts.compute>=8);const computes=h.counts.compute;effect.options.algorithm='morphological';h.frame();assert.equal(h.counts.compute,computes);
 assert.throws(()=>effect.set([{id:3}]),/Foreign/);effect.options.width=0;assert.throws(()=>h.frame(),/options/);effect.options.width=3;h.context.width=64;h.frame();effect.onDeviceRestored(h.engine);h.frame();effect.dispose();assert.ok(h.resources.every(r=>r.destroyed));
});
