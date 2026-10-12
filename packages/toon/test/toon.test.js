import test from 'node:test';import assert from 'node:assert/strict';import {Toon} from '../dist/index.js';import {optionalGPU} from '../../../tests/support/optional-gpu.js';
test('toon adds a stepped-lighting pass and a front-culled inverted-hull replay',()=>{
 const h=optionalGPU(),effect=new Toon();h.engine.use(effect);let options;h.context.draw=value=>{if(value)options=value;};h.frame();assert.equal(options.pipeline.primitive.cullMode,'front');assert.equal(options.clear,false);assert.equal(options.pipeline.depthStencil.depthWriteEnabled,false);assert.equal(options.bindings.length,1);
 assert.throws(()=>new Toon({outline:-1}),/outline/);effect.onDeviceRestored(h.engine);h.frame();effect.dispose();assert.ok(h.resources.every(r=>r.destroyed));
});
