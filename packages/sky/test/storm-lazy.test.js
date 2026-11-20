// The storm's WGSL and maths load only when a layer draws a storm (size gate: plain clouds do not carry them).
// This file runs alone in its process, so nothing has loaded the storm before it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VolumetricClouds, stormFieldFor } from '@margoengine/sky/volumetric-clouds';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

function draw(h, clouds) {
  h.engine.use(clouds);
  clouds.onPreUpdate(1);
  h.context.bindings = [];
  h.engine.frameGraph.execute(h.context);
}
const code = (h) => [...h.shaders.values()].join('\n');

test('clouds without a storm never load it, and their shaders carry no storm code', () => {
  const h = tracedGPU();
  draw(h, new VolumetricClouds({}));
  assert.ok(code(h).length > 0, 'the clouds drew');
  assert.doesNotMatch(code(h), /cloudStormDensity/);
  assert.equal(stormFieldFor({}), undefined);
  h.cleanup();
});

test('a storm loads on first use: nothing draws until `ready`, then the shaders hold the storm', async () => {
  const h = tracedGPU(),
    clouds = new VolumetricClouds({ hurricane: {} });
  draw(h, clouds);
  assert.equal(code(h).length, 0, 'the layer waits for the storm code');
  await clouds.ready;
  clouds.onPreUpdate(1);
  h.context.bindings = [];
  h.engine.frameGraph.execute(h.context);
  assert.match(code(h), /fn cloudStormDensity\(/);
  assert.match(code(h), /if\(c\.storm\[3\]\.y!=0\.0\)\{return cloudStormDensity/);
  assert.doesNotMatch(code(h), /\/\/\[storm-/, 'both markers are replaced');
  h.cleanup();
});
