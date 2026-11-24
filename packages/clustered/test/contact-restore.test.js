// KB-RESTORE-BORROWED1 for ContactLights (docs/conventions.md, "Borrowed GPU objects"): a plain `depth` texture belongs
// to the device it was given on. After a device restore the march stays off and the loss is reported once through
// engine.onError while the frame keeps running; setDepth brings it back, and a function is read each frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Clustered } from '../dist/index.js';
import { ContactLights } from '../dist/contact.js';
import { wgsl } from '../../core/src/shaders.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const SIZE = 8;
const depthOn = (h) =>
  Object.assign(h.engine.gpu.createTexture({ size: [SIZE, SIZE], format: 'depth32float', usage: 4 }), {
    width: SIZE,
    height: SIZE,
    sampleCount: 1,
  });
const marching = (contact) => new Float32Array(contact.bindings()[0].resource.buffer.data)[34] > 0.5;
function frame(h) {
  h.context.shader = wgsl;
  h.context.bindings.length = 0;
  h.engine.frameGraph.execute(h.context);
}

test('a plain depth lost at a device restore is reported once, the march stays off, and setDepth brings it back', () => {
  const first = optionalGPU(),
    second = optionalGPU(),
    errors = [],
    lights = new Clustered({ grid: [2, 2, 2] });
  first.engine.onError = (error) => errors.push(error);
  first.engine.use(lights);
  const depth = depthOn(first),
    contact = new ContactLights({ lights, depth });
  first.engine.use(contact);
  try {
    frame(first);
    assert.ok(marching(contact), 'the march runs on the first device');
    first.engine.gpu = first.context.device = second.engine.gpu;
    contact.onDeviceRestored(first.engine);
    frame(first);
    frame(first);
    assert.equal(marching(contact), false, 'nothing of the old device is read');
    const lost = errors.filter((error) => /borrowed-lost/.test(error.message));
    assert.equal(lost.length, 1, 'one report');
    assert.match(lost[0].message, /^ContactLights depth lost with the device; pass a function or call setDepth/);
    assert.equal(lost[0].code, 'state');
    contact.setDepth(depthOn(second));
    frame(first);
    assert.ok(marching(contact), 'the new depth is read');
    assert.equal(errors.filter((error) => /borrowed-lost/.test(error.message)).length, 1, 'no further report');
  } finally {
    contact.dispose();
    lights.dispose();
  }
});

test('a depth function is read each frame across a restore, with no report', () => {
  const first = optionalGPU(),
    second = optionalGPU(),
    errors = [],
    lights = new Clustered({ grid: [2, 2, 2] });
  first.engine.onError = (error) => errors.push(error);
  first.engine.use(lights);
  let current = depthOn(first);
  const contact = new ContactLights({ lights, depth: () => current });
  first.engine.use(contact);
  try {
    frame(first);
    first.engine.gpu = first.context.device = second.engine.gpu;
    contact.onDeviceRestored(first.engine);
    current = depthOn(second);
    frame(first);
    assert.ok(marching(contact));
    assert.deepEqual(errors, []);
  } finally {
    contact.dispose();
    lights.dispose();
  }
});
