import test from 'node:test';
import assert from 'node:assert/strict';
import {Bloom, SSAO} from '../dist/index.js';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';

test('Bloom captures HDR, preserves scene depth for later overlays, resizes and restores without leaks', () => {
  const h=optionalGPU(), effect=new Bloom(); h.engine.use(effect);h.frame();
  assert.equal(effect.depthTexture.width,128); assert.equal(h.context.color,h.originalColor);assert.equal(h.context.depth,h.originalDepth);
  const scene=effect.sceneTexture;assert.equal(scene.format,'rgba16float');assert.ok(scene.usage&GPUTextureUsage.COPY_SRC);
  const groups=h.counts.groups,textures=h.counts.textures,descriptors=[];
  const render=h.context.encoder.beginRenderPass;h.context.encoder.beginRenderPass=descriptor=>{descriptors.push(descriptor);return render(descriptor);};
  h.frame();assert.equal(h.counts.groups,groups);assert.equal(h.counts.textures,textures);
  const descriptor=descriptors.at(-1),attachment=descriptor.colorAttachments[0];
  h.frame();
  assert.equal(effect.sceneTexture,scene);
  assert.equal(descriptors.at(-1),descriptor);assert.equal(descriptor.colorAttachments[0],attachment);assert.equal(attachment.view,h.originalColor);
  assert.equal(h.counts.compute,3);assert.equal(h.counts.render,12);
  h.context.width=1;h.context.height=1;h.frame();assert.equal(effect.depthTexture.width,1);
  assert.equal(effect.sceneTexture.width,1);assert.equal(scene.destroyed,true);
  assert.throws(()=>h.engine.use(new SSAO()),/output target/);
  effect.onDeviceRestored(h.engine);h.frame();effect.dispose();assert.ok(h.resources.every(r=>r.destroyed));
});

test('Bloom rejects invalid grade settings before allocation and rechecks mutable options', () => {
  for(const options of [{strength:-1},{threshold:NaN},{exposure:11}])assert.throws(()=>new Bloom(options),/Invalid/);
  const h=optionalGPU(),options={strength:1},effect=new Bloom(options);h.engine.use(effect);h.frame();
  options.strength=Infinity;assert.throws(()=>h.frame(),/Invalid/);effect.dispose();
});
