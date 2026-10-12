import test from 'node:test';import assert from 'node:assert/strict';import {Transitions} from '../dist/index.js';import {optionalGPU} from '../../../tests/support/optional-gpu.js';
test('transition freezes previous scene once, advances progress, resizes and tears down',()=>{
 const h=optionalGPU(),effect=new Transitions();h.engine.use(effect);h.frame();effect.start('dissolve',0.4);h.frame();assert.equal(h.counts.copies,1);assert.equal(effect.progress,0.25);h.frame();assert.equal(h.counts.copies,1);
 for(const kind of ['wipe','radial','chromatic']){effect.start(kind,0.1);h.frame();assert.equal(effect.progress,1);}
 assert.throws(()=>effect.start('bad'),/Invalid/);h.context.width=64;h.frame();effect.onDeviceRestored(h.engine);h.frame();effect.dispose();assert.equal(h.engine.hasPlugin('transitions'),false);assert.ok(h.resources.every(r=>r.destroyed));
});
