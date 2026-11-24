import test from 'node:test';
import assert from 'node:assert/strict';
import { roomReflections, roomImpulseResponse, createRoomReverb } from '@margoengine/mixer/reflections';
import { FakeContext } from './fakes.js';

test('six image sources have the closed-form delay and pressure, with no direct arrival', () => {
  const options = { room: [4,4,4], source: [2,2,2], listener: [2,2,2], channels: 1, reflection: 0.7, tailGain: 0 };
  const arrivals = roomReflections(options);
  assert.equal(arrivals.length, 6);
  assert.equal(new Set(arrivals.map((r) => r.wall)).size, 6);
  for (const arrival of arrivals) {
    assert.equal(arrival.delay, 4 / 343);
    assert.equal(arrival.gain, 0.7 / 4);
  }
  const [data] = roomImpulseResponse(48000, options), frame = 4 / 343 * 48000;
  const at = Math.floor(frame), fraction = frame - at;
  assert.ok(Math.abs(data[at] - 1.05 * (1 - fraction)) < 2e-7);
  assert.ok(Math.abs(data[at + 1] - 1.05 * fraction) < 2e-7);
  assert.equal(data[0], 0);
  assert.ok(data.every((value, i) => i === at || i === at + 1 || value === 0));
});

test('stereo ears differ geometrically; scale and sound speed predict travel changes; seeded tail is repeatable', () => {
  const options = { room: [6,3,8], source: [1,1.5,2], listener: [3,1.5,5] };
  const arrivals = roomReflections(options);
  const left = arrivals.find((r) => r.channel === 0 && r.wall === 'left');
  const right = arrivals.find((r) => r.channel === 1 && r.wall === 'left');
  assert.ok(left.gain > right.gain);
  const faster = roomReflections({ ...options, speedOfSound: 400 });
  arrivals.forEach((arrival, i) => assert.ok(Math.abs(faster[i].delay - arrival.delay * 343 / 400) < 1e-16));
  const a = roomImpulseResponse(48000, { ...options, seconds: 0.1, seed: 17 });
  assert.deepEqual(a, roomImpulseResponse(48000, { ...options, seconds: 0.1, seed: 17 }));
  assert.notDeepEqual(a, roomImpulseResponse(48000, { ...options, seconds: 0.1, seed: 18 }));
  assert.ok(a.every((channel) => channel.every(Number.isFinite)));
});

test('room arguments reject invalid geometry, unsafe ears and unsupported Web Audio with a help link', () => {
  for (const options of [{ room: [0,3,8] }, { source: [0,1,1] }, { listener: [100,1,1] },
    { listener: [0.02,1,1], earSpacing: 1 }, { channels: 3 }, { reflection: 2 }])
    assert.throws(() => roomReflections(options));
  for (const options of [{ seed: 1.5 }, { decay: NaN }, { tailGain: -1 }, { seconds: 0 }])
    assert.throws(() => roomImpulseResponse(48000, options));
  assert.throws(() => roomImpulseResponse(0), RangeError);
  assert.throws(() => roomReflections({ room: [1,,3] }), TypeError);
  assert.throws(() => roomReflections({ channels: 'stereo' }), TypeError);
  assert.throws(() => createRoomReverb({}), { code: 'unsupported', message: /https:\/\// });
  using fx = createRoomReverb(new FakeContext(), { seconds: 0.05 });
  assert.equal(fx.kind, 'reverb');
  assert.equal(fx.params.wet.value, 0.25);
});
