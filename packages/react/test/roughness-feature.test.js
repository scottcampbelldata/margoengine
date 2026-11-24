// A reaction on device.lost cannot be removed: one made per separate-roughness feature kept every detached feature,
// with its textures, alive as long as the device. Each device now has one reaction over the features with a uniform on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { separateRoughness } from '../dist/roughness-feature.js';

function device() {
  let lose,
    reactions = 0;
  const lost = new Promise((resolve) => (lose = resolve));
  return {
    lost: { then: (done, failed) => (reactions++, lost.then(done, failed)) },
    createBuffer: (descriptor) => ({ ...descriptor, destroyed: false, destroy() { this.destroyed = true; } }),
    queue: { writeBuffer() {} },
    lose: () => lose({ reason: 'unknown', message: 'test' }),
    reactions: () => reactions,
  };
}
const texture = () => ({ bind: () => ['view', 'sampler'], dispose() {} });
const material = { uvt: new Float32Array(16) };

test('a detached roughness feature is collected while its device lives; a live one drops its uniform when it is lost', async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');
  try {
    const gpu = device();
    const reference = (() => {
      const map = texture(),
        feature = separateRoughness(map, texture());
      feature.bindings(gpu, undefined, material);
      feature.detach();
      return new WeakRef(map);
    })();
    for (let i = 0; i < 5 && reference.deref(); i++) {
      await setImmediate();
      gc();
    }
    assert.ok(reference.deref() === undefined, 'the detached feature is still reachable from its live device');
    const features = Array.from({ length: 3 }, () => separateRoughness(texture(), texture()));
    const uniforms = features.map((f) => f.bindings(gpu, undefined, material)[2].resource.buffer);
    assert.equal(gpu.reactions(), 1, 'one reaction for the device, not one per feature');
    gpu.lose();
    await setImmediate();
    assert.ok(uniforms.every((u) => u.destroyed), 'the lost device takes the live uniforms with it');
  } finally {
    setFlagsFromString('--no-expose-gc');
  }
});
