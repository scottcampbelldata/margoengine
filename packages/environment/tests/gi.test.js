// CPU checks of @margoengine/environment/gi: DynamicGI is LightProbes with a live irradiance volume over its box, its
// defaults, its sweep length, and its checks. The live capture itself: probes-live.test.js (mock GPU) and
// gi-browser.js (real GPU).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DynamicGI } from '../dist/gi.js';

const room = { min: [-5, 0, -4], max: [5, 3, 4] };

test('DynamicGI is a live irradiance volume over its box, with defaults', () => {
  const gi = new DynamicGI(room);
  // Each entry is self-contained, so the class extends its own copy of LightProbes, not the one of /probes.
  assert.equal(typeof gi.setLiveVolume, 'function');
  assert.equal(gi.name, 'dynamic-gi');
  assert.deepEqual(gi.volume.counts, [4, 4, 4]);
  assert.deepEqual([gi.volume.min, gi.volume.max], [room.min, room.max]);
  assert.equal(gi.volume.sh, 2);
  assert.deepEqual(gi.liveVolume, { probesPerFrame: 4 });
  assert.equal(gi.sweepFrames, 16);
  assert.deepEqual(gi.reflections, []);
  assert.equal(gi.baked, false);
});

test('DynamicGI passes its options on and reports its sweep length', () => {
  const gi = new DynamicGI({
    ...room,
    counts: [6, 2, 5],
    probesPerFrame: 7,
    resolution: 8,
    sh: 1,
    blend: 0.5,
    name: 'gi',
  });
  assert.deepEqual(gi.volume.counts, [6, 2, 5]);
  assert.equal(gi.volume.resolution, 8);
  assert.equal(gi.volume.sh, 1);
  assert.equal(gi.volume.blend, 0.5);
  assert.equal(gi.name, 'gi');
  assert.equal(gi.sweepFrames, Math.ceil(60 / 7));
  gi.setLiveVolume(null);
  assert.equal(gi.sweepFrames, Infinity, 'no sweep while live capture is off');
  gi.setLiveVolume({ probesPerFrame: 60 });
  assert.equal(gi.sweepFrames, 1);
});

test('DynamicGI checks its options', () => {
  assert.throws(() => new DynamicGI(), TypeError);
  assert.throws(() => new DynamicGI({ min: [0, 0, 0], max: [0, 1, 1] }), RangeError);
  assert.throws(() => new DynamicGI({ ...room, counts: [65, 1, 1] }), RangeError);
  assert.throws(() => new DynamicGI({ ...room, probesPerFrame: 0 }), RangeError);
  assert.throws(() => new DynamicGI({ ...room, resolution: 12 }), RangeError);
});
