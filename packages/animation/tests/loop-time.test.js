// A looping Animation's `time` wraps at the end of the clip, as its `loop` option says, so a scrub bar bound to it
// stays inside [0, duration] (found in the school pilot, docs/guides/animation.md step 5).
import assert from 'node:assert/strict';
import test from 'node:test';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { Animation } from '../dist/index.js';
import { skinnedStrip } from '../test/fixture.js';
import { ownerEngine } from './owner-lifetime.fixture.js';

async function player(t, options) {
  const engine = await ownerEngine(t),
    data = skinnedStrip(),
    model = new PBRModel(engine, new GLTFAsset(data.doc, data.buffers));
  t.after(() => model.dispose());
  const animation = Animation.attach(model, options);
  t.after(() => animation.dispose());
  return animation;
}

test('a looping clip wraps time at its end and poses the same frame', async (t) => {
  const animation = await player(t),
    duration = animation.clips[animation.clip].duration;
  assert.ok(duration > 0);
  animation.onPreUpdate(duration * 2.25);
  assert.ok(Math.abs(animation.time - duration * 0.25) < 1e-9, `time ${animation.time} of ${duration}`);
  assert.equal(animation.playing, true);
  for (let i = 0; i < 50; i++) animation.onPreUpdate(duration / 7);
  assert.ok(animation.time >= 0 && animation.time < duration, `time ${animation.time} stays inside the clip`);
});

test('a clip that does not loop still stops at its end', async (t) => {
  const animation = await player(t, { loop: false }),
    duration = animation.clips[animation.clip].duration;
  animation.onPreUpdate(duration * 1.5);
  assert.equal(animation.playing, false);
  assert.ok(animation.time >= duration);
});
